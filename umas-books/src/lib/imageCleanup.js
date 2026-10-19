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

const DEFAULT_MIN_AGE_DAYS = 7;
const BATCH_LIMIT = 500;

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

// One NOT EXISTS per referencing column. Identifiers come from the constant
// above (validated anyway); the hash is matched with strpos, no LIKE escapes.
function notReferencedSql(alias = "i") {
  return IMAGE_REFERENCES.map(({ table, column }) => {
    if (!IDENT_RE.test(table) || !IDENT_RE.test(column)) throw new Error(`Bad IMAGE_REFERENCES entry ${table}.${column}`);
    return `NOT EXISTS (SELECT 1 FROM ${table} r WHERE strpos(r.${column}, ${alias}.id) > 0)`;
  }).join("\n        AND ");
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
async function countUnusedImages(pool, { minAgeDays = DEFAULT_MIN_AGE_DAYS } = {}) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM images i
      WHERE i.created_at < now() - make_interval(secs => $1 * 86400)
        AND ${notReferencedSql("i")}`,
    [ageDays(minAgeDays)]
  );
  return rows[0].n;
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

module.exports = { IMAGE_REFERENCES, notReferencedSql, BATCH_LIMIT, DEFAULT_MIN_AGE_DAYS, findUnusedImages, countUnusedImages, purgeUnusedImages };
