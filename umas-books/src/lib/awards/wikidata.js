// Awards from Wikidata (free, structured, community-maintained). Looks the
// book up by ISBN-13 / ISBN-10 (P212 / P957), follows "edition or translation
// of" (P629) to the work (the item itself is tried too), then reads
// P166 "award received" (qualifier P585 = year) and P1411 "nominated for"
// (kind 'shortlist'). Only English (or language-neutral 'mul') labels are
// used; anything else is skipped rather than shown as a bare Q-number.
//
// Fails open: never throws. Returns { items, error, skipped }.
// Coverage is patchy: no result means "Wikidata does not know", not "no awards".

const { isbnVariants } = require("../inventory");
const { requestJson } = require("./http");

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "UmasBooks/1.0 (admin@umasbooks.org)";
const MAX_PER_BOOK = 15;
const GAP_MS = 1200; // be polite: at least this long between two requests

const ISBN13 = /^\d{13}$/;
const ISBN10 = /^\d{9}[\dX]$/;

// Only digits (and a final X) survive; anything else is dropped, so nothing
// the caller passes can ever break out of the SPARQL string literal.
function cleanIsbns(isbn) {
  const raw = String(isbn || "").toUpperCase().replace(/[^0-9X]/g, "");
  const found = { isbn13: null, isbn10: null };
  for (const v of isbnVariants(raw)) {
    if (ISBN13.test(v)) found.isbn13 = v;
    else if (ISBN10.test(v)) found.isbn10 = v;
  }
  return found;
}

function buildQuery({ isbn13, isbn10 }) {
  const edition = [];
  if (isbn13 && ISBN13.test(isbn13)) edition.push(`{ ?item wdt:P212 "${isbn13}" }`);
  if (isbn10 && ISBN10.test(isbn10)) edition.push(`{ ?item wdt:P957 "${isbn10}" }`);
  if (!edition.length) return null;
  return `SELECT DISTINCT ?awardLabel ?year ?kind WHERE {
  ${edition.join(" UNION ")}
  { BIND(?item AS ?work) } UNION { ?item wdt:P629 ?work }
  {
    ?work p:P166 ?st . ?st ps:P166 ?award .
    OPTIONAL { ?st pq:P585 ?when }
    BIND("award" AS ?kind)
  } UNION {
    ?work p:P1411 ?st . ?st ps:P1411 ?award .
    OPTIONAL { ?st pq:P585 ?when }
    BIND("shortlist" AS ?kind)
  }
  BIND(YEAR(?when) AS ?year)
  OPTIONAL { ?award rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?award rdfs:label ?mul FILTER(LANG(?mul) = "mul") }
  BIND(COALESCE(?en, ?mul) AS ?awardLabel)
} LIMIT 100`;
}

// Turns a SPARQL JSON response into [{label, year, kind, source_url}].
function parseBindings(json) {
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
  return items.slice(0, MAX_PER_BOOK);
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

async function lookupWikidataAwards({ isbn } = {}, { fetch: fetchFn, gapMs = GAP_MS, sleep = realSleep, timeoutMs } = {}) {
  try {
    const query = buildQuery(cleanIsbns(isbn));
    if (!query) return { items: [], error: false, skipped: true };
    await gate(gapMs, sleep);
    const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
    const res = await requestJson(url, {
      fetch: fetchFn, timeoutMs,
      headers: { accept: "application/sparql-results+json", "user-agent": USER_AGENT },
    });
    if (!res.ok) {
      console.warn("Awards: Wikidata lookup failed:", res.error);
      return { items: [], error: true };
    }
    return { items: parseBindings(res.json), error: false };
  } catch (err) {
    console.warn("Awards: Wikidata lookup failed:", err.message);
    return { items: [], error: true };
  }
}

module.exports = { lookupWikidataAwards, parseBindings, buildQuery, cleanIsbns, USER_AGENT };
