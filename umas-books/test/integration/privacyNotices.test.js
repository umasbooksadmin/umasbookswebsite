// Privacy notice at every point of data collection, role attributes on
// alert boxes, noindex on account pages, and helpful 404/500 pages.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3621;
let app, pool;
const view = (p) => fs.readFileSync(path.join(__dirname, "../../views", p), "utf8");
const get = async (p) => (await fetch(`${app.base}${p}`)).text();

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  app.stop();
});

test("signup and contact forms link to the privacy policy", async () => {
  for (const p of ["/signup", "/contact"]) {
    assert.match(await get(p), /href="\/privacy-policy\.html"/, p);
  }
});

test("contact privacy line exists in French too", async () => {
  const html = await (await fetch(`${app.base}/contact`, { headers: { cookie: "umasbooks_lang=fr" } })).text();
  assert.match(html, /Vos données servent uniquement[^<]*<a href="\/privacy-policy\.html">politique de confidentialité<\/a>/);
});

test("checkout form links to terms of sale and privacy policy", () => {
  const src = view("cart.ejs");
  assert.match(src, /terms-of-sale\.html/);
  assert.match(src, /partials\/privacy_note/);
});

test("forms that collect new personal data carry the privacy note (one-click buttons do not need it)", () => {
  for (const f of ["partials/calendar_item_event.ejs", "forum_new.ejs", "forum_thread.ejs", "charity.ejs", "cart.ejs", "signup.ejs"]) {
    assert.match(view(f), /privacy_note/, f);
  }
});

test("every form on the marketing pages (volunteer, pre-registration) links to the privacy policy, EN + FR, states the 12-month mailbox retention, and none is a mailto form", () => {
  const dir = path.join(__dirname, "../../views/marketing");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ejs"));
  for (const f of files) assert.doesNotMatch(view(`marketing/${f}`), /data-mailto=/, `${f}: mailto forms are gone`);
  const forms = files.filter((f) => /<form[^>]*action="\/(pre-registration|volunteer-signup)"/.test(view(`marketing/${f}`)));
  assert.deepEqual(forms.sort(), ["pre-registration.ejs", "volunteer.ejs"]);
  for (const f of forms) {
    const src = view(`marketing/${f}`);
    assert.match(src, /privacy-policy\.html/, f);
    const [en, fr] = src.split("const pageI18nFr");
    assert.match(en.split("const pageI18nEn")[1], /\.privacy": "[^\n]*privacy-policy\.html/, `${f}: EN note`);
    assert.match(fr, /\.privacy": "[^\n]*privacy-policy\.html/, `${f}: FR note`);
    assert.match(en.split("const pageI18nEn")[1], /\.privacy": "[^\n]*deleted from our mailbox after 12 months/, `${f}: EN retention`);
    assert.match(fr, /\.privacy": "[^\n]*supprimée?s? de notre messagerie après 12 mois/, `${f}: FR retention`);
  }
});

test("pre-registration states a minor's data comes from a parent or guardian, EN + FR", async () => {
  const html = await get("/pre-registration.html");
  assert.match(html, /parent or legal guardian/);
  assert.match(html, /représentant légal/);
  assert.match(html, /privacy-policy\.html/);
});

test("alert and notice boxes carry ARIA roles in every view", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(__dirname, "../../views")).filter((x) => x.endsWith(".ejs"))) {
    const src = fs.readFileSync(f, "utf8");
    // A box is fine with its role before or after the class attribute.
    assert.equal((src.match(/<div(?![^>]*\brole=)[^>]*class="error-box/g) || []).length, 0, `${f}: error-box without role`);
    assert.equal((src.match(/<div(?![^>]*\brole=)[^>]*class="notice-box/g) || []).length, 0, `${f}: notice-box without role`);
  }
  assert.match(view("login.ejs"), /<div[^>]*role="alert"[^>]*class="error-box"|<div[^>]*class="error-box"[^>]*role="alert"/);
  assert.match(view("login.ejs"), /<div[^>]*role="status"[^>]*class="notice-box"|<div[^>]*class="notice-box"[^>]*role="status"/);
});

test("book cover has descriptive alt text", async () => {
  const { rows: b } = await pool.query(
    "INSERT INTO books (title, authors, cover_url) VALUES ('Alt Book', 'A', $1) RETURNING id", [`/img/${"a".repeat(64)}.jpg`]);
  await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5)", [b[0].id]);
  assert.match(await get(`/books/${b[0].id}`), /alt="Cover of Alt Book"/);
});

test("account, login, signup, cart and password pages are noindex; public pages are not", async () => {
  for (const p of ["/login", "/signup", "/cart", "/forgot-password"]) {
    assert.match(await get(p), /<meta name="robots" content="noindex">/, p);
  }
  assert.doesNotMatch(await get("/contact"), /noindex/);
});

test("404 and 500 pages give a contact address and French text", async () => {
  const nf = await get("/definitely-not-a-page");
  assert.match(nf, /admin@umasbooks\.org/);
  const nfFr = await (await fetch(`${app.base}/definitely-not-a-page`, { headers: { cookie: "umasbooks_lang=fr" } })).text();
  assert.match(nfFr, /admin@umasbooks\.org/);
  assert.match(nfFr, /<h1>Page introuvable<\/h1>/);
  const err = view("500.ejs");
  assert.match(err, /admin@umasbooks\.org/);
  assert.match(err, /'Une erreur est survenue'/);
});
