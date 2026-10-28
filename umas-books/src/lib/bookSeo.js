// Search-engine and link-preview data for a book page (/books/:id): the
// meta description, the absolute cover URL for og:image, and the schema.org
// Book + Offer JSON-LD. Pure (no request/DB access) so it is easy to test.
const { isPurchasablePrice } = require("./inventory");

const SELLER = { "@type": "Organization", name: "Uma's Books" };

// A copy's grade -> schema.org itemCondition. Only "new" is new; every used
// grade (like new, very good, good, acceptable) is UsedCondition.
function itemCondition(grade) {
  return grade === "new" ? "https://schema.org/NewCondition" : "https://schema.org/UsedCondition";
}

function absoluteUrl(base, u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (!base) return "";
  return base.replace(/\/+$/, "") + (u.startsWith("/") ? "" : "/") + u;
}

function clip(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[\s,;:.-]+$/, "") + "…";
}

// Books have an English description only (Sharon, 2026-10-28): the French page's meta description is the same text.
function bookDescription(book, lang, tr) {
  const own = book.description;
  if (own && String(own).trim()) return clip(own, 200);
  const by = book.authors ? tr(" by {a}", " de {a}", { a: book.authors }) : "";
  return tr(
    "{t}{by}: a pre-loved English book at Uma's Books in Albi, France.",
    "{t}{by} : un livre anglais d’occasion chez Uma’s Books, à Albi.",
    { t: book.title, by }
  );
}

// The exact brand string of a book page's <title>. Never alter it.
const TITLE_BRAND = "Uma's Books and Adventures";
// The part before the brand stays near 60 characters (what a results page shows); the full title is still the page's h1.
const TITLE_HEAD_MAX = 60;
const VOWEL_START = /^[aeiouyàâäéèêëîïôöùûüœ]/i;

// "Emma by Jane Austen — Uma's Books and Adventures" / "Emma de Jane Austen — ..." ("d’Agatha Christie" before a
// vowel). No author: the title alone. If title + author is too long the author goes first, then the title is
// clipped at a word boundary with an ellipsis.
function bookPageTitle(book, lang) {
  const title = String(book.title || "").replace(/\s+/g, " ").trim();
  const authors = String(book.authors || "").replace(/\s+/g, " ").trim();
  let head = title;
  if (authors) {
    const by = lang === "fr"
      ? (VOWEL_START.test(authors) ? `${title} d’${authors}` : `${title} de ${authors}`)
      : `${title} by ${authors}`;
    if (by.length <= TITLE_HEAD_MAX) head = by;
  }
  if (head.length > TITLE_HEAD_MAX) head = clip(head, TITLE_HEAD_MAX);
  return `${head} — ${TITLE_BRAND}`;
}

// base: absolute site URL ('' when unknown). Returns { description, ogImage, jsonLd }.
function buildBookSeo({ book, copies, base, lang, tr }) {
  // The page's own address: /fr/books/12 in French (lib/frUrls.js), matching its canonical link.
  const url = base ? `${base.replace(/\/+$/, "")}${lang === "fr" ? "/fr" : ""}/books/${book.id}` : undefined;
  const image = absoluteUrl(base, book.cover_url);
  const description = bookDescription(book, lang, tr);

  const offers = [];
  const seen = new Set();
  for (const c of copies) {
    if (!isPurchasablePrice(c.price)) continue;
    const price = Number(c.price).toFixed(2);
    const key = `${c.condition}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const offer = {
      "@type": "Offer",
      price,
      priceCurrency: "EUR",
      availability: "https://schema.org/InStock",
      itemCondition: itemCondition(c.condition),
      seller: SELLER,
    };
    if (url) offer.url = url;
    offers.push(offer);
  }

  const jsonLd = { "@context": "https://schema.org", "@type": "Book", name: book.title };
  if (url) jsonLd.url = url;
  if (book.authors) jsonLd.author = String(book.authors).split(";").map((n) => n.trim()).filter(Boolean).map((n) => ({ "@type": "Person", name: n }));
  if (image) jsonLd.image = image;
  jsonLd.description = description;
  if (book.isbn) jsonLd.isbn = String(book.isbn);
  if (book.binding === "hardcover") jsonLd.bookFormat = "https://schema.org/Hardcover";
  else if (["trade", "mass_market", "paperback"].includes(book.binding)) jsonLd.bookFormat = "https://schema.org/Paperback";
  jsonLd.inLanguage = "en";
  if (offers.length) jsonLd.offers = offers.length === 1 ? offers[0] : offers;

  return { description, ogImage: image, jsonLd };
}

module.exports = { buildBookSeo, bookPageTitle, TITLE_BRAND, itemCondition, absoluteUrl };
