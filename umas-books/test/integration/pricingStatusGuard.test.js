// Review 5, item B: price writes only touch copies that are still in stock. A sold/reserved copy keeps its price
// (it is part of the sale / reservation record). Covers "Use this price", the Price check "use" button (race) and
// the clearance apply loop, whose candidate list is computed before the writes (a copy can be sold in between).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const clearance = require("../../src/lib/pricing/clearance");
let stale = []; // candidates the (mocked) list returns, as if computed a moment before the writes
clearance.clearanceCandidates = async () => stale;

const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("pricing_status_guard", ["inventory", "pricing"], { isolated: true });

before(() => h.start());
after(() => h.stop());

let n = 0;
async function seed(statuses) {
  const [book] = await h.q("INSERT INTO books (isbn, title, authors, description, cover_url) VALUES ($1, $2, 'A', 'd', '/c.png') RETURNING id",
    [`97800000${String(10000 + ++n)}`.slice(0, 13), `Guard ${n}`]);
  const ids = [];
  for (const status of statuses) {
    const [c] = await h.q("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 8, $2) RETURNING id", [book.id, status]);
    ids.push(c.id);
  }
  return { bookId: book.id, ids };
}
const price = async (id) => Number((await h.q("SELECT price FROM book_copies WHERE id = $1", [id]))[0].price);

test("'Use this price' refuses a sold or reserved copy and leaves its price alone", async () => {
  const { bookId, ids } = await seed(["sold", "reserved"]);
  for (const id of ids) {
    const r = await h.post(`/admin/inventory/${bookId}/copies/${id}/use-price`, {});
    assert.equal(r.res.status, 200);
    assert.match(r.text, /no longer in stock/);
    assert.equal(await price(id), 8);
  }
  assert.equal((await h.q("SELECT 1 FROM admin_audit_log WHERE action = 'copy.reprice' AND target_id = ANY($1)", [ids])).length, 0);
});

test("clearance apply: only copies still in stock are repriced; the rest are skipped and counted", async () => {
  const { ids } = await seed(["in_stock", "sold", "reserved", "in_stock"]);
  stale = ids.map((id) => ({ id, price: 8 }));
  const r = await h.post("/admin/pricing/clearance", {});
  assert.equal(r.res.status, 302);
  assert.match(r.res.headers.get("location"), /cleared=2&skipped=2/);
  assert.deepEqual(await Promise.all(ids.map(price)), [1, 8, 8, 1]);
  const audited = await h.q("SELECT target_id FROM admin_audit_log WHERE action = 'copy.reprice' AND target_id = ANY($1) ORDER BY target_id", [ids]);
  assert.deepEqual(audited.map((a) => a.target_id), [ids[0], ids[3]], "audit rows only for the copies really repriced");
  const page = await h.get(r.res.headers.get("location"));
  assert.match(page.text, /Clearance applied to 2 copies\. 2 copies were skipped/);
  stale = [];
});

test("Price check 'use suggested' on a copy that is no longer in stock changes nothing", async () => {
  const { ids } = await seed(["sold"]);
  const r = await h.post(`/admin/pricing/review/${ids[0]}`, { offset: "0" });
  assert.equal(r.res.status, 302);
  assert.equal(await price(ids[0]), 8);
  assert.match(r.res.headers.get("location"), /notice=gone/);
});
