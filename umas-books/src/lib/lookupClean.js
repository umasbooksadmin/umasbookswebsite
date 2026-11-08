// Catalogue answers come with leftovers from seller listings: "How Bear Lost His Tail  [Paperback] [Jan 01, 2012] NILL" by
// the author "NILL". cleanLookupTitle() drops the bracketed format/date notes (and the junk word after them);
// cleanLookupAuthor() drops placeholder authors, so another source's real author can fill the field or the form says
// "Unknown". Used on every source's book before the sources are merged (lib/bookLookup.js mergeBooks).

const JUNK = new Set(["nill", "nil", "null", "none", "n/a", "na", "n.a.", "unknown", "undefined", "tbd", "-", "--"]);
const isJunk = (s) => JUNK.has(String(s).trim().toLowerCase());

const FORMAT_WORDS = /\b(paperback|hardcover|hardback|board\s*book|mass\s*market|library\s*binding|spiral|audio\s*cd|ebook|kindle|large\s*print|pocket)\b/i;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const DATE_NOTE = new RegExp(`^(?:${MONTH}\\.?\\s*\\d{0,2},?\\s*)?(?:19|20)\\d{2}$`, "i");

function isNote(inner) {
  const t = inner.trim();
  return FORMAT_WORDS.test(t) || DATE_NOTE.test(t);
}

// "Title  [Paperback] [Jan 01, 2012] NILL" -> "Title". Only format and date notes are removed (a "[Illustrated]" stays),
// and a junk word is dropped only when it comes straight after such a note (so "And Then There Were None" is safe).
function cleanLookupTitle(title) {
  if (title == null) return title;
  const original = String(title);
  let removed = false;
  let out = original.replace(/\s*\[([^\]]*)\]/g, (m, inner) => { if (isNote(inner)) { removed = true; return ""; } return m; });
  if (!removed) return original;
  out = out.replace(/\s+/g, " ").trim();
  // the junk word(s) that sat after the notes
  const tail = original.replace(/^[^]*\]/, "").trim();
  if (tail && tail.split(/\s+/).every(isJunk) && out.toLowerCase().endsWith(tail.toLowerCase())) out = out.slice(0, out.length - tail.length).trim();
  return out || original;
}

// "NILL" -> null; "Jane Doe, N/A" -> "Jane Doe".
function cleanLookupAuthor(author) {
  if (author == null) return author;
  const parts = String(author).split(",").map((p) => p.trim()).filter((p) => p && !isJunk(p));
  return parts.length ? parts.join(", ") : null;
}

function cleanLookupBook(book) {
  if (!book) return book;
  return { ...book, title: cleanLookupTitle(book.title), author: cleanLookupAuthor(book.author) };
}

module.exports = { cleanLookupTitle, cleanLookupAuthor, cleanLookupBook, isJunk };
