// Review F, F10: a copy whose price was cleared (NULL) or set to 0 between the moment the cart was read and the
// moment the copy is locked for "Reserve" is NOT "taken by someone else": the customer gets a NOT_FOR_SALE message
// (English and French), nothing is held, and the copy is untouched. A copy really taken by someone else still says so.
// (The route re-reads the cart just before; the window is the wait on the row lock, reproduced here with a held lock.)

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("reserve_not_for_sale");
const { pool } = h;
before(() => h.start());
after(() => h.stop());

const { createReservation } = require("../../src/lib/cart");
const { TERMS_OF_SALE_VERSION } = require("../../src/lib/legal");

const FORM = { name: "Price Buyer", acceptCgv: "on" };
const TAKEN_EN = /something in your cart was just taken by someone else/;
const TAKEN_FR = /un article de votre panier vient d’être pris par quelqu’un d’autre/;

const line = (copyId, title, price = 8) => ({ kind: "book", copyId, title, price });
const reserveLib = (buyer, items) =>
  createReservation(pool, { user: { id: buyer.id, email: buyer.email }, name: "Price Buyer", items, lang: "en", acceptedVersion: TERMS_OF_SALE_VERSION });

for (const [label, setSql] of [["NULL", "price = NULL"], ["0", "price = 0"]]) {
  test(`lib: price set to ${label} before the lock: NOT_FOR_SALE with the title, nothing held`, async () => {
    const buyer = await h.account();
    const copy = await h.copy({ price: 8, title: `Unpriced ${label}` });
    try {
      await pool.query(`UPDATE book_copies SET ${setSql} WHERE id = $1`, [copy]);
    } catch (err) {
      assert.match(err.message, /check constraint/); // a CHECK constraint may forbid this value on this schema
      return;
    }
    await assert.rejects(() => reserveLib(buyer, [line(copy, `Unpriced ${label}`)]), (err) => {
      assert.equal(err.message, "NOT_FOR_SALE");
      assert.deepEqual(err.titles, [`Unpriced ${label}`]);
      return true;
    });
    assert.equal(await h.copyStatus(copy), "in_stock");
    assert.equal((await h.ordersOf(buyer)).length, 0, "the order row is rolled back");
  });
}

test("lib: a copy really taken by someone else is still SOLD_OUT", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 8 });
  await pool.query("UPDATE book_copies SET status = 'reserved' WHERE id = $1", [copy]);
  await assert.rejects(() => reserveLib(buyer, [line(copy, "Taken")]), /SOLD_OUT/);
});

test("lib: one unpriced and one taken copy together: SOLD_OUT (something WAS taken)", async () => {
  const buyer = await h.account();
  const a = await h.copy({ price: 8 });
  const b = await h.copy({ price: 8 });
  await pool.query("UPDATE book_copies SET price = NULL WHERE id = $1", [a]);
  await pool.query("UPDATE book_copies SET status = 'reserved' WHERE id = $1", [b]);
  await assert.rejects(() => reserveLib(buyer, [line(a, "A"), line(b, "B")]), /SOLD_OUT/);
});

// The price is cleared while the reservation waits on the row lock.
async function clearedWhileWaiting(lang, title) {
  const buyer = await h.account();
  const v = h.visitor(buyer, { lang });
  const copy = await h.copy({ price: 8, title });
  await v.post("/cart/add", { copyId: copy });
  const holder = await pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT id FROM book_copies WHERE id = $1 FOR UPDATE", [copy]);
  const pending = v.post("/cart/reserve", { ...FORM, [`seenPrice_${copy}`]: "8.00" });
  await new Promise((r) => setTimeout(r, 400));
  await holder.query("UPDATE book_copies SET price = NULL WHERE id = $1", [copy]);
  await holder.query("COMMIT");
  holder.release();
  const r = await pending;
  return { r, copy, buyer };
}

test("route (English): the message says the book is no longer for sale, not that someone else took it", async () => {
  const { r, copy, buyer } = await clearedWhileWaiting("en", "Cleared Novel");
  assert.equal(r.seeOther, "/cart");
  assert.match(r.text, /&#34;Cleared Novel&#34; is no longer for sale at the moment \(it has no price\), so nothing was reserved/);
  assert.ok(!TAKEN_EN.test(r.text));
  assert.equal(await h.copyStatus(copy), "in_stock");
  assert.equal((await h.ordersOf(buyer)).length, 0);
});

test("route (French): the same message in French", async () => {
  const { r } = await clearedWhileWaiting("fr", "Roman effacé");
  assert.match(r.text, /Roman effacé[^<]*n’est plus en vente pour le moment \(il n’a plus de prix\), donc rien n’a été réservé/);
  assert.ok(!TAKEN_FR.test(r.text));
});
