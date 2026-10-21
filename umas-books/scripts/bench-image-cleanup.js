// Benchmark for the unused-image query (src/lib/imageCleanup.js).
// Seeds N books + M images into a THROWAWAY database and times the linear
// query against the original quadratic one (test/helpers/legacyImageRefs.js).
//
//   createdb imgclean_bench && DATABASE_URL=postgres:///imgclean_bench PGSSLMODE=disable npm run migrate
//   DATABASE_URL=postgres:///imgclean_bench PGSSLMODE=disable node scripts/bench-image-cleanup.js [books=30000] [images=32000] [--skip-old]
//
// Refuses to run unless the database name contains "bench" or "scratch" or "test".
const { Pool } = require("pg");
const { IMAGE_REFERENCES, notReferencedSql } = require("../src/lib/imageCleanup");
const { legacyNotReferencedSql } = require("../test/helpers/legacyImageRefs");

const args = process.argv.slice(2);
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const books = nums[0] || 30000;
const images = nums[1] || 32000;
const skipOld = args.includes("--skip-old");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !/bench|scratch|test/i.test(new URL(url).pathname)) throw new Error("Set DATABASE_URL to a throwaway database whose name contains bench, scratch or test.");
  const pool = new Pool({ connectionString: url, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 1 });
  await pool.query("DELETE FROM books; DELETE FROM images");
  const h = (i) => `encode(sha256(('img-' || ${i})::text::bytea), 'hex')`;
  // Image g is 'old' (40 days). Books reference images 1..books (cover); the rest are unreferenced.
  await pool.query(`INSERT INTO images (id, content_type, data, byte_size, created_at)
      SELECT ${h("g")}, 'image/jpeg', '\\x00'::bytea, 1, now() - interval '40 days' FROM generate_series(1, $1) g`, [images]);
  await pool.query(`INSERT INTO books (title, authors, isbn, cover_url, description)
      SELECT 'Bench ' || g, 'A', '978' || lpad(g::text, 10, '0'), '/img/' || ${h("g")} || '.jpg',
             repeat('Lorem ipsum dolor sit amet, a description of roughly one thousand characters. ', 14)
        FROM generate_series(1, $1) g`, [books]);
  await pool.query("ANALYZE books; ANALYZE images");
  const expected = Math.max(0, images - books);

  const time = async (label, sql, timeoutMs) => {
    const c = await pool.connect();
    try {
      await c.query(`SET statement_timeout = ${timeoutMs}`);
      const t = process.hrtime.bigint();
      let n;
      try { n = (await c.query(sql)).rows[0].n; } catch (e) { n = `ERROR ${e.message}`; }
      console.log(`${label}: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(0)} ms, unused = ${n}`);
    } finally { c.release(); }
  };
  console.log(`books=${books} images=${images} references=${IMAGE_REFERENCES.length} columns, expected unused=${expected}`);
  const q = (pred) => `SELECT COUNT(*)::int AS n FROM images i WHERE i.created_at < now() - interval '7 days' AND ${pred}`;
  await time("new (linear)", q(notReferencedSql("i")), 30000);
  await time("new (linear), 2nd run", q(notReferencedSql("i")), 30000);
  if (!skipOld) await time("old (quadratic, 120 s limit)", q(legacyNotReferencedSql("i")), 120000);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
