// Admin forms redirect after saving (Post/Redirect/Get). A POST that renders a
// page itself leaves a POST in the browser history, and the Back button then
// shows "Confirm form resubmission". This file checks that
//   1. (static) no admin POST/PUT/DELETE handler renders a page or sends a body
//      itself, except the allow-listed ones below (downloads, JSON for fetch());
//   2. (HTTP, real routers and views) the POSTs that used to render a page now
//      answer 303 to a GET that shows the same thing once, from the session.
// Own database: it creates orders, copies and a session.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { adminHarness } = require("../helpers/adminHarness");
const { makeOrder } = require("../helpers/orderFixtures");

// ---------- 1. static scan of every admin POST route ----------

const ADMIN_DIR = path.join(__dirname, "..", "..", "src", "routes", "admin");

// Handlers that may answer a POST with a body: a download or JSON for fetch().
const MAY_SEND = new Set([
  "/admin/translate-french/:kind", // JSON for public/french-translate.js (fetch): the French text goes into the form, nothing is saved
  "/admin/privacy/export", // the JSON data-request download
  "/admin/inventory/generate-description", // JSON for public/app.js
  "/admin/blog/translate", // JSON for public/blog-translate.js (fetch): the French text goes into the form, nothing is saved
  "/admin/inventory", // "Save and add another" on the Add Book page: JSON for public/scan-intake.js (fetch); a plain form post redirects
  "/admin/till/sale", // JSON for the till's fetch()
  "/admin/till/scan", // ditto
  "/admin/till/release",
  "/admin/till/check",
  "/admin/forum/hide", // plain-text 400 for a missing reason (no valid target yet)
]);

function postHandlers(file) {
  const src = fs.readFileSync(path.join(ADMIN_DIR, file), "utf8");
  // Chunks start at a route registration or a top-level function, so a helper
  // that renders pages for GET routes is not blamed on the POST before it.
  const parts = src.split(/^(?=router\.(?:get|post|put|patch|delete|use)\(|(?:async )?function |const \w+ = (?:async )?\()/m);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^router\.(post|put|patch|delete)\(\s*"([^"]+)"/);
    if (m) out.push({ file, route: m[2], code: part.replace(/^\s*\/\/.*$/gm, "") });
  }
  return out;
}

test("no admin POST/PUT/DELETE handler renders a page itself (every one redirects)", () => {
  const handlers = fs.readdirSync(ADMIN_DIR).filter((f) => f.endsWith(".js")).flatMap(postHandlers);
  assert.ok(handlers.length > 90, `found ${handlers.length} admin write routes`);
  const offenders = [];
  for (const { file, route, code } of handlers) {
    const renders = code.match(/\.render\((?!"404")|\brender[A-Z]\w*\(/g);
    const sends = MAY_SEND.has(route) ? null : code.match(/res\.(?:send|json|type)\(/g);
    if (renders || sends) offenders.push(`${file} ${route}: ${[...(renders || []), ...(sends || [])].join(" ")}`);
  }
  assert.deepEqual(offenders, [], "these POST handlers answer with a page instead of a redirect");
});

// ---------- 2. over HTTP ----------

const h = adminHarness("admin_post_redirect", ["priceSuggestions", "inventory", "pricing", "sessions", "orders", "till", "privacyRequests"], { isolated: true });
before(() => h.start());
after(() => h.stop());

// One person's browser: the session cookie is kept between requests.
function browser() {
  let cookie = "";
  const send = async (method, p, fields) => {
    const headers = { "x-test-user": JSON.stringify(h.admin), cookie };
    let body;
    if (fields) {
      body = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
      body = body.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(`${h.base}${p}`, { method, redirect: "manual", headers, body });
    const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
    if (set.length) cookie = set.join("; ");
    return { res, status: res.status, location: res.headers.get("location"), text: await res.text() };
  };
  return {
    get: (p) => send("GET", p),
    post: (p, f = {}) => send("POST", p, f),
    // POST, expect 303, follow it (as the browser does), return the page.
    async submit(p, f = {}) {
      const first = await send("POST", p, f);
      assert.equal(first.status, 303, `POST ${p} answers a redirect, not a page (got ${first.status})`);
      const page = await send("GET", first.location);
      return { ...page, target: first.location };
    },
  };
}

test("privacy: search, confirm and a refused erase redirect; the result shows once and the address is not in the URL", async () => {
  const b = browser();
  const email = `pr-${h.uniq()}@example.test`;
  let r = await b.submit("/admin/privacy/search", { email });
  assert.equal(r.target, "/admin/privacy");
  assert.ok(r.text.includes(email));
  assert.ok(!(await b.get("/admin/privacy")).text.includes(email), "a reload does not show it again (and not in the URL)");

  r = await b.submit("/admin/privacy/search", { email: "not an address" });
  assert.match(r.text, /Enter one valid email address/);

  r = await b.submit("/admin/privacy/erase-confirm", { email });
  assert.ok(r.text.includes(email));
  assert.match(r.text, /confirmEmail/);

  r = await b.submit("/admin/privacy/erase", { email, confirmEmail: "other@example.test" });
  assert.match(r.text, /does not match\. Nothing was erased/);

  r = await b.submit("/admin/privacy/erase", { email, confirmEmail: email });
  assert.match(r.text, /Everything held under that address was erased/);
});

test("pricing: a refused save redirects, then shows the message and what was typed", async () => {
  const b = browser();
  const r = await b.submit("/admin/pricing", { levels: "abc" });
  assert.equal(r.target, "/admin/pricing");
  assert.equal(r.status, 200);
  assert.match(r.text, /class="(?:error|notice-box)[^"]*"/);
  assert.ok(r.text.includes("abc"));
});

test("sessions: a refused form redirects to the calendar and shows the message once", async () => {
  const b = browser();
  const r = await b.submit("/admin/sessions", { title: "T", date: "2031-05-05", startTime: "10:00", capacity: "-3", month: "2031-05" });
  assert.equal(r.target, "/admin/sessions?month=2031-05");
  assert.match(r.text, /Capacity/);
  assert.doesNotMatch((await b.get("/admin/sessions?month=2031-05")).text, /Capacity must|Capacity:/);
});

test("orders: refused collect / extend / refund redirect and show the message on the order page", async () => {
  const b = browser();
  const { order } = await makeOrder(h.pool, { status: "reserved" });
  let r = await b.submit(`/admin/orders/${order.id}/collect`, { method: "" });
  assert.equal(r.target, `/admin/orders/${order.id}`);
  assert.match(r.text, /Choose how the customer paid/);

  const { order: paid } = await makeOrder(h.pool, { status: "paid" });
  r = await b.submit(`/admin/orders/${paid.id}/refund`, { note: "kept-note-text" });
  assert.equal(r.target, `/admin/orders/${paid.id}/refund`);
  assert.match(r.text, /Tick the box/);
  assert.ok(r.text.includes(">kept-note-text</textarea>"), "the typed note is kept");

  r = await b.submit(`/admin/orders/${paid.id}/extend`);
  assert.equal(r.target, `/admin/orders/${paid.id}`);
  assert.match(r.text, /no longer a reservation/);
});

test("till items: a refused form redirects to the list with the message", async () => {
  const b = browser();
  const r = await b.submit("/admin/till/items", { name: "", price: "1" });
  assert.match(r.target, /^\/admin\/till\/items\?error=/);
  assert.equal(r.status, 200);
});

test("inventory: move scan, lookup, suggest and refused forms all redirect", async () => {
  const b = browser();
  const isbn = `9780${String(Date.now()).slice(-9)}`.slice(0, 13);
  const { rows: [book] } = await h.pool.query("INSERT INTO books (isbn, title, authors) VALUES ($1, 'Redirect Tester', 'A. Author') RETURNING id", [isbn]);
  const { rows: [copy] } = await h.pool.query("INSERT INTO book_copies (book_id, status, condition, price) VALUES ($1, 'in_stock', 'very_good', 6) RETURNING id", [book.id]);

  let r;
  r = await b.submit("/admin/inventory/move", { dest: "Shelf Z", scan: isbn });
  assert.equal(r.target, "/admin/inventory/move");
  assert.match(r.text, /Moved: Redirect Tester/);

  r = await b.submit("/admin/inventory/lookup", { isbn: "" });
  assert.equal(r.target, "/admin/inventory/lookup");
  assert.match(r.text, /Enter an ISBN or choose a photo/);
  assert.equal((await b.get("/admin/inventory/lookup")).status, 302, "a reload of the result goes back to the scan page");

  r = await b.submit("/admin/inventory/suggest", { title: "Typed Title", author: "Typed Author", condition: "very_good" });
  assert.equal(r.target, "/admin/inventory/new/again");
  assert.ok(r.text.includes("Typed Title"));

  r = await b.submit("/admin/inventory", { title: "", author: "Kept Author" });
  assert.equal(r.target, "/admin/inventory/new/again");
  assert.match(r.text, /Title is required/);
  assert.ok(r.text.includes("Kept Author"));

  r = await b.submit(`/admin/inventory/${book.id}`, { title: "Redirect Tester", publishedYear: "20x5" });
  assert.equal(r.target, `/admin/inventory/${book.id}`);
  assert.ok(r.text.includes("20x5"));

  r = await b.submit(`/admin/inventory/${book.id}/copies/${copy.id}`, { condition: "very_good", price: "abc" });
  assert.equal(r.target, `/admin/inventory/${book.id}`);
  assert.ok(r.text.includes("abc"));

  r = await b.submit(`/admin/inventory/${book.id}/copies/${copy.id}/suggest`, { condition: "very_good" });
  assert.equal(r.target, `/admin/inventory/${book.id}`);

  r = await b.submit(`/admin/inventory/${book.id}/copies/${copy.id}/cancel-reservation`);
  assert.equal(r.target, `/admin/inventory/${book.id}`);
  assert.match(r.text, /already gone/);
});
