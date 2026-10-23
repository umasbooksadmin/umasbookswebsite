// Awards and best-seller lists for a book: runs the lookups in order of
// trust (Wikidata, then the NYT API if a key is set), stores what they find in book_awards, and records when and
// how the check went on the book. Safe to run again at any time.
//
// Customers see only 'verified' rows (display.js): Wikidata, the NYT API, or
// typed in by an admin. There is no review step and no AI source.
//
// Nothing here throws to the caller: a lookup problem becomes state 'error'
// and is retried a day later by the background job (drainAwards).
//
// Kill switch: AWARDS_LOOKUPS=off stops every lookup (used by the test suite
// so no test can reach the network).

const { lookupWikidataAwards } = require("./wikidata");
const config = require("../config");
const { lookupNytAwards } = require("./nyt");

const ON_CONFLICT = "ON CONFLICT (book_id, lower(label), (COALESCE(year, 0)))";

function lookupsDisabled(env = process.env) {
  return !config.get("AWARDS_LOOKUPS", env);
}

// Inserts the items one by one. Returns how many rows were added.
async function storeItems(pool, bookId, items, source) {
  let n = 0;
  for (const it of items) {
    const { rowCount } = await pool.query(
      `INSERT INTO book_awards (book_id, label, year, kind, source, source_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'verified') ${ON_CONFLICT} DO NOTHING`,
      [bookId, it.label, it.year, it.kind, source, it.source_url]
    );
    n += rowCount;
  }
  return n;
}

// deps (all optional, for tests): fetch, env, now, gapMs, sleep, timeoutMs,
// sources (default both), and wikidata / nyt replacement functions.
async function checkBookAwards(pool, bookId, deps = {}) {
  const env = deps.env || process.env;
  try {
    if (lookupsDisabled(env)) return { state: null, disabled: true, added: 0 };
    const { rows } = await pool.query("SELECT id, isbn, title, authors, published_year FROM books WHERE id = $1", [bookId]);
    const book = rows[0];
    if (!book) return { state: null, missing: true, added: 0 };

    const sources = deps.sources || ["wikidata", "nyt"];
    const common = { fetch: deps.fetch, timeoutMs: deps.timeoutMs };

    let anyError = false;
    let found = 0;
    let added = 0;

    const run = async (name, fn) => {
      const res = (await fn()) || { items: [] };
      if (res.error) anyError = true;
      if (res.items && res.items.length) {
        found += res.items.length;
        added += await storeItems(pool, bookId, res.items, name);
      }
      return res;
    };

    if (sources.includes("wikidata")) {
      await run("wikidata", () => (deps.wikidata || lookupWikidataAwards)(book, { ...common, gapMs: deps.gapMs, sleep: deps.sleep }));
    }
    if (sources.includes("nyt")) {
      await run("nyt", () => (deps.nyt || lookupNytAwards)(book, { ...common, apiKey: config.get("NYT_API_KEY", env), now: deps.now }));
    }
    const state = anyError ? "error" : found > 0 ? "ok" : "none";
    await pool.query("UPDATE books SET awards_checked_at = now(), awards_check_state = $2 WHERE id = $1", [bookId, state]);
    return { state, added, found };
  } catch (err) {
    console.error(`Awards check for book ${bookId} failed:`, err.message);
    return { state: "error", added: 0, failed: true };
  }
}

// Fire-and-forget: used right after a book is saved. Never delays or fails
// the save; the returned promise (never rejects) is only for tests.
function checkBookAwardsInBackground(pool, bookId, deps = {}) {
  if (lookupsDisabled(deps.env || process.env)) return Promise.resolve(null);
  return Promise.resolve()
    .then(() => checkBookAwards(pool, bookId, deps))
    .catch((err) => { console.error("Background awards check failed:", err.message); return null; });
}

// One tick of the background job: up to `batch` books, in this order:
//   1. never checked (newest first, so a fresh scan is first in line),
//   2. last check was an error, more than a day ago,
//   3. last checked over a year ago (low priority).
async function drainAwards(pool, deps = {}, { batch = 5 } = {}) {
  const env = deps.env || process.env;
  if (lookupsDisabled(env)) return { processed: 0 };
  let left = batch;
  let processed = 0;
  const take = async (sql) => {
    if (left <= 0) return;
    const { rows } = await pool.query(sql, [left]);
    for (const r of rows) {
      await checkBookAwards(pool, r.id, deps);
      processed += 1;
      left -= 1;
    }
  };
  await take("SELECT id FROM books WHERE awards_checked_at IS NULL ORDER BY id DESC LIMIT $1");
  await take(
    `SELECT id FROM books WHERE awards_check_state = 'error' AND awards_checked_at < now() - interval '1 day'
     ORDER BY awards_checked_at ASC LIMIT $1`
  );
  await take(
    `SELECT id FROM books WHERE awards_checked_at < now() - interval '365 days'
       AND awards_check_state IS DISTINCT FROM 'error'
     ORDER BY awards_checked_at ASC LIMIT $1`
  );
  return { processed };
}

module.exports = { checkBookAwards, checkBookAwardsInBackground, drainAwards, lookupsDisabled };
