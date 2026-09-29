// Book metadata lookups against Open Library's free, keyless API.
// Both functions return null/[] on any failure (not-found, network error,
// timeout) rather than throwing, so a lookup miss just falls through to
// manual entry in the UI.

function normalizeIsbn(isbn) {
  return (isbn || "").replace(/[^0-9Xx]/g, "").toUpperCase();
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
function translateGenresToFrench(genresCsv) {
  if (!genresCsv) return null;
  const byLowerEn = new Map(COMMON_GENRES.map((g, i) => [g.toLowerCase(), COMMON_GENRES_FR[i]]));
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

async function lookupByIsbn(rawIsbn) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return null;

  const data = await fetchJson(`https://openlibrary.org/api/volumes/brief/isbn/${isbn}.json`);
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
  };
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

module.exports = { normalizeIsbn, lookupByIsbn, searchByTitleAuthor, COMMON_GENRES, translateGenresToFrench };
