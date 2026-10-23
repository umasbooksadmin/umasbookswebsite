// Connection-pool settings read from the environment (src/db.js).
//
// DB_POOL_MAX: most connections ONE app instance may hold open. Render's
// Postgres allows 100 connections on a database with under 8 GB of RAM
// (docs/runbook.md, "Database connections"), and a deploy briefly runs two
// instances side by side, so the default of 20 uses 40 of them.
// An invalid value (not a whole number, outside 2-50) is ignored with a
// warning rather than crashing the boot: a typo in the dashboard must not
// take the site down.
// The rule (default 20, whole number 2 to 50) is the DB_POOL_MAX entry of configRegistry.js.
const config = require("./config");

const { default: DEFAULT_POOL_MAX, min: MIN_POOL_MAX, max: MAX_POOL_MAX } = config.specFor("DB_POOL_MAX");

// { value, warning? } for the environment (default process.env).
function resolvePoolMax(env = process.env) {
  const r = config.read("DB_POOL_MAX", env);
  return r.state === "invalid" ? { value: r.value, warning: r.message } : { value: r.value };
}

// The same for a raw value (kept for callers and tests that hold only the string).
const parsePoolMax = (raw) => resolvePoolMax({ DB_POOL_MAX: raw });

module.exports = { parsePoolMax, resolvePoolMax, DEFAULT_POOL_MAX, MIN_POOL_MAX, MAX_POOL_MAX };
