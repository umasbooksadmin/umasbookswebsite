// The Reprice tool (/admin/pricing/reprice) and migration 085's settings move,
// end to end in-process on a database of this file's own.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("pricing_reprice", ["pricing"], { isolated: true });
const { clearSettingsCache } = require("../../src/lib/pricing/settings");
const reprice = require("../../src/lib/pricing/reprice");

let seq = 0;
const tag = () => `Rp${Date.now().toString(36)}${++seq}`;

async function book(binding, copies) {
  const [b] = await h.q("INSERT INTO books (title, authors, binding) VALUES ($1, 'A. Writer', $2) RETURNING id", [tag(), binding]);
  const ids = [];
  for (const c of copies) {
    const [r] = await h.q(
      `INSERT INTO book_copies (book_id, condition, price, status, is_clearance, cart_added_at, suggested_price, suggested_level, price_basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [b.id, c.condition || "good", c.price === undefined ? 8 : c.price, c.status || "in_stock", Boolean(c.clearance),
        c.inCart ? new Date() : null, c.suggested ?? null, c.level ?? null, c.basis ?? null]
    );
    ids.push(r.id);
  }
  return { id: b.id, ids };
}
const priceOf = async (id) => Number((await h.q("SELECT price FROM book_copies WHERE id = $1", [id]))[0].price);
const copy = async (id) => (await h.q("SELECT * FROM book_copies WHERE id = $1", [id]))[0];
const auditRows = (action) => h.q("SELECT * FROM admin_audit_log WHERE action = $1 ORDER BY id", [action]);
const runs = () => h.q("SELECT * FROM price_reprice_runs ORDER BY id");

before(async () => { await h.start(); });
after(async () => { await h.stop(); });
beforeEach(async () => {
  await h.q("DELETE FROM price_reprice_items");
  await h.q("DELETE FROM price_reprice_runs");
  await h.q("DELETE FROM admin_audit_log");
  await h.q("DELETE FROM book_requests");
  await h.q("DELETE FROM order_items");
  await h.q("DELETE FROM orders");
  await h.q("DELETE FROM book_copies");
  await h.q("DELETE FROM books");
  await h.q("UPDATE pricing_settings SET mass_market_price = 5, trade_price = 5 WHERE id = 1");
  clearSettingsCache();
});

// A world with every kind of copy a group must include or leave alone.
async function world() {
  const trade = await book("trade", [
    { price: 8 }, // 0 eligible
    { price: 3 }, // 1 eligible
    { price: 5 }, // 2 already 5
    { price: 8, clearance: true }, // 3 clearance: left alone
    { price: 8, status: "reserved" }, // 4
    { price: 8, status: "sold" }, // 5
    { price: 8, condition: "new" }, // 6 new book: publisher's price
    { price: null }, // 7 no price
    { price: 8, inCart: true }, // 8 in a cart
    { price: 8, status: "donated" }, // 9
    { price: 12, suggested: 12, level: "10", basis: "adjusted" }, // 10 eligible, with history to record
  ]);
  const mm = await book("mass_market", [{ price: 4 }, { price: 5 }, { price: 8 }, { price: 1, clearance: true }, { price: 6, status: "reserved" }]);
  const hard = await book("hardcover", [{ price: 8 }, { price: 10 }, { price: 8, clearance: true }, { price: 8.5 }, { price: 8, status: "reserved" }]);
  const other = await book("other", [{ price: 8 }]);
  const unknown = await book(null, [{ price: 8 }]);
  return { trade, mm, hard, other, unknown };
}

// What the confirm button posts: the count and hash of the preview shown just now.
const confirm = async (key) => {
  const p = await previewOf();
  return h.post(`/admin/pricing/reprice/${key}`, { expectedCount: String(p[key].count), expectedHash: p[key].hash });
};

const previewOf = async () => {
  const settings = await require("../../src/lib/pricing/settings").getSettings(h.pool);
  return Object.fromEntries((await reprice.previewGroups(h.pool, settings)).map((g) => [g.key, g]));
};

// ------------------------------------------------------------------ access

test("every reprice route: anonymous -> /login, member -> 403", async () => {
  const routes = [
    ["GET", "/admin/pricing/reprice"], ["POST", "/admin/pricing/reprice/trade"], ["POST", "/admin/pricing/reprice/mass_market"],
    ["POST", "/admin/pricing/reprice/eight_to_ten"], ["GET", "/admin/pricing/reprice/runs/1"], ["GET", "/admin/pricing/reprice/runs/1/export.csv"],
  ];
  for (const [method, p] of routes) {
    for (const [who, user, expect] of [["anonymous", null, 302], ["member", h.member, 403]]) {
      const res = method === "GET" ? (await h.get(p, user)).res : (await h.post(p, {}, { user })).res;
      assert.equal(res.status, expect, `${who} ${method} ${p}`);
      if (expect === 302) assert.match(res.headers.get("location"), /^\/login/);
    }
  }
});

// ----------------------------------------------------------------- preview

test("preview: counts and samples per group, only plain in-stock priced copies, and it changes nothing", async () => {
  const w = await world();
  const before = await h.q("SELECT id, price, updated_at FROM book_copies ORDER BY id");
  const p = await previewOf();
  assert.equal(p.trade.count, 3, "trade: 8, 3 and 12 only");
  assert.deepEqual(p.trade.sample.map((r) => r.id), [w.trade.ids[0], w.trade.ids[1], w.trade.ids[10]]);
  assert.equal(p.mass_market.count, 2, "mass market: 4 and 8");
  assert.equal(p.eight_to_ten.count, 3, "hardback, other and unknown at exactly 8 (not 8.50, not 10, not trade or mass market)");
  assert.deepEqual([p.trade.target, p.mass_market.target, p.eight_to_ten.target], [5, 5, 10]);

  const page = await h.get("/admin/pricing/reprice");
  assert.equal(page.res.status, 200);
  assert.match(page.text, /Group A: Trade copies[^<]*EUR 5\.00 \(3 to change\)/);
  assert.match(page.text, /Group B: Mass Market copies[^<]*EUR 5\.00 \(2 to change\)/);
  assert.match(page.text, /Group C: [^<]*EUR 10\.00 \(3 to change\)/);
  for (const g of ["trade", "mass_market", "eight_to_ten"]) assert.ok(page.text.includes(`action="/admin/pricing/reprice/${g}"`), `${g} has its own confirm button`);
  assert.deepEqual(await h.q("SELECT id, price, updated_at FROM book_copies ORDER BY id"), before, "nothing changed");
  assert.equal((await runs()).length, 0);
});

test("preview: an empty shop has nothing to change and no confirm button", async () => {
  const page = await h.get("/admin/pricing/reprice");
  assert.equal((page.text.match(/Nothing to change\./g) || []).length, 3);
  assert.ok(!page.text.includes('action="/admin/pricing/reprice/trade"'));
});

test("preview: copies held for a book request or in an open order are not listed", async () => {
  const t = await book("trade", [{ price: 8 }, { price: 8 }, { price: 8 }]);
  await h.q("INSERT INTO book_requests (title, status, matched_copy_id) VALUES ('x', 'notified', $1)", [t.ids[0]]);
  const [o] = await h.q("INSERT INTO orders (buyer_name, buyer_email, status, total_amount) VALUES ('n', 'n@example.test', 'reserved', 8) RETURNING id");
  await h.q("INSERT INTO order_items (order_id, book_copy_id, book_title, price) VALUES ($1, $2, 't', 8)", [o.id, t.ids[1]]).catch(async () => {
    await h.q("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 't', 8)", [o.id, t.ids[1]]);
  });
  const p = await previewOf();
  assert.deepEqual(p.trade.sample.map((r) => r.id), [t.ids[2]]);
});

// ----------------------------------------------------------------- confirm

test("confirm A: Trade copies go to 5.00 in one run, recorded on the copy, audited once, others untouched", async () => {
  const w = await world();
  const reservedBefore = await copy(w.trade.ids[4]);
  const r = await confirm("trade");
  assert.equal(r.res.status, 200, "lands on the result page");
  assert.match(r.text, /Group A: Trade copies: <strong>3<\/strong> copies changed to EUR 5\.00/);
  assert.match(r.text, /href="\/admin\/audit"/);
  assert.match(r.text, /\/export\.csv"/);

  for (const i of [0, 1, 10]) {
    const c = await copy(w.trade.ids[i]);
    assert.deepEqual([Number(c.price), Number(c.suggested_price), c.suggested_level, c.price_basis, c.is_clearance], [5, 5, "5", "repriced", false], `trade copy ${i}`);
  }
  // left alone: clearance, reserved, sold, new, no price, in a cart, donated, already 5
  assert.deepEqual(await Promise.all([3, 4, 5, 6, 8, 9].map((i) => priceOf(w.trade.ids[i]))), [8, 8, 8, 8, 8, 8]);
  assert.equal((await copy(w.trade.ids[3])).is_clearance, true);
  assert.equal((await copy(w.trade.ids[7])).price, null);
  assert.deepEqual(await copy(w.trade.ids[4]), reservedBefore, "a reserved copy keeps its row exactly");
  // groups B and C untouched
  assert.equal(await priceOf(w.mm.ids[0]), 4);
  assert.equal(await priceOf(w.hard.ids[0]), 8);

  const [run] = await runs();
  assert.deepEqual([run.group_key, Number(run.new_price), run.copies_changed, run.actor_user_id], ["trade", 5, 3, h.admin.id]);
  // Privacy: the run records the account and a role, never the administrator's email.
  assert.deepEqual([run.actor_role, run.actor_label], ["admin", null]);
  assert.ok(!JSON.stringify(run).includes("@"), "no email anywhere in the run row");
  assert.doesNotMatch(r.text, /@/, "the result page shows no email either");
  const items = await h.q("SELECT * FROM price_reprice_items WHERE run_id = $1 ORDER BY copy_id", [run.id]);
  assert.equal(items.length, 3);
  const withHistory = items.find((i) => i.copy_id === w.trade.ids[10]);
  assert.deepEqual([Number(withHistory.old_price), Number(withHistory.new_price), Number(withHistory.old_suggested_price), withHistory.old_suggested_level, withHistory.old_price_basis], [12, 5, 12, "10", "adjusted"]);
  const audits = await auditRows("pricing.reprice");
  assert.equal(audits.length, 1, "one audit row per group");
  assert.deepEqual([audits[0].target_type, audits[0].target_id, audits[0].actor_user_id], ["price_reprice_run", run.id, h.admin.id]);
  assert.match(audits[0].detail, /Group A \(trade\): 3 copies -> 5\.00/);
});

test("confirm is idempotent: a second run finds nothing, records no run and no audit row", async () => {
  await world();
  await confirm("trade");
  const second = await confirm("trade");
  assert.equal(second.res.status, 200);
  assert.match(second.text, /Group A: nothing left to change/);
  assert.equal((await runs()).length, 1);
  assert.equal((await auditRows("pricing.reprice")).length, 1);
  assert.equal((await previewOf()).trade.count, 0);
});

test("confirm B: Mass Market only, to the saved Mass market price", async () => {
  const w = await world();
  await h.q("UPDATE pricing_settings SET mass_market_price = 6 WHERE id = 1");
  clearSettingsCache();
  const r = await confirm("mass_market");
  assert.match(r.text, /Group B: Mass Market copies: <strong>3<\/strong> copies changed to EUR 6\.00/, "4, 5 and 8 are not 6");
  assert.deepEqual(await Promise.all([0, 1, 2, 3, 4].map((i) => priceOf(w.mm.ids[i]))), [6, 6, 6, 1, 6]);
  assert.equal((await copy(w.mm.ids[3])).is_clearance, true, "clearance left alone");
  assert.equal(await priceOf(w.trade.ids[0]), 8, "trade untouched");
});

test("confirm C: other bindings at exactly 8.00 go to 10.00; trade and mass market at 8 are not C's", async () => {
  const w = await world();
  const r = await confirm("eight_to_ten");
  assert.match(r.text, /<strong>3<\/strong> copies changed to EUR 10\.00/);
  assert.deepEqual(await Promise.all([0, 1, 2, 3, 4].map((i) => priceOf(w.hard.ids[i]))), [10, 10, 8, 8.5, 8], "hardback: 8 -> 10; 10, clearance, 8.50 and reserved unchanged");
  assert.equal(await priceOf(w.other.ids[0]), 10);
  assert.equal(await priceOf(w.unknown.ids[0]), 10);
  assert.equal(await priceOf(w.trade.ids[0]), 8, "trade at 8 waits for group A");
  assert.equal(await priceOf(w.mm.ids[2]), 8, "mass market at 8 waits for group B");
  // then A takes the trade copy to 5, never to 10
  await confirm("trade");
  assert.equal(await priceOf(w.trade.ids[0]), 5);
});

test("an unknown group is a 404 and changes nothing", async () => {
  const w = await world();
  const r = await h.post("/admin/pricing/reprice/everything", {});
  assert.equal(r.res.status, 404);
  assert.equal(await priceOf(w.trade.ids[0]), 8);
});

test("orders keep the price they were made at: a reserved copy's order line is not changed by any group", async () => {
  const t = await book("trade", [{ price: 8, status: "reserved" }]);
  const [o] = await h.q("INSERT INTO orders (buyer_name, buyer_email, status, total_amount) VALUES ('n', 'n@example.test', 'reserved', 8) RETURNING id");
  const col = (await h.q("SELECT column_name FROM information_schema.columns WHERE table_name = 'order_items' AND column_name IN ('book_title', 'item_title') ORDER BY 1 LIMIT 1"))[0].column_name;
  await h.q(`INSERT INTO order_items (order_id, book_copy_id, ${col}, price) VALUES ($1, $2, 't', 8)`, [o.id, t.ids[0]]);
  for (const g of ["trade", "mass_market", "eight_to_ten"]) await confirm(g);
  assert.equal(await priceOf(t.ids[0]), 8);
  assert.equal(Number((await h.q("SELECT price FROM order_items WHERE order_id = $1", [o.id]))[0].price), 8);
});

// -------------------------------------------------------------- concurrency

test("a copy sold or reserved between the preview and the confirmation: NOTHING is applied and the admin is told to re-preview", async () => {
  const w = await world();
  const p = await previewOf();
  assert.equal(p.trade.count, 3);
  // ... the shop sells one, and a customer reserves another, after the admin looked
  await h.q("UPDATE book_copies SET status = 'sold' WHERE id = $1", [w.trade.ids[0]]);
  await h.q("UPDATE book_copies SET status = 'reserved' WHERE id = $1", [w.trade.ids[1]]);
  const r = await h.post("/admin/pricing/reprice/trade", { expectedCount: String(p.trade.count), expectedHash: p.trade.hash });
  assert.match(r.text, /Group A was NOT changed[^<]*you confirmed 3, there are now 1/);
  assert.equal(await priceOf(w.trade.ids[0]), 8);
  assert.equal(await priceOf(w.trade.ids[1]), 3);
  assert.equal(await priceOf(w.trade.ids[10]), 12, "even the copy that is still eligible is not touched");
  assert.equal((await runs()).length, 0);
  assert.equal((await auditRows("pricing.reprice.refused")).length, 1);
  // confirming the NEW preview works
  const ok = await confirm("trade");
  assert.match(ok.text, /<strong>1<\/strong> copies changed/);
});

test("same count but different copies is refused too (the ids are compared, not just the count)", async () => {
  const t = await book("trade", [{ price: 8 }, { price: 8 }]);
  const p = await previewOf();
  const [b2] = await h.q("INSERT INTO books (title, authors, binding) VALUES ($1, 'A', 'trade') RETURNING id", [tag()]);
  await h.q("UPDATE book_copies SET status = 'sold' WHERE id = $1", [t.ids[0]]);
  await h.q("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 9, 'in_stock')", [b2.id]);
  const live = await previewOf();
  assert.equal(live.trade.count, p.trade.count, "the count is the same");
  const r = await h.post("/admin/pricing/reprice/trade", { expectedCount: String(p.trade.count), expectedHash: p.trade.hash });
  assert.match(r.text, /was NOT changed/);
  assert.equal(await priceOf(t.ids[1]), 8);
});

test("a confirm without the previewed count and hash is never applied", async () => {
  const t = await book("trade", [{ price: 8 }]);
  const r = await h.post("/admin/pricing/reprice/trade", {});
  assert.match(r.text, /was NOT changed/);
  assert.equal(await priceOf(t.ids[0]), 8);
  assert.equal((await runs()).length, 0);
});

test("preview: copies that would RAISE, LOWER or stay the same are counted separately; the first 25 of each are listed", async () => {
  // Group A: hand-priced 3 and 4 go UP to 5, 8 and 12 go DOWN
  const t = await book("trade", [{ price: 3 }, { price: 4 }, { price: 8 }, { price: 12 }, { price: 5 }]);
  const p = (await previewOf()).trade;
  assert.equal(p.count, 4);
  assert.deepEqual([p.raiseCount, p.lowerCount, p.sameCount], [2, 2, 0]);
  assert.deepEqual(p.raiseSample.map((r) => r.id), [t.ids[0], t.ids[1]]);
  assert.deepEqual(p.lowerSample.map((r) => r.id), [t.ids[2], t.ids[3]]);
  const page = await h.get("/admin/pricing/reprice");
  assert.match(page.text, /<strong>2<\/strong> would go <strong>UP<\/strong>[^<]*<strong>2<\/strong> would go <strong>DOWN<\/strong>/);
  // the lists are capped at 25 per direction
  await book("trade", Array.from({ length: 30 }, () => ({ price: 2 })));
  const big = (await previewOf()).trade;
  assert.equal(big.raiseCount, 32);
  assert.equal(big.raiseSample.length, 25);
});

// --------------------------------------------------------------------- undo

test("undo: preview, then confirm restores the previous prices (and history), only for copies still at the new price and in stock; audited", async () => {
  const w = await world();
  await confirm("trade");
  const run = (await runs())[0];
  assert.equal(await priceOf(w.trade.ids[0]), 5);
  // after the run: one copy was sold, one hand-edited
  await h.q("UPDATE book_copies SET status = 'sold' WHERE id = $1", [w.trade.ids[0]]);
  await h.q("UPDATE book_copies SET price = 6.5 WHERE id = $1", [w.trade.ids[1]]);

  const result = await h.get(`/admin/pricing/reprice/runs/${run.id}`);
  assert.match(result.text, /Undo this run/);
  const preview = await h.get(`/admin/pricing/reprice/runs/${run.id}/undo`);
  assert.equal(preview.res.status, 200);
  assert.match(preview.text, /<strong>1<\/strong> copies go back/);
  assert.match(preview.text, /<strong>2<\/strong> are left alone/);
  assert.equal(await priceOf(w.trade.ids[10]), 5, "the preview changes nothing");

  const m = preview.text.match(/name="expectedCount" value="(\d+)"[\s\S]*?name="expectedHash" value="([0-9a-f]{64})"/);
  const done = await h.post(`/admin/pricing/reprice/runs/${run.id}/undo`, { expectedCount: m[1], expectedHash: m[2] });
  assert.match(done.text, /Undone: 1 copies back at their previous price, 2 left alone/);
  const c = await copy(w.trade.ids[10]);
  assert.equal(Number(c.price), 12);
  assert.equal(Number(c.suggested_price), 12);
  assert.equal(c.suggested_level, "10");
  assert.equal(c.price_basis, "adjusted");
  assert.equal(await priceOf(w.trade.ids[0]), 5, "sold copy untouched");
  assert.equal(await priceOf(w.trade.ids[1]), 6.5, "hand-edited copy untouched");
  const a = await auditRows("pricing.reprice.undo");
  assert.equal(a.length, 1);
  assert.match(a[0].detail, /1 copies restored, 2 left alone/);
  // a second undo has nothing left to restore
  const again = await h.get(`/admin/pricing/reprice/runs/${run.id}/undo`);
  assert.match(again.text, /Nothing can be restored/);
});

test("undo: a confirm with a stale count/hash, or without them, restores nothing", async () => {
  const w = await world();
  await confirm("trade");
  const run = (await runs())[0];
  const preview = await h.get(`/admin/pricing/reprice/runs/${run.id}/undo`);
  const m = preview.text.match(/name="expectedCount" value="(\d+)"[\s\S]*?name="expectedHash" value="([0-9a-f]{64})"/);
  await h.q("UPDATE book_copies SET status = 'sold' WHERE id = $1", [w.trade.ids[0]]); // changes the restorable set
  const stale = await h.post(`/admin/pricing/reprice/runs/${run.id}/undo`, { expectedCount: m[1], expectedHash: m[2] });
  assert.match(stale.text, /Nothing was undone/);
  const none = await h.post(`/admin/pricing/reprice/runs/${run.id}/undo`, {});
  assert.equal(none.res.status, 200);
  assert.equal(await priceOf(w.trade.ids[10]), 5);
  assert.equal((await auditRows("pricing.reprice.undo")).length, 0);
});

test("undo: only the LAST run can be undone; routes need admin and a real run", async () => {
  const t = await book("trade", [{ price: 8 }]);
  await book("mass_market", [{ price: 8 }]);
  await confirm("trade");
  await confirm("mass_market");
  const [first, second] = await runs();
  const old = await h.get(`/admin/pricing/reprice/runs/${first.id}/undo`);
  assert.match(old.text, /A newer run exists/);
  assert.doesNotMatch((await h.get(`/admin/pricing/reprice/runs/${first.id}`)).text, /Undo this run/);
  const r = await h.post(`/admin/pricing/reprice/runs/${first.id}/undo`, { expectedCount: "1", expectedHash: "0".repeat(64) });
  assert.equal(r.res.status, 200);
  assert.equal(await priceOf(t.ids[0]), 5, "the older run was not undone");
  assert.equal((await h.get(`/admin/pricing/reprice/runs/${second.id}/undo`, h.member)).res.status, 403);
  assert.equal((await h.get(`/admin/pricing/reprice/runs/99999/undo`)).res.status, 404);
  assert.equal((await h.post(`/admin/pricing/reprice/runs/99999/undo`, {})).res.status, 404);
});

test("a copy locked by another transaction is skipped, not waited for, and is picked up by the next run", async () => {
  const t = await book("trade", [{ price: 8 }, { price: 8 }]);
  const settings = await require("../../src/lib/pricing/settings").getSettings(h.pool);
  const other = await h.pool.connect();
  try {
    await other.query("BEGIN");
    await other.query("SELECT id FROM book_copies WHERE id = $1 FOR UPDATE", [t.ids[0]]); // e.g. a reservation in progress
    const started = Date.now();
    const result = await reprice.applyGroup(h.pool, "trade", settings, { id: h.admin.id, role: "admin" });
    assert.ok(Date.now() - started < 3000, "did not wait for the lock");
    assert.equal(result.changed, 1);
    assert.equal(await priceOf(t.ids[0]), 8);
    assert.equal(await priceOf(t.ids[1]), 5);
  } finally {
    await other.query("ROLLBACK");
    other.release();
  }
  const again = await reprice.applyGroup(h.pool, "trade", settings, { id: h.admin.id, role: "admin" });
  assert.equal(again.changed, 1);
  assert.equal(await priceOf(t.ids[0]), 5);
});

test("a group is all or nothing: a failure while recording rolls every price back", async () => {
  const w = await book("trade", [{ price: 8 }, { price: 9 }]);
  const settings = await require("../../src/lib/pricing/settings").getSettings(h.pool);
  await h.q("ALTER TABLE price_reprice_items RENAME TO price_reprice_items_x");
  try {
    await assert.rejects(reprice.applyGroup(h.pool, "trade", settings, { id: h.admin.id, role: "admin" }));
  } finally {
    await h.q("ALTER TABLE price_reprice_items_x RENAME TO price_reprice_items");
  }
  assert.deepEqual(await Promise.all(w.ids.map(priceOf)), [8, 9]);
  assert.equal((await runs()).length, 0);
});

// --------------------------------------------------------------------- csv

test("CSV: every changed copy with before and after, audited, admin only, and quotes are safe", async () => {
  const [b] = await h.q("INSERT INTO books (title, authors, binding) VALUES ($1, 'A', 'trade') RETURNING id", ['=HYPERLINK("x"), "q"']);
  const [c1] = await h.q("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 8.5, 'in_stock') RETURNING id", [b.id]);
  await confirm("trade");
  const [run] = await runs();
  const res = await h.get(`/admin/pricing/reprice/runs/${run.id}/export.csv`);
  assert.equal(res.res.status, 200);
  assert.match(res.res.headers.get("content-type"), /text\/csv/);
  assert.match(res.res.headers.get("content-disposition"), /attachment; filename="umas-books-reprice-run-\d+-trade\.csv"/);
  const lines = res.text.replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(lines[0], 'run|group|copy_id|book_id|title|binding|old_price|new_price|old_suggested_price|old_suggested_level|old_price_basis');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith(`${run.id}|trade|${c1.id}|${b.id}|'=HYPERLINK('x'), 'q'|trade|8.50|5.00||`), lines[1]);
  assert.equal((await auditRows("pricing.reprice.csv")).length, 1);
  assert.equal((await h.get(`/admin/pricing/reprice/runs/${run.id}/export.csv`, h.member)).res.status, 403);
  assert.equal((await h.get(`/admin/pricing/reprice/runs/99999/export.csv`)).res.status, 404);
  assert.equal((await h.get(`/admin/pricing/reprice/runs/abc`)).res.status, 404);
});

test("the Reprice page lists earlier runs, and the result page shows before and after", async () => {
  const w = await book("trade", [{ price: 8 }]);
  await confirm("trade");
  const [run] = await runs();
  const page = await h.get("/admin/pricing/reprice");
  assert.ok(page.text.includes(`/admin/pricing/reprice/runs/${run.id}"`));
  const result = await h.get(`/admin/pricing/reprice/runs/${run.id}`);
  assert.match(result.text, /EUR 8\.00<\/td><td>EUR 5\.00/);
  assert.ok(result.text.includes(`#${w.ids[0]}`));
});

// ------------------------------------------------- migration 085 (settings)

const MIGRATION = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "085_pricing_trade_flat_no_eur8.sql"), "utf8");
const OLD_DEFAULTS = `UPDATE pricing_settings SET levels = '[3,5,8,10]', b_price = 8, fallback_trade = 8, fallback_mass_market = 4, fallback_unknown = 8, trade_price = 5 WHERE id = 1`;
const settingsRow = async () => (await h.q("SELECT levels, b_price, fallback_trade, fallback_mass_market, fallback_unknown, fallback_hardcover, trade_price, mass_market_price FROM pricing_settings WHERE id = 1"))[0];
const num = (r) => ({ ...r, b_price: Number(r.b_price), fallback_trade: Number(r.fallback_trade), fallback_mass_market: Number(r.fallback_mass_market), fallback_unknown: Number(r.fallback_unknown), fallback_hardcover: Number(r.fallback_hardcover), trade_price: Number(r.trade_price), mass_market_price: Number(r.mass_market_price) });

test("migration 085: an untouched row moves to the new defaults, and running it twice changes nothing more", async () => {
  await h.q(OLD_DEFAULTS);
  await h.pool.query(MIGRATION);
  const expected = { levels: [3, 5, 10], b_price: 10, fallback_trade: 5, fallback_mass_market: 5, fallback_unknown: 5, fallback_hardcover: 12, trade_price: 5, mass_market_price: 5 };
  assert.deepEqual(num(await settingsRow()), expected);
  await h.pool.query(MIGRATION);
  assert.deepEqual(num(await settingsRow()), expected);
});

test("migration 085: values the maintainer edited are never overwritten, each setting decided on its own", async () => {
  await h.q(`UPDATE pricing_settings SET levels = '[3,6,8,10]', b_price = 9, fallback_trade = 7, fallback_mass_market = 4, fallback_unknown = 6, fallback_hardcover = 15, mass_market_price = 6, trade_price = 7 WHERE id = 1`);
  await h.pool.query(MIGRATION);
  assert.deepEqual(num(await settingsRow()), {
    levels: [3, 6, 8, 10], b_price: 9, fallback_trade: 7, fallback_mass_market: 5, fallback_unknown: 6, fallback_hardcover: 15, trade_price: 7, mass_market_price: 6,
  }, "only fallback_mass_market was still the old default (4), so only it moved");
  await h.pool.query(MIGRATION);
  assert.equal(num(await settingsRow()).trade_price, 7);
});

test("migration 085: adds trade_price with default 5 and leaves book prices alone", async () => {
  const t = await book("trade", [{ price: 8 }]);
  await h.pool.query(MIGRATION);
  assert.equal(await priceOf(t.ids[0]), 8, "the migration never changes a copy");
  const [col] = await h.q("SELECT column_default FROM information_schema.columns WHERE table_name = 'pricing_settings' AND column_name = 'trade_price'");
  assert.match(col.column_default, /^5/);
  const [def] = await h.q("SELECT column_default FROM information_schema.columns WHERE table_name = 'pricing_settings' AND column_name = 'levels'");
  assert.match(def.column_default, /\[3, ?5, ?10\]/);
});

test("a fresh database ends with the new defaults (migrations run in order)", async () => {
  // The harness database was built by running every migration; put the row back the way a fresh one is built.
  await h.q("DELETE FROM pricing_settings");
  await h.q("INSERT INTO pricing_settings (id) VALUES (1)");
  assert.deepEqual(num(await settingsRow()), { levels: [3, 5, 10], b_price: 10, fallback_trade: 5, fallback_mass_market: 5, fallback_unknown: 5, fallback_hardcover: 12, trade_price: 5, mass_market_price: 5 });
});

test("migration 090: reprice run labels older than 12 months are erased, newer ones stay until the purge; the admin FK is SET NULL", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const sql = fs.readFileSync(path.join(__dirname, "../../migrations/090_privacy_reprice_actor.sql"), "utf8");
  await h.q("DELETE FROM price_reprice_runs");
  await h.q(
    `INSERT INTO price_reprice_runs (group_key, new_price, copies_changed, actor_user_id, actor_label, created_at) VALUES
       ('trade', 5, 1, $1, 'old-admin@example.test', now() - interval '13 months'),
       ('trade', 5, 1, $1, 'recent-admin@example.test', now() - interval '2 months')`,
    [h.admin.id]
  );
  await h.pool.query(sql);
  await h.pool.query(sql); // idempotent
  const rows = await h.q("SELECT actor_label FROM price_reprice_runs ORDER BY created_at");
  assert.deepEqual(rows.map((r) => r.actor_label), [null, "recent-admin@example.test"]);
  const [fk] = await h.q(
    "SELECT confdeltype::text AS t FROM pg_constraint WHERE conname = 'price_reprice_runs_actor_user_fk'"
  );
  assert.equal(fk.t, "n", "ON DELETE SET NULL");
});
