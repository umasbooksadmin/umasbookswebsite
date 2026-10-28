// The clean-up every saved genre goes through (English books.categories and French books.categories_fr), and the
// matching of a genre with the KNOWN genres (the taxonomy of lib/bookLookup.js and the managed list of Admin > Genres).
// Pure functions, no database and no other module: lib/bookLookup.js (translateGenresToFrench), lib/inventory.js
// (normalizeGenres) and lib/genreRules.js (the save paths and "Update all books") all use them.
//
// Why: a genre typed on a phone comes with a curly apostrophe ("Children’s Fiction"), and on a Mac ISO keyboard the
// § key sits next to 1, so "Children's Fiction§" gets saved. Neither matched the taxonomy, so the French stayed English.
//
// cleanGenreName("  Children’s   Fiction§ ") -> "Children's Fiction":
//   - typographic apostrophes (‘ ’ ‛ ʼ ′ ` ´) become the straight one
//   - control characters and every kind of space become one plain space, runs of spaces become one
//   - characters at the START that are not a letter, a digit or an opening bracket are dropped, and characters at the
//     END that are not a letter, a digit, a closing bracket, + or # (C++, C#) are dropped: §, ±, `, ~, *, ., ;, :,
//     quotes, dashes...
//   Nothing inside the name is touched: "Science-Fiction", "Health & Wellbeing", "Crime (Classic)", "Santé & Bien-être".
//
// migrations/107_genre_cleanup.sql does the very same in SQL (test/integration/genreCleanupMigration.test.js checks
// both give the same result). A "letter" is spelled out as code-point ranges (not \p{L} / [:alnum:]) because
// Postgres' [:alnum:] depends on the database locale: under the C locale "Économie" would lose its É.

const APOSTROPHES = "‘’‛ʼ′`´";
const SPACES = "\\u0000-\\u0020\\u007F\\u00A0\\u1680\\u2000-\\u200B\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";
// ASCII letters and digits, Latin-1 and Latin Extended letters (not × ÷), Greek to Latin Extended Additional, CJK, Hangul.
const LETTERS = "0-9A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02AF\\u0370-\\u1FFF\\u3040-\\u9FFF\\uAC00-\\uD7AF";
const LEAD_KEEP = "([{";
const TRAIL_KEEP = ")\\]}+#";

const APOSTROPHE_RE = new RegExp(`[${APOSTROPHES}]`, "g");
const SPACE_RE = new RegExp(`[${SPACES}]+`, "g");
const LEAD_RE = new RegExp(`^[^${LETTERS}${LEAD_KEEP}]+`);
const TRAIL_RE = new RegExp(`[^${LETTERS}${TRAIL_KEEP}]+$`);

function cleanGenreName(value) {
  return String(value == null ? "" : value)
    .replace(APOSTROPHE_RE, "'")
    .replace(SPACE_RE, " ")
    .replace(LEAD_RE, "")
    .replace(TRAIL_RE, "");
}

// The form two genres are compared in (case-insensitive).
function cleanKey(value) {
  return cleanGenreName(value).toLowerCase();
}

// "A, b ,, §" -> ["A", "b"]: split on commas, each one cleaned, empty ones dropped (nothing de-duplicated).
function cleanList(csv) {
  return String(csv == null ? "" : csv).split(",").map(cleanGenreName).filter(Boolean);
}

// The known genres: Map(key -> { en, fr }). Later sources win over earlier ones, as in translateGenresToFrench:
// the aliases, then the taxonomy, then the managed genres (the names the shop chose in Admin > Genres). A managed genre
// with no French name takes the taxonomy's French, else its English name (as lib/genreRules.js readRules does).
//   aliases  [[en, fr], ...]    common / commonFr  same order    managed  [{ name_en, name_fr }, ...]
function buildKnown({ aliases = [], common = [], commonFr = [], managed = [] } = {}) {
  const known = new Map();
  const put = (en, fr) => {
    const key = cleanKey(en);
    if (key) known.set(key, { en: cleanGenreName(en), fr });
  };
  for (const [en, fr] of aliases) put(en, fr);
  common.forEach((en, i) => put(en, commonFr[i]));
  for (const g of managed) {
    const fr = (g.name_fr && String(g.name_fr).trim()) || (known.get(cleanKey(g.name_en)) || {}).fr || cleanGenreName(g.name_en);
    put(g.name_en, fr);
  }
  return known;
}

// One English genre: cleaned, and spelled as the known genre when it is one ("children’s fiction§" -> "Children's Fiction").
function canonicalGenre(name, known) {
  const clean = cleanGenreName(name);
  const hit = known && known.get(clean.toLowerCase());
  return hit ? hit.en : clean;
}

// The English genres of a book: each one cleaned and canonical, duplicates dropped (case-insensitive), order kept.
// -> "Fantasy, Fiction" | null
function canonicalGenres(csv, known) {
  const seen = new Set();
  const out = [];
  for (const raw of cleanList(csv)) {
    const g = canonicalGenre(raw, known);
    const key = g.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out.length ? out.join(", ") : null;
}

// One English genre in French: the known genre's French, else the cleaned name itself.
function frenchOf(name, known) {
  const clean = cleanGenreName(name);
  const hit = known && known.get(clean.toLowerCase());
  return hit ? hit.fr : clean;
}

// The French genres of a book. A French list typed (or filled in) is kept, each entry cleaned, and an entry that is
// just the English name of a known genre ("Children's Fiction§") becomes its French ("Fiction jeunesse"). With no
// French at all, the French is made from the English. Duplicates dropped. -> string | null
function tidyFrench(frCsv, enCsv, known) {
  const typed = cleanList(frCsv);
  const list = typed.length ? typed.map((g) => frenchOf(g, known)) : cleanList(enCsv).map((g) => frenchOf(g, known));
  const seen = new Set();
  const out = list.filter((g) => {
    const key = g.toLowerCase();
    if (!g || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return out.length ? out.join(", ") : null;
}

// What migrations/107_genre_cleanup.sql does to ONE stored book, in JS (the migration test checks the SQL gives exactly
// this for every seeded book). -> { en, fr } (the values to store; equal to the input when nothing changes)
//   English: canonicalGenres. Left exactly as stored when only the spacing around the commas would change, or when
//            nothing would be left (a genre that is only "§" is not deleted by a data fix).
//   French:  stored French with entries: tidyFrench of it (same "spacing only" and "nothing left" rules).
//            No French: made from the English, but only when one of the genres is a known one.
function planGenreCleanup(categories, categoriesFr, known) {
  const sameItems = (csv, list) => {
    const raw = String(csv == null ? "" : csv).split(",").map((g) => g.trim()).filter(Boolean);
    return raw.length === list.length && raw.every((g, i) => g === list[i]);
  };
  let en = categories;
  const enNew = canonicalGenres(categories, known);
  if (enNew && !sameItems(categories, enNew.split(", "))) en = enNew;
  let fr = categoriesFr;
  if (cleanList(categoriesFr).length) {
    const frNew = tidyFrench(categoriesFr, null, known);
    if (frNew && !sameItems(categoriesFr, frNew.split(", "))) fr = frNew;
  } else if (enNew && cleanList(enNew).some((g) => known.has(g.toLowerCase()))) {
    fr = tidyFrench(null, enNew, known);
  }
  return { en, fr };
}

module.exports = { planGenreCleanup, APOSTROPHES, SPACES, LETTERS, LEAD_KEEP, TRAIL_KEEP, cleanGenreName, cleanKey, cleanList, buildKnown, canonicalGenre, canonicalGenres, frenchOf, tidyFrench };
