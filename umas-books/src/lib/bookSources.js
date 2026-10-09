// The catalog sources behind the ISBN lookup of the scan page (lib/bookLookup.js).
// Each source asks ONE outside service about an ISBN and answers, never throwing,
//   { state: "ok", book } | { state: "missing" } (the service has no such book) | { state: "error" }
// with `book` in one shape whatever the service: { title, subtitle, author, publisher, publishedYear,
// description, coverUrl, genre, pages, language, binding }. Nothing is ever made up: a field the service
// does not give stays null, and a record that is not for this ISBN is refused. The lookup merges them by priority.
//
//   openLibraryBrief  Open Library volumes/brief  (the original source; has the format, "Hardcover" ...)
//   openLibraryData   Open Library /api/books jscmd=data: an edition under the other ISBN form, or a
//                     record the brief service lacks
//   googleBooks       Google Books volumes?q=isbn:  (descriptions, publishers; keyless use is capped by
//                     Google and may answer 429: then it is left alone for 10 minutes)
//   isbndb            ISBNdb (paid; only with ISBNDB_API_KEY; a fallback, see below)
//   bnf               Bibliotheque nationale de France SRU (free, no key): French-language books only
//
// Every request names who we are (Open Library, Google and the BnF ask API clients to).

const USER_AGENT = "UmasBooksInventory/1.0 (+https://umasbooks.org; admin@umasbooks.org)";

function isbn10to13(isbn10) {
  const body = "978" + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
  return body + String((10 - (sum % 10)) % 10);
}
function isbn13to10(isbn13) {
  if (!/^978\d{10}$/.test(isbn13)) return null; // 979- books have no ISBN-10
  const body = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(body[i]);
  const check = (11 - (sum % 11)) % 11;
  return body + (check === 10 ? "X" : String(check));
}
// { isbn13, isbn10 } for an ISBN-10 or ISBN-13 (isbn10 null for a 979- book).
function isbnForms(isbn) {
  if (/^\d{13}$/.test(isbn)) return { isbn13: isbn, isbn10: isbn13to10(isbn) };
  if (/^\d{9}[\dX]$/.test(isbn)) return { isbn13: isbn10to13(isbn), isbn10: isbn };
  return { isbn13: isbn, isbn10: null };
}
// French-language publishers' ISBNs: group 2 (978-2) or the 979-10 range.
const isFrenchIsbn = (isbn13) => /^9782/.test(isbn13) || /^97910/.test(isbn13);

const clean = (v, max = 2000) => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const yearOf = (v) => { const m = String(v == null ? "" : v).match(/\d{4}/); return m ? Number(m[0]) : null; };

async function getRaw(fetchImpl, url, signal, accept) {
  try {
    const res = await fetchImpl(url, { signal, headers: { "User-Agent": USER_AGENT, Accept: accept } });
    if (res.status === 404) return { state: "missing" };
    if (!res.ok) return { state: "error", status: res.status };
    return { state: "ok", res };
  } catch {
    return { state: "error" };
  }
}
async function getJson(fetchImpl, url, signal) {
  const r = await getRaw(fetchImpl, url, signal, "application/json");
  if (r.state !== "ok") return r;
  try { return { state: "ok", data: await r.res.json() }; } catch { return { state: "error" }; }
}

// ---------------- Open Library: data API ----------------
function fromOpenLibraryData(entry, helpers) {
  if (!entry || typeof entry !== "object" || !clean(entry.title)) return null;
  const subjects = Array.isArray(entry.subjects) ? entry.subjects.map((s) => s && s.name) : null;
  return {
    title: clean(entry.title, 500),
    subtitle: clean(entry.subtitle, 500),
    author: Array.isArray(entry.authors) && entry.authors.length ? entry.authors.map((a) => a && a.name).filter(Boolean).join(", ") || null : null,
    publisher: Array.isArray(entry.publishers) && entry.publishers[0] ? clean(entry.publishers[0].name, 200) : null,
    publishedYear: yearOf(entry.publish_date),
    description: null,
    coverUrl: (entry.cover && (entry.cover.large || entry.cover.medium)) || null,
    genre: helpers.pickGenres(subjects),
    pages: Number.isInteger(entry.number_of_pages) ? entry.number_of_pages : null,
    language: null,
    binding: null,
  };
}
async function openLibraryData({ forms, fetchImpl, signal, helpers }) {
  const keys = [forms.isbn13, forms.isbn10].filter(Boolean).map((i) => `ISBN:${i}`);
  const r = await getJson(fetchImpl, `https://openlibrary.org/api/books?bibkeys=${keys.join(",")}&format=json&jscmd=data`, signal);
  if (r.state !== "ok") return r;
  const entry = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? keys.map((k) => r.data[k]).find(Boolean) : null;
  const book = fromOpenLibraryData(entry, helpers);
  return book ? { state: "ok", book } : { state: "missing" };
}

// ---------------- Google Books ----------------
const googlePause = { until: 0 };
function fromGoogle(item, forms, helpers) {
  const v = item && item.volumeInfo;
  if (!v || !clean(v.title)) return null;
  // The record must carry this very ISBN (in either form): a search that "nearly" matches is not an answer.
  const ids = (Array.isArray(v.industryIdentifiers) ? v.industryIdentifiers : []).map((x) => String(x && x.identifier || "").replace(/-/g, ""));
  if (!ids.some((i) => i === forms.isbn13 || (forms.isbn10 && i === forms.isbn10))) return null;
  return {
    title: clean(v.title, 500),
    subtitle: clean(v.subtitle, 500),
    author: Array.isArray(v.authors) && v.authors.length ? v.authors.join(", ") : null,
    publisher: clean(v.publisher, 200),
    publishedYear: yearOf(v.publishedDate),
    description: clean(v.description, 4000),
    coverUrl: null, // Google's image hosts are not on the cover whitelist (lib/coverStore.js): the cover comes from Open Library
    genre: helpers.pickGenres(Array.isArray(v.categories) ? v.categories.flatMap((c) => String(c).split("/").map((x) => x.trim())) : null),
    pages: Number.isInteger(v.pageCount) && v.pageCount > 0 ? v.pageCount : null,
    language: clean(v.language, 10),
    binding: null,
  };
}
async function googleBooks({ forms, fetchImpl, signal, helpers, now = Date.now }) {
  if (now() < googlePause.until) return { state: "error", skipped: true };
  const key = process.env.GOOGLE_BOOKS_API_KEY ? `&key=${encodeURIComponent(process.env.GOOGLE_BOOKS_API_KEY)}` : "";
  let sawMissing = false;
  for (const isbn of [forms.isbn13, forms.isbn10].filter(Boolean)) {
    const r = await getJson(fetchImpl, `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=3${key}`, signal);
    if (r.state === "error") {
      if (r.status === 429 || r.status === 403) googlePause.until = now() + 10 * 60 * 1000;
      return { state: "error" };
    }
    if (r.state === "ok") {
      const items = Array.isArray(r.data && r.data.items) ? r.data.items : [];
      for (const item of items) {
        const book = fromGoogle(item, forms, helpers);
        if (book) return { state: "ok", book };
      }
    }
    sawMissing = true;
  }
  return sawMissing ? { state: "missing" } : { state: "error" };
}

// ---------------- BnF (French National Library) ----------------
const xmlText = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const dcValues = (xml, tag) => [...xml.matchAll(new RegExp(`<dc:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</dc:${tag}>`, "g"))].map((m) => xmlText(m[1]).trim()).filter(Boolean);
// "Saint-Exupéry, Antoine de (1900-1944). Auteur du texte" -> "Antoine de Saint-Exupéry"
function bnfPerson(raw) {
  const name = raw.replace(/\s*\([^)]*\)/g, "").replace(/\.\s+[A-ZÉ][^.]*$/, "").trim();
  const m = name.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : name;
}
function fromBnf(xml, forms) {
  const rec = xml.match(/<oai_dc:dc[\s\S]*?<\/oai_dc:dc>/);
  if (!rec) return null;
  const dc = rec[0];
  const ids = dcValues(dc, "identifier").join(" ").replace(/-/g, "") + " " + dcValues(dc, "description").join(" ").replace(/-/g, "");
  if (!ids.includes(forms.isbn13) && !(forms.isbn10 && ids.includes(forms.isbn10))) return null;
  const rawTitle = dcValues(dc, "title")[0];
  const title = clean(rawTitle && rawTitle.split(" / ")[0].split(" ; ")[0], 500);
  if (!title) return null;
  const people = dcValues(dc, "creator").filter((c) => /auteur|ill|adaptateur|traducteur|^[^.]*$/i.test(c));
  const authors = people.filter((c) => !/traducteur|illustrateur/i.test(c)).map(bnfPerson);
  const pub = dcValues(dc, "publisher")[0];
  const pages = (dcValues(dc, "format")[0] || "").match(/(\d{2,4}) p\./);
  return {
    title,
    subtitle: null,
    author: authors.length ? authors.join(", ") : null,
    publisher: clean(pub && pub.replace(/\s*\([^)]*\)\s*$/, ""), 200),
    publishedYear: yearOf(dcValues(dc, "date")[0]),
    description: null,
    coverUrl: null,
    genre: null,
    pages: pages ? Number(pages[1]) : null,
    language: clean(dcValues(dc, "language")[0], 10),
    binding: null,
  };
}
async function bnf({ forms, fetchImpl, signal }) {
  if (!isFrenchIsbn(forms.isbn13)) return { state: "missing", notApplicable: true };
  const url = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(`bib.isbn adj "${forms.isbn13}"`)}&recordSchema=dublincore&maximumRecords=1`;
  const r = await getRaw(fetchImpl, url, signal, "application/xml");
  if (r.state !== "ok") return r;
  let xml;
  try { xml = await r.res.text(); } catch { return { state: "error" }; }
  const book = fromBnf(xml, forms);
  return book ? { state: "ok", book } : { state: "missing" };
}

// ---------------- ISBNdb (paid, optional) ----------------
// Active ONLY when ISBNDB_API_KEY is set. A fallback: the lookup asks it only when the free sources found no
// title, or left out the author, publisher or year (lib/bookLookup.js), to keep paid calls few.
//   - at most one request per ISBNDB_MIN_INTERVAL_MS (default 1000: the basic plans allow about 1 a second),
//     whatever the number of scans: requests queue for a slot, and one that would wait longer than
//     MAX_QUEUE_WAIT_MS is skipped (the lookup never waits on it);
//   - 401/403 (key unknown or subscription lapsed): left alone for 30 min, logged once per change, shown on
//     /admin/diagnostics/lookup, never shown to the scanning person;
//   - 429 (minute or daily quota): left alone for the Retry-After seconds, else 1 min (minute quota) / 30 min (daily);
//   - the key goes only in the Authorization header of a request to an isbndb.com host, is never logged and never
//     reaches the browser.
// ISBNdb's terms (isbndb.com/terms-and-conditions) allow a subscriber to cache and store the data "to the extent
// necessary" to run the shop's own site for the length of the subscription, and forbid passing the database on
// or building a collection from it. So: results live in memory for minutes only (like every lookup), and only
// the fields the app stores for a saved book are used. The cover image is NOT used: images are third-party
// content whose rights ISBNdb does not grant.
const ISBNDB_DEFAULT_BASE = "https://api2.isbndb.com";
const MAX_QUEUE_WAIT_MS = 2500;
const isbndbState = { nextSlot: 0, pausedUntil: 0, status: "unknown", lastError: null, lastOkAt: null, lastCallAt: null, calls: 0, warned: new Set() };

const isbndbConfigured = (env = process.env) => Boolean(env.ISBNDB_API_KEY && String(env.ISBNDB_API_KEY).trim());
function isbndbBase(env = process.env) {
  const raw = String(env.ISBNDB_API_BASE || "").trim().replace(/\/+$/, "");
  if (!raw) return ISBNDB_DEFAULT_BASE;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" && (u.hostname === "isbndb.com" || u.hostname.endsWith(".isbndb.com")) && !u.username && !u.password) return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch { /* falls through */ }
  warnOnce("base", "ISBNDB_API_BASE ignored: it must be an https://...isbndb.com address (the key is never sent anywhere else).");
  return ISBNDB_DEFAULT_BASE;
}
function warnOnce(key, message) {
  if (isbndbState.warned.has(key)) return;
  isbndbState.warned.add(key);
  console.warn(`ISBNdb: ${message}`);
}
// What /admin/diagnostics/lookup shows. Never includes the key.
function isbndbStatus(now = Date.now()) {
  if (!isbndbConfigured()) return { configured: false, status: "off", lastError: null, lastOkAt: null, pausedUntil: null, calls: 0 };
  return {
    configured: true,
    status: isbndbState.status,
    lastError: isbndbState.lastError,
    lastOkAt: isbndbState.lastOkAt,
    pausedUntil: isbndbState.pausedUntil > now ? isbndbState.pausedUntil : null,
    calls: isbndbState.calls,
  };
}
function fromIsbndb(b, helpers) {
  if (!b || typeof b !== "object") return null;
  const title = clean(b.title, 500) || clean(b.title_long, 500);
  if (!title) return null;
  const stripTags = (v) => clean(String(v == null ? "" : v).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&"), 4000);
  return {
    title,
    subtitle: null,
    author: Array.isArray(b.authors) && b.authors.length ? b.authors.map((a) => clean(a, 200)).filter(Boolean).join(", ") || null : null,
    publisher: clean(b.publisher, 200),
    publishedYear: yearOf(b.date_published),
    description: stripTags(b.synopsis) || stripTags(b.overview),
    coverUrl: null, // ISBNdb's terms give no right to its cover images: never used
    genre: helpers.pickGenres(Array.isArray(b.subjects) ? b.subjects.map((x) => String(x)) : null),
    pages: Number.isInteger(b.pages) && b.pages > 0 ? b.pages : null,
    language: clean(b.language, 10),
    binding: helpers.mapBinding ? helpers.mapBinding(b.binding) : null,
  };
}
async function isbndb({ forms, fetchImpl, signal, helpers, env = process.env, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!isbndbConfigured(env)) return { state: "error", skipped: true };
  if (now() < isbndbState.pausedUntil) return { state: "error", skipped: true };
  const interval = Number(env.ISBNDB_MIN_INTERVAL_MS) >= 0 && env.ISBNDB_MIN_INTERVAL_MS !== undefined && env.ISBNDB_MIN_INTERVAL_MS !== "" ? Number(env.ISBNDB_MIN_INTERVAL_MS) : 1000;
  const slot = Math.max(now(), isbndbState.nextSlot);
  if (slot - now() > MAX_QUEUE_WAIT_MS) return { state: "error", skipped: true };
  isbndbState.nextSlot = slot + interval;
  if (slot > now()) await sleep(slot - now());
  if (signal && signal.aborted) return { state: "error", skipped: true };
  isbndbState.calls += 1;
  isbndbState.lastCallAt = now();
  let res;
  try {
    res = await fetchImpl(`${isbndbBase(env)}/book/${encodeURIComponent(forms.isbn13)}`, {
      signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json", Authorization: String(env.ISBNDB_API_KEY).trim() },
    });
  } catch {
    return { state: "error" };
  }
  if (res.status === 401 || res.status === 403) {
    isbndbState.status = "invalid";
    isbndbState.lastError = `The key was refused (HTTP ${res.status}): it is wrong, or the ISBNdb subscription is not active.`;
    isbndbState.pausedUntil = now() + 30 * 60 * 1000;
    warnOnce(`auth${res.status}`, `the API key was refused (HTTP ${res.status}); ISBNdb is left alone for 30 minutes. Check ISBNDB_API_KEY and the subscription.`);
    return { state: "error" };
  }
  if (res.status === 429) {
    const retry = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
    let daily = false;
    try { daily = /daily/i.test(JSON.stringify(await res.json())); } catch { /* no body */ }
    isbndbState.status = "rate_limited";
    isbndbState.lastError = daily ? "The daily quota of the ISBNdb plan is used up (it resets at 00:00 UTC)." : "The per-minute quota of the ISBNdb plan was exceeded.";
    isbndbState.pausedUntil = now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : daily ? 30 * 60 * 1000 : 60 * 1000);
    warnOnce(`quota${daily}`, isbndbState.lastError);
    return { state: "error" };
  }
  if (res.status === 404) { isbndbState.status = "ok"; isbndbState.lastOkAt = now(); return { state: "missing" }; }
  if (!res.ok) { isbndbState.status = "error"; isbndbState.lastError = `ISBNdb answered HTTP ${res.status}.`; return { state: "error" }; }
  let data;
  try { data = await res.json(); } catch { return { state: "error" }; }
  isbndbState.status = "ok";
  isbndbState.lastError = null;
  isbndbState.lastOkAt = now();
  isbndbState.warned.clear(); // a later problem is logged again
  const book = fromIsbndb(data && data.book, helpers);
  return book ? { state: "ok", book } : { state: "missing" };
}

function resetSourcePauses() {
  googlePause.until = 0;
  Object.assign(isbndbState, { nextSlot: 0, pausedUntil: 0, status: "unknown", lastError: null, lastOkAt: null, lastCallAt: null, calls: 0 });
  isbndbState.warned.clear();
}

module.exports = {
  USER_AGENT, isbnForms, isFrenchIsbn, isbn10to13, isbn13to10, openLibraryData, googleBooks, bnf, isbndb, isbndbConfigured, isbndbStatus, isbndbBase, fromIsbndb, fromBnf, fromGoogle, fromOpenLibraryData, resetSourcePauses, getJson,
};
