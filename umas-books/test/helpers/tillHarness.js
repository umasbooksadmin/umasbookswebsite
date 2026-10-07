// Shared by the till integration tests: starts the real app, logs in an admin,
// and offers get/post/scan/sale helpers plus book/copy seeding.
const { strict: assert } = require("node:assert");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("./testApp");
const { makeCookieJar, fetchCsrfToken } = require("./httpClient");

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function tillHarness({ port, ip, env = {}, loginAdmin = true }) {
  const h = { ip, jar: makeCookieJar(), n: 0 };
  h.app = await startTestApp({ port, isolated: true, env });
  process.env.DATABASE_URL = h.app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  h.pool = require("../../src/db").pool;

  h.post = async (path, fields, jar = h.jar) => {
    const csrf = await fetchCsrfToken(h.app.base, jar, { "x-forwarded-for": ip });
    const res = await fetch(`${h.app.base}${path}`, {
      method: "POST", redirect: "manual",
      headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": ip },
      body: new URLSearchParams({ ...fields, _csrf: csrf }).toString(),
    });
    jar.capture(res);
    return res;
  };
  h.get = async (path, jar = h.jar) => {
    const res = await fetch(`${h.app.base}${path}`, { redirect: "manual", headers: { cookie: jar.header(), "x-forwarded-for": ip } });
    return { res, text: await res.text() };
  };
  h.json = async (path, fields, jar = h.jar) => {
    const res = await h.post(path, fields, jar);
    return { status: res.status, body: await res.json() };
  };

  const password = "Till-Test-Pass-1!";
  const email = `till-admin-${Date.now()}-${port}@example.test`;
  const { rows } = await h.pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member) VALUES ($1, $2, 'Till Admin', true, true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)]
  );
  h.adminId = rows[0].id;
  h.email = email;
  if (loginAdmin) assert.equal((await h.post("/login", { email, password })).status, 302);

  // Another account (a till-only volunteer, a plain member...) with its own cookie jar.
  h.makeUser = async ({ admin = false, till = false, member = false, name = "Till Helper" } = {}) => {
    const mail = `till-user-${Date.now()}-${++h.n}@example.test`;
    const { rows: u } = await h.pool.query(
      `INSERT INTO users (email, password_hash, display_name, is_admin, is_till, is_member, email_verified_at) VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
      [mail, await bcrypt.hash(password, 10), name, admin, till, member]
    );
    const jar = makeCookieJar();
    const res = await h.post("/login", { email: mail, password }, jar);
    assert.equal(res.status, 302);
    return { id: u[0].id, email: mail, jar, location: res.headers.get("location") };
  };

  h.stop = async () => { await h.pool.end(); h.app.stop(); };
  h.uniq = () => `${Date.now()}${++h.n}`;
  // A valid ISBN-13 (real check digit), so its ISBN-10 twin matches too.
  h.isbn13 = () => {
    const body = "978" + String(Date.now()).slice(-6) + String(100 + (++h.n % 900));
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
    return body + String((10 - (sum % 10)) % 10);
  };
  h.token = () => `tok-${h.uniq()}-${Math.random().toString(36).slice(2, 12)}`;

  h.seedBook = async (title, isbn = h.isbn13()) => (await h.pool.query(
    "INSERT INTO books (isbn, title, authors) VALUES ($1, $2, 'An Author') RETURNING id, isbn", [isbn, title])).rows[0];
  h.seedCopy = async (bookId, { status = "in_stock", condition = "very_good", price = 5, publisherPrice = null, location = null } = {}) => (await h.pool.query(
    "INSERT INTO book_copies (book_id, condition, price, publisher_price, status, location) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [bookId, condition, price, publisherPrice, status, location])).rows[0].id;
  h.copy = async (id) => (await h.pool.query("SELECT * FROM book_copies WHERE id = $1", [id])).rows[0];

  h.scan = (code, have = []) => h.json("/admin/till/scan", { code, have: JSON.stringify(have) });
  // items: array of line objects as the page sends them.
  // The page sends the total it showed (expectedTotalCents) with every confirm. Unless a test
  // passes its own, the helper asks /admin/till/check what the server would charge and sends
  // that, like a page whose prices are up to date; when the check refuses, it sends 1 and
  // the sale itself reports the refusal.
  h.sale = async (items, { method = "cash", received = "100", token = h.token(), jar = h.jar, ...rest } = {}) => {
    const form = { token, method, items: JSON.stringify(items), received, cardConfirmed: method === "card" ? "1" : "", ...rest };
    if (form.expectedTotalCents === undefined) {
      const chk = await h.json("/admin/till/check", { method, items: JSON.stringify(items), ...rest }, jar);
      form.expectedTotalCents = chk.body.ok ? String(chk.body.totalCents) : "1";
    } else if (form.expectedTotalCents === null) delete form.expectedTotalCents;
    return h.json("/admin/till/sale", form, jar);
  };
  h.book = (copyId, price = "", reason = "") => ({ kind: "book", copyId, price, reason });
  h.audit = async (action) => (await h.pool.query("SELECT * FROM admin_audit_log WHERE action = $1 ORDER BY id", [action])).rows;
  return h;
}

module.exports = { tillHarness };
