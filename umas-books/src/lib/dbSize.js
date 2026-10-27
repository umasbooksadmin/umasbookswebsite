// Database size monitoring. Covers and photos live in the `images` table (<= 400 KB each), so the
// database is the thing that fills up on a small Render plan. This module:
//   - reads the sizes (whole database, the images table, its row count, the 5 biggest tables);
//   - judges them against DB_PLAN_STORAGE_MB (0 = unknown: sizes only, no warning);
//   - keeps a weekly snapshot (table db_size_snapshots, last 120 rows) for the "growth" line;
//   - warns: the dashboard's "Needs attention" line (from 70%) and ONE alert email per week at
//     70% and, separately, one per week at 90% (alert_flags keys below, so a restart or several
//     instances do not repeat it).
// Read-only except the snapshot rows and the alert flag. Admin page: /admin/diagnostics/database.
const config = require("./config");
const { claimAlertSlot, releaseAlertSlot } = require("./alertFlags");
const { looseBaseUrl } = require("./baseUrl");

const MB = 1024 * 1024;
const WARN_PERCENT = 70;
const CRITICAL_PERCENT = 90;
const KEEP_SNAPSHOTS = 120;
const ALERT_EVERY_MINUTES = 7 * 24 * 60;
const FLAG_WARN = "db-size-warning";
const FLAG_CRITICAL = "db-size-critical";
const SNAPSHOT_MIN_AGE_DAYS = 6;

// -> { limitMb, known, percent, level }  level: "unknown" | "ok" | "warning" | "critical"
// Integer comparison on bytes, so 69.99% is never rounded up to a warning.
function assess(dbBytes, limitMb = config.get("DB_PLAN_STORAGE_MB")) {
  const limit = Number(limitMb) || 0;
  if (!(limit > 0)) return { limitMb: 0, known: false, percent: null, level: "unknown" };
  const limitBytes = limit * MB;
  const percent = Math.floor((Number(dbBytes) * 1000) / limitBytes) / 10;
  let level = "ok";
  if (Number(dbBytes) * 100 >= CRITICAL_PERCENT * limitBytes) level = "critical";
  else if (Number(dbBytes) * 100 >= WARN_PERCENT * limitBytes) level = "warning";
  return { limitMb: limit, known: true, percent, level };
}

const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
};

async function readSizes(db) {
  const [size, imgs, top, last] = await Promise.all([
    db.query("SELECT pg_database_size(current_database())::bigint AS db_bytes"),
    db.query("SELECT pg_total_relation_size('images')::bigint AS bytes, (SELECT count(*) FROM images)::int AS n"),
    db.query(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public'
        ORDER BY pg_total_relation_size(c.oid) DESC, c.relname LIMIT 5`
    ),
    db.query("SELECT taken_at, db_bytes::bigint AS db_bytes, images_bytes::bigint AS images_bytes FROM db_size_snapshots ORDER BY taken_at DESC, id DESC LIMIT 1"),
  ]);
  const dbBytes = Number(size.rows[0].db_bytes);
  const prev = last.rows[0] || null;
  return {
    dbBytes,
    imagesBytes: Number(imgs.rows[0].bytes),
    imageCount: imgs.rows[0].n,
    topTables: top.rows.map((r) => ({ name: r.name, bytes: Number(r.bytes) })),
    previous: prev && { takenAt: prev.taken_at, dbBytes: Number(prev.db_bytes), imagesBytes: Number(prev.images_bytes) },
    growthBytes: prev ? dbBytes - Number(prev.db_bytes) : null,
  };
}

// Stores a snapshot and keeps only the newest KEEP_SNAPSHOTS rows.
async function takeSnapshot(db, { keep = KEEP_SNAPSHOTS } = {}) {
  const { rows } = await db.query(
    `INSERT INTO db_size_snapshots (db_bytes, images_bytes)
     VALUES (pg_database_size(current_database()), pg_total_relation_size('images')) RETURNING id, db_bytes, images_bytes`
  );
  await db.query(
    "DELETE FROM db_size_snapshots WHERE id NOT IN (SELECT id FROM db_size_snapshots ORDER BY taken_at DESC, id DESC LIMIT $1)",
    [keep]
  );
  return rows[0];
}

function alertText(level, sizes, a, base = looseBaseUrl()) {
  const strong = level === "critical";
  return (
    (strong
      ? `The database is ${a.percent}% full (${fmtBytes(sizes.dbBytes)} of ${a.limitMb} MB). Act now: when it is full, saving anything stops.\n\n`
      : `The database has reached ${a.percent}% of its plan (${fmtBytes(sizes.dbBytes)} of ${a.limitMb} MB).\n\n`) +
    `The images table (covers and photos) is ${fmtBytes(sizes.imagesBytes)} in ${sizes.imageCount} image(s). Biggest tables: ` +
    `${sizes.topTables.map((t) => `${t.name} ${fmtBytes(t.bytes)}`).join(", ")}.\n\n` +
    "What to do:\n" +
    "  1. Render dashboard > the database `umas-books-db` > Info/Settings: upgrade the plan (more storage). This is the real fix; it takes a few minutes and keeps the data.\n" +
    "  2. Then, in Render > `umas-books` > Environment, update DB_PLAN_STORAGE_MB to the new limit in MB.\n" +
    "  3. Optional, to slow the growth: the daily image cleanup job removes unused images; see docs/runbook.md, \"Database size monitoring\".\n\n" +
    `Details: ${base}/admin/diagnostics/database\n` +
    (strong ? "You get this stronger warning at most once a week while the database stays above 90%.\n" : "You get this at most once a week while the database stays above 70%. A stronger warning follows at 90%.\n")
  );
}

// The weekly job. Snapshot (at most one per SNAPSHOT_MIN_AGE_DAYS: a restart-heavy host must not fill the table),
// then the warning. Returns what it did, for the log and the tests.
async function runDbSizeCheck(db, { send = (m) => require("./errorAlert").sendAdminAlert(m), limitMb, force = false } = {}) {
  let snapshot = null;
  const { rows: recent } = await db.query(
    "SELECT 1 FROM db_size_snapshots WHERE taken_at > now() - ($1 * interval '1 day') LIMIT 1",
    [SNAPSHOT_MIN_AGE_DAYS]
  );
  if (force || !recent.length) snapshot = await takeSnapshot(db);
  const sizes = await readSizes(db);
  const a = assess(sizes.dbBytes, limitMb);
  let alerted = null;
  if (a.level === "warning" || a.level === "critical") {
    const flag = a.level === "critical" ? FLAG_CRITICAL : FLAG_WARN;
    if (await claimAlertSlot(db, flag, ALERT_EVERY_MINUTES)) {
      const subject = a.level === "critical"
        ? `[umas-books] Database is ${a.percent}% full: upgrade the plan now`
        : `[umas-books] Database has reached ${a.percent}% of its plan`;
      const ok = await send({ subject, text: alertText(a.level, sizes, a) });
      if (ok) alerted = a.level;
      else await releaseAlertSlot(db, flag);
    }
  }
  return { snapshot: Boolean(snapshot), level: a.level, percent: a.percent, alerted };
}

// The "Needs attention" line for the dashboard (nothing below 70% or when the limit is unknown).
async function dbSizeAttention(db) {
  const { rows } = await db.query("SELECT pg_database_size(current_database())::bigint AS b");
  const a = assess(Number(rows[0].b));
  if (a.level !== "warning" && a.level !== "critical") return [];
  return [{
    href: "/admin/diagnostics/database",
    text: `The database is ${a.percent}% full (${fmtBytes(rows[0].b)} of ${a.limitMb} MB). ${a.level === "critical" ? "Upgrade the database plan in Render now." : "Plan an upgrade of the database in Render."}`,
  }];
}

module.exports = { assess, readSizes, takeSnapshot, runDbSizeCheck, dbSizeAttention, fmtBytes, WARN_PERCENT, CRITICAL_PERCENT, KEEP_SNAPSHOTS, FLAG_WARN, FLAG_CRITICAL, MB };
