// Customer book requests, the staff side: matching at intake and on edit,
// the admin Requests page (notify, notify-and-hold, match, fulfil, cancel,
// note, delete), audit rows without personal data, authorisation, and the
// privacy side (daily purge, erasure, data export).
//
// In-process (mailer stubbed). Every value is unique: CI shares one database.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeClient, makeUser, uniq } = require("../helpers/routeClient");

const db = prepareDatabase("bookreq_admin", { isolated: true });
const mailer = require("../../src/mailer");
const sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };

// No outbound HTTP: description and cover are supplied by the tests, but any
// stray lookup must fail loudly rather than reach the internet.
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, init);
  throw new Error(`unexpected outbound request: ${url}`);
};

const { pool } = require("../../src/db");
const privacy = require("../../src/lib/privacy");
const { buildMemberExport } = require("../../src/lib/memberExport");
const { sendPickupReminders } = require("../../src/lib/reservations");
const br = require("../../src/lib/bookRequests");

let server, c, admin;
before(async () => {
  db.create();
  admin = await makeUser(pool, { admin: true, name: "Admin Tester" });
  server = await listen(buildApp([
    require("../../src/routes/bookRequests"),
    require("../../src/routes/admin/requests"),
    require("../../src/routes/admin/inventory"),
  ]));
  c = makeClient(server.base);
});
after(async () => {
  await server.close();
  global.fetch = realFetch;
  await pool.end();
  db.drop();
});
beforeEach(() => { sent.length = 0; });

// ---------------------------------------------------------------- helpers

// Adds a book with one copy through the real admin route (so matching runs).
async function intake({ title, isbn = "", author = "", status = "in_stock", price = "6.50" }) {
  const res = await c.post("/admin/inventory", {
    title, isbn, author, price, status, condition: "very_good",
    description: "d", descriptionFr: "d fr", coverUrl: "http://cover.example/c.jpg",
  }, { as: admin });
  assert.equal(res.status, 302, res.text.slice(0, 200));
  const bookId = Number(res.location.match(/\/admin\/inventory\/(\d+)/)[1]);
  const { rows } = await pool.query("SELECT id FROM book_copies WHERE book_id = $1 ORDER BY id DESC LIMIT 1", [bookId]);
  return { bookId, copyId: rows[0].id, location: res.location };
}

// A unique 979-prefixed ISBN-13 (no ISBN-10 form; the column is unique across files).
const fakeIsbn = () => `979${String(Date.now()).slice(-7)}${String(Math.floor(Math.random() * 1e3)).padStart(3, "0")}`;

async function request(over = {}) {
  const email = over.email === undefined ? `rq-${uniq()}@example.test` : over.email;
  const { rows } = await pool.query(
    `INSERT INTO book_requests (title, author, isbn, email, name, lang, status, note, manage_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '12 months') RETURNING id`,
    [
      over.title || `Req ${uniq()}`, over.author || null, over.isbn || null, email, over.name === undefined ? "Req Person" : over.name,
      over.lang || "en", over.status || "open", over.note || null, `old-${uniq()}`,
    ]
  );
  return { id: rows[0].id, email };
}
const get = async (id) => (await pool.query("SELECT * FROM book_requests WHERE id = $1", [id])).rows[0];
const copy = async (id) => (await pool.query("SELECT * FROM book_copies WHERE id = $1", [id])).rows[0];
const adminPost = (path, fields = {}) => c.post(path, fields, { as: admin });

// A request already matched to a fresh in-stock copy.
async function matched({ lang = "en", price = "6.50", copyStatus = "in_stock" } = {}) {
  const title = `Matched ${uniq()}`;
  const book = await intake({ title, price, status: copyStatus });
  const r = await request({ title, lang });
  await pool.query("UPDATE book_requests SET status = 'matched', matched_copy_id = $2 WHERE id = $1", [r.id, book.copyId]);
  return { ...book, ...r, title };
}

// ---------------------------------------------------------------- matching

test("matching by ISBN treats the 10- and 13-digit forms as the same book, in both directions", async () => {
  const a = await request({ isbn: "9780141439518" });
  const b = await request({ isbn: "0141439513" });
  const other = await request({ isbn: "9780000000002" });
  const book13 = await intake({ title: `Isbn A ${uniq()}`, isbn: "9780141439518" });
  assert.equal((await get(a.id)).status, "matched");
  assert.equal((await get(a.id)).matched_copy_id, book13.copyId);
  assert.equal((await get(b.id)).status, "matched", "request typed as ISBN-10, book scanned as ISBN-13");
  assert.equal((await get(other.id)).status, "open");

});

test("matching by ISBN also works when the book was scanned as ISBN-10 and the request typed as ISBN-13", async () => {
  const req13 = await request({ isbn: "9780804429573" });
  const book10 = await intake({ title: `Isbn B ${uniq()}`, isbn: "080442957X" });
  assert.equal((await get(req13.id)).status, "matched");
  assert.equal((await get(req13.id)).matched_copy_id, book10.copyId);
});

test("matching by title ignores case, accents and punctuation; the author must be empty or overlap", async () => {
  const stamp = uniq().replace(/\D/g, "");
  const title = `L'Étranger ${stamp}`;
  const plain = await request({ title: `l etranger ${stamp}!` });
  const withAuthor = await request({ title: `L’ETRANGER  ${stamp}`, author: "Camus" });
  const wrongAuthor = await request({ title: `L'Etranger ${stamp}`, author: "Sartre" });
  const otherTitle = await request({ title: `La Peste ${stamp}` });
  const unconfirmed = await request({ title: `L'Étranger ${stamp}`, status: "unconfirmed" });
  await intake({ title, author: "Albert Camus" });
  assert.equal((await get(plain.id)).status, "matched");
  assert.equal((await get(withAuthor.id)).status, "matched");
  assert.equal((await get(wrongAuthor.id)).status, "open");
  assert.equal((await get(otherTitle.id)).status, "open");
  assert.equal((await get(unconfirmed.id)).status, "unconfirmed", "only confirmed requests are matched");
});

test("a copy that is not in stock, or an already matched request, is not matched", async () => {
  const title = `Sold ${uniq()}`;
  const r = await request({ title });
  await intake({ title, status: "sold" });
  assert.equal((await get(r.id)).status, "open");
  const first = await intake({ title });
  assert.equal((await get(r.id)).matched_copy_id, first.copyId);
  await intake({ title });
  assert.equal((await get(r.id)).matched_copy_id, first.copyId, "stays on the first matching copy");
});

test("intake shows the banner: redirect and the book's admin page say how many customers asked", async () => {
  const title = `Banner ${uniq()}`;
  await request({ title });
  await request({ title: title.toUpperCase() });
  const book = await intake({ title });
  assert.match(book.location, /\?requests=2$/);
  const page = await c.get(`/admin/inventory/${book.bookId}`, { as: admin });
  assert.match(page.text, /2 customers asked for this book/);
  assert.match(page.text, new RegExp(`/admin/requests\\?status=matched&amp;book=${book.bookId}`));
  const quiet = await intake({ title: `Quiet ${uniq()}` });
  assert.ok(!(await c.get(`/admin/inventory/${quiet.bookId}`, { as: admin })).text.includes("asked for this book"));
  // the scan flow carries the count to the scan screen
  const t2 = `Scan ${uniq()}`;
  await request({ title: t2 });
  const res = await adminPost("/admin/inventory", {
    title: t2, price: "5", condition: "very_good", fromScan: "1", description: "d", descriptionFr: "d", coverUrl: "http://cover.example/c.jpg",
  });
  assert.match(res.location, /^\/admin\/inventory\/scan\?saved=1.*&requests=1$/);
  assert.match((await c.get(res.location, { as: admin })).text, /1 customer asked for this book/);
});

test("editing a book's title re-checks the open requests", async () => {
  const stamp = uniq();
  const book = await intake({ title: `Typo Tilte ${stamp}` });
  const r = await request({ title: `Typo Title ${stamp}` });
  assert.equal((await get(r.id)).status, "open");
  const res = await adminPost(`/admin/inventory/${book.bookId}`, {
    title: `Typo Title ${stamp}`, description: "d", descriptionFr: "d", coverUrl: "http://cover.example/c.jpg",
  });
  assert.equal(res.status, 302);
  assert.equal((await get(r.id)).status, "matched");
  assert.equal((await get(r.id)).matched_copy_id, book.copyId);
});

// ---------------------------------------------------------------- admin page

test("admin requests page lists requests with name and email, filters by status and searches", async () => {
  const r = await request({ title: `Listed ${uniq()}`, name: "Visible Person", note: "a customer note" });
  const done = await request({ title: `Done ${uniq()}`, status: "cancelled", email: null, name: null });
  const page = await c.get(`/admin/requests?q=${encodeURIComponent((await get(r.id)).title)}`, { as: admin });
  assert.equal(page.status, 200);
  assert.match(page.text, /Visible Person/);
  assert.ok(page.text.includes(r.email));
  assert.match(page.text, /a customer note/);
  assert.ok(!(await c.get("/admin/requests", { as: admin })).text.includes(`id="request-${done.id}"`), "cancelled is hidden in the default view");
  assert.ok((await c.get("/admin/requests?status=cancelled", { as: admin })).text.includes(`id="request-${done.id}"`));
  const byEmail = await c.get(`/admin/requests?status=all&q=${encodeURIComponent(r.email)}`, { as: admin });
  assert.ok(byEmail.text.includes(`id="request-${r.id}"`));
  assert.equal((await c.get("/admin/requests?status=bogus&q=%25", { as: admin })).status, 200);
});

test("manual 'Match to a book' accepts a book id or an ISBN and refuses anything without a copy in stock", async () => {
  const r = await request({ title: `Manual ${uniq()}` });
  const book = await intake({ title: `Manual Book ${uniq()}`, isbn: fakeIsbn() });
  const sold = await intake({ title: `Sold Manual ${uniq()}`, status: "sold" });
  assert.match((await adminPost(`/admin/requests/${r.id}/match`, { book: String(sold.bookId) })).location, /notice=no-match/);
  assert.match((await adminPost(`/admin/requests/${r.id}/match`, { book: "banana" })).location, /notice=no-match/);
  assert.equal((await get(r.id)).status, "open");
  const ok = await adminPost(`/admin/requests/${r.id}/match`, { book: String(book.bookId) });
  assert.match(ok.location, /notice=matched/);
  assert.equal((await get(r.id)).matched_copy_id, book.copyId);
  const isbn = (await pool.query("SELECT isbn FROM books WHERE id = $1", [book.bookId])).rows[0].isbn;
  const r2 = await request({ title: `Manual2 ${uniq()}` });
  await adminPost(`/admin/requests/${r2.id}/match`, { book: isbn });
  assert.equal((await get(r2.id)).matched_copy_id, book.copyId);
});

// ---------------------------------------------------------------- notify

test("Notify emails the requester in English with the book link, price, reply line and a working cancel link", async () => {
  const m = await matched({ price: "6.50" });
  const res = await adminPost(`/admin/requests/${m.id}/notify`);
  assert.match(res.location, /notice=notified/);
  const mail = sent.find((x) => x.to === m.email);
  assert.ok(mail, "email sent");
  assert.match(mail.subject, /Good news/);
  assert.ok(mail.text.includes(m.title));
  assert.match(mail.text, new RegExp(`/books/${m.bookId}\\b`));
  assert.match(mail.text, /€6\.50/);
  assert.match(mail.text, /reply to this email/i);
  // there is no online reservation: the wording must not promise one
  assert.match(mail.text, /come by the shop soon or add it to your cart online/);
  assert.doesNotMatch(mail.text, /reserve it online/i);
  const token = mail.text.match(/\/my-requests\/([a-f0-9]{64})/)[1];
  const r = await get(m.id);
  assert.equal(r.status, "notified");
  assert.ok(r.notified_at);
  assert.equal((await copy(m.copyId)).status, "in_stock", "plain Notify does not hold the copy");
  // the cancel link in the email works (and replaced the older link)
  assert.match((await c.get(`/my-requests/${token}`)).text, /We have written to you/);
  assert.equal((await c.post(`/my-requests/${token}/cancel`, {})).status, 302);
  assert.equal((await get(m.id)).status, "cancelled");
});

test("Notify writes to a French-speaking requester in French, with a French price", async () => {
  const m = await matched({ lang: "fr", price: "6.50" });
  await adminPost(`/admin/requests/${m.id}/notify`);
  const mail = sent.find((x) => x.to === m.email);
  assert.match(mail.subject, /Bonne nouvelle/);
  assert.match(mail.text, /vous avez des questions|Pour toute question, répondez/);
  assert.match(mail.text, /6,50\u00a0€/);
  assert.match(mail.text, /passez vite à la boutique ou ajoutez-le à votre panier en ligne\./);
  assert.doesNotMatch(mail.text, /réservez-le en ligne/);
  assert.ok(!/Good news|reply to this email/.test(mail.subject + mail.text));
  assert.equal((await get(m.id)).status, "notified");
});

test("Notify refuses when the copy is gone, there is no match, or the status is wrong; nothing is sent", async () => {
  const sold = await matched();
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [sold.copyId]);
  const open = await request();
  for (const [id, expected] of [[sold.id, "matched"], [open.id, "open"]]) {
    const res = await adminPost(`/admin/requests/${id}/notify`);
    assert.match(res.location, /error=/);
    assert.equal((await get(id)).status, expected);
    assert.equal((await get(id)).notified_at, null);
  }
  const page = await c.get(`/admin/requests?error=${encodeURIComponent(br.NOTIFY_ERRORS.stockGone)}`, { as: admin });
  assert.match(page.text, /no longer in stock/);
  const forged = await c.get("/admin/requests?error=%3Cb%3Eanything%3C%2Fb%3E", { as: admin });
  assert.ok(!forged.text.includes("anything"), "only known messages are ever shown");
  assert.equal(sent.length, 0);
});

test("a failed email leaves the request, the copy and the old link as they were", async () => {
  const m = await matched();
  const before = await get(m.id);
  const original = mailer.sendMail;
  mailer.sendMail = async () => { throw new Error("smtp down"); };
  let res;
  try {
    res = await adminPost(`/admin/requests/${m.id}/notify-hold`);
  } finally {
    mailer.sendMail = original;
  }
  assert.match(res.location, /error=/);
  const after_ = await get(m.id);
  assert.equal(after_.status, "matched");
  assert.equal(after_.manage_token_hash, before.manage_token_hash);
  assert.equal((await copy(m.copyId)).status, "in_stock", "the hold was released");
});

test("Notify and hold: emails, reserves the copy so the hold ends in 7 days, and no pickup reminder is sent", async () => {
  const m = await matched();
  const res = await adminPost(`/admin/requests/${m.id}/notify-hold`, {});
  assert.match(res.location, /notice=held/);
  const mail = sent.find((x) => x.to === m.email);
  assert.match(mail.text, /set this copy aside for you for 7 days/);
  const r = await get(m.id);
  assert.equal(r.status, "notified");
  const cp = await copy(m.copyId);
  assert.equal(cp.status, "reserved");
  assert.equal(cp.reserved_by_email, m.email);
  assert.equal(cp.reserved_by_name, "Req Person");
  const { rows } = await pool.query(
    "SELECT extract(epoch FROM (reserved_at + interval '14 days' - now())) / 86400 AS days_left FROM book_copies WHERE id = $1",
    [m.copyId]
  );
  assert.ok(Math.abs(Number(rows[0].days_left) - 7) < 0.01, `hold ends in ${rows[0].days_left} days`);
  assert.ok(cp.reminder_sent_at, "reminder is marked as handled");

  // the day-11 pickup reminder stays quiet, now and when the hold is older
  sent.length = 0;
  await sendPickupReminders(pool);
  assert.equal(sent.filter((x) => x.to === m.email).length, 0);
  await pool.query("UPDATE book_copies SET reserved_at = reserved_at - interval '5 days' WHERE id = $1", [m.copyId]);
  await sendPickupReminders(pool);
  assert.equal(sent.filter((x) => x.to === m.email).length, 0, "no reminder for a request hold");
  assert.equal((await copy(m.copyId)).status, "reserved", "the hold has 2 days left");
});

test("Notify and hold is refused for a sold or already reserved copy, and nothing is sent", async () => {
  const soldOne = await matched();
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [soldOne.copyId]);
  const reservedOne = await matched();
  await pool.query("UPDATE book_copies SET status = 'reserved', reserved_by_email = 'other@example.test', reserved_by_name = 'Other', reserved_at = now() WHERE id = $1", [reservedOne.copyId]);
  for (const m of [soldOne, reservedOne]) {
    const res = await adminPost(`/admin/requests/${m.id}/notify-hold`);
    assert.match(res.location, /error=/);
    assert.equal((await get(m.id)).status, "matched");
  }
  assert.equal((await copy(soldOne.copyId)).status, "sold");
  assert.equal((await copy(reservedOne.copyId)).reserved_by_email, "other@example.test", "someone else's hold is untouched");
  assert.equal(sent.length, 0);
});

test("Notify and hold is refused for a copy with no price, and nothing is sent", async () => {
  const m = await matched({ price: "" });
  assert.equal((await copy(m.copyId)).price, null, "intake with a blank price stores no price");
  const res = await adminPost(`/admin/requests/${m.id}/notify-hold`);
  assert.match(res.location, /no\+price\+yet/);
  assert.equal((await get(m.id)).status, "matched");
  assert.equal((await copy(m.copyId)).status, "in_stock", "the copy is not held");
  assert.equal(sent.length, 0);
});

test("cancelling a request (by the customer or an admin) releases the copy held for them", async () => {
  const m = await matched();
  await adminPost(`/admin/requests/${m.id}/notify-hold`);
  assert.equal((await copy(m.copyId)).status, "reserved");
  const token = sent.find((x) => x.to === m.email).text.match(/\/my-requests\/([a-f0-9]{64})/)[1];
  await c.post(`/my-requests/${token}/cancel`, {});
  const cp = await copy(m.copyId);
  assert.equal(cp.status, "in_stock");
  assert.equal(cp.reserved_by_email, null);

  const m2 = await matched();
  await adminPost(`/admin/requests/${m2.id}/notify-hold`);
  await adminPost(`/admin/requests/${m2.id}/cancel`);
  assert.equal((await copy(m2.copyId)).status, "in_stock");
  const r2 = await get(m2.id);
  assert.deepEqual([r2.status, r2.email, r2.name], ["cancelled", null, null]);
});

test("fulfil, note and delete work, and only on requests that can take them", async () => {
  const r = await request();
  assert.match((await adminPost(`/admin/requests/${r.id}/note`, { adminNote: "called her" })).location, /notice=noted/);
  assert.equal((await get(r.id)).admin_note, "called her");
  assert.match((await adminPost(`/admin/requests/${r.id}/fulfil`)).location, /notice=fulfilled/);
  assert.equal((await get(r.id)).status, "fulfilled");
  assert.match((await adminPost(`/admin/requests/${r.id}/fulfil`)).location, /notice=gone/);
  assert.match((await adminPost(`/admin/requests/${r.id}/delete`)).location, /notice=deleted/);
  assert.equal(await get(r.id), undefined);
  assert.match((await adminPost("/admin/requests/999999999/delete")).location, /notice=gone/);
  assert.match((await adminPost("/admin/requests/abc/delete")).location, /notice=gone/);
});

test("every admin action leaves an audit row with ids only, never an email, name or title", async () => {
  const m = await matched();
  const title = m.title;
  await adminPost(`/admin/requests/${m.id}/note`, { adminNote: "secret staff note" });
  await adminPost(`/admin/requests/${m.id}/notify-hold`);
  await adminPost(`/admin/requests/${m.id}/fulfil`);
  const r2 = await request();
  await adminPost(`/admin/requests/${r2.id}/cancel`);
  const r3 = await request();
  await adminPost(`/admin/requests/${r3.id}/delete`);
  const r4 = await request();
  const spare = await intake({ title: `Spare ${uniq()}` });
  await adminPost(`/admin/requests/${r4.id}/match`, { book: String(spare.bookId) });

  const { rows } = await pool.query(
    "SELECT * FROM admin_audit_log WHERE action LIKE 'request.%' AND target_id = ANY($1) ORDER BY id",
    [[m.id, r2.id, r3.id, r4.id]]
  );
  assert.deepEqual(
    rows.map((r) => r.action).sort(),
    ["request.cancel", "request.delete", "request.fulfil", "request.match", "request.note", "request.notify_hold"]
  );
  for (const row of rows) {
    assert.equal(row.target_type, "book_request");
    assert.equal(row.actor_user_id, admin.id);
    const text = JSON.stringify([row.detail, row.target_type, row.action]);
    for (const secret of [m.email, r2.email, r3.email, "Req Person", title, "secret staff note"]) {
      assert.ok(!text.includes(secret), `audit row leaks ${secret}`);
    }
  }
});

test("admin pages need an admin: anonymous is sent to login, a member or customer is refused", async () => {
  const r = await request();
  const member = await makeUser(pool, { member: true });
  const customer = await makeUser(pool);
  for (const [method, path] of [
    ["get", "/admin/requests"],
    ["post", `/admin/requests/${r.id}/notify`],
    ["post", `/admin/requests/${r.id}/notify-hold`],
    ["post", `/admin/requests/${r.id}/delete`],
    ["post", `/admin/requests/${r.id}/match`],
  ]) {
    const send = (as) => (method === "get" ? c.get(path, { as }) : c.post(path, {}, { as }));
    const anon = await send(null);
    assert.equal(anon.status, 302, path);
    assert.equal(anon.location, "/login");
    for (const as of [member, customer]) {
      const res = await send(as);
      assert.equal(res.status, 403, path);
    }
  }
  assert.equal((await get(r.id)).status, "open", "nothing changed");
});

// ---------------------------------------------------------------- privacy

test("daily purge: unconfirmed after 7 days, open/matched/notified at 12 months, ended ones after 30 days", async () => {
  const mk = async (status, sql) => {
    const r = await request({ status, name: "Purge Me", note: "n" });
    await pool.query(`UPDATE book_requests SET admin_note = 'staff', user_id = $2 WHERE id = $1`, [r.id, admin.id]);
    if (sql) await pool.query(`UPDATE book_requests SET ${sql} WHERE id = $1`, [r.id]);
    return r.id;
  };
  const ids = {
    unconfirmedOld: await mk("unconfirmed", "created_at = now() - interval '8 days', expires_at = now() - interval '1 day'"),
    unconfirmedNew: await mk("unconfirmed", "created_at = now() - interval '2 days', expires_at = now() + interval '5 days'"),
    openOld: await mk("open", "created_at = now() - interval '13 months', expires_at = now() - interval '1 month'"),
    matchedOld: await mk("matched", "created_at = now() - interval '13 months', expires_at = now() - interval '1 month'"),
    notifiedOld: await mk("notified", "created_at = now() - interval '13 months', expires_at = now() - interval '1 month'"),
    openNew: await mk("open", "created_at = now() - interval '11 months'"),
    fulfilledOld: await mk("fulfilled", "updated_at = now() - interval '31 days'"),
    fulfilledNew: await mk("fulfilled", "updated_at = now() - interval '2 days'"),
    cancelledOld: await mk("cancelled", "updated_at = now() - interval '31 days'"),
    expiredOld: await mk("expired", "updated_at = now() - interval '31 days'"),
  };
  await pool.query("INSERT INTO book_request_list_tokens (email, token_hash, expires_at) VALUES ('gone@example.test', $1, now() - interval '1 day')", [`t-${uniq()}`]);
  const counts = await privacy.purgeExpiredPersonalData(pool);
  assert.notEqual(counts.bookRequests, "error");

  assert.equal(await get(ids.unconfirmedOld), undefined);
  assert.equal((await get(ids.unconfirmedNew)).email !== null, true);
  for (const k of ["openOld", "matchedOld", "notifiedOld"]) {
    const r = await get(ids[k]);
    assert.equal(r.status, "expired", k);
    assert.deepEqual([r.email, r.name, r.note, r.admin_note, r.user_id], [null, null, null, null, null], k);
    assert.ok(r.title, "title kept for demand counts");
  }
  assert.equal((await get(ids.openNew)).status, "open");
  assert.notEqual((await get(ids.openNew)).email, null);
  for (const k of ["fulfilledOld", "cancelledOld", "expiredOld"]) {
    const r = await get(ids[k]);
    assert.deepEqual([r.email, r.name, r.note, r.admin_note, r.user_id], [null, null, null, null, null], k);
    assert.ok(r.title);
  }
  const young = await get(ids.fulfilledNew);
  assert.equal(young.status, "fulfilled");
  assert.notEqual(young.email, null, "closed less than 30 days ago keeps its contact for now");
  assert.equal((await pool.query("SELECT 1 FROM book_request_list_tokens WHERE email = 'gone@example.test'")).rowCount, 0);
});

test("erasing a member clears their requests by email and by account, and leaves other people's alone", async () => {
  const user = await makeUser(pool);
  const byEmail = await request({ email: user.email });
  const byId = await request({ email: `other-${uniq()}@example.test` });
  await pool.query("UPDATE book_requests SET user_id = $2 WHERE id = $1", [byId.id, user.id]);
  const stranger = await request();
  await pool.query("INSERT INTO book_request_list_tokens (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '5 days')", [user.email, `t-${uniq()}`]);

  assert.equal(await privacy.eraseMember(pool, user.id), true);
  for (const id of [byEmail.id, byId.id]) {
    const r = await get(id);
    assert.equal(r.status, "cancelled");
    assert.deepEqual([r.email, r.name, r.note, r.user_id, r.manage_token_hash], [null, null, null, null, null]);
    assert.ok(r.title);
  }
  assert.equal((await get(stranger.id)).status, "open");
  assert.notEqual((await get(stranger.id)).email, null);
  assert.equal((await pool.query("SELECT 1 FROM book_request_list_tokens WHERE email = $1", [user.email])).rowCount, 0);
});

test("the member data export includes their requests (no token hashes), by email and by account", async () => {
  const user = await makeUser(pool);
  const mine = await request({ email: user.email, note: "export me", title: `Export ${uniq()}` });
  const linked = await request({ email: `else-${uniq()}@example.test`, title: `Linked ${uniq()}` });
  await pool.query("UPDATE book_requests SET user_id = $2 WHERE id = $1", [linked.id, user.id]);
  await request({ title: `Not mine ${uniq()}` });
  const data = await buildMemberExport(pool, user.id);
  assert.deepEqual(data.book_requests.map((r) => r.id).sort(), [mine.id, linked.id].sort());
  const first = data.book_requests.find((r) => r.id === mine.id);
  assert.equal(first.email, user.email);
  assert.equal(first.note, "export me");
  assert.ok(!JSON.stringify(data.book_requests).includes("hash"));
});
