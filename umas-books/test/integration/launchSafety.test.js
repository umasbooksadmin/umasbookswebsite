// Launch safety, part 1 (real server): the trusted-proxy hop count and the
// admin client-IP diagnostics page, the HelloAsso sandbox banner on admin pages,
// and the extensionless marketing redirects.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const PORT = 4101;
let app;
let pool;
let adminJar;

before(async () => {
  app = await startTestApp({
    port: PORT,
    isolated: true,
    env: { TRUST_PROXY_HOPS: "2", HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5" },
  });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const admin = await createAccount(pool, { email: `launch-admin-${Date.now()}@example.test`, displayName: "Launch Admin" });
  await pool.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);
  adminJar = makeCookieJar();
  const res = await loginOverHttp(app.base, adminJar, admin, { "x-forwarded-for": "198.51.100.1, 172.70.0.1" });
  assert.equal(res.status, 302);
});

after(async () => {
  await pool.end();
  app.stop();
});

const getAs = (path, xff) =>
  fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: adminJar.header(), "x-forwarded-for": xff } });

test("TRUST_PROXY_HOPS is logged at boot", async () => {
  await app.waitForLog(/\[proxy\] trusting 2 proxy hop/);
});

test("diagnostics page: req.ip is the client with 'client, edge'", async () => {
  const res = await getAs("/admin/diagnostics/client-ip", "198.51.100.7, 172.70.0.9");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<strong>198\.51\.100\.7<\/strong>/);
  assert.match(html, /198\.51\.100\.7, 172\.70\.0\.9/, "raw X-Forwarded-For is shown");
  assert.match(html, /172\.70\.0\.9/, "req.ips lists the edge");
  assert.match(html, /CF-Connecting-IP/);
  assert.match(html, /True-Client-IP/);
});

test("diagnostics page: a spoofed 'evil, client, edge' still yields the client", async () => {
  const res = await getAs("/admin/diagnostics/client-ip", "6.6.6.6, 198.51.100.7, 172.70.0.9");
  const html = await res.text();
  assert.match(html, /<strong>198\.51\.100\.7<\/strong>/);
  assert.doesNotMatch(html, /<strong>6\.6\.6\.6<\/strong>/);
});

test("diagnostics page is admin-only", async () => {
  const anon = await fetch(`${app.base}/admin/diagnostics/client-ip`, { redirect: "manual" });
  assert.notEqual(anon.status, 200);
  const jar = makeCookieJar();
  const member = await createAccount(pool, { email: `launch-user-${Date.now()}@example.test` });
  await loginOverHttp(app.base, jar, member, { "x-forwarded-for": "198.51.100.2, 172.70.0.1" });
  const res = await fetch(`${app.base}/admin/diagnostics/client-ip`, { redirect: "manual", headers: { cookie: jar.header(), "x-forwarded-for": "198.51.100.2, 172.70.0.1" } });
  assert.notEqual(res.status, 200);
});

test("rate-limit buckets are per real client, not per edge address", async () => {
  // Same edge, different clients: separate ratelimit-remaining counters.
  const remaining = async (client) => {
    const res = await fetch(`${app.base}/api/csrf-token`, { headers: { "x-forwarded-for": `${client}, 172.70.0.50` } });
    return Number(res.headers.get("ratelimit-remaining"));
  };
  const a1 = await remaining("203.0.113.10");
  const a2 = await remaining("203.0.113.10");
  const b1 = await remaining("203.0.113.11");
  assert.equal(a2, a1 - 1);
  assert.equal(b1, a1, "another client behind the same edge starts a fresh bucket");
  // spoofing a different left-hand address does not give a fresh bucket
  const spoof = await fetch(`${app.base}/api/csrf-token`, { headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.10, 172.70.0.50" } });
  assert.equal(Number(spoof.headers.get("ratelimit-remaining")), a2 - 1);
});

test("admin pages show the red HelloAsso sandbox banner when preview is off and the API base is the sandbox", async () => {
  const res = await getAs("/admin", "198.51.100.1, 172.70.0.1");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /HelloAsso sandbox: payments are not real/);
});

test("the sandbox banner is not on customer pages", async () => {
  const res = await fetch(`${app.base}/books.html`);
  assert.doesNotMatch(await res.text(), /HelloAsso sandbox: payments are not real/);
});

test("extensionless marketing addresses redirect to the .html page, keeping the query string", async () => {
  const cases = [
    ["/books", "/books.html"],
    ["/books?genre=Fantasy%20%26%20Co", "/books.html?genre=Fantasy%20%26%20Co"],
    ["/membership", "/membership.html"],
    ["/about", "/about.html"],
    ["/visit", "/visit.html"],
    ["/privacy-policy", "/privacy-policy.html"],
    ["/pre-registration?x=1", "/pre-registration.html?x=1"],
  ];
  for (const [from, to] of cases) {
    const res = await fetch(`${app.base}${from}`, { redirect: "manual" });
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get("location"), to, from);
  }
});

test("app pages that own a plain name keep it (not redirected to marketing)", async () => {
  for (const p of ["/events", "/volunteer"]) {
    const res = await fetch(`${app.base}${p}`, { redirect: "manual" });
    assert.notEqual(res.headers.get("location"), `${p}.html`, p);
  }
  const res = await fetch(`${app.base}/programs`, { redirect: "manual" });
  assert.equal(res.headers.get("location"), "/sessions");
});

test("the book page's back link points at a real page", async () => {
  const { rows } = await pool.query("INSERT INTO books (title, authors) VALUES ('Back Link Book', 'A. Author') RETURNING id");
  const html = await (await fetch(`${app.base}/books/${rows[0].id}`)).text();
  assert.match(html, /href="\/books\.html"/);
  const withGenre = await (await fetch(`${app.base}/books/${rows[0].id}?genre=Fantasy`)).text();
  assert.match(withGenre, /href="\/books\.html\?genre=Fantasy"/);
  assert.equal((await fetch(`${app.base}/books.html`)).status, 200);
});
