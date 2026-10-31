// "Find a cover" (Admin > a book's Cover card, and Reports > Covers to check): candidate covers from Open Library for a book
// whose exact ISBN has no cover. The admin looks at the candidates and picks one; nothing here is ever applied by itself.
//
// Rights decision (Sharon): covers come only from Open Library / the BnF, or our own photo. So the only search is Open Library's
// search.json, and the only picture address ever built is https://covers.openlibrary.org/b/id/<number>-<size>.jpg from a cover
// number: a pick is a cover NUMBER, never an address from the browser.
//
// What is asked (at most four requests per press, cached for SCAN_CACHE_TTL_MS, one attempt each with a deadline, never in bulk):
//   1. search by title + author (the best edition of each work comes with it: cover number, publisher, year, language, ISBN list)
//   2. when the book has a valid ISBN: search by that ISBN, which returns exactly the edition(s) holding it
//   3. the editions list of the best one or two works found (a search shows only one edition per work), for more candidates
// A candidate's "isbnMatch" is true ONLY when the ISBN list of that very edition holds this book's ISBN (either form). A work's
// main cover is listed too, but with no edition details: it can be another edition's picture, and says so.

const { isValidIsbn, normalizeIsbn, createTtlCache } = require("./bookLookup");
const { isbnForms } = require("./bookSources");
const { readBoundedJson } = require("./boundedBody");
const { CONTACT_EMAIL } = require("./legal");

const MAX_CANDIDATES = 8;
const SEARCH_TIMEOUT_MS = 6000;
const USER_AGENT = `UmasBooksInventory/1.0 (+https://umasbooks.org; ${CONTACT_EMAIL})`;
const FIELDS = [
  "key", "title", "author_name", "cover_i", "cover_edition_key", "first_publish_year",
  "editions", "editions.key", "editions.title", "editions.cover_i", "editions.publisher", "editions.publish_year", "editions.language", "editions.isbn",
].join(",");

const searchCache = createTtlCache({ max: 100 });

// A cover number is digits only (1..9 digits): the one thing the browser sends back when a candidate is picked.
function parseCoverId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  return /^[1-9]\d{0,8}$/.test(s) ? Number(s) : null;
}
const coverAddress = (coverId, size = "L") => `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;

async function fetchCached(url, valid, fetchImpl) {
  const hit = searchCache.get(url);
  if (hit) return hit;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS), headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
  const data = await readBoundedJson(res);
  if (!data || !valid(data)) throw new Error("unexpected answer");
  searchCache.set(url, data);
  return data;
}
const fetchSearch = (params, fetchImpl) => fetchCached(`https://openlibrary.org/search.json?${new URLSearchParams(params).toString()}`, (d) => Array.isArray(d.docs), fetchImpl);
const WORK_KEY = /^\/works\/(OL\d{1,12}W)$/;
const fetchWorkEditions = (workId, fetchImpl) => fetchCached(`https://openlibrary.org/works/${workId}/editions.json?limit=50`, (d) => Array.isArray(d.entries), fetchImpl);

const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;
const joinNames = (v) => (Array.isArray(v) && v.length ? v.slice(0, 3).join(", ") : null);

function ownIsbns(isbn) {
  const n = normalizeIsbn(isbn);
  if (!isValidIsbn(n)) return new Set();
  const f = isbnForms(n);
  return new Set([f.isbn13, f.isbn10].filter(Boolean));
}

// Candidates out of one search answer. `mine`: the book's ISBN forms (a Set, maybe empty).
function candidatesFromDocs(docs, mine) {
  const out = [];
  for (const doc of docs) {
    const author = joinNames(doc.author_name);
    const editions = doc.editions && Array.isArray(doc.editions.docs) ? doc.editions.docs : [];
    for (const e of editions) {
      const coverId = parseCoverId(e.cover_i);
      if (!coverId) continue;
      const isbns = Array.isArray(e.isbn) ? e.isbn.map(normalizeIsbn) : [];
      out.push({
        coverId, kind: "edition", title: e.title || doc.title || null, author,
        publisher: first(e.publisher), year: first(e.publish_year), language: joinNames(e.language),
        isbnMatch: isbns.some((i) => mine.has(i)),
        editionKey: typeof e.key === "string" ? e.key.replace(/^\/books\//, "") : null,
      });
    }
    const workCover = parseCoverId(doc.cover_i);
    if (workCover) {
      out.push({
        coverId: workCover, kind: "work", title: doc.title || null, author, publisher: null, year: doc.first_publish_year || null,
        language: null, isbnMatch: false, editionKey: typeof doc.cover_edition_key === "string" ? doc.cover_edition_key : null,
      });
    }
  }
  return out;
}

// Candidates out of a work's editions list (works/<id>/editions.json): one per edition that has a cover.
function candidatesFromEditionList(entries, doc, mine) {
  const out = [];
  for (const e of entries) {
    const coverId = Array.isArray(e.covers) ? e.covers.map(parseCoverId).find(Boolean) : null;
    if (!coverId) continue;
    const isbns = [].concat(e.isbn_10 || [], e.isbn_13 || []).map(normalizeIsbn);
    const year = /\d{4}/.exec(String(e.publish_date || ""));
    const lang = Array.isArray(e.languages) ? e.languages.map((l) => String((l && l.key) || "").replace("/languages/", "")).filter(Boolean) : [];
    out.push({
      coverId, kind: "edition", title: e.title || doc.title || null, author: joinNames(doc.author_name),
      publisher: first(e.publishers), year: year ? Number(year[0]) : null, language: lang.length ? lang.slice(0, 3).join(", ") : null,
      isbnMatch: isbns.some((i) => mine.has(i)),
      editionKey: typeof e.key === "string" ? e.key.replace(/^\/books\//, "") : null,
    });
  }
  return out;
}

// Same cover number twice (an edition and the work's main cover): one entry, the more precise one kept (an edition beats the
// work, a match beats no match). Best match first, then editions of the same publisher and year as the book, then editions with
// a publisher and a year, then the rest. hint: { publisher, year } of the book (both optional).
function rank(list, hint = {}) {
  const byId = new Map();
  for (const c of list) {
    const old = byId.get(c.coverId);
    const better = !old || (c.isbnMatch && !old.isbnMatch) || (c.kind === "edition" && old.kind === "work" && !old.isbnMatch);
    if (better) byId.set(c.coverId, c);
  }
  const pub = String(hint.publisher || "").trim().toLowerCase();
  const samePublisher = (c) => Boolean(pub && c.publisher && String(c.publisher).toLowerCase().includes(pub));
  const sameYear = (c) => Boolean(hint.year && c.year && Number(c.year) === Number(hint.year));
  const score = (c) => (c.isbnMatch ? 8 : 0) + (c.kind === "edition" ? 2 : 0) + (samePublisher(c) ? 1.5 : 0) + (sameYear(c) ? 0.75 : 0) + (c.publisher && c.year ? 1 : 0);
  return [...byId.values()].map((c, i) => ({ c, i })).sort((a, b) => score(b.c) - score(a.c) || a.i - b.i).map((x) => x.c);
}

// -> { candidates: [...up to 8], state: "ok" | "empty" | "error", message }
// book: { title, authors, isbn }. deps: fetchImpl (tests).
async function findCoverCandidates(book, deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
  const title = String((book && book.title) || "").slice(0, 200);
  const author = String((book && book.authors) || "").split(/[,;]/)[0].trim().slice(0, 100);
  const mine = ownIsbns(book && book.isbn);
  if (!title && !mine.size) return { candidates: [], state: "empty", message: "This book has no title or ISBN to search with." };

  const jobs = [];
  if (mine.size) jobs.push(fetchSearch({ isbn: [...mine][0], limit: "3", fields: FIELDS }, fetchImpl)); // first: its works lead
  if (title) {
    const params = { title, limit: "5", fields: FIELDS };
    if (author) params.author = author;
    jobs.push(fetchSearch(params, fetchImpl));
  }
  const settled = await Promise.allSettled(jobs);
  const docs = settled.filter((s) => s.status === "fulfilled").flatMap((s) => s.value.docs);
  if (!docs.length && settled.every((s) => s.status === "rejected")) {
    return { candidates: [], state: "error", message: "Open Library did not answer. Try again in a minute." };
  }
  // The editions of the best works (the ISBN search's first, then the title search's): a search lists one edition per work.
  const works = [];
  for (const d of docs) { const m = WORK_KEY.exec(String(d.key || "")); if (m && !works.some((w) => w.id === m[1])) works.push({ id: m[1], doc: d }); }
  const lists = await Promise.allSettled(works.slice(0, 2).map((w) => fetchWorkEditions(w.id, fetchImpl).then((r) => candidatesFromEditionList(r.entries, w.doc, mine))));
  const more = lists.filter((l) => l.status === "fulfilled").flatMap((l) => l.value);
  const candidates = rank([...candidatesFromDocs(docs, mine), ...more], { publisher: book && book.publisher, year: book && book.publishedYear }).slice(0, MAX_CANDIDATES);
  if (!candidates.length) return { candidates, state: "empty", message: "Open Library has no cover for this title and author. Take a photo of the book instead." };
  return { candidates, state: "ok", message: null };
}

module.exports = { findCoverCandidates, candidatesFromDocs, candidatesFromEditionList, rank, parseCoverId, coverAddress, MAX_CANDIDATES, searchCache };
