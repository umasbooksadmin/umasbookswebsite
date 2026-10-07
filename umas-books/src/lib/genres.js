// How a book's genres are shown to CUSTOMERS. books.categories holds English
// genres, comma-separated ("Mystery, Fiction"); in French each one is shown
// through the fixed taxonomy (bookLookup.translateGenresToFrench), so a genre
// is never left in English just because the stored French copy
// (books.categories_fr) is blank, stale or was typed by hand in English.
// A genre outside the taxonomy keeps the matching entry of categories_fr when
// that field has one entry per genre, otherwise its original text.
// Admin screens do not use this: they always show the stored English value.

const { translateGenresToFrench } = require("./bookLookup");

function split(csv) {
  return String(csv == null ? "" : csv).split(",").map((g) => g.trim()).filter(Boolean);
}

// One genre ("Mystery") -> "Policier" in French; anything else unchanged.
function genreLabel(genre, lang) {
  if (lang !== "fr" || !genre) return genre || "";
  return translateGenresToFrench(String(genre).trim()) || "";
}

// "Mystery, Fiction" (+ optional stored French) -> the label to print.
function genresLabel(csv, lang, storedFr) {
  if (lang !== "fr") return String(csv == null ? "" : csv);
  const en = split(csv);
  const fr = split(storedFr);
  return en.map((g, i) => {
    const mapped = genreLabel(g, "fr");
    if (mapped.toLowerCase() !== g.toLowerCase()) return mapped;
    return fr.length === en.length && fr[i] ? fr[i] : g;
  }).join(", ");
}

module.exports = { genreLabel, genresLabel };
