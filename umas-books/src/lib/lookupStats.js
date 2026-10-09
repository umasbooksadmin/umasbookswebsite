// Counts of how often each ISBN catalog was used (report /admin/reports/lookup-sources).
//
// COUNTS ONLY: never an ISBN, a title or a user. record(source, { asked: 1, won: 1, ms: 120 }) adds to an
// in-memory total for (Paris day, source); flush() writes the totals to lookup_source_stats with
// upsert increments, about every 30 s (start()) and at shutdown (stop()). The scan path never waits on the
// database: record() is synchronous and never throws, and a failed flush is swallowed (logged once, the
// counts are kept for the next try, up to a cap).
//
// Counters: asked (calls made), won (supplied the title that was used), filled (only filled missing fields),
// redundant (had a book but nothing new), empty (found nothing), errors (errors and timeouts), limited
// (refused: HTTP 429/401/403), cancelled (still running when the answer was given), paid_calls (ISBNdb requests
// really sent), ms (response time: ms_sum / ms_n).

const { SITE_TIME_ZONE } = require("./tz");

const SOURCES = ["openlibrary", "bnf", "google", "openlibrary-data", "isbndb", "lookup", "cache", "none"];
const COUNTERS = ["asked", "won", "filled", "redundant", "empty", "errors", "limited", "cancelled", "paid_calls", "ms_sum", "ms_n"];
const MAX_KEYS = 500;
const RETENTION_MONTHS = 36;

const parisDay = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: SITE_TIME_ZONE });

function createLookupStats({ getPool = () => require("../db").pool, flushMs = 30 * 1000, now = Date.now, log = (m) => console.warn(m) } = {}) {
  let totals = new Map(); // "day|source" -> { day, source, ...counters }
  let timer = null;
  let flushing = null;
  let warned = false;

  const add = (target, day, source, delta) => {
    const key = `${day}|${source}`;
    let row = target.get(key);
    if (!row) {
      row = { day, source };
      for (const c of COUNTERS) row[c] = 0;
      target.set(key, row);
    }
    for (const c of COUNTERS) if (delta[c]) row[c] += delta[c];
  };

  // delta may carry `ms` (one response time: counted into ms_sum / ms_n).
  function record(source, delta = {}) {
    try {
      if (!SOURCES.includes(source)) return;
      const d = { ...delta };
      if (Number.isFinite(d.ms) && d.ms >= 0) { d.ms_sum = Math.round(d.ms); d.ms_n = 1; }
      add(totals, parisDay(now()), source, d);
    } catch { /* never in the way of a lookup */ }
  }

  async function writeRows(rows) {
    const col = (c) => rows.map((r) => r[c]);
    const sets = COUNTERS.map((c) => `${c} = lookup_source_stats.${c} + EXCLUDED.${c}`).join(", ");
    await getPool().query(
      `INSERT INTO lookup_source_stats (day, source, ${COUNTERS.join(", ")})
       SELECT * FROM unnest($1::date[], $2::text[], ${COUNTERS.map((c, i) => `$${i + 3}::${c === "ms_sum" ? "bigint" : "int"}[]`).join(", ")})
       ON CONFLICT (day, source) DO UPDATE SET ${sets}`,
      [col("day"), col("source"), ...COUNTERS.map(col)]
    );
  }

  // Writes what is in memory. Resolves { rows } and never rejects.
  function flush() {
    if (flushing) return flushing;
    if (!totals.size) return Promise.resolve({ rows: 0 });
    const batch = totals;
    totals = new Map();
    flushing = (async () => {
      try {
        const rows = [...batch.values()];
        await writeRows(rows);
        warned = false;
        return { rows: rows.length };
      } catch (err) {
        // keep the counts for the next try (bounded), log once until a flush works again
        for (const row of batch.values()) if (totals.size < MAX_KEYS || totals.has(`${row.day}|${row.source}`)) add(totals, row.day, row.source, row);
        if (!warned) {
          warned = true;
          try { log(`Lookup statistics: could not be saved (${String((err && err.message) || err).slice(0, 120)}); will retry. Lookups are not affected.`); } catch { /* ignore */ }
        }
        return { rows: 0, failed: true };
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { flush(); }, flushMs);
    if (timer.unref) timer.unref();
  }
  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (flushing) await flushing;
    return flush();
  }

  return { record, flush, start, stop, pending: () => totals.size, snapshot: () => [...totals.values()].map((r) => ({ ...r })) };
}

let current = null;
// The process-wide recorder (lazy, so requiring this file never touches the database).
const getStats = () => current || (current = createLookupStats());
// Tests inject a fake (or null to go back to the default).
const setStats = (s) => { current = s; };

// Daily rows older than RETENTION_MONTHS are deleted (run by a daily job in index.js).
async function pruneLookupStats(pool) {
  const { rowCount } = await pool.query("DELETE FROM lookup_source_stats WHERE day < ((now() AT TIME ZONE $1)::date - make_interval(months => $2))", [SITE_TIME_ZONE, RETENTION_MONTHS]);
  return rowCount;
}

module.exports = { createLookupStats, getStats, setStats, pruneLookupStats, SOURCES, COUNTERS, RETENTION_MONTHS, parisDay };
