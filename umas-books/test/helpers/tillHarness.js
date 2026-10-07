// Shared by the till integration tests: starts the real app, logs in an admin,
// and offers get/post/scan/sale helpers plus book/copy seeding.
const { strict: assert } = require("node:assert");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("./testApp");
const { makeCookieJar, fetchCsrfToken, followSeeOther } = require("./httpClient");

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function tillHarness({ port, ip }) {
  const h = { ip, jar: makeCookieJar(), n: 0 };
  h.app = await startTestApp({ port, isolated: true });
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
    return followSeeOther(res, { base: h.app.base, jar, headers: { "x-forwarded-for": ip } });
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
  assert.equal((await h.post("/login", { email, password })).status, 302);

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
  h.sale = (items, { method = "cash", received = "100", token = h.token(), ...rest } = {}) =>
    h.json("/admin/till/sale", { token, method, items: JSON.stringify(items), received, cardConfirmed: method === "card" ? "1" : "", ...rest });
  h.book = (copyId, price = "", reason = "") => ({ kind: "book", copyId, price, reason });
  h.audit = async (action) => (await h.pool.query("SELECT * FROM admin_audit_log WHERE action = $1 ORDER BY id", [action])).rows;
  return h;
}

module.exports = { tillHarness };
