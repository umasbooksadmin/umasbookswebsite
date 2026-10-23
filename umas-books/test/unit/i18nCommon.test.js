// The COMMON dictionary (the EN/FR texts every page shares) lives in ONE file, assets/i18n-common.js, as plain data:
// the browser loads it with a <script> (window.UMAS_COMMON) before assets/site.js, the server require()s it. It used
// to be sliced out of the browser file with indexOf + vm, so reformatting site.js could break every /fr/ page, and the
// nav labels were written a second time in the header partial (NAV_FR).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const ejs = require("ejs");

const FILE = path.join(__dirname, "..", "..", "..", "assets", "i18n-common.js");
const SITE_JS = path.join(__dirname, "..", "..", "..", "assets", "site.js");
const PAGE_DICTIONARY = path.join(__dirname, "..", "..", "src", "lib", "pageDictionary.js");

test("the shared file parses in Node and in a browser-like context, giving the same data", () => {
  const fromNode = require(FILE);
  const win = {};
  vm.runInNewContext(fs.readFileSync(FILE, "utf8"), { self: win });
  assert.deepEqual(JSON.parse(JSON.stringify(win.UMAS_COMMON)), JSON.parse(JSON.stringify(fromNode)));
  assert.deepEqual(Object.keys(fromNode), ["en", "fr"]);
});

test("EN and FR have exactly the same keys, and every value is a non-empty string", () => {
  const { en, fr } = require(FILE);
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const dict of [en, fr]) for (const [k, v] of Object.entries(dict)) assert.ok(typeof v === "string" && v.trim(), k);
});

test("the header partial renders the same nav labels as before (the French ones used to be written in the partial)", async () => {
  const NAV_FR_BEFORE = { "nav.home": "Accueil", "nav.books": "Parcourir les livres", "nav.programs": "Programmes d’anglais", "nav.events": "Événements", "nav.visit": "Nous rendre visite" };
  const { en } = require(FILE);
  const { commonDictionary } = require("../../src/lib/pageDictionary");
  const nav = Object.keys(NAV_FR_BEFORE).map((i18n) => ({ key: i18n.slice(4), href: "/" + i18n.slice(4), i18n, label: en[i18n] }));
  const render = (lang) => ejs.renderFile(path.join(__dirname, "..", "..", "views", "partials", "mkt_chrome_header.ejs"), {
    nav, lang, assetUrl: (u) => u, commonDictionary,
    tr: (e, f) => (lang === "fr" ? f : e),
  });
  const labels = (html) => [...html.matchAll(/<a href="[^"]*"[^>]* data-i18n="(nav\.[a-z]+)">([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
  const expectEn = nav.map((n) => [n.i18n, n.label]).filter(([k]) => k !== "nav.back");
  assert.deepEqual(labels(await render("en")), expectEn);
  assert.deepEqual(labels(await render("fr")), Object.entries(NAV_FR_BEFORE));
});

test("pageDictionary.js no longer slices a browser file: no indexOf on source text, no vm, no site.js read", () => {
  const src = fs.readFileSync(PAGE_DICTIONARY, "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /indexOf\(\s*["']var COMMON/);
  assert.doesNotMatch(src, /require\(["'](?:node:)?vm["']\)|runInNewContext|runInThisContext/);
  assert.doesNotMatch(src, /site\.js/);
  assert.doesNotMatch(src, /readFileSync/);
});

test("the server dictionary loads with assets/site.js absent, unreadable or reformatted (regression: it used to be parsed out of it)", () => {
  // A fresh process where any read of site.js fails and a reformatted copy would not matter: the load must not touch it.
  const script = `
    const fs = require("fs"); const real = fs.readFileSync;
    fs.readFileSync = function (p, ...a) { if (String(p).endsWith("site.js")) throw new Error("site.js was read"); return real.call(this, p, ...a); };
    const { commonDictionary } = require(${JSON.stringify(PAGE_DICTIONARY)});
    process.stdout.write(JSON.stringify([commonDictionary("fr")["nav.back"], commonDictionary("en")["nav.home"], commonDictionary("zz")["nav.home"]]));
  `;
  const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), ["← Retour", "Home", "Home"]);
});

test("assets/site.js still works whatever its whitespace: it takes COMMON from window.UMAS_COMMON and holds no dictionary of its own", () => {
  const src = fs.readFileSync(SITE_JS, "utf8");
  assert.match(src, /window\.UMAS_COMMON/);
  assert.doesNotMatch(src, /"nav\.home"/);
  // Reformatted (prettier-style: tabs, extra blank lines, trailing spaces) it still evaluates and exposes its hooks.
  const reformatted = src.replace(/^ {2}/gm, "\t").replace(/;\n/g, ";  \n\n");
  const window = { document: { addEventListener() {}, cookie: "" }, UMAS_COMMON: require(FILE) };
  vm.runInNewContext(reformatted, { window, document: window.document, navigator: { language: "en-US" }, location: { protocol: "http:" } });
  assert.equal(typeof window.__umasResolveInitialLang, "function");
  assert.equal(require("../../src/lib/pageDictionary").commonDictionary("fr")["nav.menu"], "Menu");
});

test("every page that loads site.js loads the shared file first, through assetUrl (versioned, same static handler, no inline script)", () => {
  for (const f of ["views/marketing/partials/mkt_footer.ejs", "views/partials/footer.ejs"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", f), "utf8");
    const common = src.indexOf("assetUrl('/assets/i18n-common.js')"), site = src.indexOf("assetUrl('/assets/site.js')");
    assert.ok(common !== -1 && site !== -1 && common < site, f);
  }
});
