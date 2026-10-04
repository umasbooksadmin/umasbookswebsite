// Customer book requests, the public side (src/routes/bookRequests.js):
// the form and its limits, the neutral answer, double opt-in, the private
// manage link, "find my requests", and the My Account section.
//
// In-process so the mailer can be stubbed. The route's limiters are
// module-level state, so every scenario loads a FRESH copy of the router.
// Every value is unique (CI shares one database between files).

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen, waitFor } = require("../helpers/inProcessApp");
const { makeClient, makeUser, uniq } = require("../helpers/routeClient");

const db = prepareDatabase("bookreq_public");
const mailer = require("../../src/mailer");
const sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };

const { pool } = require("../../src/db");
const privacy = require("../../src/lib/privacy");

const ROUTE = require.resolve("../../src/routes/bookRequests");

before(() => db.create());
after(async () => {
  await pool.end();
  db.drop();
});
beforeEach(() => { sent.length = 0; });

async function withApp(fn) {
  delete require.cache[ROUTE];
  const server = await listen(buildApp([require(ROUTE), require("../../src/routes/account")]));
  try {
    await fn(makeClient(server.base));
  } finally {
    await server.close();
  }
}

const form = (over = {}) => ({ title: `Title ${uniq()}`, email: `rq-${uniq()}@example.test`, ...over });
const row = async (email) => (await pool.query("SELECT * FROM book_requests WHERE lower(email) = $1 ORDER BY id DESC", [email.toLowerCase()])).rows[0];
const mailTo = (email) => sent.filter((m) => m.to === email);
const tokenIn = (mail, re) => mail.text.match(re)[1];
const CONFIRM_RE = /\/request-a-book\/confirm\/([a-f0-9]{64})/;
const MANAGE_RE = /\/my-requests\/([a-f0-9]{64})/;
const LIST_RE = /\/my-requests\/list\/([a-f0-9]{64})/;

// Submits the form, waits for the confirmation mail, returns its tokens.
async function submit(c, fields, opts) {
  const res = await c.post("/request-a-book", fields, opts);
  assert.equal(res.status, 200);
  const mail = await waitFor(() => mailTo(fields.email)[0], { message: "confirmation email" });
  return { res, mail, confirm: tokenIn(mail, CONFIRM_RE), manage: tokenIn(mail, MANAGE_RE) };
}

async function openRequest(c, over = {}) {
  const fields = form(over);
  const { confirm, manage } = await submit(c, fields);
  const confirmed = await c.post(`/request-a-book/confirm/${confirm}`, {});
  assert.equal(confirmed.status, 200);
  sent.length = 0;
  return { fields, manage };
}

test("the form renders with a honeypot, a CSRF field and a link to the privacy policy", async () => {
  await withApp(async (c) => {
    const { status, text } = await c.get("/request-a-book");
    assert.equal(status, 200);
    assert.match(text, /name="title"[^>]*required/);
    assert.match(text, /name="website"/);
    assert.match(text, /name="_csrf"/);
    assert.match(text, /href="\/privacy-policy\.html"/);
  });
});

test("a logged-in customer gets name and email pre-filled, and the request stores user_id", async () => {
  await withApp(async (c) => {
    const user = await makeUser(pool, { name: "Pre Filled" });
    const page = await c.get("/request-a-book", { as: user });
    assert.match(page.text, new RegExp(`value="${user.email.replace(".", "\\.")}"`));
    assert.match(page.text, /value="Pre Filled"/);
    const fields = form({ email: user.email });
    await submit(c, fields, { as: user });
    assert.equal((await row(user.email)).user_id, user.id);
  });
});

test("validation: title, one valid email, ISBN shape and field lengths", async () => {
  const bad = [
    [{ title: "" }, /title/i],
    [{ email: "nope" }, /email/i],
    [{ email: "a@example.test, b@example.test" }, /email/i],
    [{ title: "x".repeat(201) }, /too long/i],
    [{ note: "n".repeat(501) }, /too long/i],
    [{ isbn: "123" }, /ISBN/],
  ];
  for (const [over, message] of bad) {
    // A fresh app per case: every POST, valid or not, counts toward the 5-a-day limit.
    await withApp(async (c) => {
      const fields = form(over);
      const { status, text } = await c.post("/request-a-book", fields);
      assert.equal(status, 400, JSON.stringify(over).slice(0, 40));
      assert.match(text, message);
      if (over.email === undefined) assert.equal(await row(fields.email), undefined, "nothing stored");
    });
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 0);
});

test("the ISBN is normalised to digits and X; the 200-character title limit is inclusive", async () => {
  await withApp(async (c) => {
    const a = form({ isbn: "978-0-14-143951-8", title: "t".repeat(200) });
    await submit(c, a);
    const r = await row(a.email);
    assert.equal(r.isbn, "9780141439518");
    assert.equal(r.title.length, 200);
    const b = form({ isbn: "0-8044-2957-x" });
    await submit(c, b);
    assert.equal((await row(b.email)).isbn, "080442957X");
    // a name, author and note are stored as typed
    const d = form({ name: "Jean", author: "Camus", note: "paperback please" });
    await submit(c, d);
    const dr = await row(d.email);
    assert.deepEqual([dr.name, dr.author, dr.note, dr.status, dr.lang], ["Jean", "Camus", "paperback please", "unconfirmed", "en"]);
  });
});

test("honeypot: a filled hidden field gets the normal page but stores and sends nothing", async () => {
  await withApp(async (c) => {
    const fields = form({ website: "http://spam.example" });
    const normal = await c.post("/request-a-book", form());
    const trapped = await c.post("/request-a-book", fields);
    assert.equal(trapped.status, 200);
    assert.equal(trapped.text, normal.text);
    assert.equal(await row(fields.email), undefined);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mailTo(fields.email).length, 0);
  });
});

test("the answer is identical for a new request, a duplicate and an address over its cap (no enumeration)", async () => {
  await withApp(async (c) => {
    const email = `rq-${uniq()}@example.test`;
    const first = await submit(c, form({ email, title: "One" }), undefined);
    sent.length = 0;
    const dup = await c.post("/request-a-book", { title: "one", email });
    for (const t of ["Two", "Three"]) await c.post("/request-a-book", { title: t, email });
    const capped = await c.post("/request-a-book", { title: "Four", email });
    assert.equal(first.res.text, dup.text);
    assert.equal(first.res.text, capped.text);
    assert.match(first.res.text, /Check your inbox/);
    // the duplicate (title differs only by case) and the 4th title created nothing
    const { rows } = await pool.query("SELECT title FROM book_requests WHERE lower(email) = $1 ORDER BY id", [email]);
    assert.deepEqual(rows.map((r) => r.title), ["One", "Two", "Three"]);
  });
});

test("at most 3 pending requests per email; a cancelled one frees a slot", async () => {
  await withApp(async (c) => {
    const email = `rq-${uniq()}@example.test`;
    for (const t of ["A", "B", "C"]) await c.post("/request-a-book", { title: t, email });
    await c.post("/request-a-book", { title: "D", email });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM book_requests WHERE lower(email) = $1", [email])).rows[0].n, 3);
    await pool.query("UPDATE book_requests SET status = 'cancelled' WHERE lower(email) = $1 AND title = 'A'", [email]);
    await c.post("/request-a-book", { title: "D", email });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM book_requests WHERE lower(email) = $1", [email])).rows[0].n, 4);
  });
});

test("5 requests a day per connection: the 6th is refused with 429 and stores nothing", async () => {
  await withApp(async (c) => {
    for (let i = 0; i < 5; i++) assert.equal((await c.post("/request-a-book", form())).status, 200);
    const fields = form();
    const sixth = await c.post("/request-a-book", fields);
    assert.equal(sixth.status, 429);
    assert.match(sixth.text, /several requests today/);
    assert.equal(await row(fields.email), undefined);
  });
});

test("double opt-in: GET only shows a Confirm button; the POST confirms; a used link is refused", async () => {
  await withApp(async (c) => {
    const fields = form({ title: `Confirm ${uniq()}` });
    const { confirm } = await submit(c, fields);
    assert.equal((await row(fields.email)).status, "unconfirmed");

    const page = await c.get(`/request-a-book/confirm/${confirm}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /method="post" action="\/request-a-book\/confirm\//);
    assert.ok(page.text.includes(fields.title));
    assert.equal((await row(fields.email)).status, "unconfirmed", "a GET (e.g. a mail scanner) must not confirm");

    const done = await c.post(`/request-a-book/confirm/${confirm}`, {});
    assert.equal(done.status, 200);
    const r = await row(fields.email);
    assert.equal(r.status, "open");
    assert.ok(r.confirmed_at);
    assert.equal(r.confirm_token_hash, null);
    const months = (await pool.query("SELECT round(extract(epoch FROM (expires_at - created_at)) / 86400 / 30.4)::int AS m FROM book_requests WHERE id = $1", [r.id])).rows[0].m;
    assert.equal(months, 12);

    assert.equal((await c.post(`/request-a-book/confirm/${confirm}`, {})).status, 400);
    assert.equal((await c.get(`/request-a-book/confirm/${confirm}`)).status, 400);
    assert.equal((await c.get("/request-a-book/confirm/not-a-token")).status, 400);
    assert.equal((await c.post("/request-a-book/confirm/not-a-token", {})).status, 400);
  });
});

test("the confirmation email follows the language of the page the request was made on", async () => {
  await withApp(async (c) => {
    const en = form();
    const fr = form();
    const a = await submit(c, en);
    const b = await submit(c, fr, { headers: { cookie: "umasbooks_lang=fr" } });
    assert.match(a.mail.subject, /Please confirm your book request/);
    assert.match(b.mail.subject, /Merci de confirmer votre demande de livre/);
    assert.match(b.mail.text, /Vous nous avez demandé/);
    assert.equal((await row(fr.email)).lang, "fr");
    assert.equal((await row(en.email)).lang, "en");
    // the request page itself is French too
    const page = await c.get("/request-a-book", { headers: { cookie: "umasbooks_lang=fr" } });
    assert.match(page.text, /Vous ne trouvez pas un livre/);
  });
});

test("an unconfirmed request expires after 7 days: the link stops working and the purge deletes it", async () => {
  await withApp(async (c) => {
    const old = form();
    const fresh = form();
    const { confirm } = await submit(c, old);
    await submit(c, fresh);
    await pool.query(
      "UPDATE book_requests SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE lower(email) = $1",
      [old.email]
    );
    assert.equal((await c.get(`/request-a-book/confirm/${confirm}`)).status, 400, "expired link is refused");
    assert.equal((await c.post(`/request-a-book/confirm/${confirm}`, {})).status, 400);
    assert.equal((await row(old.email)).status, "unconfirmed");

    await privacy.purgeExpiredPersonalData(pool);
    assert.equal(await row(old.email), undefined, "deleted");
    assert.equal((await row(fresh.email)).status, "unconfirmed", "a recent one stays");
  });
});

test("manage link: shows the status, cancel clears personal data and keeps title/author/ISBN", async () => {
  await withApp(async (c) => {
    const { fields, manage } = await openRequest(c, { name: "Jean Dupont", author: "Camus", isbn: "9780141439518", note: "a note" });
    const page = await c.get(`/my-requests/${manage}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(fields.title));
    assert.match(page.text, /We are looking/);
    assert.match(page.text, /action="\/my-requests\/[a-f0-9]{64}\/cancel"/);
    assert.ok(!page.text.includes(fields.email) && !page.text.includes("Jean Dupont"), "the page shows no personal data");
    assert.equal(page.res.headers.get("cache-control"), "no-store");
    assert.equal(page.res.headers.get("referrer-policy"), "no-referrer");

    const cancel = await c.post(`/my-requests/${manage}/cancel`, {});
    assert.equal(cancel.status, 302);
    const { rows } = await pool.query("SELECT * FROM book_requests WHERE manage_token_hash = encode(sha256($1::bytea), 'hex')", [manage]);
    const r = rows[0];
    assert.equal(r.status, "cancelled");
    assert.deepEqual([r.email, r.name, r.note, r.user_id], [null, null, null, null]);
    assert.deepEqual([r.title, r.author, r.isbn], [fields.title, "Camus", "9780141439518"]);
    assert.match((await c.get(`/my-requests/${manage}`)).text, /cancelled/i);

    assert.equal((await c.get(`/my-requests/${"0".repeat(64)}`)).status, 404);
    assert.equal((await c.post(`/my-requests/${"0".repeat(64)}/cancel`, {})).status, 404);
  });
});

test("find my requests: always the same answer; a mail with a 30-day link only when requests exist", async () => {
  await withApp(async (c) => {
    const known = form();
    await openRequest(c, known);
    const unknown = `nobody-${uniq()}@example.test`;
    const a = await c.post("/my-requests", { email: known.email });
    const b = await c.post("/my-requests", { email: unknown });
    assert.equal(a.status, 200);
    assert.equal(a.text, b.text);
    assert.match(a.text, /If requests exist for that address/);
    await waitFor(() => mailTo(known.email)[0], { message: "list email" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mailTo(unknown).length, 0);
    assert.equal(mailTo(known.email).length, 1);
    const token = tokenIn(mailTo(known.email)[0], LIST_RE);
    const days = (await pool.query("SELECT round(extract(epoch FROM (expires_at - created_at)) / 86400)::int AS d FROM book_request_list_tokens WHERE email = $1", [known.email])).rows[0].d;
    assert.equal(days, 30);

    const list = await c.get(`/my-requests/list/${token}`);
    assert.equal(list.status, 200);
    assert.ok(list.text.includes(known.title));
    assert.match(list.text, /Cancel all/);
    assert.equal((await c.post("/my-requests", { email: "not an email" })).status, 400);
  });
});

test("the list link cancels one request or all of them, and only that address's own", async () => {
  await withApp(async (c) => {
    const email = `rq-${uniq()}@example.test`;
    const other = form();
    await openRequest(c, other);
    for (const t of ["L1", "L2", "L3"]) await openRequest(c, { email, title: `${t} ${uniq()}` });
    await c.post("/my-requests", { email });
    const token = tokenIn(await waitFor(() => mailTo(email)[0]), LIST_RE);
    const ids = (await pool.query("SELECT id FROM book_requests WHERE lower(email) = $1 ORDER BY id", [email])).rows.map((r) => r.id);

    await c.post(`/my-requests/list/${token}/cancel/${ids[0]}`, {});
    assert.equal((await pool.query("SELECT status FROM book_requests WHERE id = $1", [ids[0]])).rows[0].status, "cancelled");
    // someone else's request id through this link does nothing
    const otherId = (await row(other.email)).id;
    await c.post(`/my-requests/list/${token}/cancel/${otherId}`, {});
    assert.equal((await row(other.email)).status, "open");

    await c.post(`/my-requests/list/${token}/cancel-all`, {});
    const { rows } = await pool.query("SELECT status, email FROM book_requests WHERE id = ANY($1)", [ids]);
    assert.ok(rows.every((r) => r.status === "cancelled" && r.email === null));
    assert.equal((await row(other.email)).status, "open");

    assert.equal((await c.get(`/my-requests/list/${"1".repeat(64)}`)).status, 400);
    await pool.query("UPDATE book_request_list_tokens SET expires_at = now() - interval '1 minute' WHERE email = $1", [email]);
    assert.equal((await c.get(`/my-requests/list/${token}`)).status, 400, "an expired link is refused");
  });
});

test("find my requests is limited to 3 mails a day per address (same answer) and 5 an hour per connection (429)", async () => {
  await withApp(async (c) => {
    const email = `rq-${uniq()}@example.test`;
    await openRequest(c, { email });
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push((await c.post("/my-requests", { email })).text);
    assert.equal(new Set(answers).size, 1, "the fourth answer looks like the others");
    await waitFor(() => mailTo(email).length >= 3, { message: "three list emails" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(mailTo(email).length, 3, "no fourth mail");
    const fifth = await c.post("/my-requests", { email: `x-${uniq()}@example.test` });
    assert.equal(fifth.status, 200);
    const sixth = await c.post("/my-requests", { email: `y-${uniq()}@example.test` });
    assert.equal(sixth.status, 429);
  });
});

test("My Account lists a logged-in non-member's requests (by user id or verified email) and lets them cancel", async () => {
  await withApp(async (c) => {
    const user = await makeUser(pool, { member: false });
    const byId = await pool.query(
      "INSERT INTO book_requests (title, email, status, user_id) VALUES ($1, 'someone-else@example.test', 'open', $2) RETURNING id",
      [`ById ${uniq()}`, user.id]
    );
    const byEmail = await pool.query(
      "INSERT INTO book_requests (title, email, status) VALUES ($1, upper($2), 'matched') RETURNING id",
      [`ByEmail ${uniq()}`, user.email]
    );
    const foreign = await pool.query(
      "INSERT INTO book_requests (title, email, status) VALUES ($1, $2, 'open') RETURNING id",
      [`Foreign ${uniq()}`, `foreign-${uniq()}@example.test`]
    );
    const page = await c.get("/account", { as: user });
    assert.equal(page.status, 200);
    assert.match(page.text, /My book requests/);
    assert.match(page.text, /Orders/, "the existing page is intact");
    assert.ok(page.text.includes("ById ") && page.text.includes("ByEmail "));
    assert.ok(!page.text.includes("Foreign "));
    assert.match(page.text, /We found a copy/);

    const fr = await c.get("/account", { as: user, headers: { cookie: "umasbooks_lang=fr" } });
    assert.match(fr.text, /Mes demandes de livres/);

    // cancel own; someone else's request is untouched
    await c.post(`/account/book-requests/${byId.rows[0].id}/cancel`, {}, { as: user });
    await c.post(`/account/book-requests/${foreign.rows[0].id}/cancel`, {}, { as: user });
    const { rows } = await pool.query("SELECT id, status, email FROM book_requests WHERE id = ANY($1)", [[byId.rows[0].id, byEmail.rows[0].id, foreign.rows[0].id]]);
    const byIdRow = rows.find((r) => r.id === byId.rows[0].id);
    assert.equal(byIdRow.status, "cancelled");
    assert.equal(byIdRow.email, null);
    assert.equal(rows.find((r) => r.id === foreign.rows[0].id).status, "open");
    assert.equal(rows.find((r) => r.id === byEmail.rows[0].id).status, "matched");

    // logged out: bounced to login
    const anon = await c.post(`/account/book-requests/${byEmail.rows[0].id}/cancel`, {});
    assert.equal(anon.status, 302);
    assert.equal(anon.location, "/login");
  });
});

test("an unverified account does not see requests made under its email address", async () => {
  await withApp(async (c) => {
    const user = await makeUser(pool);
    await pool.query("UPDATE users SET email_verified_at = NULL WHERE id = $1", [user.id]);
    await pool.query("INSERT INTO book_requests (title, email, status) VALUES ($1, $2, 'open')", [`Squat ${uniq()}`, user.email]);
    const page = await c.get("/account", { as: user });
    assert.ok(!page.text.includes("Squat "));
  });
});
