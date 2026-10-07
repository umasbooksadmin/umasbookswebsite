// The drop-in withdrawal waiver is GONE: it was only asked because a seat was
// paid online (the customer waived the 14-day withdrawal right to attend a
// dated session). Seats are now reserved and paid at the session, so the cart
// shows no 'waiveWithdrawal' box, a drop-in reservation needs nothing but the
// terms box, and orders.withdrawal_waiver_at stays NULL (the column remains for
// the old orders that have it).
//
// (The tests "drop-in checkout without the box is refused" and "with the box the
// waiver time is stored" were deleted with the box: they protected behaviour
// that no longer exists.)

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("dropin_waiver");
const { pool } = h;
before(() => h.start());
after(() => h.stop());

test("the cart shows no withdrawal-waiver box, with a drop-in seat or without (EN and FR)", async () => {
  const classId = await h.session({ price: 12 });
  const copy = await h.copy();
  for (const lang of ["en", "fr"]) {
    const v = h.visitor(await h.account(), { lang });
    await v.post("/cart/add-dropin", { classId });
    const seatPage = (await v.get("/cart")).text;
    assert.match(seatPage, /name="acceptCgv"/, `${lang}: the terms box is still there`);
    assert.doesNotMatch(seatPage, /waiveWithdrawal|waive|renonc/i, `${lang}: no waiver box for a seat`);
    const w = h.visitor(await h.account(), { lang });
    await w.post("/cart/add", { copyId: copy });
    assert.doesNotMatch((await w.get("/cart")).text, /waiveWithdrawal/, `${lang}: nor for books`);
  }
});

test("a drop-in seat is reserved with only the terms box ticked; no waiver time is stored", async () => {
  const buyer = await h.account();
  const classId = await h.session({ price: 12 });
  const v = h.visitor(buyer);
  await v.post("/cart/add-dropin", { classId });
  const r = await v.post("/cart/reserve", { name: "Waiver Buyer", acceptCgv: "on" });
  assert.equal(r.status, 302);
  const [order] = await h.ordersOf(buyer);
  assert.equal(order.status, "reserved");
  assert.equal(order.withdrawal_waiver_at, null);
  const seat = (await pool.query("SELECT status, order_id FROM class_dropin_seats WHERE class_id = $1", [classId])).rows;
  assert.deepEqual(seat.map((s) => s.status), ["reserved"]);
});

test("a posted waiveWithdrawal field changes nothing: still no waiver time stored, for a seat or for books", async () => {
  const buyer = await h.account();
  const classId = await h.session({ price: 12 });
  const copy = await h.copy();
  const v = h.visitor(buyer);
  await v.post("/cart/add-dropin", { classId });
  await v.post("/cart/add", { copyId: copy });
  assert.equal((await v.post("/cart/reserve", { name: "Old Form", acceptCgv: "on", waiveWithdrawal: "on" })).status, 302);
  const [order] = await h.ordersOf(buyer);
  assert.equal(order.withdrawal_waiver_at, null);
});

test("books-only reservation stores no waiver time either", async () => {
  const buyer = await h.account();
  const { order } = await h.reserve(buyer, { copyIds: [await h.copy()] });
  assert.equal(order.withdrawal_waiver_at, null);
});
