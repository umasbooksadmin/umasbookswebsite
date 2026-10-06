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
  IMAGE_REFERENCES, BATCH_LIMIT, findUnusedImages, countUnusedImages, purgeUnusedImages,
} = require("../../src/lib/imageCleanup");

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
        AND column_name <> 'cover_source_url' -- an external address to download from (lib/coverStore.js), never an /img URL`
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
    ["lib/coverStore.js", "lib/imageStore.js", "routes/admin/announcements.js", "routes/admin/blog.js", "routes/admin/charity.js", "routes/admin/inventory.js"],
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
