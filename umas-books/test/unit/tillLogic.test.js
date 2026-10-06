const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseTillScan } = require("../../src/lib/tillScan");
const till = require("../../src/lib/till");
const { ManualCard } = require("../../src/lib/cardPayments");

test("scan parsing: copy labels, ISBN-10/13 with hyphens, orders, unknown", () => {
  assert.deepEqual(parseTillScan("UB-1234"), { type: "copy", copyId: 1234 });
  assert.deepEqual(parseTillScan(" ub-7 "), { type: "copy", copyId: 7 });
  assert.deepEqual(parseTillScan("978-0-14-312755-0"), { type: "isbn", isbn: "9780143127550" });
  assert.deepEqual(parseTillScan("0-14-312755-X"), { type: "isbn", isbn: "014312755X" });
  assert.deepEqual(parseTillScan("0143127551"), { type: "isbn", isbn: "0143127551" });
  assert.deepEqual(parseTillScan("ORDER-42"), { type: "order", orderId: 42 });
  assert.equal(parseTillScan("hello").type, "unknown");
  assert.equal(parseTillScan("UB-").type, "unknown");
  assert.equal(parseTillScan("").type, "unknown");
  assert.equal(parseTillScan("123").type, "unknown");
});

test("cash change is exact in cents (no float drift)", () => {
  assert.deepEqual(till.cashChange(1010, 2000), { changeCents: 990 });
  assert.deepEqual(till.cashChange(1000, 1000), { changeCents: 0 });
  // 0.1 + 0.2 style traps
  assert.equal(till.cashChange(till.toCents("0.30"), till.toCents("1.00")).changeCents, 70);
  assert.equal(till.cashChange(till.toCents("4.35"), till.toCents("5")).changeCents, 65);
  assert.equal(till.parseCents("4,35").cents, 435);
  assert.equal(till.parseCents("1.005").error !== undefined, true);
  assert.match(till.cashChange(1000, 999).error, /still to pay/);
  assert.ok(till.cashChange(1000, -1).error);
});

test("manual card: paid only when the person confirmed; reference is trimmed", async () => {
  const c = new ManualCard();
  assert.equal((await c.startCharge(500, "tok")).status, "pending");
  assert.deepEqual(await c.startCharge(500, "tok", { confirmed: true, reference: " 1234 " }), { status: "paid", reference: "1234" });
  assert.deepEqual(await c.startCharge(500, "tok", { confirmed: true }), { status: "paid", reference: null });
  assert.equal((await c.startCharge(0, "tok", { confirmed: true })).status, "failed");
  assert.equal((await c.startCharge(500, "", { confirmed: true })).status, "failed");
  assert.match(c.instruction(1250), /Charge €12\.50 on the SumUp reader, then press Card paid/);
});
