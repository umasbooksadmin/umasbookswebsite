const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildBookSeo, itemCondition, absoluteUrl } = require("../../src/lib/bookSeo");
const { translator } = require("../../src/lib/lang");

const book = { id: 7, title: "Emma", authors: "Jane Austen", cover_url: "/img/abc", description: "A <comedy> of manners.", description_fr: "Une comédie de mœurs.", isbn: "9780141439587", binding: "trade" };
const copies = [
  { condition: "very_good", price: "4.50" },
  { condition: "new", price: "9.90" },
  { condition: "very_good", price: "4.50" },
  { condition: "acceptable", price: null },
];
const base = "https://books.example.test";

test("grades map to schema.org conditions", () => {
  assert.equal(itemCondition("new"), "https://schema.org/NewCondition");
  for (const g of ["like_new", "very_good", "acceptable"]) assert.equal(itemCondition(g), "https://schema.org/UsedCondition");
});

test("Book + Offer JSON-LD has the fields search engines need", () => {
  const { jsonLd, ogImage, description } = buildBookSeo({ book, copies, base, lang: "en", tr: translator("en") });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(jsonLd)));
  assert.equal(jsonLd["@type"], "Book");
  assert.equal(jsonLd.url, `${base}/books/7`);
  assert.equal(jsonLd.image, `${base}/img/abc`);
  assert.equal(ogImage, `${base}/img/abc`);
  assert.deepEqual(jsonLd.author, [{ "@type": "Person", name: "Jane Austen" }]);
  assert.equal(jsonLd.bookFormat, "https://schema.org/Paperback");
  assert.equal(description, "A <comedy> of manners.");
  assert.equal(jsonLd.offers.length, 2, "duplicates and unpriced copies are dropped");
  const o = jsonLd.offers.find((x) => x.price === "4.50");
  assert.equal(o.priceCurrency, "EUR");
  assert.equal(o.availability, "https://schema.org/InStock");
  assert.equal(o.itemCondition, "https://schema.org/UsedCondition");
  assert.deepEqual(o.seller, { "@type": "Organization", name: "Uma's Books" });
  assert.equal(jsonLd.offers.find((x) => x.price === "9.90").itemCondition, "https://schema.org/NewCondition");
});

test("French uses the French description; no copies means no offers; external covers stay as they are", () => {
  const seo = buildBookSeo({ book: { ...book, cover_url: "https://covers.openlibrary.org/x.jpg" }, copies: [], base, lang: "fr", tr: translator("fr") });
  assert.equal(seo.description, "Une comédie de mœurs.");
  assert.equal(seo.jsonLd.offers, undefined);
  assert.equal(seo.ogImage, "https://covers.openlibrary.org/x.jpg");
});

test("a book with no description gets a sentence; no base URL means no relative cover is invented", () => {
  const seo = buildBookSeo({ book: { ...book, description: "", description_fr: "" }, copies, base: "", lang: "en", tr: translator("en") });
  assert.match(seo.description, /^Emma by Jane Austen/);
  assert.equal(seo.ogImage, "");
  assert.equal(absoluteUrl("", "/x"), "");
});
