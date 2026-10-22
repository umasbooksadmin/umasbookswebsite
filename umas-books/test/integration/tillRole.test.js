// The "Till" role (users.is_till): a volunteer can sell at /admin/till without being an admin.
// Real app, with admin two-step verification ON so the difference is visible.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");

let h;
let till; // a till-only account
before(async () => {
  h = await tillHarness({ port: 4352, ip: "10.81.2.2", env: { ADMIN_2FA_REQUIRED: "true" }, loginAdmin: false });
  till = await h.makeUser({ till: true, name: "Till Volunteer" });
});
after(async () => { await h.stop(); });

const parisDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });

async function seedAdmin() {
  // An admin that has finished two-step setup: the flag is what the middleware reads.
  const a = await h.makeUser({ admin: true, name: "Real Admin" });
  await h.pool.query("UPDATE users SET totp_enabled_at = now() WHERE id = $1", [a.id]);
  return a;
}

test("a till-only account lands on the till after login and needs no two-step verification; an admin without it is sent to set it up", async () => {
  assert.equal(till.location, "/admin/till");
  const page = await h.get("/admin/till", till.jar);
  assert.equal(page.res.status, 200);
  assert.match(page.text, /Scan a label or a book barcode/);
  // the menu is cut down to the till
  assert.match(page.text, /<strong>Till<\/strong>/);
  assert.doesNotMatch(page.text, /href="\/admin\/inventory"|href="\/admin\/members"|href="\/admin\/reports"/);
  assert.doesNotMatch(page.text, /Sale made earlier/, "no backdating box for a till-only account");
  assert.match(page.text, /data-admin="0"/);
  const plainAdmin = await h.makeUser({ admin: true });
  const blocked = await h.get("/admin/till", plainAdmin.jar);
  assert.equal(blocked.res.status, 302);
  assert.match(blocked.res.headers.get("location"), /\/account\/2fa/);
  assert.equal((await h.get("/admin", till.jar)).res.status, 403, "the admin dashboard stays closed to it");
});

test("a till-only account can scan, check, sell, see the receipt and void today's sale", async () => {
  const book = await h.seedBook(`Role Book ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5 });
  const scan = await h.json("/admin/till/scan", { code: `UB-${c}`, have: "[]" }, till.jar);
  assert.equal(scan.body.type, "line");
  const sale = await h.sale([h.book(c)], { jar: till.jar, received: "5" });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal((await h.pool.query("SELECT staff_user_id FROM till_sales WHERE id = $1", [sale.body.saleId])).rows[0].staff_user_id, till.id);
  assert.equal((await h.get(`/admin/till/sales/${sale.body.saleId}/receipt`, till.jar)).res.status, 200);
  const day = await h.get("/admin/till/day", till.jar);
  assert.equal(day.res.status, 200, "end of day can be looked at");
  assert.doesNotMatch(day.text, /action="\/admin\/till\/day\/close"/, "read-only: no close form");
  assert.doesNotMatch(day.text, /action="\/admin\/till\/day\/open"/);
  assert.match(day.text, /for an admin/);
  const v = await h.post(`/admin/till/sales/${sale.body.saleId}/void`, { reason: "wrong book" }, till.jar);
  assert.match(v.headers.get("location"), /voided=/);
  assert.equal((await h.copy(c)).status, "in_stock");
  assert.equal((await h.audit("till.void")).at(-1).target_id, sale.body.saleId);
});

test("a till-only account cannot override prices beyond the rules, backdate, reopen or close a day, or manage quick items", async () => {
  const book = await h.seedBook(`Role Limits ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 10 });
  // a small raise is allowed; lower, or far above, is admin only (403) even with a reason
  const small = await h.sale([h.book(c, "11")], { jar: till.jar, received: "20" });
  assert.equal(small.status, 200, JSON.stringify(small.body));
  const c2 = await h.seedCopy(book.id, { price: 10 });
  const lower = await h.sale([h.book(c2, "8", "agreed")], { jar: till.jar, received: "20" });
  assert.equal(lower.status, 403);
  assert.match(lower.body.error, /Only an admin/);
  assert.equal((await h.sale([h.book(c2, "13", "rare")], { jar: till.jar, received: "20" })).status, 403);
  assert.equal((await h.copy(c2)).status, "in_stock");
  // an unpriced copy: typing its price is allowed
  const c3 = await h.seedCopy(book.id, { price: null });
  assert.equal((await h.sale([h.book(c3, "3")], { jar: till.jar, received: "5" })).status, 200);
  // backdating
  const back = await h.sale([h.book(c2)], { jar: till.jar, received: "10", soldAtTime: "09:00", backdateReason: "paper" });
  assert.equal(back.status, 403);
  // reopening a closed day
  const day = parisDay();
  await h.pool.query(
    "INSERT INTO till_days (day, opening_float_cents, closed_at, counted_cash_cents, expected_cash_cents, difference_cents) VALUES ($1, 0, now(), 0, 0, 0) ON CONFLICT (day) DO UPDATE SET closed_at = now()", [day]);
  const closed = await h.sale([h.book(c2)], { jar: till.jar, received: "10" });
  assert.equal(closed.body.code, "day_closed");
  const tryReopen = await h.sale([h.book(c2)], { jar: till.jar, received: "10", reopen: "1", reopenReason: "please" });
  assert.equal(tryReopen.status, 403);
  assert.ok((await h.pool.query("SELECT closed_at FROM till_days WHERE day = $1", [day])).rows[0].closed_at, "still closed");
  await h.pool.query("UPDATE till_days SET closed_at = NULL WHERE day = $1", [day]);
  // everything else is closed to it
  for (const [method, path] of [["get", "/admin/till/items"], ["get", "/admin/inventory"], ["get", "/admin/members"], ["get", "/admin/reports"]]) {
    assert.equal((await h[method](path, till.jar)).res.status, 403, path);
  }
  for (const path of ["/admin/till/day/open", "/admin/till/day/close", "/admin/till/day/reopen", "/admin/till/items"]) {
    assert.equal((await h.post(path, { day, openingFloat: "1", counted: "1", reason: "x", name: "n", price: "1", category: "other" }, till.jar)).status, 403, path);
  }
});

test("a till-only session ends after 8 hours without a till request; admins are not timed out", async () => {
  const fresh = await h.makeUser({ till: true });
  assert.equal((await h.get("/admin/till", fresh.jar)).res.status, 200);
  // 7 hours idle: still fine
  const setActive = (id, hoursAgo) => h.pool.query(
    `UPDATE session SET sess = jsonb_set(sess::jsonb, '{user,tillActiveAt}', to_jsonb(($2::bigint))) WHERE (sess::jsonb -> 'user' ->> 'id')::int = $1`,
    [id, Date.now() - hoursAgo * 3600 * 1000]);
  await setActive(fresh.id, 7);
  assert.equal((await h.get("/admin/till", fresh.jar)).res.status, 200);
  // the last request refreshed it; now push it back past 8 hours
  await setActive(fresh.id, 8.5);
  const out = await h.get("/admin/till", fresh.jar);
  assert.equal(out.res.status, 302);
  assert.match(out.res.headers.get("location"), /login/);
  // the session is really gone, not just redirected once
  const again = await h.get("/admin/till", fresh.jar);
  assert.match(again.res.headers.get("location") || "", /login/);
  // an admin session is not subject to it (admins have two-step verification instead)
  const adm = await seedAdmin();
  await setActive(adm.id, 100);
  assert.equal((await h.get("/admin/till", adm.jar)).res.status, 200);
});

test("turning Till access on and off is an admin action on Accounts, audited; the list pill, filter and Accounts report show it", async () => {
  const adm = await seedAdmin();
  const holder = await h.makeUser({ name: "Future Cashier" });
  assert.equal((await h.get("/admin/till", holder.jar)).res.status, 403, "no access yet");
  // only an admin can toggle
  assert.equal((await h.post(`/admin/members/${holder.id}/toggle-till`, { desired: "on" }, till.jar)).status, 403);
  // with two-step on, the admin must have it set up to reach /admin/members at all: use a session the middleware accepts
  const detail = await h.get(`/admin/members?view=${holder.id}`, adm.jar);
  assert.equal(detail.res.status, 200, "an admin with two-step verification set up");
  assert.match(detail.text, /Till access: off \(give\)/);
  assert.equal((await h.post(`/admin/members/${holder.id}/toggle-till`, { desired: "on" }, adm.jar)).status, 302);
  assert.equal((await h.pool.query("SELECT is_till FROM users WHERE id = $1", [holder.id])).rows[0].is_till, true);
  assert.match((await h.audit("member.toggle_till")).at(-1).detail, /Till access given/);
  // takes effect on the next request (no new login)
  assert.equal((await h.get("/admin/till", holder.jar)).res.status, 200);

  const list = await h.get("/admin/members?role=till", adm.jar);
  assert.match(list.text, /Future Cashier/);
  assert.match(list.text, /<span class="status-pill [a-z]+"[^>]*>Till<\/span>/);
  assert.doesNotMatch(list.text, /Real Admin<\/a>[\s\S]{0,400}>Till</, "the filter lists only accounts with Till access");
  const report = await h.get("/admin/reports/accounts?type=till", adm.jar);
  assert.match(report.text, /Future Cashier/);
  assert.match(report.text, /Till access \(can use the till without being an admin\)/);
  assert.match(report.text, /\+ Till/);
  const csv = await (await fetch(`${h.app.base}/admin/reports/accounts?format=csv`, { headers: { cookie: adm.jar.header(), "x-forwarded-for": h.ip } })).text();
  assert.match(csv, /Future Cashier[^\n]*\+ Till/);

  // removing it takes the access away at once
  await h.post(`/admin/members/${holder.id}/toggle-till`, { desired: "off" }, adm.jar);
  assert.equal((await h.get("/admin/till", holder.jar)).res.status, 403);
  assert.match((await h.audit("member.toggle_till")).at(-1).detail, /Till access removed/);
});

test("a disabled till account is out at once", async () => {
  const u = await h.makeUser({ till: true });
  assert.equal((await h.get("/admin/till", u.jar)).res.status, 200);
  await h.pool.query("UPDATE users SET is_disabled = true WHERE id = $1", [u.id]);
  const res = await h.get("/admin/till", u.jar);
  assert.equal(res.res.status, 302);
  assert.match(res.res.headers.get("location"), /login/);
});
