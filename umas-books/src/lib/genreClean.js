// The clean-up every saved book genre goes through (books.categories, English only), and the matching of a genre with
// the KNOWN genres (the taxonomy of lib/bookLookup.js COMMON_GENRES and the managed genres of Admin > Genres).
// Pure functions, no database and no other module: lib/inventory.js (normalizeGenres), lib/genreRules.js (the save
// paths) and migrations/109_genre_spelling_cleanup.sql (the same thing in SQL, for the books already saved) all use it.
//
// Why: a genre typed on a phone comes with a curly apostrophe ("Children’s Fiction"), and on a Mac ISO keyboard the
// § key sits next to 1, so "Children's Fiction§" gets saved, and "Chidren's Fiction" or "art & Design" were typed.
//
// cleanGenreName("  Children’s   Fiction§ ") -> "Children's Fiction":
//   - typographic apostrophes (‘ ’ ‛ ʼ ′ ` ´) become the straight one
//   - control characters and every kind of space become one plain space, runs of spaces become one
//   - characters at the START that are not a letter, a digit or an opening bracket are dropped, and characters at the
//     END that are not a letter, a digit, a closing bracket, + # ! ? (C++, C#) are dropped: §, ±, `, ~, *, ., ;, :,
//     quotes, dashes...
//   Nothing inside the name is touched: "Science-Fiction", "Health & Wellbeing", "Crime (Classic)".
// canonicalGenre: a genre that is a known one (any capitals) takes the known spelling ("art & design" -> "Art & Design"),
//   and the few typos listed in GENRE_TYPOS below take the right one. A genre that is not known is only cleaned: we
//   never guess a spelling.
//
// A "letter" is spelled out as code-point ranges (not \p{L} / [:alnum:]) because Postgres' [:alnum:] depends on the
// database locale; the SQL of the migration uses the very same ranges (test/integration/genreSpellingMigration.test.js
// checks both give the same result).

const APOSTROPHES = "‘’‛ʼ′`´";
const SPACES = "\\u0000-\\u0020\\u007F\\u00A0\\u1680\\u2000-\\u200B\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";
// ASCII letters and digits, Latin-1 and Latin Extended letters (not × ÷), Greek to Latin Extended Additional, CJK, Hangul.
const LETTERS = "0-9A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02AF\\u0370-\\u1FFF\\u3040-\\u9FFF\\uAC00-\\uD7AF";
const LEAD_KEEP = "([{";
const TRAIL_KEEP = ")\\]}+#!?";

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

// The typos we are SURE about: the cleaned, lower-case wrong spelling -> the genre it can only mean. Nothing else is
// ever corrected by guessing. Add a line here AND to the typo list of the migration (the migration test compares them).
const GENRE_TYPOS = [
  ["chidren's fiction", "Children's Fiction"],
  ["childrens fiction", "Children's Fiction"],
];

// The known genres: Map(key -> spelling). The typos first, then the taxonomy, then the managed genres (the names the
// shop chose in Admin > Genres) win over both. A typo only counts when its key is not itself a known genre; it takes
// the spelling the known genre has (a managed "Children's fiction" wins over the taxonomy's).
//   common  [name, ...]    managed  [{ name_en }, ...]
function buildKnown({ common = [], managed = [], typos = GENRE_TYPOS } = {}) {
  const known = new Map();
  const put = (name) => {
    const key = cleanKey(name);
    if (key) known.set(key, cleanGenreName(name));
  };
  for (const name of common) put(name);
  for (const g of managed) put(g.name_en);
  for (const [wrong, right] of typos) {
    const key = cleanKey(wrong);
    if (key && !known.has(key)) known.set(key, known.get(cleanKey(right)) || cleanGenreName(right));
  }
  return known;
}

// One genre: cleaned, and spelled as the known genre when it is one ("children’s fiction§" -> "Children's Fiction").
function canonicalGenre(name, known) {
  const clean = cleanGenreName(name);
  const hit = known && known.get(clean.toLowerCase());
  return hit || clean;
}

// The genres of a book: each one cleaned and canonical, duplicates dropped (case-insensitive), order kept.
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

// What migrations/109_genre_spelling_cleanup.sql does to ONE stored value, in JS (the migration test checks the SQL gives
// exactly this for every seeded book). -> the value to store (the input itself when nothing changes).
// Left exactly as stored when only the spacing around the commas would change, or when nothing would be left (a genre
// that is only "§" is not deleted by a data fix).
function planGenreCleanup(categories, known) {
  const next = canonicalGenres(categories, known);
  if (!next) return categories;
  const raw = String(categories == null ? "" : categories).split(",").map((g) => g.trim()).filter(Boolean);
  const list = next.split(", ");
  return raw.length === list.length && raw.every((g, i) => g === list[i]) ? categories : next;
}

module.exports = { GENRE_TYPOS, APOSTROPHES, SPACES, LETTERS, LEAD_KEEP, TRAIL_KEEP, cleanGenreName, cleanKey, cleanList, buildKnown, canonicalGenre, canonicalGenres, planGenreCleanup };
