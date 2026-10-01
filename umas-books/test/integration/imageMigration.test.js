// migrations/033_image_store.sql converts every inline data: URI image into
// an `images` row and rewrites the column to /img/<hash>.<ext>. The database
// is isolated (the migration touches every row of four tables) and has
// already had 033 applied once by startTestApp; the test then plants legacy
// rows and re-runs the migration SQL, which also proves it is re-runnable.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3591;
let app;
let pool;
let migrationSql;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  migrationSql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "033_image_store.sql"), "utf8");
});

after(async () => {
  await pool.end();
  await app.stop();
});

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const dataUri = (type, b) => `data:${type};base64,${b.toString("base64")}`;

test("the migration is safe on an empty database", async () => {
  await pool.query(migrationSql);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM images");
  assert.equal(rows[0].n, 0);
});

test("inline data URIs in all four tables become short URLs and round-trip", async () => {
  const jpeg = crypto.randomBytes(5000);
  const png = crypto.randomBytes(3000);
  const shared = crypto.randomBytes(2000); // same picture in two tables -> one image row
  const open = "https://covers.openlibrary.org/b/id/123-L.jpg";
  const bogus = "data:image/jpeg;base64,!!!not base64!!!";
  const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

  const { rows: [book] } = await pool.query("INSERT INTO books (title, cover_url) VALUES ('mig book', $1) RETURNING id", [dataUri("image/jpeg", jpeg)]);
  const { rows: [bookOpen] } = await pool.query("INSERT INTO books (title, cover_url) VALUES ('mig open', $1) RETURNING id", [open]);
  const { rows: [bookNull] } = await pool.query("INSERT INTO books (title) VALUES ('mig null') RETURNING id");
  const { rows: [bookBogus] } = await pool.query("INSERT INTO books (title, cover_url) VALUES ('mig bogus', $1) RETURNING id", [bogus]);
  const { rows: [bookGif] } = await pool.query("INSERT INTO books (title, cover_url) VALUES ('mig gif', $1) RETURNING id", [gif]);
  const { rows: [ann] } = await pool.query("INSERT INTO announcements (title, body, image_url) VALUES ('mig ann', 'b', $1) RETURNING id", [dataUri("image/png", png)]);
  const { rows: [ch] } = await pool.query("INSERT INTO charities (name, image_url) VALUES ('mig charity', $1) RETURNING id", [dataUri("image/jpeg", shared)]);
  const { rows: [post] } = await pool.query("INSERT INTO blog_posts (slug, title, body, image_url) VALUES ('mig-post', 'mig post', 'b', $1) RETURNING id", [dataUri("image/jpeg", shared)]);

  await pool.query(migrationSql);

  const col = async (table, column, id) => (await pool.query(`SELECT ${column} AS v FROM ${table} WHERE id = $1`, [id])).rows[0].v;
  assert.equal(await col("books", "cover_url", book.id), `/img/${sha(jpeg)}.jpg`);
  assert.equal(await col("announcements", "image_url", ann.id), `/img/${sha(png)}.png`);
  assert.equal(await col("charities", "image_url", ch.id), `/img/${sha(shared)}.jpg`);
  assert.equal(await col("blog_posts", "image_url", post.id), `/img/${sha(shared)}.jpg`);

  // Untouched: remote URLs, NULL, malformed and unsupported types.
  assert.equal(await col("books", "cover_url", bookOpen.id), open);
  assert.equal(await col("books", "cover_url", bookNull.id), null);
  assert.equal(await col("books", "cover_url", bookBogus.id), bogus);
  assert.equal(await col("books", "cover_url", bookGif.id), gif);

  // Bytes and content types round-trip exactly; the shared picture is stored once.
  for (const [buf, type] of [[jpeg, "image/jpeg"], [png, "image/png"], [shared, "image/jpeg"]]) {
    const { rows } = await pool.query("SELECT data, content_type, byte_size FROM images WHERE id = $1", [sha(buf)]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].data.equals(buf));
    assert.equal(rows[0].content_type, type);
    assert.equal(rows[0].byte_size, buf.length);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM images")).rows[0].n, 3);

  // Served through the real route, byte for byte.
  const res = await fetch(`${app.base}/img/${sha(png)}.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(png));

  // Running it again changes nothing.
  await pool.query(migrationSql);
  assert.equal(await col("books", "cover_url", book.id), `/img/${sha(jpeg)}.jpg`);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM images")).rows[0].n, 3);
});
