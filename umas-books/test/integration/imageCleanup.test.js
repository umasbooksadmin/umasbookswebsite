// Unused-image cleanup (src/lib/imageCleanup.js): an image row is deleted only
// when it is old enough AND its hash appears in no referencing column, so
// replaced covers stop piling up but nothing in use (or just uploaded) goes.
// Runs against a real migrated database; DB access goes straight through the
// pool (the HTTP layer is only used for the admin dashboard line).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const {
  IMAGE_REFERENCES, BATCH_LIMIT, findUnusedImages, countUnusedImages, purgeUnusedImages, makeDashboardUnusedCount, notReferencedSql,
} = require("../../src/lib/imageCleanup");
const { legacyNotReferencedSql } = require("../helpers/legacyImageRefs");

const PORT = 3760;
const TAG = `imgclean${Date.now()}`;
const PASSWORD = "Image-Clean-Pass1!";

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  // The server runs an image cleanup of its own at boot, in the background.
  // Let it finish before inserting old images, or it can delete one between
  // a test's insert of the image and of the row that references it.
  await app.waitForLog(/Image cleanup/);
});

after(async () => {
  await pool.query("DELETE FROM books WHERE title LIKE $1", [`${TAG}%`]);
  await pool.query("DELETE FROM blog_posts WHERE title LIKE $1", [`${TAG}%`]);
  await pool.query("DELETE FROM announcements WHERE title LIKE $1", [`${TAG}%`]);
  await pool.query("DELETE FROM charities WHERE name LIKE $1", [`${TAG}%`]);
  await pool.query("DELETE FROM curated_collections WHERE slug LIKE $1", [`${TAG}%`]);
  await pool.end();
  await app.stop();
});

// Distinct fake bytes per call; the cleanup never decodes them. "ancient"
// backdates to the year 2000 so, oldest-first, these are always ahead of any
// leftover rows when the database is shared with other test files.
let counter = 0;
function fakeBytes(n) {
  return crypto.createHash("sha256").update(`${TAG}-${n}`).digest();
}
async function addImage({ ageDays = 30, ancient = false } = {}) {
  const n = counter++;
  const bytes = fakeBytes(n);
  const id = crypto.createHash("sha256").update(bytes).digest("hex");
  const created = ancient ? `to_timestamp(946684800 + ${n})` : `now() - interval '${ageDays} days'`;
  await pool.query(
    `INSERT INTO images (id, content_type, data, byte_size, created_at)
     VALUES ($1, 'image/jpeg', $2, $3, ${created})`,
    [id, bytes, bytes.length]
  );
  return { id, url: `/img/${id}.jpg`, n };
}

const exists = async (id) => (await pool.query("SELECT 1 FROM images WHERE id = $1", [id])).rowCount === 1;

async function addBook(title, fields = {}) {
  const isbn = `978${String(Date.now()).slice(-7)}${counter++}`.slice(0, 13);
  const { rows } = await pool.query(
    `INSERT INTO books (title, authors, isbn, cover_url, description) VALUES ($1, 'A', $2, $3, $4) RETURNING id`,
    [`${TAG} ${title}`, isbn, fields.cover_url || null, fields.description || null]
  );
  return rows[0].id;
}

test("images in use are kept: book cover, blog image column, hash only inside a blog body", async () => {
  const cover = await addImage({ ancient: true });
  const blogImage = await addImage({ ancient: true });
  const inBody = await addImage({ ancient: true });
  const unused = await addImage({ ancient: true });

  await addBook("covered", { cover_url: cover.url });
  await pool.query(
    `INSERT INTO blog_posts (title, slug, body, image_url, status) VALUES ($1, $2, $3, $4, 'published')`,
    [`${TAG} post`, `${TAG}-post`, `<p>hi</p><img src="${inBody.url}" alt="x">`, blogImage.url]
  );

  const result = await purgeUnusedImages(pool);
  assert.ok(result.deleted >= 1);
  assert.equal(await exists(cover.id), true, "book cover kept");
  assert.equal(await exists(blogImage.id), true, "blog image_url kept");
  assert.equal(await exists(inBody.id), true, "image referenced only inside a blog body kept");
  assert.equal(await exists(unused.id), false, "unreferenced old image deleted");
});

test("an unused image younger than 7 days is kept, an older one is deleted", async () => {
  const young = await addImage({ ageDays: 6 });
  const old = await addImage({ ageDays: 8 });
  await purgeUnusedImages(pool);
  assert.equal(await exists(young.id), true, "6-day-old unused image must survive");
  assert.equal(await exists(old.id), false, "8-day-old unused image is removed");

  // minAgeDays is honoured as a parameter.
  await purgeUnusedImages(pool, { minAgeDays: 5 });
  assert.equal(await exists(young.id), false);
});

test("a replaced cover's old image is removed, the new one stays", async () => {
  const first = await addImage({ ancient: true });
  const second = await addImage({ ancient: true });
  const bookId = await addBook("replaced", { cover_url: first.url });
  await pool.query("UPDATE books SET cover_url = $1 WHERE id = $2", [second.url, bookId]);
  await purgeUnusedImages(pool);
  assert.equal(await exists(first.id), false);
  assert.equal(await exists(second.id), true);
});

test("dryRun reports candidates but deletes nothing", async () => {
  const a = await addImage({ ancient: true });
  const found = await findUnusedImages(pool, { minAgeDays: 7 });
  assert.ok(found.some((r) => r.id === a.id));
  const dry = await purgeUnusedImages(pool, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.deleted, 0);
  assert.ok(dry.candidates >= 1);
  assert.equal(await exists(a.id), true);
  assert.ok((await countUnusedImages(pool)) >= 1);
  await purgeUnusedImages(pool); // tidy
  assert.equal(await exists(a.id), false);
});

test("one run deletes at most BATCH_LIMIT images; the next run finishes", async () => {
  const total = BATCH_LIMIT + 5;
  const ids = [];
  const values = [];
  for (let i = 0; i < total; i++) {
    const bytes = crypto.createHash("sha256").update(`${TAG}-batch-${i}`).digest();
    const id = crypto.createHash("sha256").update(bytes).digest("hex");
    ids.push(id);
    values.push(`('${id}', 'image/jpeg', '\\x${bytes.toString("hex")}'::bytea, ${bytes.length}, to_timestamp(900000000 + ${i}))`);
  }
  await pool.query(`INSERT INTO images (id, content_type, data, byte_size, created_at) VALUES ${values.join(",")}`);

  const first = await purgeUnusedImages(pool);
  assert.equal(first.deleted, BATCH_LIMIT);
  const left = (await pool.query("SELECT count(*)::int AS n FROM images WHERE id = ANY($1)", [ids])).rows[0].n;
  assert.equal(left, 5, "oldest 500 of mine went first, 5 remain");

  await purgeUnusedImages(pool);
  const after2 = (await pool.query("SELECT count(*)::int AS n FROM images WHERE id = ANY($1)", [ids])).rows[0].n;
  assert.equal(after2, 0);
});

test("re-uploading identical bytes through saveImage restarts the age clock", async () => {
  const { saveImage } = require("../../src/lib/imageStore");
  const old = await addImage({ ancient: true });
  const url = await saveImage(fakeBytes(old.n), "image/jpeg", pool);
  assert.equal(url, old.url);
  await purgeUnusedImages(pool);
  assert.equal(await exists(old.id), true, "freshly re-uploaded image must not be purged");
});

test("admin dashboard shows the unused-image count", async () => {
  const email = `${TAG}@example.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at)
     VALUES ($1, $2, 'Img Admin', TRUE, now())`,
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const login = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(login);
  assert.equal(login.status, 302);
  await addImage({ ancient: true });
  const res = await fetch(`${app.base}/admin`, { headers: { cookie: jar.header() } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Unused images waiting for cleanup: \d+/);
  await purgeUnusedImages(pool);
});

// ---- Linear reference detection vs the original quadratic query (the oracle) ----

// Inserts one row in `table` whose `column` holds `value`, filling the NOT NULL
// columns of that table with throwaway values.
async function insertReferencing(table, column, value) {
  const n = counter++;
  const base = {
    books: { title: `${TAG} ref ${n}`, authors: "A" },
    announcements: { title: `${TAG} ref ${n}`, body: "b" },
    blog_posts: { title: `${TAG} ref ${n}`, slug: `${TAG}-ref-${n}`, body: "b", status: "published" },
    charities: { name: `${TAG} ref ${n}` },
    curated_collections: { slug: `${TAG}-ref-${n}`, title_en: `${TAG} ref ${n}` },
    // one row per book (migration 107's copy of the old French book text)
    book_french_backup: table === "book_french_backup"
      ? { book_id: (await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`${TAG} ref ${n}`])).rows[0].id }
      : null,
  }[table];
  assert.ok(base, `test has no fixture for table ${table}: add it to insertReferencing`);
  const cols = { ...base, [column]: value };
  const keys = Object.keys(cols);
  await pool.query(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => cols[k]));
}

test("new reference detection finds exactly what the old strpos query found (every column, plus edge cases)", async () => {
  const mine = [];
  const track = async (opts) => { const img = await addImage(opts); mine.push(img.id); return img; };

  // One image referenced from each listed column, in three URL shapes.
  const shapes = [(u) => u, (u) => `<p>x</p><img src="${u}" alt="">`, (u, id) => `see ${id} and more`];
  let k = 0;
  for (const { table, column } of IMAGE_REFERENCES) {
    const img = await track({ ageDays: 30 });
    await insertReferencing(table, column, shapes[k++ % shapes.length](img.url, img.id));
  }
  // Two images in one cell, a variant URL, and an id that sits inside a longer hex run.
  const a = await track({ ageDays: 30 });
  const b = await track({ ageDays: 30 });
  await insertReferencing("blog_posts", "body", `<img src="${a.url}"><img src="/img/${b.id}-600.jpg">`);
  const inLongRun = await track({ ageDays: 30 });
  await insertReferencing("books", "description", `0${inLongRun.id}`); // 65 hex: strpos matched, so must the new one
  const inLongRun2 = await track({ ageDays: 30 });
  await insertReferencing("announcements", "body", `${inLongRun2.id}f${"a".repeat(70)}`);
  // Uppercase hex is not the stored form and never matched.
  const upper = await track({ ageDays: 30 });
  await insertReferencing("books", "cover_url", `/img/${upper.id.toUpperCase()}.jpg`);
  // Unreferenced: old, old but only 63 chars of it quoted, and recent.
  await track({ ancient: true });
  const partial = await track({ ageDays: 30 });
  await insertReferencing("books", "description", partial.id.slice(0, 63));
  await track({ ageDays: 2 });
  await track({ ageDays: 6 });

  const run = async (pred) => (await pool.query(
    `SELECT i.id FROM images i WHERE i.id = ANY($1) AND i.created_at < now() - interval '7 days' AND ${pred} ORDER BY i.id`, [mine]
  )).rows.map((r) => r.id);
  const oracle = await run(legacyNotReferencedSql("i"));
  const linear = await run(notReferencedSql("i"));
  assert.deepEqual(linear, oracle, "new query must return exactly the old query's unused set");
  // The set itself is what we built: only the uppercase-only, 63-char-only and ancient images are old AND unreferenced.
  assert.equal(oracle.length, 3, "everything else is referenced or younger than 7 days");
  assert.ok(![a.id, b.id, inLongRun.id, inLongRun2.id].some((id) => oracle.includes(id)));
});

test("the new reference query is linear: no per-image correlated scan of the referencing tables", async () => {
  const { rows } = await pool.query(`EXPLAIN SELECT i.id FROM images i WHERE ${notReferencedSql("i")}`);
  const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
  // The old form planned one anti join per referencing column (13), each rescanning its table per image.
  assert.equal((plan.match(/Anti Join/g) || []).length, 1, `exactly one anti join against the precomputed id set:\n${plan}`);
  assert.doesNotMatch(plan, /SubPlan/, "a correlated SubPlan would rescan the tables per image");
});

// ---- Dashboard line: bounded wait, connection released, last good value ----

test("countUnusedImages(timeoutMs) cancels a slow query, releases its connection, and the dashboard wrapper degrades", async () => {
  const { Pool } = require("pg");
  const own = new Pool({ connectionString: app.databaseUrl, ssl: false, max: 2, statement_timeout: 30000 });
  try {
    // A pool whose count query is slowed down with pg_sleep, to stand in for 30k books.
    const slow = {
      connect: async () => {
        const c = await own.connect();
        const q = c.query.bind(c);
        const release = c.release.bind(c);
        c.query = (sql, ...rest) => q(typeof sql === "string" ? sql.replace("SELECT COUNT(*)::int AS n", "SELECT pg_sleep(5), COUNT(*)::int AS n") : sql, ...rest);
        c.release = (...a) => { c.query = q; c.release = release; return release(...a); }; // the pooled client is reused: undo the patch
        return c;
      },
    };
    const t0 = Date.now();
    await assert.rejects(countUnusedImages(slow, { timeoutMs: 300 }), (err) => err.code === "57014");
    assert.ok(Date.now() - t0 < 2500, `must not wait for the slow query (waited ${Date.now() - t0} ms)`);
    assert.equal(own.totalCount - own.idleCount, 0, "connection released after the timeout");
    assert.equal((await own.query("SHOW statement_timeout")).rows[0].statement_timeout, "30s", "SET LOCAL must not leak onto the pooled connection");

    // Wrapper: null before any good value, last good value afterwards, never throws, cached.
    let now = 0;
    const clock = () => now;
    const get = makeDashboardUnusedCount(slow, { ttlMs: 1000, timeoutMs: 200, clock });
    assert.equal(await get(), null, "no cached value yet: null (page shows n/a)");
    const good = makeDashboardUnusedCount(own, { ttlMs: 1000, timeoutMs: 2000, clock });
    const n = await good();
    assert.equal(typeof n, "number");
    assert.equal(await good(), n, "served from cache within the TTL");
  } finally {
    await own.end();
  }
});

test("dashboard wrapper keeps the last good value when a later refresh times out", async () => {
  let calls = 0;
  const fake = {
    connect: async () => ({
      query: async (sql) => {
        if (/COUNT/.test(sql)) {
          calls++;
          if (calls === 1) return { rows: [{ n: 7 }] };
          const err = new Error("canceling statement due to statement timeout"); err.code = "57014"; throw err;
        }
        return { rows: [] };
      },
      release() { this.released = (this.released || 0) + 1; },
    }),
  };
  let now = 0;
  const get = makeDashboardUnusedCount(fake, { ttlMs: 1000, timeoutMs: 100, clock: () => now });
  assert.equal(await get(), 7);
  now = 5000;
  assert.equal(await get(), 7, "refresh timed out: last good value, not 0 and not an error");
  assert.equal(calls, 2);
});

// ---- Completeness: a new image-bearing column must be added to IMAGE_REFERENCES ----

const ROOT = path.join(__dirname, "..", "..");
const listed = new Set(IMAGE_REFERENCES.map((r) => `${r.table}.${r.column}`));

test("every IMAGE_REFERENCES entry is a real text column", async () => {
  const { rows } = await pool.query(
    `SELECT table_name || '.' || column_name AS k FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying')`
  );
  const real = new Set(rows.map((r) => r.k));
  for (const k of listed) assert.ok(real.has(k), `${k} in IMAGE_REFERENCES does not exist as a text column`);
});

test("every text column that looks image-bearing is listed in IMAGE_REFERENCES", async () => {
  const { rows } = await pool.query(
    `SELECT table_name || '.' || column_name AS k FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'images'
        AND data_type IN ('text', 'character varying')
        AND column_name ~* '(image|img|cover|photo|picture|thumb|avatar|logo|banner)'
        AND column_name NOT IN ('cover_source_url', 'cover_origin') -- an external address to download from (lib/coverStore.js), never an /img URL`
  );
  const missing = rows.map((r) => r.k).filter((k) => !listed.has(k));
  assert.deepEqual(missing, [], `add to IMAGE_REFERENCES in src/lib/imageCleanup.js: ${missing.join(", ")}`);
});

test("only the known upload handlers call saveImage, and the rich-text bodies are listed", () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && entry.name !== "imageCleanup.js" && /\bsaveImage\(/.test(fs.readFileSync(full, "utf8"))) {
        files.push(path.relative(path.join(ROOT, "src"), full));
      }
    }
  })(path.join(ROOT, "src"));
  assert.deepEqual(
    files.sort(),
    ["lib/collectionImages.js", "lib/coverStore.js", "lib/imageStore.js", "lib/inventoryIntake.js", "routes/admin/announcements.js", "routes/admin/blog.js", "routes/admin/charity.js", "routes/admin/inventoryCover.js"],
    "a new saveImage caller: add the column it writes to IMAGE_REFERENCES (src/lib/imageCleanup.js), then update this list"
  );
  for (const k of ["books.cover_url", "announcements.image_url", "blog_posts.image_url", "charities.image_url",
    "announcements.body", "blog_posts.body"]) {
    assert.ok(listed.has(k), `${k} must be in IMAGE_REFERENCES`);
  }
});

test("no migration other than the image-store one writes /img/ URLs into other columns", () => {
  const dir = path.join(ROOT, "migrations");
  const offenders = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f !== "034_image_store.sql")
    .filter((f) => /['"]\/img\//.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(offenders, [], "migration embeds '/img/' URLs: make sure the columns are in IMAGE_REFERENCES, then allow-list the file here");
});
