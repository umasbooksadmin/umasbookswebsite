// The Browse Books genre buttons (views/marketing/books.ejs renders them; public/page-books.js reads them back from the
// page). They are DATA now: the rows of managed_genres (Admin > Genres) that have show_on_browse, in browse_order, read
// through loadBrowseGenres() and cached for 60 s (cleared when a genre is edited and after Update all books). A button is:
//   slug    the stable value of ?genre= (kept for the 13 original buttons: old links still select the right genre)
//   key     g.<slug>, the page dictionary key; the English / French label (browse_label_*, else the managed name) is put
//           in the page's EN / FR dictionaries by views/marketing/books.ejs, so there is still one copy of every text
//   topic   comma-separated words matched against a book's categories ('' = every book): browse_topic, else the genre's
//           own name (routes/books.js /api/books/search ?topic= matches them as substrings, case-insensitive)
//   bg, fg  tile colours: one of PALETTE (colour key)
//   svg     icon paths: one of ICONS (icon key), drawn with the stroke settings in ICON_ATTRS
// "All Genres" is not a genre (no books carry it): it is ALL_BUTTON below, always the last button.
const config = require("./config");

const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';

// Tile colours (the nine pairs the buttons used before they were data). New genres rotate through them.
const PALETTE = {
  rose: { bg: "#f7dcdc", fg: "#a65347", label: "Rose" },
  sage: { bg: "#e0ebdc", fg: "#2b2a26", label: "Sage" },
  apricot: { bg: "#f4e4d2", fg: "#a65347", label: "Apricot" },
  sky: { bg: "#dbe8f0", fg: "#2b2a26", label: "Sky" },
  blush: { bg: "#f3d6d1", fg: "#a65347", label: "Blush" },
  pink: { bg: "#f7dfe2", fg: "#a65347", label: "Pink" },
  moss: { bg: "#e0ebdc", fg: "#43523a", label: "Moss" },
  coral: { bg: "#f7dede", fg: "#a65347", label: "Coral" },
  cream: { bg: "#f6e6d4", fg: "#a65347", label: "Cream" },
};
const PALETTE_KEYS = Object.keys(PALETTE);

// Icons (24x24 paths). "book" is the generic one new genres get; "star" is the All Genres button's.
const ICONS = {
  "open-book": { label: "Open book", svg: "<path d=\"M12 6.5C10.2 5.2 7.6 4.5 4 4.5v14c3.6 0 6.2.7 8 2 1.8-1.3 4.4-2 8-2v-14c-3.6 0-6.2.7-8 2z\"/><path d=\"M12 6.5v14\"/><path d=\"M6.5 8.5c1.5 0 2.8.3 3.8.8M6.5 11.5c1.5 0 2.8.3 3.8.8M17.5 8.5c-1.5 0-2.8.3-3.8.8M17.5 11.5c-1.5 0-2.8.3-3.8.8\"/>" },
  "rocking-horse": { label: "Rocking horse", svg: "<path d=\"M4 18h12\"/><path d=\"M5 18c-1-2-1-4 .5-5.5\"/><path d=\"M15 18c1-2 1-4-.5-5.5\"/><path d=\"M6 13h8.5c1.5 0 2.5-1 2.5-2.5V8.5l2-1.5-2-1-1.2-1.5c-.8 1-1.8 1.5-3 1.5H9c-2 0-3 1.5-3 3.5V13z\"/><path d=\"M8 13l-.5 5M13 13l.5 5\"/><circle cx=\"15\" cy=\"7.2\" r=\".5\" fill=\"currentColor\" stroke=\"none\"/>" },
  "leaf-quill": { label: "Leaf and quill", svg: "<path d=\"M6 20c1-7 5-12 13-15-1 8-6 12-13 15z\"/><path d=\"M6 20 15 9\"/><path d=\"M9.5 15.5H7M11.5 13v-2.5M11.5 13H14M14 10V8\"/>" },
  "globe": { label: "Globe", svg: "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M3.5 12h17\"/><path d=\"M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5S9.5 5.8 12 3.5z\"/>" },
  "book-stack": { label: "Stack of books", svg: "<path d=\"M4 7.5h14.5a1.5 1.5 0 0 1 0 3H4z\"/><path d=\"M5 10.5h13a1.5 1.5 0 0 1 0 3H5z\"/><path d=\"M4 13.5h14.5a1.5 1.5 0 0 1 0 3H4z\"/><path d=\"M5 16.5h13a1.5 1.5 0 0 1 0 3H5z\"/><path d=\"M6 4.5h12a1.5 1.5 0 0 1 0 3H6z\"/>" },
  "magnifier": { label: "Magnifying glass", svg: "<circle cx=\"10\" cy=\"10\" r=\"6\"/><path d=\"M14.5 14.5 20 20\"/><path d=\"M7 9.5a3 3 0 0 1 3-3\"/>" },
  "heart": { label: "Heart", svg: "<path d=\"M12 20s-7.5-4.6-9.5-9.3C1.2 7.3 3.3 4.5 6.3 4.5c2 0 3.8 1.3 5.7 3.5 1.9-2.2 3.7-3.5 5.7-3.5 3 0 5.1 2.8 3.8 6.2C19.5 15.4 12 20 12 20z\"/>" },
  "people": { label: "People", svg: "<circle cx=\"12\" cy=\"7.5\" r=\"2.6\"/><circle cx=\"6\" cy=\"9\" r=\"2.1\"/><circle cx=\"18\" cy=\"9\" r=\"2.1\"/><path d=\"M7.5 19.5c0-3 2-5.3 4.5-5.3s4.5 2.3 4.5 5.3\"/><path d=\"M2.5 18.5c0-2.4 1.5-4.3 3.5-4.3 1 0 1.8.4 2.4 1\"/><path d=\"M21.5 18.5c0-2.4-1.5-4.3-3.5-4.3-1 0-1.8.4-2.4 1\"/>" },
  "sprout": { label: "Sprout", svg: "<path d=\"M12 18c-2-2-3-4.5-3-7.5S10 5 12 3.5c2 1.5 3 4 3 7s-1 5.5-3 7.5z\"/><path d=\"M12 18c-3.5 0-6.5-2-8-5 2-.8 4.3-.7 6 .5\"/><path d=\"M12 18c3.5 0 6.5-2 8-5-2-.8-4.3-.7-6 .5\"/><path d=\"M4 18.5h16\"/>" },
  "palette": { label: "Paint palette", svg: "<path d=\"M12 3.5c-4.8 0-8.5 3.6-8.5 8.2 0 4.2 3.2 7.8 7.2 7.8 1.3 0 1.8-.8 1.8-1.6 0-1.3-1-1.6-1-2.7 0-1 .8-1.7 1.8-1.7h2.2c2.7 0 4.9-2 4.9-4.6C20.4 6.5 16.8 3.5 12 3.5z\"/><circle cx=\"7.8\" cy=\"11\" r=\"1.2\"/><circle cx=\"10\" cy=\"7.3\" r=\"1.2\"/><circle cx=\"14.5\" cy=\"7.3\" r=\"1.2\"/><circle cx=\"17\" cy=\"10.8\" r=\"1.1\"/>" },
  "map-globe": { label: "World map", svg: "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M7 5.5c.5 2 2.2 2.5 3 3.8.8 1.4-.4 2.3.8 3.4 1 1 2.6.2 3.2 1.6.4 1-.6 2.4-.4 3.6\"/><path d=\"M15.5 4.5c-.6 1.3.2 2.3 1.4 2.6 1.3.3 2.5 1 3 2.2\"/><path d=\"M4 13c1.5.2 2.6 1 3 2.5.3 1.2 0 2.5.8 3.5\"/>" },
  "pot": { label: "Cooking pot", svg: "<path d=\"M7 13.5V20h10v-6.5\"/><path d=\"M7 13.5a4 4 0 0 1-.7-7.9A4.5 4.5 0 0 1 12 3.5a4.5 4.5 0 0 1 5.7 2.1 4 4 0 0 1-.7 7.9z\"/><path d=\"M7 17h10\"/>" },
  "house": { label: "House", svg: "<path d=\"M3.5 11 12 4l8.5 7\"/><path d=\"M5.5 9.5V20h13V9.5\"/><path d=\"M10 20v-5.5h4V20\"/><path d=\"M9 11h6\"/>" },
  "star": { label: "Star", svg: "<path d=\"m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z\"/>" },
  "book": { label: "Book", svg: "<path d=\"M6 4.5h11a1.5 1.5 0 0 1 1.5 1.5v13H7.5A1.5 1.5 0 0 0 6 20.5z\"/><path d=\"M6 18.5V4.5\"/><path d=\"M9.5 8h5M9.5 11h5\"/>" },
};
const ICON_KEYS = Object.keys(ICONS);
const DEFAULT_ICON = "book";

const ALL_BUTTON = { slug: "all", key: "g.all", bg: PALETTE.cream.bg, fg: PALETTE.cream.fg, topic: "", svg: ICONS.star.svg, labelEn: "All Genres", labelFr: "Tous les genres" };

// A URL-safe, unique-able slug from an English name: "Science Fiction" -> "science-fiction". "all" is reserved.
function slugify(name) {
  const s = String(name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s && s !== "all" ? s : `genre-${s || "x"}`;
}

// The colour a new genre gets: the palette key after the previous genre's, so neighbours differ.
function nextColour(previous) {
  const i = PALETTE_KEYS.indexOf(previous);
  return PALETTE_KEYS[(i + 1) % PALETTE_KEYS.length];
}

// One managed_genres row -> a button.
function buttonFromRow(r) {
  const palette = PALETTE[r.colour] || PALETTE[PALETTE_KEYS[(r.id || 0) % PALETTE_KEYS.length]];
  const icon = ICONS[r.icon] || ICONS[DEFAULT_ICON];
  return {
    slug: r.browse_slug, key: `g.${r.browse_slug}`, bg: palette.bg, fg: palette.fg,
    topic: r.browse_topic != null && String(r.browse_topic).trim() !== "" ? String(r.browse_topic).trim() : r.name_en,
    svg: icon.svg,
    labelEn: r.browse_label_en || r.name_en,
    // Book genres are English on both sites (Sharon, 2026-10-28): the French page shows the English label too.
    labelFr: r.browse_label_en || r.name_en,
  };
}

const CACHE_MS = 60 * 1000;
const cacheMs = () => (config.isTest() ? 0 : CACHE_MS);
const caches = new WeakMap(); // pool -> { at, value }

// [button, ..., ALL_BUTTON]. A database problem leaves just the All Genres button (the page still works) or, when a
// list was read before, that list.
async function loadBrowseGenres(pool) {
  const hit = caches.get(pool);
  if (hit && Date.now() - hit.at < cacheMs()) return hit.value;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM managed_genres WHERE show_on_browse AND browse_slug IS NOT NULL ORDER BY browse_order, id`
    );
    const value = [...rows.map(buttonFromRow), ALL_BUTTON];
    caches.set(pool, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.error("Browse genres: could not read managed_genres:", err.message);
    return hit ? hit.value : [ALL_BUTTON];
  }
}

function clearBrowseGenreCache(pool) {
  if (pool) caches.delete(pool);
}

module.exports = { ICON_ATTRS, PALETTE, PALETTE_KEYS, ICONS, ICON_KEYS, DEFAULT_ICON, ALL_BUTTON, slugify, nextColour, buttonFromRow, loadBrowseGenres, clearBrowseGenreCache, CACHE_MS };
