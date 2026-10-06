// Search-engine and link-preview data for a book page (/books/:id): the
// meta description, the absolute cover URL for og:image, and the schema.org
// Book + Offer JSON-LD. Pure (no request/DB access) so it is easy to test.
const { isPurchasablePrice } = require("./inventory");

const SELLER = { "@type": "Organization", name: "Uma's Books" };

// A copy's grade -> schema.org itemCondition. Only "new" is new; every used
// grade (like new, very good, acceptable) is UsedCondition.
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

function bookDescription(book, lang, tr) {
  const own = lang === "fr" ? (book.description_fr || book.description) : book.description;
  if (own && String(own).trim()) return clip(own, 200);
  const by = book.authors ? tr(" by {a}", " de {a}", { a: book.authors }) : "";
  return tr(
    "{t}{by}: a pre-loved English book at Uma's Books in Albi, France.",
    "{t}{by} : un livre anglais d’occasion chez Uma’s Books, à Albi.",
    { t: book.title, by }
  );
}

// base: absolute site URL ('' when unknown). Returns { description, ogImage, jsonLd }.
function buildBookSeo({ book, copies, base, lang, tr }) {
  const url = base ? `${base.replace(/\/+$/, "")}/books/${book.id}` : undefined;
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
  else if (book.binding === "paperback") jsonLd.bookFormat = "https://schema.org/Paperback";
  jsonLd.inLanguage = "en";
  if (offers.length) jsonLd.offers = offers.length === 1 ? offers[0] : offers;

  return { description, ogImage: image, jsonLd };
}

module.exports = { buildBookSeo, itemCondition, absoluteUrl };
