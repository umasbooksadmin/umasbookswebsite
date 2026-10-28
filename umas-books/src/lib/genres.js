// How a book's genres are shown to CUSTOMERS. books.categories holds English
// genres, comma-separated ("Mystery, Fiction"). Books have no French genre
// (Sharon, 2026-10-28): the French site shows the same English genres, and
// books.categories_fr is no longer read or written (migration 107 emptied it).
// The functions keep their shape so the views and the collection API stay
// one code path for both languages.

// One genre ("Mystery") -> "Mystery", in both languages.
function genreLabel(genre) {
  return genre ? String(genre) : "";
}

// "Mystery, Fiction" -> the label to print, in both languages.
function genresLabel(csv) {
  return String(csv == null ? "" : csv);
}

module.exports = { genreLabel, genresLabel };
