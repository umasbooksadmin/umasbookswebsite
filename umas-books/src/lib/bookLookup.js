// Book metadata lookups against Open Library's free, keyless API.
// Both functions return null/[] on any failure (not-found, network error,
// timeout) rather than throwing, so a lookup miss just falls through to
// manual entry in the UI.

function normalizeIsbn(isbn) {
  return (isbn || "").replace(/[^0-9Xx]/g, "").toUpperCase();
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

// Same order as COMMON_GENRES — a fixed, deterministic translation (no AI
// call needed) since the taxonomy itself is fixed. Used to keep the
// AI-assigned/backfilled genre in French too (see translateGenresToFrench).
const COMMON_GENRES_FR = [
  "Fiction", "Non-fiction",
  "Fantasy", "Science-fiction", "Policier", "Romance", "Thriller", "Horreur",
  "Biographie", "Histoire", "Poésie", "Théâtre", "Aventure", "Humour",
  "Philosophie", "Religion", "Voyage", "Cuisine", "Art", "Développement personnel",
  "Fiction jeunesse", "Fiction jeune adulte", "Classiques",
];

// Translates a comma-joined genre string (must be drawn from COMMON_GENRES,
// e.g. from pickGenres/normalizeGenres) into French. A genre that isn't in
// the taxonomy (the rare free-text fallback in pickGenres, or something a
// staff member typed by hand) is kept as-is rather than dropped.
// Short forms of the age-group genres (the browse page's chips, hand-typed tags):
// not in the taxonomy above, but they must not stay English on a French page.
const GENRE_ALIASES_FR = [
  ["Young Adult", "Jeune adulte"], ["Young Adult Books", "Jeune adulte"],
  ["Children's", "Jeunesse"], ["Children's Books", "Jeunesse"], ["Children", "Jeunesse"], ["Juvenile Fiction", "Fiction jeunesse"],
  // Other tags that turn up from ISBN lookups, the browse page's topics and hand typing.
  ["Nonfiction", "Non-fiction"], ["Juvenile Nonfiction", "Documentaires jeunesse"], ["Picture Books", "Albums illustrés"],
  ["Memoir", "Mémoires"], ["Memoirs", "Mémoires"], ["Autobiography", "Autobiographie"], ["Biography & Autobiography", "Biographies et autobiographies"],
  ["Crime", "Polar"], ["Detective", "Policier"], ["Mystery & Detective", "Policier"], ["Suspense", "Suspense"], ["Crime & Mystery", "Polar"], ["True Crime", "Faits divers"],
  ["Sci-Fi", "Science-fiction"], ["Short Stories", "Nouvelles"], ["Graphic Novels", "Bandes dessinées"], ["Comics", "Bandes dessinées"], ["Comics & Graphic Novels", "Bandes dessinées"],
  ["Literary Fiction", "Littérature générale"], ["Historical Fiction", "Roman historique"], ["Humour", "Humour"], ["Humor & Entertainment", "Humour"],
  ["Self Help", "Développement personnel"], ["Self-Help", "Développement personnel"], ["Health", "Santé"], ["Health & Fitness", "Santé et forme"], ["Fitness", "Forme"], ["Wellness", "Bien-être"],
  ["Psychology", "Psychologie"], ["Business", "Économie et gestion"], ["Education", "Éducation"], ["Science", "Sciences"], ["Nature", "Nature"], ["Language", "Langues"],
  ["Social Science", "Sciences sociales"], ["Political Science", "Sciences politiques"], ["Music", "Musique"], ["Photography", "Photographie"], ["Antiques & Collectibles", "Antiquités et objets de collection"],
  ["Performing Arts", "Arts du spectacle"], ["Arts & Crafts", "Arts et loisirs créatifs"], ["Crafts & Hobbies", "Loisirs créatifs"], ["Design", "Design"],
  ["Gardening", "Jardinage"], ["Home & Garden", "Maison et jardin"], ["House & Home", "Maison"], ["Interior Design", "Décoration d'intérieur"],
  ["Food & Drink", "Cuisine et boissons"], ["Cooking & Food", "Cuisine"], ["Wine", "Vin"], ["Baking", "Pâtisserie"],
  ["Pets", "Animaux de compagnie"], ["Sports & Recreation", "Sports et loisirs"], ["Games", "Jeux"], ["Reference", "Ouvrages de référence"], ["Fairy Tales", "Contes"],
];

function translateGenresToFrench(genresCsv) {
  if (!genresCsv) return null;
  const byLowerEn = new Map([
    ...GENRE_ALIASES_FR.map(([en, fr]) => [en.toLowerCase(), fr]),
    ...COMMON_GENRES.map((g, i) => [g.toLowerCase(), COMMON_GENRES_FR[i]]),
  ]);
  return genresCsv.split(",").map((g) => {
    const trimmed = g.trim();
    return byLowerEn.get(trimmed.toLowerCase()) || trimmed;
  }).join(", ");
}

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
    return await res.json();
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

const envNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function createTtlCache({ max = 300, ttlMs = () => envNumber("SCAN_CACHE_TTL_MS", 10 * 60 * 1000), now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) { map.delete(key); return undefined; }
      map.delete(key); map.set(key, hit); // most recently used last
      return hit.value;
    },
    set(key, value) {
      const ttl = typeof ttlMs === "function" ? ttlMs() : ttlMs;
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
          if (!res.ok) return { state: res.status === 404 ? "missing" : "error" };
          return { state: "ok", data: await res.json() };
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
    author,
    publisher: Array.isArray(info.publishers) && info.publishers[0] ? info.publishers[0].name : null,
    publishedYear: extractYear(info.publish_date),
    description: typeof info.description === "string" ? info.description : (info.description && info.description.value) || null,
    coverUrl: (info.cover && (info.cover.large || info.cover.medium)) || null,
    genre,
    genreFr: translateGenresToFrench(genre),
    binding: mapBinding(info.physical_format || (record.details && record.details.details && record.details.details.physical_format)),
  };
}

// -> { book, state } with state "found" | "missing" (the catalog has no such book) |
// "slow" (gave up waiting) | "error" (network trouble). Never throws.
// opts: timeoutMs, hedgeMs, fetchImpl (tests), cache (a createTtlCache(), tests; false = no cache).
async function lookupByIsbnDetailed(rawIsbn, opts = {}) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return { book: null, state: "missing" };
  const cache = opts.cache === undefined ? lookupCache : opts.cache;
  const hit = cache ? cache.get(isbn) : undefined;
  if (hit) return { book: hit.book ? { ...hit.book } : null, state: hit.state, cached: true };

  const r = await fetchJsonRace(`https://openlibrary.org/api/volumes/brief/isbn/${isbn}.json`, {
    timeoutMs: opts.timeoutMs === undefined ? envNumber("SCAN_LOOKUP_TIMEOUT_MS", 4000) : opts.timeoutMs,
    hedgeMs: opts.hedgeMs === undefined ? envNumber("SCAN_LOOKUP_HEDGE_MS", 1500) : opts.hedgeMs,
    fetchImpl: opts.fetchImpl,
  });
  if (r.state === "timeout") return { book: null, state: "slow" };
  if (r.state === "error") return { book: null, state: "error" };
  const book = r.state === "ok" ? bookFromRecord(isbn, r.data) : null;
  const result = { book, state: book ? "found" : "missing" };
  if (cache) cache.set(isbn, result);
  return { book: book ? { ...book } : null, state: result.state };
}

// The book the catalog knows for an ISBN, or null (not found, slow, network error).
// Callers that are not the scan page (a photo, the saving of a book) can wait longer.
async function lookupByIsbn(rawIsbn, opts = {}) {
  return (await lookupByIsbnDetailed(rawIsbn, { timeoutMs: 8000, ...opts })).book;
}

async function searchByTitleAuthor(title, author) {
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
      genreFr: translateGenresToFrench(genre),
    };
  });
}

module.exports = { normalizeIsbn, mapBinding, lookupByIsbn, lookupByIsbnDetailed, createTtlCache, lookupCache, searchByTitleAuthor, COMMON_GENRES, COMMON_GENRES_FR, GENRE_ALIASES_FR, translateGenresToFrench };
