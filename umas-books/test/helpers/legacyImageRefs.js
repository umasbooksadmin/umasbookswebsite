// The ORIGINAL (quadratic) "image is unreferenced" predicate from
// src/lib/imageCleanup.js, kept only as a test oracle and benchmark baseline:
// one correlated strpos() NOT EXISTS per referencing column per image.
const { IMAGE_REFERENCES } = require("../../src/lib/imageCleanup");

function legacyNotReferencedSql(alias = "i") {
  return IMAGE_REFERENCES.map(({ table, column }) =>
    `NOT EXISTS (SELECT 1 FROM ${table} r WHERE strpos(r.${column}, ${alias}.id) > 0)`
  ).join("\n        AND ");
}

function legacyUnusedIdsSql() {
  return `SELECT i.id FROM images i
      WHERE i.created_at < now() - make_interval(secs => $1 * 86400)
        AND ${legacyNotReferencedSql("i")}
      ORDER BY i.id`;
}

module.exports = { legacyNotReferencedSql, legacyUnusedIdsSql };
