// Garbage collection for the `images` table (migrations/034_image_store.sql).
// Replacing a cover or deleting a record leaves the old bytes behind, because
// other tables only hold the URL string '/img/<sha256>.jpg'. An image is
// "unused" when its id (the hash) appears in none of the columns below.
//
// IMAGE_REFERENCES is the ONE list of text columns that can hold an image
// URL. It covers the columns saveImage() results are written to
// (*.cover_url / *.image_url) AND the free-text columns where a URL could be
// pasted or embedded (rich-text bodies, excerpts, descriptions). The match is
// a substring search for the 64-hex hash, so '<img src="/img/<hash>.jpg">'
// inside HTML counts too. test/integration/imageCleanup.test.js fails when a
// new image-bearing column exists that is not listed here - when you add a
// table or column that stores an /img/ URL, add it below.
//
// Safety: a new upload sits in `images` before the admin form saves the row
// that points at it, so only images older than minAgeDays are ever removed.
// saveImage() refreshes created_at when identical bytes are uploaded again,
// so re-uploading an old, currently unused picture also restarts its clock.

const IMAGE_REFERENCES = [
  { table: "books", column: "cover_url" },
  { table: "books", column: "description" },
  { table: "books", column: "description_fr" },
  { table: "announcements", column: "image_url" },
  { table: "announcements", column: "body" },
  { table: "announcements", column: "excerpt" },
  { table: "blog_posts", column: "image_url" },
  { table: "blog_posts", column: "body" },
  { table: "blog_posts", column: "excerpt" },
  { table: "charities", column: "image_url" },
  { table: "charities", column: "description" },
  { table: "curated_collections", column: "icon_path" },
  { table: "curated_collections", column: "banner_path" },
];

const { cachedFor } = require("./runLimited");

const DEFAULT_MIN_AGE_DAYS = 7;
const BATCH_LIMIT = 500;

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

// The ids of every image some row refers to, as one set (UNION of one scan per
// referencing column). Each column is scanned ONCE with regexp_matches, which
// pulls out every maximal run of 64 or more lowercase hex characters, and
// substr() slices every 64-character window out of the run (one for a normal
// id; more only for a longer run), so any id that strpos(col, id) > 0 would
// have found is found here too. Identifiers come from the constant above
// (validated anyway).
const HASH_PATTERN = "[0-9a-f]{64,}";

function referencedIdsSql() {
  return IMAGE_REFERENCES.map(({ table, column }) => {
    if (!IDENT_RE.test(table) || !IDENT_RE.test(column)) throw new Error(`Bad IMAGE_REFERENCES entry ${table}.${column}`);
    return `SELECT substr(m[1], k, 64) AS id FROM ${table}, regexp_matches(${table}.${column}, '(${HASH_PATTERN})', 'g') AS m, generate_series(1, length(m[1]) - 63) AS k`;
  }).join("\n        UNION\n        ");
}

// "alias.id is referenced by no row". LINEAR: the set above is built once and
// hash-anti-joined to the images (the earlier form, one correlated
// strpos() NOT EXISTS per image per column, was images x rows: ~1.7 ms per
// image at 30k books, past the 30 s statement timeout around 20k images).
function notReferencedSql(alias = "i") {
  return `NOT EXISTS (SELECT 1 FROM (\n        ${referencedIdsSql()}\n      ) refs WHERE refs.id = ${alias}.id)`;
}

function ageDays(minAgeDays) {
  const n = Number(minAgeDays);
  if (!Number.isFinite(n) || n < 0) throw new Error("minAgeDays must be a non-negative number");
  return n;
}

// Unused images at least minAgeDays old, oldest first, at most `limit`.
// -> [{ id, byte_size, created_at }]
async function findUnusedImages(pool, { minAgeDays = 0, limit = BATCH_LIMIT } = {}) {
  const { rows } = await pool.query(
    `SELECT i.id, i.byte_size, i.created_at
       FROM images i
      WHERE i.created_at < now() - make_interval(secs => $1 * 86400)
        AND ${notReferencedSql("i")}
      ORDER BY i.created_at, i.id
      LIMIT $2`,
    [ageDays(minAgeDays), limit]
  );
  return rows;
}

// Number of unused images old enough to be purged (the admin dashboard line).
// timeoutMs (optional) bounds the query with a transaction-local
// statement_timeout on its own connection, which is released either way; on
// timeout the error (code 57014) propagates.
async function countUnusedImages(pool, { minAgeDays = DEFAULT_MIN_AGE_DAYS, timeoutMs = 0 } = {}) {
  const sql = `SELECT COUNT(*)::int AS n
       FROM images i
      WHERE i.created_at < now() - make_interval(secs => $1 * 86400)
        AND ${notReferencedSql("i")}`;
  const params = [ageDays(minAgeDays)];
  if (!(timeoutMs > 0)) return (await pool.query(sql, params)).rows[0].n;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    const { rows } = await client.query(sql, params);
    await client.query("COMMIT");
    return rows[0].n;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The dashboard's version: never waits longer than timeoutMs, computed at most
// once per ttlMs per process, and on a timeout/failure shows the last good
// value (null before there is one; the page prints "n/a").
function makeDashboardUnusedCount(pool, { ttlMs = 10 * 60 * 1000, timeoutMs = 3000, clock = Date.now } = {}) {
  let last = null;
  return cachedFor(
    () => countUnusedImages(pool, { timeoutMs }).then((n) => (last = n), () => last),
    ttlMs,
    clock
  );
}

// Deletes up to BATCH_LIMIT unused images older than minAgeDays in a single
// statement (the reference check and the delete see the same snapshot).
// dryRun only reports what would go. Counts only, never ids, in the result.
// -> { candidates, deleted, bytes, dryRun }
async function purgeUnusedImages(pool, { minAgeDays = DEFAULT_MIN_AGE_DAYS, dryRun = false } = {}) {
  const days = ageDays(minAgeDays);
  if (dryRun) {
    const rows = await findUnusedImages(pool, { minAgeDays: days });
    return { candidates: rows.length, deleted: 0, bytes: rows.reduce((s, r) => s + r.byte_size, 0), dryRun: true };
  }
  const { rows } = await pool.query(
    `DELETE FROM images
      WHERE id IN (
        SELECT i.id FROM images i
         WHERE i.created_at < now() - make_interval(secs => $1 * 86400)
           AND ${notReferencedSql("i")}
         ORDER BY i.created_at, i.id
         LIMIT $2)
      RETURNING byte_size`,
    [days, BATCH_LIMIT]
  );
  return { candidates: rows.length, deleted: rows.length, bytes: rows.reduce((s, r) => s + r.byte_size, 0), dryRun: false };
}

module.exports = { IMAGE_REFERENCES, notReferencedSql, referencedIdsSql, makeDashboardUnusedCount, BATCH_LIMIT, DEFAULT_MIN_AGE_DAYS, findUnusedImages, countUnusedImages, purgeUnusedImages };
