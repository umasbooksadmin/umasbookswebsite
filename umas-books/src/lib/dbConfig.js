// Connection-pool settings read from the environment (src/db.js).
//
// DB_POOL_MAX: most connections ONE app instance may hold open. Render's
// Postgres allows 100 connections on a database with under 8 GB of RAM
// (docs/runbook.md, "Database connections"), and a deploy briefly runs two
// instances side by side, so the default of 20 uses 40 of them.
// An invalid value (not a whole number, outside 2-50) is ignored with a
// warning rather than crashing the boot: a typo in the dashboard must not
// take the site down.
const DEFAULT_POOL_MAX = 20;
const MIN_POOL_MAX = 2;
const MAX_POOL_MAX = 50;

function parsePoolMax(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { value: DEFAULT_POOL_MAX };
  const text = String(raw).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(n) || n < MIN_POOL_MAX || n > MAX_POOL_MAX) {
    return {
      value: DEFAULT_POOL_MAX,
      warning: `DB_POOL_MAX="${text}" is not a whole number from ${MIN_POOL_MAX} to ${MAX_POOL_MAX}; using ${DEFAULT_POOL_MAX}.`,
    };
  }
  return { value: n };
}

module.exports = { parsePoolMax, DEFAULT_POOL_MAX, MIN_POOL_MAX, MAX_POOL_MAX };
