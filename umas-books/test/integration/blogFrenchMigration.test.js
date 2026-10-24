// Migration 095: the three nullable French columns of blog_posts, and the French texts of the three starter posts
// (they come from the old assets/posts.js, written by the shop). The French is attached only to a row whose English text
// is still EXACTLY the original of migration 027 and that has no French yet; running it again changes nothing.
// Port 6533 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { startTestApp } = require("../helpers/testApp");

let app;
let pool;
before(async () => {
  app = await startTestApp({ port: 6533, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  app.stop();
});

const SQL = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "095_blog_french.sql"), "utf8");
const UPDATES = SQL.slice(SQL.indexOf("UPDATE blog_posts"));
const POSTS = (() => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "..", "..", "assets", "posts.js"), "utf8"), ctx);
  return ctx.window.UMAS_POSTS;
})();
const row = async (slug) => (await pool.query("SELECT * FROM blog_posts WHERE slug = $1", [slug])).rows[0];

test("the columns exist, are nullable text, and the three starter posts carry the shop's own French", async () => {
  const cols = (await pool.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'blog_posts' AND column_name IN ('title_fr','excerpt_fr','body_fr') ORDER BY 1")).rows;
  assert.deepEqual(cols.map((c) => [c.column_name, c.data_type, c.is_nullable]), [["body_fr", "text", "YES"], ["excerpt_fr", "text", "YES"], ["title_fr", "text", "YES"]]);
  assert.equal(POSTS.length, 3);
  for (const p of POSTS) {
    const r = await row(p.slug);
    assert.equal(r.title_fr, p.title.fr, p.slug);
    assert.equal(r.excerpt_fr, p.excerpt.fr, p.slug);
    assert.equal(r.body_fr, "<p>" + p.body.fr.join("</p><p>") + "</p>", p.slug);
  }
});

test("running the French update again changes nothing; a post whose English was edited, or that already has French, is left alone", async () => {
  const [a, b, c] = POSTS.map((p) => p.slug);
  await pool.query("UPDATE blog_posts SET title_fr = NULL, excerpt_fr = NULL, body_fr = NULL, title = 'Edited by the shop' WHERE slug = $1", [a]);
  await pool.query("UPDATE blog_posts SET title_fr = 'Déjà traduit' WHERE slug = $1", [b]);
  await pool.query("UPDATE blog_posts SET title_fr = NULL, excerpt_fr = NULL, body_fr = NULL WHERE slug = $1", [c]);
  await pool.query(UPDATES);
  const ra = await row(a);
  assert.deepEqual([ra.title_fr, ra.excerpt_fr, ra.body_fr], [null, null, null], "edited English: no French attached");
  assert.equal((await row(b)).title_fr, "Déjà traduit", "existing French is never overwritten");
  const rc = await row(c);
  assert.equal(rc.title_fr, POSTS[2].title.fr, "untouched English with no French: filled in again");
  await pool.query(UPDATES);
  assert.equal((await row(c)).title_fr, POSTS[2].title.fr);
});
