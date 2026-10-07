// Awards from Wikidata (free, structured, community-maintained). Looks the
// book up by ISBN (P212 ISBN-13 / P957 ISBN-10) in every written form
// Wikidata uses (it stores them mostly HYPHENATED, e.g. 978-1-4000-3341-6),
// then reads P166 "award received" (qualifier P585 = year) and P1411
// "nominated for" (kind 'shortlist') from the edition item itself and from
// the work(s) it is an edition of (P629). Only awards of THOSE items are
// returned. Only English (or language-neutral 'mul') labels are used;
// anything else is skipped rather than shown as a bare Q-number.
//
// Separate, flagged addition (a second, independent request): the Nobel Prize
// in Literature (Q37922) held by the work's author (P50) is returned as
// "Author: Nobel Prize in Literature". Limited to that one prize on purpose;
// other author awards are noisy. If that request fails the rest still counts.
//
// Fails open: never throws. Returns { items, error, skipped, suspicious }.
// A timeout or HTTP failure is an ERROR (retried later), never "no awards".
// Coverage is patchy: no result means "Wikidata does not know", not "no awards".

const isbn3 = require("isbn3");
const { isbnVariants } = require("../inventory");
const { requestJson } = require("./http");

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "UmasBooks/1.0 (admin@umasbooks.org)";
const MAX_PER_BOOK = 15;
const MAX_PLAUSIBLE = 25; // more distinct awards than this = a broken query/data, discard
const GAP_MS = 1200; // be polite: at least this long between two requests
const TIMEOUT_MS = 25000; // the live API often needs 10-20 s
const RETRIES = 2; // extra attempts after a timeout / 429 / 5xx
const BACKOFF_MS = [2000, 6000];
const AUTHOR_NOBEL = "Author: Nobel Prize in Literature";
const NOBEL_LIT = "Q37922";

const ISBN13 = /^\d{13}$/;
const ISBN10 = /^\d{9}[\dX]$/;

// Only digits (and a final X) survive; anything else is dropped, so nothing
// the caller passes can ever break out of the SPARQL string literal.
// Returns the plain forms plus every hyphenated form, ISBN-13 and ISBN-10.
function cleanIsbns(isbn) {
  const raw = String(isbn || "").toUpperCase().replace(/[^0-9X]/g, "");
  const found = { isbn13: null, isbn10: null, isbn13h: null, isbn10h: null };
  for (const v of isbnVariants(raw)) {
    if (ISBN13.test(v)) found.isbn13 = v;
    else if (ISBN10.test(v)) found.isbn10 = v;
  }
  for (const v of [found.isbn13, found.isbn10]) {
    if (!v) continue;
    let parsed;
    try { parsed = isbn3.parse(v); } catch { continue; }
    if (!parsed || !parsed.isValid) continue;
    if (parsed.isbn13h && ISBN13.test(parsed.isbn13h.replace(/-/g, ""))) found.isbn13h = found.isbn13h || parsed.isbn13h;
    if (parsed.isbn10h && ISBN10.test(parsed.isbn10h.replace(/-/g, ""))) found.isbn10h = found.isbn10h || parsed.isbn10h;
  }
  return found;
}

const HYPHENATED = /^[0-9X-]+$/;

// The ISBN lookup shared by both queries: every written form of the ISBN is
// matched against ISBN-13 (P212) and ISBN-10 (P957), then ?holder is the
// edition item itself or a work it is an edition of (P629). Binding ?holder
// here, before any award pattern, is what keeps awards tied to THIS book.
function holderPattern(ids) {
  const values = [...new Set([ids.isbn13, ids.isbn13h, ids.isbn10, ids.isbn10h])]
    .filter((v) => v && HYPHENATED.test(v) && v.length <= 17);
  if (!values.length) return null;
  return `VALUES ?isbn { ${values.map((v) => `"${v}"`).join(" ")} }
  { ?edition wdt:P212 ?isbn } UNION { ?edition wdt:P957 ?isbn }
  ?edition wdt:P629? ?holder .`;
}

// Awards and nominations of the edition / work. The two statement kinds are
// driven from a VALUES table rather than a UNION of two branches: the UNION
// form makes the live query planner time out (verified against the real
// service), the VALUES form answers in well under a second.
function buildQuery(ids) {
  const holder = holderPattern(ids);
  if (!holder) return null;
  return `SELECT DISTINCT ?award ?awardLabel ?year ?kind WHERE {
  ${holder}
  VALUES (?pp ?ps ?kind) { (p:P166 ps:P166 "award") (p:P1411 ps:P1411 "shortlist") }
  ?holder ?pp ?st . ?st ?ps ?award .
  OPTIONAL { ?st pq:P585 ?when }
  BIND(YEAR(?when) AS ?year)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} LIMIT 100`;
}

// Separate flagged addition: has the work's author (P50) received the Nobel
// Prize in Literature? One prize only, on purpose: other author awards are noise.
function buildAuthorQuery(ids) {
  const holder = holderPattern(ids);
  if (!holder) return null;
  return `SELECT DISTINCT ?year WHERE {
  ${holder}
  ?holder wdt:P50 ?author . ?author p:P166 ?st . ?st ps:P166 wd:${NOBEL_LIT} .
  OPTIONAL { ?st pq:P585 ?when }
  BIND(YEAR(?when) AS ?year)
} LIMIT 5`;
}

// Turns a SPARQL JSON response into [{label, year, kind, source_url}].
function parseBindings(json, { limit = MAX_PER_BOOK } = {}) {
  const rows = json && json.results && Array.isArray(json.results.bindings) ? json.results.bindings : [];
  const best = new Map(); // key -> item
  for (const r of rows) {
    const label = String((r.awardLabel && r.awardLabel.value) || "").trim().slice(0, 200);
    if (!label || /^Q\d+$/.test(label)) continue; // no English label
    const y = r.year ? parseInt(r.year.value, 10) : NaN;
    const year = Number.isInteger(y) && y >= 1000 && y <= 2200 ? y : null;
    const kind = r.kind && r.kind.value === "shortlist" ? "shortlist" : "award";
    const key = `${label.toLowerCase()}|${year || 0}`;
    const prev = best.get(key);
    if (!prev || (prev.kind === "shortlist" && kind === "award")) best.set(key, { label, year, kind, source_url: null });
  }
  let items = [...best.values()];
  // "Hugo Award" with a year beats the same label without one.
  const datedLabels = new Set(items.filter((i) => i.year).map((i) => i.label.toLowerCase()));
  items = items.filter((i) => i.year || !datedLabels.has(i.label.toLowerCase()));
  return items.slice(0, limit);
}

// The author query's rows (just a year each) become one labelled item.
function parseAuthorNobel(json) {
  const rows = json && json.results && Array.isArray(json.results.bindings) ? json.results.bindings : [];
  const years = rows.map((r) => (r.year ? parseInt(r.year.value, 10) : NaN)).filter((y) => Number.isInteger(y) && y >= 1000 && y <= 2200);
  if (!rows.length) return [];
  return [{ label: AUTHOR_NOBEL, year: years.length ? Math.min(...years) : null, kind: "award", source_url: null }];
}

// Serialises requests so two books checked at once still keep the gap.
let chain = Promise.resolve();
let lastAt = 0;
function gate(gapMs, sleep) {
  const run = chain.then(async () => {
    const wait = lastAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
  });
  chain = run.catch(() => {});
  return run;
}
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request with retries on timeout / 429 / 5xx (backoff between tries).
async function fetchWithRetry(url, { fetchFn, timeoutMs, sleep }) {
  let res;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    res = await requestJson(url, {
      fetch: fetchFn, timeoutMs,
      headers: { accept: "application/sparql-results+json", "user-agent": USER_AGENT },
    });
    const retryable = !res.ok && (res.status === 0 || res.status === 429 || res.status >= 500);
    if (res.ok || !retryable || attempt === RETRIES) break;
    await sleep(BACKOFF_MS[attempt] || 6000);
  }
  return res;
}

async function lookupWikidataAwards({ isbn } = {}, { fetch: fetchFn, gapMs = GAP_MS, sleep = realSleep, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const query = buildQuery(cleanIsbns(isbn));
    if (!query) return { items: [], error: false, skipped: true };
    await gate(gapMs, sleep);
    const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
    const res = await fetchWithRetry(url, { fetchFn, timeoutMs, sleep });
    if (!res.ok) {
      console.warn("Awards: Wikidata lookup failed:", res.error);
      return { items: [], error: true };
    }
    const items = parseBindings(res.json, { limit: Infinity });
    if (items.length > MAX_PLAUSIBLE) {
      // A real book has a handful of awards. A flood means the query or the
      // data is wrong: store nothing rather than show customers rubbish.
      console.warn(`Awards: Wikidata returned ${items.length} awards for ISBN ${isbn}; discarded as implausible`);
      return { items: [], error: false, suspicious: true };
    }
    // The Nobel check is a bonus: if it fails, the book's own awards still count.
    const ids = cleanIsbns(isbn);
    const authorQuery = buildAuthorQuery(ids);
    if (authorQuery) {
      await gate(gapMs, sleep);
      const ar = await fetchWithRetry(`${ENDPOINT}?format=json&query=${encodeURIComponent(authorQuery)}`, { fetchFn, timeoutMs, sleep });
      if (ar.ok) items.push(...parseAuthorNobel(ar.json));
      else console.warn("Awards: Wikidata author-prize lookup failed:", ar.error);
    }
    return { items: items.slice(0, MAX_PER_BOOK), error: false };
  } catch (err) {
    console.warn("Awards: Wikidata lookup failed:", err.message);
    return { items: [], error: true };
  }
}

module.exports = { lookupWikidataAwards, parseBindings, buildQuery, buildAuthorQuery, parseAuthorNobel, cleanIsbns, USER_AGENT, MAX_PLAUSIBLE, TIMEOUT_MS };
