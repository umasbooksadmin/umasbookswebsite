// Book metadata lookups against Open Library's free, keyless API.
// Both functions return null/[] on any failure (not-found, network error,
// timeout) rather than throwing, so a lookup miss just falls through to
// manual entry in the UI.

const config = require("./config");
const { readBoundedJson } = require("./boundedBody");
const { createInflight } = require("./inflight");

function normalizeIsbn(isbn) {
  return (isbn || "").replace(/[^0-9Xx]/g, "").toUpperCase();
}

// Is this (already normalized) string a REAL ISBN: ISBN-13 (978 or 979 prefix) or ISBN-10 (X allowed as the last
// character) with a correct check digit? Used before any outbound call, so a mistyped or made-up number never
// costs a catalog request (or a paid ISBNdb one). normalizeIsbn itself stays loose: it is also how stored values
// and the till's codes are compared.
function isValidIsbn(isbn) {
  const s = String(isbn == null ? "" : isbn);
  if (/^97[89]\d{10}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === Number(s[12]);
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += (10 - i) * Number(s[i]);
    sum += s[9] === "X" ? 10 : Number(s[9]);
    return sum % 11 === 0;
  }
  return false;
}

// A free-text physical format from Open Library or Google ("Hardcover", "Mass
// Market Paperback", "trade paperback"...) mapped to our four bindings:
// hardcover, mass_market (also "Poche"), trade (any other paperback or
// softcover) or other (board book, spiral, audio...). null when missing.
function mapBinding(physicalFormat) {
  const f = String(physicalFormat == null ? "" : physicalFormat).trim().toLowerCase();
  if (!f) return null;
  if (f.includes("mass market") || f.includes("mass-market") || f.includes("massmarket") || f === "poche" || f.includes("pocket")) return "mass_market";
  if (f.includes("hardcover") || f.includes("hardback") || f.includes("hard cover") || f.includes("hard back") || f.includes("relié")) return "hardcover";
  if (f.includes("paperback") || f.includes("softcover") || f.includes("soft cover") || f.includes("trade") || f.includes("broché") || f === "paper") return "trade";
  return "other";
}

function extractYear(publishDate) {
  if (!publishDate) return null;
  const match = String(publishDate).match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

// Open Library subject lists are long and noisy (fictitious characters,
// series tags, themes like "Ghosts" or "Magic", etc.) — not a genre
// taxonomy. Prefer the broadest standard bookstore genre that appears
// anywhere in the list (checked most-generic-first), falling back to the
// shortest raw tag if none of these common genres show up at all.
const COMMON_GENRES = [
  "Fiction", "Non-fiction",
  "Fantasy", "Science Fiction", "Mystery", "Romance", "Thriller", "Horror",
  "Biography", "History", "Poetry", "Drama", "Adventure", "Humor",
  "Philosophy", "Religion", "Travel", "Cooking", "Art", "Self-help",
  "Children's Fiction", "Young Adult Fiction", "Classics",
];

// Books have English genres only (Sharon, 2026-10-28): there is no French list and no French translation of a genre.

// A book can reasonably match several of these (e.g. both "Fantasy" and
// "Young Adult Fiction") — return every one that appears, most-generic
// first, capped so a noisy subject list doesn't produce a huge string.
const MAX_GENRES = 3;

function pickGenres(names) {
  const clean = (names || []).filter((n) => typeof n === "string" && !n.includes(":"));
  if (!clean.length) return null;

  const lower = clean.map((n) => n.toLowerCase());
  const matches = COMMON_GENRES.filter((genre) => lower.some((n) => n.includes(genre.toLowerCase())));
  if (matches.length) return matches.slice(0, MAX_GENRES).join(", ");

  return clean.reduce((shortest, n) => (n.length < shortest.length ? n : shortest));
}

async function fetchJsonOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "UmasBooksInventory/1.0" } });
    if (!res.ok) return null;
    return await readBoundedJson(res); // over 1 MB: treated as a failed source
  } finally {
    clearTimeout(timeout);
  }
}

// One retry on transient network errors (e.g. a reset connection) so a
// real book doesn't come back "not found" just from a network blip —
// capped low so a slow/unreachable Open Library can't make the whole
// admin request hang for tens of seconds.
const MAX_ATTEMPTS = 2;

async function fetchJson(url, timeoutMs = 5000) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchJsonOnce(url, timeoutMs);
    } catch {
      if (attempt === MAX_ATTEMPTS - 1) return null;
    }
  }
  return null;
}

// ---------- The ISBN lookup (the one that has to feel instant) ----------
//
// Open Library answers in 0.7 s most of the time and now and then in 6 s or never.
// So the lookup of the scan page does not wait on one slow answer:
//   - timeoutMs  (SCAN_LOOKUP_TIMEOUT_MS, default 4000): the whole lookup is given up after
//                this long; the page then says "not found: fill in by hand" (state "slow").
//   - hedgeMs    (SCAN_LOOKUP_HEDGE_MS, default 1500, 0 = off): if the first request has not
//                answered by then, an identical second one is sent and the first answer wins.
//                A request that FAILS fast (connection reset) is retried at once, as before.
//   - cache      found and "not in the catalog" answers are kept in memory for
//                SCAN_CACHE_TTL_MS (default 10 minutes, 0 = off), so scanning the same ISBN
//                again, or saving a book just looked up, does not call Open Library twice.
//                A timeout or a network error is never cached.

function createTtlCache({ max = 300, ttlMs = () => config.get("SCAN_CACHE_TTL_MS"), now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) { map.delete(key); return undefined; }
      map.delete(key); map.set(key, hit); // most recently used last
      return hit.value;
    },
    set(key, value, ttlOverride) {
      const ttl = ttlOverride !== undefined ? ttlOverride : typeof ttlMs === "function" ? ttlMs() : ttlMs;
      if (!(ttl > 0)) return;
      map.delete(key);
      map.set(key, { value, expires: now() + ttl });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}

const lookupCache = createTtlCache();

// One GET with a deadline, an optional hedge and one quick retry.
// Resolves { state: "ok", data } | { state: "missing" } (404) | { state: "error" } | { state: "timeout" }; never rejects.
function fetchJsonRace(url, { timeoutMs, hedgeMs = 0, fetchImpl = (...a) => fetch(...a) }) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let started = 0;
    let ended = 0;
    let settled = false;
    let last = { state: "error" };
    let hedgeTimer = null;
    let deadline = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadline);
      controller.abort();
      resolve(result);
    };
    deadline = setTimeout(() => finish({ state: "timeout" }), timeoutMs);
    const attempt = () => {
      if (settled || started >= MAX_ATTEMPTS) return;
      started += 1;
      (async () => {
        try {
          const res = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": "UmasBooksInventory/1.0" } });
          if (!res.ok) return res.status === 404 ? { state: "missing" } : { state: "error", status: res.status };
          return { state: "ok", data: await readBoundedJson(res) }; // over 1 MB: this source failed
        } catch {
          return { state: "error" };
        }
      })().then((r) => {
        ended += 1;
        if (r.state === "ok" || r.state === "missing") return finish(r);
        last = r;
        if (ended >= started) {
          if (started < MAX_ATTEMPTS) attempt();
          else finish(last);
        }
      });
    };
    attempt();
    if (hedgeMs > 0 && hedgeMs < timeoutMs) hedgeTimer = setTimeout(attempt, hedgeMs);
  });
}

function bookFromRecord(isbn, data) {
  if (!data || Array.isArray(data) || !data.records) return null;

  const record = Object.values(data.records)[0];
  // Open Library returns *something* even for garbage ISBNs; an empty
  // isbns list on the matched record is the signal that it's not real.
  if (!record || !Array.isArray(record.isbns) || !record.isbns.length) return null;

  const info = record.data || {};
  let author = null;
  if (Array.isArray(info.authors) && info.authors.length) {
    author = info.authors.map((a) => a.name).filter(Boolean).join(", ") || null;
  } else if (info.by_statement) {
    author = info.by_statement.replace(/^\s*by\s+/i, "").trim();
  }

  const genre = pickGenres(Array.isArray(info.subjects) ? info.subjects.map((s) => s.name) : null);
  return {
    isbn,
    title: info.title || null,
    subtitle: info.subtitle || null,
    author,
    publisher: Array.isArray(info.publishers) && info.publishers[0] ? info.publishers[0].name : null,
    publishedYear: extractYear(info.publish_date),
    description: typeof info.description === "string" ? info.description : (info.description && info.description.value) || null,
    coverUrl: (info.cover && (info.cover.large || info.cover.medium)) || null,
    genre,
    pages: Number.isInteger(info.number_of_pages) ? info.number_of_pages : null,
    language: null,
    binding: mapBinding(info.physical_format || (record.details && record.details.details && record.details.details.physical_format)),
  };
}

// Open Library's own cover for an ISBN ("default=false": a 404 when there is none, so a placeholder is never stored).
function isbnCoverUrl(isbn) {
  const { isbn13 } = require("./bookSources").isbnForms(normalizeIsbn(isbn));
  return /^\d{13}$/.test(isbn13) ? `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg?default=false` : null;
}

const FIELDS = ["title", "subtitle", "author", "publisher", "publishedYear", "description", "coverUrl", "genre", "pages", "language", "binding"];

// The books of several sources into one: the first source with a title is the base (the sources
// come in priority order), every field it lacks is filled from the next ones. Nothing is invented:
// a field nobody gave stays null.
function mergeBooks(isbn, books) {
  // Several answers: the ones with a title lead. A record without any title (it happens) is still passed on as it is, so
  // the caller sees what the catalog really said (the page treats a title-less book as "not found").
  const withTitle = books.filter((b) => b && b.title);
  const titled = withTitle.length ? withTitle : books.filter(Boolean).slice(0, 1);
  if (!titled.length) return null;
  const out = { isbn };
  for (const f of FIELDS) {
    const from = titled.find((b) => b[f] !== undefined && b[f] !== null && b[f] !== "");
    out[f] = from ? from[f] : null;
  }
  return out;
}

// Which of the sources that gave a book did what, for the statistics (report /admin/reports/lookup-sources):
// "won" supplied the title (the first titled one, in priority order), "filled" supplied at least one other field
// of the merged book, "redundant" had a book but nothing of it was used. Same rule as mergeBooks.
// entries: [[name, book]] in priority order. -> Map name -> "won" | "filled" | "redundant"
function attributeSources(entries) {
  const titled = entries.filter(([, b]) => b && b.title);
  const out = new Map(entries.filter(([, b]) => b).map(([n]) => [n, "redundant"]));
  if (!titled.length) return out;
  out.set(titled[0][0], "won");
  for (const f of FIELDS) {
    const from = titled.find(([, b]) => b[f] !== undefined && b[f] !== null && b[f] !== "");
    if (from && out.get(from[0]) === "redundant") out.set(from[0], "filled");
  }
  return out;
}

const enabledSources = () => new Set(String(config.get("SCAN_LOOKUP_SOURCES")).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
const isComplete = (b) => Boolean(b && b.title && b.author && b.publisher && b.publishedYear);

// -> { book, state, via } with state "found" | "missing" (no source has such a book) |
// "slow" (gave up waiting) | "error" (network trouble). Never throws.
// The sources (lib/bookSources.js) are asked AT THE SAME TIME and merged by priority (Open Library, then
// the BnF for a French ISBN, Google Books, Open Library's data API, which starts when the first answer is
// "not found" or slow). The answer is given as soon as a titled result is complete, or graceMs
// (SCAN_LOOKUP_GRACE_MS, 300) after the first titled result, or at the deadline: a slow secondary source never
// holds back the primary one, and a source that fails never hides the others.
// opts: timeoutMs, hedgeMs, graceMs, lateMs, fetchImpl (tests), cache (a createTtlCache(), tests; false = no cache).
// Lookups for the same ISBN running at the same time (a double scan, the scan page and a save) share ONE set of outside
// calls; every caller gets its own copy of the answer. An ISBN whose check digit is wrong is refused here with state
// "invalid", before any outside call.
const lookupInflight = createInflight();
async function lookupByIsbnDetailed(rawIsbn, opts = {}) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return { book: null, state: "missing" };
  if (!isValidIsbn(isbn)) return { book: null, state: "invalid" };
  const r = await lookupInflight.run(isbn, () => lookupByIsbnOnce(isbn, opts));
  return { ...r, book: r.book ? { ...r.book } : r.book, via: r.via ? [...r.via] : r.via };
}

async function lookupByIsbnOnce(isbn, opts) {
  const cache = opts.cache === undefined ? lookupCache : opts.cache;
  const stats = opts.stats || require("./lookupStats").getStats(); // counts only, see lib/lookupStats.js
  const hit = cache ? cache.get(isbn) : undefined;
  if (hit) stats.record("cache", { asked: 1, won: hit.book && hit.book.title ? 1 : 0 });
  if (hit && !(hit.book && hit.book.title)) stats.record("none", { asked: 1 });
  if (hit) return { book: hit.book ? { ...hit.book } : null, state: hit.state, via: hit.via, cached: true };

  const sources = require("./bookSources");
  const forms = sources.isbnForms(isbn);
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs === undefined ? config.get("SCAN_LOOKUP_TIMEOUT_MS") : opts.timeoutMs;
  const hedgeMs = opts.hedgeMs === undefined ? config.get("SCAN_LOOKUP_HEDGE_MS") : opts.hedgeMs;
  const graceMs = opts.graceMs === undefined ? config.get("SCAN_LOOKUP_GRACE_MS") : opts.graceMs;
  const lateMs = opts.lateMs === undefined ? Math.min(900, timeoutMs / 2) : opts.lateMs;
  const enabled = enabledSources();
  const started = Date.now();
  const controller = new AbortController();
  const helpers = { pickGenres, mapBinding };

  const briefOnce = async (form, budget) => {
    const r = await fetchJsonRace(`https://openlibrary.org/api/volumes/brief/isbn/${form}.json`, { timeoutMs: budget, hedgeMs, fetchImpl });
    if (r.state === "timeout") return { state: "error", slow: true };
    if (r.state !== "ok") return r.status ? { state: r.state, status: r.status } : { state: r.state };
    const book = bookFromRecord(isbn, r.data);
    return book ? { state: "ok", book } : { state: "missing" };
  };
  // Open Library's brief service, then (when it has nothing) the same book under its other ISBN form.
  const brief = async () => {
    const first = await briefOnce(isbn, timeoutMs);
    const other = isbn === forms.isbn13 ? forms.isbn10 : forms.isbn13;
    if (first.state !== "missing" || !other) return first;
    const left = timeoutMs - (Date.now() - started);
    return left > 200 ? briefOnce(other, left) : first;
  };

  // [name, runner, startsLate], in priority order.
  const plan = [];
  if (enabled.has("openlibrary")) plan.push(["openlibrary", brief, false]);
  if (enabled.has("bnf") && sources.isFrenchIsbn(forms.isbn13)) plan.push(["bnf", () => sources.bnf({ forms, fetchImpl, signal: controller.signal }), false]);
  if (enabled.has("google")) plan.push(["google", () => sources.googleBooks({ forms, fetchImpl, signal: controller.signal, helpers }), false]);
  if (enabled.has("openlibrary-data")) plan.push(["openlibrary-data", () => sources.openLibraryData({ forms, fetchImpl, signal: controller.signal, helpers }), true]);
  // ISBNdb (paid, only with ISBNDB_API_KEY): the last resort, asked once the free sources are all in and the
  // book is still missing or lacks its author, publisher or year.
  if (enabled.has("isbndb") && sources.isbndbConfigured()) plan.push(["isbndb", () => sources.isbndb({ forms, fetchImpl, signal: controller.signal, helpers, stats }), "fallback"]);
  if (!plan.length) { stats.record("lookup", { asked: 1 }); stats.record("none", { asked: 1 }); return { book: null, state: "error", via: [] }; }

  const results = new Map();
  const free = plan.filter((e) => e[2] !== "fallback");
  const fallback = plan.find((e) => e[2] === "fallback");
  await new Promise((resolve) => {
    let done = false;
    let graceTimer = null;
    let deadlineTimer = null;
    const timers = [];
    const orderedBooks = () => plan.map(([name]) => results.get(name)).filter((r) => r && r.book).map((r) => r.book);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(graceTimer);
      clearTimeout(deadlineTimer);
      timers.forEach(clearTimeout);
      controller.abort();
      resolve();
    };
    const launch = (entry) => {
      const [name, run] = entry;
      if (done || results.has(name) || entry.running) return;
      entry.running = true;
      const askedAt = Date.now();
      Promise.resolve().then(run).catch(() => ({ state: "error" })).then((r) => {
        results.set(name, { ...(r || { state: "error" }), ms: Date.now() - askedAt });
        if (done) return;
        if (r && r.state !== "ok" && name === "openlibrary") {
          const late = plan.find((e) => e[2] === true);
          if (late) launch(late); // the primary has nothing: ask the data API now
        }
        const merged = mergeBooks(isbn, orderedBooks());
        const freeDone = free.every(([n]) => results.has(n));
        if (freeDone && fallback && !fallback.running && !isComplete(merged)) return startFallback();
        if (plan.every(([n]) => results.has(n))) return finish();
        if (merged) {
          if (isComplete(merged)) return finish();
          if (!graceTimer && !(fallback && fallback.running)) {
            graceTimer = setTimeout(() => {
              graceTimer = null;
              if (fallback && !fallback.running && !isComplete(mergeBooks(isbn, orderedBooks()))) startFallback(); else finish();
            }, graceMs);
          }
        }
      });
    };
    // ISBNdb: only now, and only for a book that is missing or incomplete. It gets a little more time.
    const startFallback = () => {
      clearTimeout(graceTimer);
      graceTimer = null;
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(finish, Math.max(2000, Math.min(timeoutMs, 3000)));
      launch(fallback);
    };
    for (const entry of free) if (entry[2] !== true) launch(entry);
    const late = plan.find((e) => e[2] === true);
    if (late) timers.push(setTimeout(() => launch(late), lateMs));
    deadlineTimer = setTimeout(finish, timeoutMs);
  });

  const merged = mergeBooks(isbn, plan.map(([name]) => results.get(name)).filter((r) => r && r.book).map((r) => r.book));
  recordLookupStats(stats, plan, results, merged);
  const via = plan.map(([name]) => name).filter((name) => results.get(name) && results.get(name).book && results.get(name).book.title);
  if (merged) {
    const out = { book: merged, state: "found", via };
    if (cache) cache.set(isbn, out);
    return { ...out, book: { ...merged } };
  }
  const pending = plan.some((entry) => entry.running && !results.has(entry[0])); // asked, not answered
  const slow = [...results.values()].some((r) => r.slow);
  const primariesMissing = ["openlibrary", "openlibrary-data"].filter((n) => plan.some(([p]) => p === n)).every((n) => results.get(n) && results.get(n).state === "missing");
  if (!pending && !slow && primariesMissing) {
    const out = { book: null, state: "missing", via: [] };
    if (cache) cache.set(isbn, out, config.get("SCAN_NEGATIVE_TTL_MS"));
    return out;
  }
  return { book: null, state: pending || slow ? "slow" : "error", via: [] };
}

// One lookup into the statistics: what each source that was really asked did. Counts only; never throws.
function recordLookupStats(stats, plan, results, merged) {
  try {
    const roles = attributeSources(plan.map(([name]) => [name, results.get(name) && results.get(name).book]));
    for (const entry of plan) {
      const name = entry[0];
      const r = results.get(name);
      if (r && r.skipped) continue; // paused or not applicable: no call was made
      if (!r) {
        if (entry.running) stats.record(name, { asked: 1, cancelled: 1 }); // still waiting when the answer was given
        continue;
      }
      const delta = { asked: 1, ms: r.ms };
      if (r.state === "ok" && r.book && r.book.title) delta[roles.get(name)] = 1;
      else if (r.state === "error") delta[r.status === 429 || r.status === 401 || r.status === 403 ? "limited" : "errors"] = 1;
      else delta.empty = 1;
      stats.record(name, delta);
    }
    const found = Boolean(merged && merged.title);
    stats.record("lookup", { asked: 1, won: found ? 1 : 0 });
    if (!found) stats.record("none", { asked: 1 });
  } catch { /* statistics never get in the way */ }
}

// The book the catalog knows for an ISBN, or null (not found, slow, network error).
// Callers that are not the scan page (a photo, the saving of a book) can wait longer.
async function lookupByIsbn(rawIsbn, opts = {}) {
  const { book } = await lookupByIsbnDetailed(rawIsbn, { timeoutMs: 8000, ...opts });
  if (!book) return null;
  const { subtitle: _s, pages: _p, language: _l, ...legacy } = book; // the shape the older callers know
  return legacy;
}

async function searchByTitleAuthor(title, author) {
  title = String(title == null ? "" : title).slice(0, 200);
  author = String(author == null ? "" : author).slice(0, 200);
  if (!title && !author) return [];
  const params = new URLSearchParams({
    limit: "5",
    fields: "title,author_name,isbn,cover_i,first_publish_year,publisher,subject",
  });
  if (title) params.set("title", title);
  if (author) params.set("author", author);

  const data = await fetchJson(`https://openlibrary.org/search.json?${params.toString()}`);
  if (!data || !Array.isArray(data.docs)) return [];

  return data.docs.slice(0, 5).map((doc) => {
    const genre = pickGenres(doc.subject);
    return {
      isbn: Array.isArray(doc.isbn) ? doc.isbn[0] : null,
      title: doc.title || null,
      author: Array.isArray(doc.author_name) ? doc.author_name.join(", ") : null,
      publisher: Array.isArray(doc.publisher) ? doc.publisher[0] : null,
      publishedYear: doc.first_publish_year || null,
      description: null,
      coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null,
      genre,
    };
  });
}

module.exports = { normalizeIsbn, isValidIsbn, mapBinding, lookupByIsbn, lookupByIsbnDetailed, mergeBooks, attributeSources, pickGenres, isbnCoverUrl, createTtlCache, lookupCache, searchByTitleAuthor, COMMON_GENRES };
