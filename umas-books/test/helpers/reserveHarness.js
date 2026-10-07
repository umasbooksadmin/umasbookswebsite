// In-process harness for "reserve online, pay at the shop" tests: the REAL cart,
// account and admin order routes on one app (MemoryStore session, no CSRF: see
// inProcessApp.js), the mailer stubbed (every email lands in `sent`), and
// NOTHING that talks to HelloAsso allowed: any call to its client or to a
// helloasso host throws (assertNoHelloAssoCalls counts them).
//
//   const h = reserveHarness("my_label");   // call at the top of the file
//   before(() => h.start());  after(() => h.stop());
//   const buyer = await h.account();                 // a confirmed account
//   const v = h.visitor(buyer);                      // a browser session (cookie jar), logged in as buyer; h.visitor() = guest
//   await v.post("/cart/add", { copyId });  await v.post("/cart/reserve", { name, acceptCgv: "on" });
//   const admin = h.visitor(h.admin);  await admin.post(`/admin/orders/${id}/collect`, {...});
//
// Every visitor sends its own X-Forwarded-For (trusted by this harness), so rate
// limits keyed on the IP never collide between tests that share a database.

const { prepareDatabase, buildApp, listen } = require("./inProcessApp");
const { makeCookieJar } = require("./httpClient");
const { createAccount, sessionHeaders } = require("./accounts");

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function reserveHarness(label, { isolated = true } = {}) {
  const db = prepareDatabase(label, { isolated });

  const mailer = require("../../src/mailer");
  const sent = [];
  mailer.sendMail = async (opts) => { sent.push(opts); };

  // Nothing in the reservation path may talk to HelloAsso: make any attempt loud.
  const helloasso = require("../../src/lib/helloasso");
  const helloassoCalls = [];
  for (const name of Object.keys(helloasso)) {
    if (typeof helloasso[name] !== "function") continue;
    helloasso[name] = async () => {
      helloassoCalls.push(`helloasso.${name}`);
      throw new Error(`HelloAsso must not be called on the reservation path (${name})`);
    };
  }
  const realFetch = global.fetch;
  global.fetch = (url, ...rest) => {
    if (/helloasso/i.test(String(url))) {
      helloassoCalls.push(`fetch ${url}`);
      return Promise.reject(new Error(`HelloAsso must not be called on the reservation path (${url})`));
    }
    return realFetch(url, ...rest);
  };

  const { pool } = require("../../src/db");
  const h = { pool, sent, helloassoCalls, uniq, base: null, admin: null, db };
  let server;

  let ipSeq = Math.floor(Math.random() * 200) * 250;
  const nextIp = () => { ipSeq += 1; return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

  h.start = async () => {
    db.create();
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at)
       VALUES ($1, 'x', 'Shop Admin', TRUE, now()) RETURNING id, email`,
      [`reserve-admin-${uniq()}@example.test`]
    );
    h.admin = { id: rows[0].id, email: rows[0].email, display_name: "Shop Admin", is_admin: true, is_member: false };
    const express = require("express");
    const { isPreviewMode } = require("../../src/lib/preview");
    const previewLocals = express.Router();
    previewLocals.use((req, res, next) => { res.locals.preview = isPreviewMode(); next(); });
    const app = buildApp([
      previewLocals,
      require("../../src/routes/cart"),
      require("../../src/routes/account"),
      require("../../src/routes/admin/orders"),
      require("../../src/routes/admin/dashboard"),
      require("../../src/routes/admin/reports"),
      require("../../src/routes/admin/inventory"),
    ]);
    app.set("trust proxy", true);
    server = await listen(app);
    h.base = server.base;
  };

  h.stop = async () => {
    delete process.env.PREVIEW_MODE;
    global.fetch = realFetch;
    if (server) await server.close();
    await pool.end();
    db.drop();
  };

  // A confirmed account (a user row); lang is the language of its pages.
  h.account = (opts = {}) => createAccount(pool, { email: `acct-${uniq()}@example.test`, displayName: "Reserve Buyer", ...opts });

  // A browser: its own cookie jar and IP. `user` = a createAccount() result or h.admin; none = a guest.
  h.visitor = (user, { lang } = {}) => {
    const jar = makeCookieJar();
    const ip = nextIp();
    const asUser = user ? (user.is_admin ? { ...user, isAdmin: true } : user) : null;
    const identity = asUser
      ? (asUser.isAdmin
        ? { "x-test-user": JSON.stringify({ id: asUser.id, email: asUser.email, displayName: asUser.display_name, isAdmin: true, isMember: false, isVolunteer: false }) }
        : sessionHeaders(asUser))
      : {};
    const send = async (path, { method = "GET", form } = {}) => {
      const body = form ? new URLSearchParams() : undefined;
      if (form) for (const [k, v] of Object.entries(form)) for (const item of [].concat(v)) body.append(k, String(item));
      const res = await fetch(`${h.base}${path}`, {
        method, redirect: "manual",
        headers: {
          "x-forwarded-for": ip,
          cookie: [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; "),
          ...identity,
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        body: body ? body.toString() : undefined,
      });
      jar.capture(res);
      // 303 = an admin form answered Post/Redirect/Get: follow it like the browser (see followSeeOther).
      if (res.status === 303) {
        const next = await fetch(`${h.base}${res.headers.get("location")}`, { redirect: "manual", headers: { "x-forwarded-for": ip, cookie: [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; "), ...identity } });
        jar.capture(next);
        return { res: next, status: next.status, text: await next.text(), location: next.headers.get("location"), seeOther: res.headers.get("location") };
      }
      return { res, status: res.status, text: await res.text(), location: res.headers.get("location") };
    };
    return { jar, ip, get: (p) => send(p), post: (p, form = {}) => send(p, { method: "POST", form }) };
  };

  // ---------- fixtures ----------
  h.copy = async ({ price = 6, status = "in_stock", title, location = null } = {}) => {
    const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'Fixture Author') RETURNING id", [title || `Reserve Book ${uniq()}`]);
    const { rows } = await pool.query(
      "INSERT INTO book_copies (book_id, status, price, location) VALUES ($1, $2, $3, $4) RETURNING id",
      [b[0].id, status, price, location]
    );
    return rows[0].id;
  };
  h.session = async ({ capacity = 5, price = 8, startsInHours = 24 * 7, endsInHours = null, title } = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO classes (title, starts_at, ends_at, capacity, dropin_price)
       VALUES ($1, now() + make_interval(hours => $2), CASE WHEN $3::numeric IS NULL THEN NULL ELSE now() + make_interval(hours => $3::int) END, $4, $5) RETURNING id`,
      [title || `Reserve Session ${uniq()}`, startsInHours, endsInHours, capacity, price]
    );
    return rows[0].id;
  };

  // ---------- reading ----------
  h.copyStatus = async (id) => (await pool.query("SELECT status FROM book_copies WHERE id = $1", [id])).rows[0].status;
  h.order = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
  h.ordersOf = async (user) => (await pool.query("SELECT * FROM orders WHERE user_id = $1 ORDER BY id", [user.id])).rows;
  h.emailsTo = (to) => sent.filter((m) => m.to === to);
  h.audit = async (id) => (await pool.query("SELECT action, detail FROM admin_audit_log WHERE target_type = 'order' AND target_id = $1 ORDER BY id", [id])).rows;

  // Reserve `copyIds` (and `classIds` seats) as `user`; resolves { order, v, r }.
  h.reserve = async (user, { copyIds = [], classIds = [], v, lang, name = "Reserve Buyer" } = {}) => {
    const visitor = v || h.visitor(user, { lang });
    for (const c of copyIds) await visitor.post("/cart/add", { copyId: c });
    for (const c of classIds) await visitor.post("/cart/add-dropin", { classId: c });
    const r = await visitor.post("/cart/reserve", { name, acceptCgv: "on" });
    const token = (r.location || "").match(/order=([0-9a-f-]{36})/);
    const order = token ? (await pool.query("SELECT * FROM orders WHERE access_token = $1", [token[1]])).rows[0] : null;
    return { order, v: visitor, r };
  };

  return h;
}

module.exports = { reserveHarness, uniq };
