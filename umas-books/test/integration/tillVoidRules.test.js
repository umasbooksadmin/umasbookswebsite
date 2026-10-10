// L5: a till-only account (no two-step verification) must not be able to make money disappear.
//   * card-sale voids and the "I refunded the card" tick need an ADMIN;
//   * a till-only account may void a CASH sale, with a real reason, at most N times a day
//     (TILL_MAX_VOIDS_PER_DAY, default 3), beyond which an admin is needed;
//   * every void (who, when, amount, why) is shown on Needs attention, End of day and its CSV.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const till = require("../../src/lib/till");

let h;
let clerk;
before(async () => {
  h = await tillHarness({ port: 6131, ip: "10.82.3.3", env: { TILL_MAX_VOIDS_PER_DAY: "2" } });
  clerk = await h.makeUser({ till: true, name: "Clerk Clara" });
});
after(async () => { await h.stop(); });

async function sell(method, jar = h.jar) {
  const b = await h.seedBook(`Void Rule ${h.uniq()}`);
  const c = await h.seedCopy(b.id, { price: 6 });
  const r = await h.sale([h.book(c)], { method, jar, received: "10" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { saleId: r.body.saleId, copyId: c };
}
const sale = async (id) => (await h.pool.query("SELECT * FROM till_sales WHERE id = $1", [id])).rows[0];
const errorOf = (res) => decodeURIComponent((res.headers.get("location") || "").replace(/^.*error=/, ""));

test("default limit is 3 a day and can be set with TILL_MAX_VOIDS_PER_DAY", () => {
  assert.equal(till.maxTillVoidsPerDay({}), 3);
  assert.equal(till.maxTillVoidsPerDay({ TILL_MAX_VOIDS_PER_DAY: "5" }), 5);
  assert.equal(till.maxTillVoidsPerDay({ TILL_MAX_VOIDS_PER_DAY: "banana" }), 3);
});

test("a till-only account cannot void a CARD sale: refused, still completed, nothing put back", async () => {
  const s = await sell("card");
  const r = await h.post(`/admin/till/sales/${s.saleId}/void`, { reason: "customer changed mind", refundConfirmed: "1" }, clerk.jar);
  assert.match(errorOf(r), /Only an admin can void a card sale/);
  assert.equal((await sale(s.saleId)).status, "completed");
  assert.equal((await h.copy(s.copyId)).status, "sold");
  // the till page does not even offer the form to it
  const page = await h.get("/admin/till", clerk.jar);
  assert.match(page.text, /Only an admin can void a card sale/);
});

test("an admin can void a card sale and tick the refund; a till-only account cannot tick 'I refunded the card' later", async () => {
  const s = await sell("card");
  const v = await h.post(`/admin/till/sales/${s.saleId}/void`, { reason: "wrong book", refundConfirmed: "" });
  assert.match(v.headers.get("location"), /voided=/);
  assert.equal((await sale(s.saleId)).refund_confirmed, false);
  const forged = await h.post(`/admin/till/sales/${s.saleId}/refunded`, { back: "/admin/till" }, clerk.jar);
  assert.match(errorOf(forged), /Only an admin can confirm/);
  assert.equal((await sale(s.saleId)).refund_confirmed, false, "the till account could not tick it");
  const day = await h.get("/admin/till/day", clerk.jar);
  assert.doesNotMatch(day.text, /action="\/admin\/till\/sales\/\d+\/refunded"/);
  assert.match(day.text, /an admin confirms the refund/);
  await h.post(`/admin/till/sales/${s.saleId}/refunded`, { back: "/admin/till" });
  assert.equal((await sale(s.saleId)).refund_confirmed, true);
});

test("a till-only account cannot smuggle the refund tick in with a void either (card voids are refused outright)", async () => {
  const s = await sell("card");
  await h.post(`/admin/till/sales/${s.saleId}/void`, { reason: "x".repeat(10), refundConfirmed: "1" }, clerk.jar);
  assert.equal((await sale(s.saleId)).status, "completed");
  assert.equal((await sale(s.saleId)).refund_confirmed, false);
});

test("a till-only cash void needs a real reason (5+ characters)", async () => {
  const s = await sell("cash");
  const r = await h.post(`/admin/till/sales/${s.saleId}/void`, { reason: "no" }, clerk.jar);
  assert.match(errorOf(r), /at least 5 characters/);
  assert.equal((await sale(s.saleId)).status, "completed");
  const empty = await h.post(`/admin/till/sales/${s.saleId}/void`, { reason: "  " }, clerk.jar);
  assert.match(errorOf(empty), /reason is required/i);
});

test("a till-only account can void cash sales up to the daily limit; beyond it an admin is required (and an admin is never limited)", async () => {
  const user = await h.makeUser({ till: true, name: "Limited Lena" });
  const sales = [await sell("cash"), await sell("cash"), await sell("cash")];
  for (const s of sales.slice(0, 2)) {
    const r = await h.post(`/admin/till/sales/${s.saleId}/void`, { reason: "scanned twice by mistake" }, user.jar);
    assert.match(r.headers.get("location"), /voided=/);
    assert.equal((await sale(s.saleId)).status, "voided");
  }
  const third = await h.post(`/admin/till/sales/${sales[2].saleId}/void`, { reason: "scanned twice by mistake" }, user.jar);
  assert.match(errorOf(third), /already voided 2 sales today.*Ask an admin/);
  assert.equal((await sale(sales[2].saleId)).status, "completed");
  assert.equal((await h.copy(sales[2].copyId)).status, "sold");
  // another till account has its own allowance
  const other = await h.post(`/admin/till/sales/${sales[2].saleId}/void`, { reason: "scanned twice by mistake" }, clerk.jar);
  assert.match(other.headers.get("location"), /voided=/);
  // the admin is not limited
  for (let i = 0; i < 3; i++) {
    const s = await sell("cash");
    const r = await h.post(`/admin/till/sales/${s.saleId}/void`, { reason: "ok" });
    assert.match(r.headers.get("location"), /voided=/);
  }
});

test("every void is listed: Needs attention (admin), End of day and its CSV show who, when, amount and reason", async () => {
  const user = await h.makeUser({ till: true, name: "Visible Vera" });
  const s = await sell("cash");
  await h.post(`/admin/till/sales/${s.saleId}/void`, { reason: "dropped on the floor" }, user.jar);

  const dash = await h.get("/admin");
  assert.equal(dash.res.status, 200);
  const re = new RegExp(`Till void today: sale ${s.saleId}, €6\\.00 cash, by Visible Vera \\(till account\\) at \\d\\d:\\d\\d: dropped on the floor`);
  assert.match(dash.text, re);

  const day = await h.get("/admin/till/day");
  assert.match(day.text, /id="voids"/);
  assert.match(day.text, /Visible Vera \(till account\)/);
  assert.match(day.text, /dropped on the floor/);

  const csv = await h.get("/admin/till/day?format=csv");
  assert.match(csv.text, /"Voided by","Voided at \(Paris\)"/);
  const line = csv.text.split("\r\n").find((l) => l.startsWith(`${s.saleId},`));
  assert.match(line, /Visible Vera/);
  assert.match(line, /dropped on the floor/);
  const audit = (await h.audit("till.void")).filter((a) => a.target_id === s.saleId);
  assert.match(audit[0].detail, /by till account: dropped on the floor/);
});
