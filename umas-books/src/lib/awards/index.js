// Awards and best-seller lists for a book: runs the lookups in order of
// trust (Wikidata, then the NYT API if a key is set, then AI web search if
// switched on), stores what they find in book_awards, and records when and
// how the check went on the book. Safe to run again at any time.
//
// Customers only ever see 'verified' and 'approved' rows (display.js).
// Wikidata, NYT and admin-typed rows are 'verified'; AI rows are 'pending'
// until an admin approves them.
//
// Nothing here throws to the caller: a lookup problem becomes state 'error'
// and is retried a day later by the background job (drainAwards).
//
// Kill switch: AWARDS_LOOKUPS=off stops every lookup (used by the test suite
// so no test can reach the network).

const { lookupWikidataAwards } = require("./wikidata");
const { lookupNytAwards } = require("./nyt");
const { lookupAiAwards, aiEnabled, aiUsage, noteAiCall } = require("./ai");

const ON_CONFLICT = "ON CONFLICT (book_id, lower(label), (COALESCE(year, 0)))";

function lookupsDisabled(env = process.env) {
  return /^(off|0|false)$/i.test(String(env.AWARDS_LOOKUPS || "").trim());
}

// Inserts the items one by one. Returns how many rows were added or upgraded.
async function storeItems(pool, bookId, items, source, existingLabels) {
  let n = 0;
  for (const it of items) {
    if (source === "ai") {
      // The same label already on the book (any year, any status, so a
      // rejected suggestion is never offered again) is not suggested again.
      if (existingLabels.has(it.label.toLowerCase())) continue;
      const { rowCount } = await pool.query(
        `INSERT INTO book_awards (book_id, label, year, kind, source, source_url, status)
         VALUES ($1, $2, $3, $4, 'ai', $5, 'pending') ${ON_CONFLICT} DO NOTHING`,
        [bookId, it.label, it.year, it.kind, it.source_url]
      );
      n += rowCount;
    } else {
      // A trusted source also upgrades an AI suggestion still waiting for review.
      const { rowCount } = await pool.query(
        `INSERT INTO book_awards (book_id, label, year, kind, source, source_url, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'verified') ${ON_CONFLICT}
         DO UPDATE SET source = EXCLUDED.source, kind = EXCLUDED.kind,
                       source_url = COALESCE(EXCLUDED.source_url, book_awards.source_url), status = 'verified'
         WHERE book_awards.status = 'pending'`,
        [bookId, it.label, it.year, it.kind, source, it.source_url]
      );
      n += rowCount;
    }
  }
  return n;
}

// deps (all optional, for tests): fetch, env, now, gapMs, sleep, timeoutMs,
// sources (default all three), and wikidata / nyt / ai replacement functions.
async function checkBookAwards(pool, bookId, deps = {}) {
  const env = deps.env || process.env;
  try {
    if (lookupsDisabled(env)) return { state: null, disabled: true, added: 0 };
    const { rows } = await pool.query("SELECT id, isbn, title, authors, published_year FROM books WHERE id = $1", [bookId]);
    const book = rows[0];
    if (!book) return { state: null, missing: true, added: 0 };

    const sources = deps.sources || ["wikidata", "nyt", "ai"];
    const aiOnly = sources.length === 1 && sources[0] === "ai";
    const common = { fetch: deps.fetch, timeoutMs: deps.timeoutMs };
    const { rows: existing } = await pool.query("SELECT label FROM book_awards WHERE book_id = $1", [bookId]);
    const existingLabels = new Set(existing.map((r) => r.label.toLowerCase()));

    let anyError = false;
    let found = 0;
    let added = 0;
    let aiCalled = false;
    let aiCapped = false;

    const run = async (name, fn) => {
      const res = (await fn()) || { items: [] };
      if (res.error) anyError = true;
      if (res.items && res.items.length) {
        found += res.items.length;
        added += await storeItems(pool, bookId, res.items, name, existingLabels);
      }
      return res;
    };

    if (sources.includes("wikidata")) {
      await run("wikidata", () => (deps.wikidata || lookupWikidataAwards)(book, { ...common, gapMs: deps.gapMs, sleep: deps.sleep }));
    }
    if (sources.includes("nyt")) {
      await run("nyt", () => (deps.nyt || lookupNytAwards)(book, { ...common, apiKey: env.NYT_API_KEY, now: deps.now }));
    }
    if (sources.includes("ai") && aiEnabled(env) && book.title && book.authors) {
      const usage = await aiUsage(pool, { env, now: deps.now });
      if (usage.remaining <= 0) {
        aiCapped = true;
      } else {
        noteAiCall(deps.now);
        aiCalled = true;
        await run("ai", () => (deps.ai || lookupAiAwards)(book, { ...common, env }));
      }
    }

    const state = anyError ? "error" : found > 0 ? "ok" : "none";
    if (aiOnly && !anyError) {
      // Only the AI step ran (back-fill): keep the earlier state and date.
      await pool.query(
        "UPDATE books SET awards_ai_checked_at = CASE WHEN $2 THEN now() ELSE awards_ai_checked_at END WHERE id = $1",
        [bookId, aiCalled]
      );
    } else {
      await pool.query(
        `UPDATE books SET awards_checked_at = now(), awards_check_state = $2,
                awards_ai_checked_at = CASE WHEN $3 THEN now() ELSE awards_ai_checked_at END
         WHERE id = $1`,
        [bookId, state, aiCalled]
      );
    }
    return { state, added, found, aiCalled, aiCapped };
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
//   3. checked before AI was available (or the daily cap was hit): AI only,
//   4. last checked over a year ago (low priority).
async function drainAwards(pool, deps = {}, { batch = 5 } = {}) {
  const env = deps.env || process.env;
  if (lookupsDisabled(env)) return { processed: 0 };
  let left = batch;
  let processed = 0;
  const take = async (sql, extraDeps, cap = Infinity) => {
    const limit = Math.min(left, cap);
    if (limit <= 0) return;
    const { rows } = await pool.query(sql, [limit]);
    for (const r of rows) {
      await checkBookAwards(pool, r.id, { ...deps, ...extraDeps });
      processed += 1;
      left -= 1;
    }
  };
  await take("SELECT id FROM books WHERE awards_checked_at IS NULL ORDER BY id DESC LIMIT $1");
  await take(
    `SELECT id FROM books WHERE awards_check_state = 'error' AND awards_checked_at < now() - interval '1 day'
     ORDER BY awards_checked_at ASC LIMIT $1`
  );
  if (aiEnabled(env) && left > 0) {
    const usage = await aiUsage(pool, { env, now: deps.now });
    await take(
      `SELECT id FROM books
       WHERE awards_ai_checked_at IS NULL AND awards_checked_at IS NOT NULL
         AND awards_check_state IS DISTINCT FROM 'error'
         AND COALESCE(title, '') <> '' AND COALESCE(authors, '') <> ''
       ORDER BY id DESC LIMIT $1`,
      { sources: ["ai"] }, usage.remaining
    );
  }
  await take(
    `SELECT id FROM books WHERE awards_checked_at < now() - interval '365 days'
       AND awards_check_state IS DISTINCT FROM 'error'
     ORDER BY awards_checked_at ASC LIMIT $1`
  );
  return { processed };
}

module.exports = { checkBookAwards, checkBookAwardsInBackground, drainAwards, lookupsDisabled };
