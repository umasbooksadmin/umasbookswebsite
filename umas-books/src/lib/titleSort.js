// Alphabetical order for book titles ignores a leading "The", "A" or "An".
//
// Same rule as books.title_sort (migrations/086 and 099_books_title_sort_a_an.sql), which
// the SQL "ORDER BY b.title_sort, b.title, b.id" uses. This is the JavaScript
// twin for anything that sorts titles in code instead of the database.
//   - leading spaces, quotes, brackets and other punctuation are ignored;
//   - then one leading "The", "A" or "An" (any capitals) is ignored, only when it is a
//     whole first word followed by a space, so "Theory", "Anne" and "A. J. Ayer" are untouched;
//   - a title that is only "The", "A" or "An" (or only punctuation) keeps its own text.
// The French articles are deliberately NOT ignored.
// The shown title is never changed: this is only the sort key.

const NOT_ALNUM = "[^\\p{L}\\p{N}]";
const LEADING_PUNCT = new RegExp(`^${NOT_ALNUM}+`, "u");
const LEADING_THE = new RegExp(`^(?:the${NOT_ALNUM}*|an?)\\s${NOT_ALNUM}*([\\p{L}\\p{N}])`, "iu");

function sortTitleKey(title) {
  const t = String(title == null ? "" : title);
  const stripped = t.replace(LEADING_PUNCT, "") || t;
  return stripped.replace(LEADING_THE, "$1").toLowerCase();
}

// Accents and capitals do not matter ("Élan" next to "Elan"). Digits compare
// as text, like the database does ("10 Down" before "2 Fast"), so both agree.
const collator = new Intl.Collator("en", { sensitivity: "base" });

// For Array.sort over { title, id } rows (or plain title strings): sort key,
// then the full original title, then id, so the order is stable.
function compareTitles(a, b) {
  const ta = typeof a === "string" ? a : a.title;
  const tb = typeof b === "string" ? b : b.title;
  return (
    collator.compare(sortTitleKey(ta), sortTitleKey(tb)) ||
    collator.compare(String(ta || ""), String(tb || "")) ||
    ((typeof a === "object" && typeof b === "object" ? Number(a.id) - Number(b.id) : 0) || 0)
  );
}

module.exports = { sortTitleKey, compareTitles };
