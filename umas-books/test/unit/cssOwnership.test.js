// One owner per CSS class. The marketing site and the app used to define the same class names in several sheets
// (.site-back-bar twice, .dash-row twice, .card in three...). When two sheets that load on the SAME page both
// declare a selector, which declaration wins depends on the order of the <link> tags, and editing one rule
// silently has no effect (or changes the other design system). This test fails when that happens again.
//
// What it checks, using the real <link> tags of the templates (test/helpers/cssPages.js):
//  1. No selector (with the same media context) is declared by two sheets that load on the same page type,
//     unless it is in ALLOWED_SHARED below with the reason.
//  2. The two base sheets (assets/site.css, public/style.css) define the same design tokens with the same values.
//  3. A var(--token) used without a fallback is defined by a sheet that loads on every page that uses the sheet.
//
// To fix a failure, make ONE sheet the owner (see "CSS ownership" in ARCHITECTURE.md): delete the other
// declaration, or scope it (e.g. `:where(.admin-main) .card`, which keeps the specificity). Do not add to the
// allowlist to silence a conflict: it is for deliberate, harmless overlaps only.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSheet } = require("../helpers/css");
const { pageTypes } = require("../helpers/cssPages");

// Deliberate overlaps. Keep this list short; every entry needs a reason.
const ALLOWED_SHARED = [
  // (none today)
];

// Tokens used without a fallback in a sheet whose page does not load any sheet that defines them. Each one is a
// bug that is visible today (the property is dropped); fixing it changes how the page looks, so it needs a decision.
const KNOWN_MISSING_TOKENS = [
  { sheet: "floral-calendar.css", token: "--cream-alt", why: ".fcal-day.is-empty gets no background in the app (style.css has no --cream-alt); defining it would tint empty calendar days" },
];

// Sheets of a page type, with the media context each one applies in.
const sheetsOf = (type) => type.sheets.map((s) => ({ file: s.file, media: s.media, sheet: loadSheet(s.file) }));
const contextOf = (rule, link) => {
  const parts = [rule.at, link.media ? `@media ${link.media}` : ""].filter(Boolean);
  return parts.join(" in ");
};

test("no selector is declared by two stylesheets that load on the same page", () => {
  const found = new Map(); // JSON [context, selector] -> { files:Set, pages:Set }
  for (const type of pageTypes()) {
    const owners = new Map();
    for (const link of sheetsOf(type)) {
      for (const rule of link.sheet.list) {
        for (const sel of rule.selectors) {
          const key = JSON.stringify([contextOf(rule, link) || "(always)", sel]);
          if (!owners.has(key)) owners.set(key, new Set());
          owners.get(key).add(link.file);
        }
      }
    }
    for (const [key, files] of owners) {
      if (files.size < 2) continue;
      const rec = found.get(key) || { files: new Set(), pages: new Set() };
      files.forEach((f) => rec.files.add(f));
      type.views.forEach((v) => rec.pages.add(v));
      found.set(key, rec);
    }
  }
  const unexpected = [...found].filter(([key, rec]) => {
    const [context, selector] = JSON.parse(key);
    return !ALLOWED_SHARED.some((a) => a.selector === selector && (a.at || "(always)") === context
      && [...rec.files].every((f) => a.sheets.includes(f)));
  });
  assert.deepEqual(
    unexpected.map(([key, rec]) => {
      const [context, selector] = JSON.parse(key);
      return `${selector}${context === "(always)" ? "" : ` in ${context}`}: declared in ${[...rec.files].join(" and ")} (e.g. on ${[...rec.pages][0]})`;
    }),
    [],
    "make one sheet the owner of each selector (ARCHITECTURE.md, CSS ownership)"
  );
});

test("the allowlist only names overlaps that still exist", () => {
  // a stale entry would hide a future conflict of the same selector
  for (const a of ALLOWED_SHARED) {
    assert.ok(a.why && a.sheets && a.selector, "every entry has selector, sheets and why");
    const defined = a.sheets.filter((f) => loadSheet(f).hasRule(a.selector, { at: a.at || "" }));
    assert.equal(defined.length, a.sheets.length, `${a.selector} is still declared in ${a.sheets.join(" and ")}`);
  }
});

test("both base sheets define the same design tokens with the same values", () => {
  const site = loadSheet("assets/site.css").tokens();
  const app = loadSheet("public/style.css").tokens();
  const SITE_ONLY = ["--cream-alt", "--shadow"]; // used by marketing sheets only
  const mismatched = Object.keys(site).filter((k) => k in app && site[k] !== app[k]).map((k) => `${k}: site.css ${site[k]} vs style.css ${app[k]}`);
  assert.deepEqual(mismatched, []);
  const missingInApp = Object.keys(site).filter((k) => !(k in app) && !SITE_ONLY.includes(k));
  assert.deepEqual(missingInApp, [], "a token added to site.css :root needs the same line in style.css (or an entry in SITE_ONLY)");
  const appOnly = Object.keys(app).filter((k) => !(k in site));
  assert.deepEqual(appOnly, [], "a token added to style.css :root needs the same line in site.css");
  // the tokens that were removed because they only repeated another one must not come back unnoticed
  for (const gone of ["--ink-soft", "--maroon-soft", "--green-soft"]) {
    assert.ok(!(gone in site) && !(gone in app), `${gone} was removed (it equalled another token); use the base token`);
  }
});

test("every design token a sheet uses without a fallback is defined on every page that loads the sheet", () => {
  const defined = new Set();
  for (const f of ["assets/site.css", "public/style.css"]) Object.keys(loadSheet(f).tokens()).forEach((t) => defined.add(t));
  const problems = new Set();
  for (const type of pageTypes()) {
    const available = new Set();
    for (const link of sheetsOf(type)) Object.keys(link.sheet.tokens()).forEach((t) => available.add(t));
    for (const link of sheetsOf(type)) {
      const text = link.sheet.root.toString();
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        const token = m[1];
        if (!defined.has(token) || available.has(token)) continue; // not a design token, or fine
        if (KNOWN_MISSING_TOKENS.some((k) => k.sheet === link.file && k.token === token)) continue;
        problems.add(`${link.file} uses var(${token}) on ${type.key}, where no loaded sheet defines it`);
      }
    }
  }
  assert.deepEqual([...problems], []);
});

test("the known missing tokens are still missing (remove the entry when fixed)", () => {
  for (const k of KNOWN_MISSING_TOKENS) {
    const used = new RegExp(`var\\(\\s*${k.token}\\s*\\)`).test(loadSheet(k.sheet).root.toString());
    assert.ok(used, `${k.sheet} still uses ${k.token}`);
  }
});
