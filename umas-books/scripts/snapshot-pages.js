#!/usr/bin/env node
// Developer tool: renders the pages and emails that carry the association's identity and contact facts
// (legal notice, terms of sale, privacy policy, membership terms, visit, contact, home, about, events, the
// 404 page, the footer on each, and the order / reminder emails) in English and French, and writes each as a
// file. Run it on two builds and `diff -r` the two folders: an empty diff proves a refactor of those texts
// (for example moving them into src/lib/legal.js) changed no byte of the output.
//
//   node scripts/snapshot-pages.js --dir <an umas-books directory> --out <empty folder>
//
// It boots that directory's createApp() on a free port against DATABASE_URL (a throwaway database that has been
// migrated; nothing is written to it), with NODE_ENV=test. test/unit/pageSnapshots.test.js runs the same thing
// against the fixtures in test/fixtures/page-snapshots/ (regenerate them with UPDATE_SNAPSHOTS=1).
const fs = require("node:fs");
const path = require("node:path");

const PAGES = [
  "/", "/about.html", "/visit.html", "/events.html", "/privacy-policy.html", "/membership-terms.html",
  "/terms-of-sale.html", "/mentions-legales.html", "/contact", "/no-such-page-for-the-snapshot",
];

// `--wide` (a developer check, not the fixture test): every marketing page, the app pages that share the chrome, and the
// /fr/ addresses, so a change to the shared header/footer/dictionary is proved on all of them.
const WIDE_PAGES = [
  "/books.html", "/blog.html", "/immersion.html", "/membership.html", "/pre-registration.html", "/programs.html", "/volunteer.html",
  "/login", "/favorites", "/cart", "/fr/", "/fr/books.html", "/fr/visit.html", "/fr/events.html", "/fr/privacy-policy.html", "/fr/membership.html",
];

// Anything that legitimately changes between two renders is blanked: the port, asset version hashes, CSRF tokens, nonces.
function normalise(text) {
  return String(text)
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://BASE")
    .replace(/(\?|&)v=[0-9a-zA-Z]+/g, "$1v=X")
    .replace(/name="_csrf" value="[^"]*"/g, 'name="_csrf" value="X"')
    .replace(/nonce="[^"]*"/g, 'nonce="X"')
    .replace(/"csrfToken":"[^"]*"/g, '"csrfToken":"X"');
}

// `base`: an already running app of that directory (the unit test boots one with its own database); without it
// the app is started here on a free port.
async function snapshot(dir, { base: givenBase, wide = false } = {}) {
  const files = {};
  const { createApp } = require(path.join(dir, "src/app"));
  const server = givenBase ? null : await new Promise((resolve, reject) => {
    const s = createApp().listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve(s)));
  });
  const base = givenBase || `http://127.0.0.1:${server.address().port}`;
  try {
    for (const lang of ["en", "fr"]) {
      for (const p of wide ? [...PAGES, ...WIDE_PAGES] : PAGES) {
        const res = await fetch(base + p, { headers: { cookie: `umasbooks_lang=${lang}`, "accept-language": lang }, redirect: "manual" });
        files[`page-${lang}${p === "/" ? "-home" : p.replace(/[^a-zA-Z0-9]+/g, "-")}.txt`] = `${res.status}\n${normalise(await res.text())}`;
      }
    }
  } finally {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  // Views that no public URL renders on demand (error page, the "too many attempts" state, the reservation receipt):
  // rendered straight from the view with the locals the language middleware would give them.
  const renderApp = createApp();
  const { langMiddleware } = require(path.join(dir, "src/middleware/lang"));
  const viewLocals = (lang) => {
    const req = { headers: { cookie: `umasbooks_lang=${lang}` }, url: "/", originalUrl: "/", get: () => undefined };
    const res = { locals: {}, cookie() {}, set() {}, setHeader() {}, getHeader() {}, render() {}, redirect() {}, status() { return this; } };
    langMiddleware(req, res, () => {});
    return { ...res.locals, user: null, cartCount: 0, csrfToken: "X", noindex: true, req };
  };
  const viewOrder = { id: 42, buyer_name: "Ada", buyer_email: "ada@example.org", total_amount: "12.50", created_at: "2026-03-05T23:30:00Z", reserved_until: "2026-03-19T23:00:00Z", paid_at: "2026-03-05T23:30:00Z" };
  for (const lang of ["en", "fr"]) {
    for (const [name, view, extra] of [
      ["500", "500", {}],
      ["my-requests-limited", "my_requests", { state: "limited", notice: null, requests: [] }],
      ["cart-return-reserved", "cart_return", { status: "reserved", order: viewOrder, items: [{ label: "Emma", price: "12.50", isSeat: false }], lastDay: new Date("2026-03-19T12:00:00Z"), isOwner: false }],
    ]) {
      files[`view-${lang}-${name}.txt`] = await new Promise((resolve) => {
        renderApp.render(view, { ...viewLocals(lang), ...extra }, (err, html) => resolve(err ? `ERROR ${String(err.message).split("\n")[0]}` : normalise(html)));
      });
    }
  }
  const orderEmail = require(path.join(dir, "src/lib/orderEmail"));
  const sweeps = require(path.join(dir, "src/lib/orderSweeps"));
  const order = { id: 42, buyer_name: "Ada", total_amount: "12.50", created_at: "2026-03-05T23:30:00Z", reserved_until: "2026-03-19T23:00:00Z", paid_at: "2026-03-05T23:30:00Z" };
  const items = [{ item_title: "Emma", price: "12.50" }];
  for (const lang of ["en", "fr"]) {
    const o = { ...order, lang };
    files[`email-${lang}-confirmation.txt`] = `${orderEmail.orderConfirmationSubject(lang)}\n${orderEmail.buildOrderConfirmationText(o, items, "https://shop.test/")}`;
    for (const [name, build] of [["reminder", orderEmail.buildReservationReminder], ["expired", orderEmail.buildReservationExpiredNotice], ["pickup", sweeps.buildCustomerPickupReminder]]) {
      let out;
      try { out = build(o, items); } catch (e) { out = { subject: `ERROR ${e.message}`, text: "" }; }
      files[`email-${lang}-${name}.txt`] = `${out.subject}\n${out.text}`;
    }
  }
  files["email-sellerLines.txt"] = `${orderEmail.sellerLines("en")}\n--\n${orderEmail.sellerLines("fr")}\n--\n${orderEmail.LEGAL_RIGHTS}\n--\n${orderEmail.LEGAL_RIGHTS_FRENCH_ONLY}`;
  return files;
}

// The identity facts, as a pattern. Written out here on purpose: this file is the reference the facts are checked against.
const FACTS = /admin@umasbooks\.org|109 441 147(?: 00013)?|W811011706|5,? rue Hippolyte Savary[^<"\\]{0,30}/g;

// For every snapshot file, each fact with 60 characters of context either side (pages are big; the facts are what
// the refactor could have broken). { file: [snippet, ...] }, files without a fact left out.
function identitySnippets(files) {
  const out = {};
  for (const [name, text] of Object.entries(files)) {
    const found = [];
    for (const m of String(text).matchAll(FACTS)) found.push(String(text).slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, " "));
    if (found.length) out[name] = found;
  }
  return out;
}

module.exports = { snapshot, identitySnippets, PAGES, normalise };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const dir = path.resolve(opt("--dir") || path.join(__dirname, ".."));
  const out = opt("--out");
  const identityFile = opt("--identity");
  if (!out && !identityFile) { console.error("usage: node scripts/snapshot-pages.js --dir <umas-books dir> [--out <folder>] [--identity <file.json>] [--wide]"); process.exit(2); }
  Object.assign(process.env, { NODE_ENV: "test", SESSION_SECRET: "snapshot-session-secret", PGSSLMODE: "disable", AWARDS_LOOKUPS: "off", COVER_BACKFILL: "off" });
  if (!require("../src/lib/config").get("DATABASE_URL")) { console.error("Set DATABASE_URL to a migrated throwaway database."); process.exit(2); }
  snapshot(dir, { wide: argv.includes("--wide") }).then(async (files) => {
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text);
      console.log(`wrote ${Object.keys(files).length} files to ${out}`);
    }
    if (identityFile) {
      fs.mkdirSync(path.dirname(path.resolve(identityFile)), { recursive: true });
      fs.writeFileSync(identityFile, `${JSON.stringify(identitySnippets(files), null, 1)}\n`);
      console.log(`wrote the identity snippets to ${identityFile}`);
    }
    await require(path.join(dir, "src/db")).pool.end();
    process.exit(0);
  }, (err) => { console.error(err); process.exit(1); });
}
