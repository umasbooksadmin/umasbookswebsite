// The words that name the goods in reservation emails and in the cart/receipt sentences (lib/orderEmail.js, lib/legalText.js):
// books only (unchanged), educational items only, or both. Educational items are new goods, so no "books" and no
// "used books are not taken back" for an order that holds only items.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOrderConfirmationText, buildGuestConfirmEmail, buildReservationReminder, buildReservationExpiredNotice } = require("../../src/lib/orderEmail");
const { forItems, itemsKind, noReturnsShortPlain, legalFor } = require("../../src/lib/legalText");

const base = { id: 42, buyer_name: "Ada", total_amount: "12.50", created_at: "2026-03-05T23:30:00Z", reserved_until: "2026-03-19T23:00:00Z" };
const book = { item_title: "Emma", price: "6.00" };
const edu = { item_title: "Colours Flash Cards", price: "5.00", edu_item_id: 3 };
const seat = { item_title: "Drop-in", price: "8.00", class_dropin_seat_id: 9 };
const sets = { books: [book], edu: [edu], mixed: [book, edu], seats: [seat] };

test("itemsKind: books (also seats alone), edu, mixed", () => {
  assert.equal(itemsKind({ books: true }), "books");
  assert.equal(itemsKind({}), "books");
  assert.equal(itemsKind({ edu: true }), "edu");
  assert.equal(itemsKind({ books: true, edu: true }), "mixed");
});

test("book-only reservation: the existing wording is unchanged (cart sentences are the legalText constants)", () => {
  const l = legalFor("en"), b = forItems("en", "books");
  assert.equal(b.nothingPaidOnline, l.nothingPaidOnline);
  assert.equal(b.pickupWhere, l.pickupWhere);
  assert.equal(b.noReturns, l.noReturns);
  assert.equal(b.noReturnsShort, l.noReturnsShort);
  assert.match(l.nothingPaidOnline, /We hold your books for 14 days/);
  assert.equal(forItems("fr", undefined).noReturns, legalFor("fr").noReturns);
  for (const lang of ["en", "fr"]) {
    const t = buildOrderConfirmationText({ ...base, lang }, sets.books, "https://shop.test/");
    assert.match(t, lang === "en" ? /We hold your books until the end of 19 March 2026/ : /Nous gardons vos livres jusqu’à la fin/);
    assert.match(t, lang === "en" ? /after checking the book: you are free to decline it/ : /après avoir vérifié le livre/);
    assert.match(t, lang === "en" ? /Collect your books during our regular hours/ : /retirer vos livres/);
    assert.doesNotMatch(t, /educational|éducatifs/i);
  }
});

test("educational items only: 'items', new goods, no used books, in the confirmation (EN and FR)", () => {
  const en = buildOrderConfirmationText({ ...base, lang: "en" }, sets.edu, "https://shop.test/");
  assert.match(en, /We hold your items until the end of 19 March 2026/);
  assert.match(en, /All educational items are new\./);
  assert.match(en, /Collect your items during our regular hours/);
  assert.match(en, /after checking the items: you are free to decline them/);
  assert.match(en, /after you have seen the items\. The legal guarantees still apply\./, "the rights block names items");
  assert.doesNotMatch(en, /after you have seen the book\b|Used books|Collect your books|hold your books/);
  const fr = buildOrderConfirmationText({ ...base, lang: "fr" }, sets.edu, "https://shop.test/");
  assert.match(fr, /Nous gardons vos articles jusqu’à la fin/);
  assert.match(fr, /Tous les articles éducatifs sont neufs\./);
  assert.match(fr, /retirer vos articles/);
  assert.match(fr, /après avoir vérifié les articles\s*: vous êtes libre de les refuser/);
  assert.match(fr, /après avoir vu les articles/);
  assert.doesNotMatch(fr, /après avoir vu le livre|Les livres d’occasion|retirer vos livres|vos livres/);
});

test("books and educational items: 'items'; the used-books rule stays, for the books", () => {
  const en = buildOrderConfirmationText({ ...base, lang: "en" }, sets.mixed, "https://shop.test/");
  assert.match(en, /We hold your items until the end/);
  assert.match(en, /All educational items are new\./);
  assert.match(en, /after you have seen the items\. Used books are not taken back/);
  assert.doesNotMatch(en, /after you have seen the book\b|hold your books/);
  const fr = buildOrderConfirmationText({ ...base, lang: "fr" }, sets.mixed, "https://shop.test/");
  assert.match(fr, /après avoir vu les articles\. Les livres d’occasion ne sont ni repris/);
});

test("guest confirmation email: 'items' and the new-goods line when educational items are in it; 'books' otherwise", () => {
  const urls = { confirmUrl: "https://shop.test/c/x", manageUrl: "https://shop.test/m/y" };
  const o = { ...base, lang: "en" };
  assert.match(buildGuestConfirmEmail(o, sets.books, urls).text, /we hold your books for 14 days/);
  for (const k of ["edu", "mixed"]) {
    const en = buildGuestConfirmEmail(o, sets[k], urls).text;
    assert.match(en, /we hold your items for 14 days/);
    assert.match(en, /All educational items are new\./);
    assert.doesNotMatch(en, /hold your books/);
    const fr = buildGuestConfirmEmail({ ...base, lang: "fr" }, sets[k], urls).text;
    assert.match(fr, /nous gardons vos articles 14 jours/);
    assert.match(fr, /Tous les articles éducatifs sont neufs\./);
    assert.doesNotMatch(fr, /vos livres/);
  }
  assert.doesNotMatch(buildGuestConfirmEmail(o, sets.books, urls).text, /educational/);
});

test("reminder and expiry emails: items wording, and for educational items only no 'second-hand books' sentence", () => {
  for (const [k, lang] of [["edu", "en"], ["edu", "fr"], ["mixed", "en"], ["mixed", "fr"]]) {
    const r = buildReservationReminder({ ...base, lang }, sets[k], "https://shop.test");
    assert.match(r.subject, lang === "en" ? /reserved items/ : /articles réservés/);
    assert.doesNotMatch(r.text, lang === "en" ? /Collect your books|want the books/ : /vos livres|ces livres/);
    assert.match(r.text, lang === "en" ? /Collect your items/ : /retirer vos articles/);
    const x = buildReservationExpiredNotice({ ...base, lang }, sets[k], "https://shop.test");
    assert.equal(/econd-hand books|livres d’occasion/i.test(x.text), k === "mixed", `${k} ${lang}: the second-hand sentence only when a used book is in the order`);
  }
  assert.match(buildReservationReminder({ ...base, lang: "en" }, sets.books, "https://shop.test").subject, /reserved books/);
  assert.equal(noReturnsShortPlain("en", "", "edu"), "Your legal guarantees still apply.");
  assert.match(noReturnsShortPlain("en", "", "books"), /Second-hand books/);
});

test("cart and receipt sentences for items (EN/FR): hold period once, 'items', no 'books'", () => {
  for (const kind of ["edu", "mixed"]) for (const lang of ["en", "fr"]) {
    const f = forItems(lang, kind);
    assert.match(f.nothingPaidOnline, lang === "en" ? /We hold your items for 14 days/ : /Nous gardons vos articles 14 jours/);
    assert.doesNotMatch(f.pickupWhere, /hold|gardons|14 days|14 jours|book|livre/i);
    assert.ok(f.pickup.includes(f.pickupWhere), "pickup = hold + pickupWhere");
    assert.doesNotMatch(f.shopHoursFirm, /book|livre/i);
  }
  assert.doesNotMatch(forItems("en", "edu").noReturns, /book/);
  assert.match(forItems("en", "mixed").noReturns, /Used books are not taken back/);
});
