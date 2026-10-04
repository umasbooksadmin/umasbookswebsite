// New York Times best-seller history for one ISBN (Books API v3). Optional:
// only runs when NYT_API_KEY is set. The key goes in the query string (the
// API's only option) and is never logged: errors are scrubbed first.
//
// The API allows 5 requests/minute and 500/day; a tiny in-process gate keeps
// us under both. A refused call counts as an error, so the book is simply
// re-checked later. Fails open: never throws. Returns { items, error, skipped }.

const { isbnVariants } = require("../inventory");
const { requestJson, scrub } = require("./http");

const ENDPOINT = "https://api.nytimes.com/svc/books/v3/lists/best-sellers/history.json";
const PER_MINUTE = 5;
const PER_DAY = 500;

// Timestamps (ms) of recent requests; kept in memory, resets on restart.
const gate = { recent: [], day: "", dayCount: 0 };

function tryAcquire(now = Date.now()) {
  gate.recent = gate.recent.filter((t) => now - t < 60 * 1000);
  const today = new Date(now).toISOString().slice(0, 10);
  if (gate.day !== today) { gate.day = today; gate.dayCount = 0; }
  if (gate.recent.length >= PER_MINUTE || gate.dayCount >= PER_DAY) return false;
  gate.recent.push(now);
  gate.dayCount += 1;
  return true;
}

function resetGate() {
  gate.recent = [];
  gate.day = "";
  gate.dayCount = 0;
}

function isbn13Of(isbn) {
  const raw = String(isbn || "").toUpperCase().replace(/[^0-9X]/g, "");
  return isbnVariants(raw).find((v) => /^\d{13}$/.test(v)) || null;
}

// ranks_history -> one item per list + year.
function mapHistory(json) {
  const results = json && Array.isArray(json.results) ? json.results : [];
  const seen = new Map();
  for (const book of results) {
    const ranks = Array.isArray(book && book.ranks_history) ? book.ranks_history : [];
    for (const r of ranks) {
      const list = String((r && (r.list_name || r.display_name)) || "").trim().slice(0, 120);
      if (!list) continue;
      const y = parseInt(String(r.published_date || "").slice(0, 4), 10);
      const year = Number.isInteger(y) && y >= 1930 && y <= 2200 ? y : null;
      const label = `New York Times Best Seller (${list})`;
      const key = `${label.toLowerCase()}|${year || 0}`;
      if (!seen.has(key)) seen.set(key, { label, year, kind: "bestseller", source_url: "https://www.nytimes.com/books/best-sellers/" });
    }
  }
  return [...seen.values()].slice(0, 15);
}

async function lookupNytAwards({ isbn } = {}, { fetch: fetchFn, apiKey = process.env.NYT_API_KEY, now, timeoutMs } = {}) {
  if (!apiKey) return { items: [], error: false, skipped: true };
  try {
    const isbn13 = isbn13Of(isbn);
    if (!isbn13) return { items: [], error: false, skipped: true };
    if (!tryAcquire(now)) {
      console.warn("Awards: NYT lookup deferred (rate limit).");
      return { items: [], error: true };
    }
    const url = `${ENDPOINT}?isbn=${isbn13}&api-key=${encodeURIComponent(apiKey)}`;
    const res = await requestJson(url, { fetch: fetchFn, timeoutMs, secrets: [apiKey, encodeURIComponent(apiKey)] });
    if (!res.ok) {
      console.warn("Awards: NYT lookup failed:", scrub(res.error, [apiKey]));
      return { items: [], error: true };
    }
    return { items: mapHistory(res.json), error: false };
  } catch (err) {
    console.warn("Awards: NYT lookup failed:", scrub(err.message, [apiKey]));
    return { items: [], error: true };
  }
}

module.exports = { lookupNytAwards, mapHistory, tryAcquire, resetGate, isbn13Of };
