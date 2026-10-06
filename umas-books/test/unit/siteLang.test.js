// assets/site.js decides the starting language on every page. It used to take
// localStorage, else the BROWSER's language, ignoring the language the server
// had already rendered: a French visitor with an English browser was flipped to
// English and the cookie rewritten.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "..", "assets", "site.js"), "utf8");
const window = { document: { addEventListener() {}, cookie: "" } };
vm.runInNewContext(src, { window, document: window.document, navigator: { language: "en-US" }, location: { protocol: "http:" } });
const resolve = window.__umasResolveInitialLang;

test("the resolver is exposed by site.js", () => assert.equal(typeof resolve, "function"));

test("the server-rendered language beats the browser language", () => {
  assert.equal(resolve(null, null, "fr", "en-US"), "fr");
  assert.equal(resolve(null, null, "en", "fr-FR"), "en");
});

test("the cookie beats <html lang>; a stored choice beats both", () => {
  assert.equal(resolve(null, "fr", "en", "en-US"), "fr");
  assert.equal(resolve("en", "fr", "fr", "fr-FR"), "en");
});

test("junk values are skipped; the browser language is the last resort", () => {
  assert.equal(resolve("de", "xx", "", "fr-CA"), "fr");
  assert.equal(resolve(null, null, "", "en-GB"), "en");
  assert.equal(resolve(null, null, undefined, undefined), "en");
  assert.equal(resolve(null, null, "fr-FR", "en"), "fr");
});
