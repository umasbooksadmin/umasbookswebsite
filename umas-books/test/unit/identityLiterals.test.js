"use strict";

// The association's identity and contact facts live in src/lib/legal.js (CONTACT_EMAIL, SIREN, SIRET, RNA,
// REGISTERED_OFFICE...) and nowhere else. Server code requires them; views read legalText.contactEmail ...
// or, inside a page dictionary, the {contactEmail} {siret} {siren} {rna} {registeredOffice[Formal]} tokens that
// fillVat() fills. This test fails when one is typed again where it is rendered, so there is again exactly one
// place to change it.
//
// NOT covered, on purpose (they cannot import): the static assets (assets/site.js and posts.js carry the address
// in their client-side dictionaries), the workflow YAML and render.yaml, the docs, the migrations' seed text,
// and scripts/ (developer tools).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const legal = require("../../src/lib/legal");
const { fillVat, legalFor } = require("../../src/lib/legalText");

const ROOT = path.join(__dirname, "..", "..");
const FACTS = [
  ["the contact email", /admin@umasbooks\.org/],
  ["the SIREN / SIRET", /109 441 147/],
  ["the RNA number", /W811011706/],
  ["the registered office street", /Hippolyte Savary/],
];
// file (relative to umas-books/) -> reason. Everything else under src/ and views/ must be free of the literals.
const ALLOWED = {
  "src/lib/legal.js": "the one place the facts are written",
};

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

test("no file under src/ or views/ types an identity fact: it is read from lib/legal.js", () => {
  const files = [...walk(path.join(ROOT, "src"), [".js"]), ...walk(path.join(ROOT, "views"), [".ejs"])];
  assert.ok(files.length > 150, "the scan found too few files");
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (ALLOWED[rel]) continue;
    const text = fs.readFileSync(f, "utf8");
    for (const [label, re] of FACTS) if (re.test(text)) hits.push(`${rel}: ${label}`);
  }
  assert.deepEqual(hits, [], `use legal.CONTACT_EMAIL / SIRET ... (server code), legalText.contactEmail ... (views) or the {contactEmail} ... tokens (page dictionaries):\n  ${hits.join("\n  ")}`);
  for (const rel of Object.keys(ALLOWED)) assert.ok(FACTS.some(([, re]) => re.test(fs.readFileSync(path.join(ROOT, rel), "utf8"))), `${rel} is allowed but holds no fact: remove it from ALLOWED`);
});

test("the facts have their documented values, in legal.js, legalText and the fillVat tokens", () => {
  assert.equal(legal.CONTACT_EMAIL, "admin@umasbooks.org");
  assert.equal(legal.SIREN, "109 441 147");
  assert.equal(legal.SIRET, "109 441 147 00013");
  assert.equal(legal.RNA, "W811011706");
  assert.equal(legal.REGISTERED_OFFICE, "5 rue Hippolyte Savary, 81000 Albi");
  assert.equal(legal.REGISTERED_OFFICE_FORMAL, "5, rue Hippolyte Savary, 81000 Albi, France");
  assert.ok(legal.SIRET.startsWith(legal.SIREN), "a SIRET is the SIREN plus a 5-digit establishment number");
  for (const lang of ["en", "fr"]) {
    const lt = legalFor(lang);
    assert.deepEqual([lt.contactEmail, lt.siren, lt.siret, lt.rna, lt.registeredOffice, lt.registeredOfficeFormal],
      [legal.CONTACT_EMAIL, legal.SIREN, legal.SIRET, legal.RNA, legal.REGISTERED_OFFICE, legal.REGISTERED_OFFICE_FORMAL]);
    const filled = fillVat({ k: "{contactEmail}|{siren}|{siret}|{rna}|{registeredOffice}|{registeredOfficeFormal}" }, lang).k;
    assert.equal(filled, [legal.CONTACT_EMAIL, legal.SIREN, legal.SIRET, legal.RNA, legal.REGISTERED_OFFICE, legal.REGISTERED_OFFICE_FORMAL].join("|"));
  }
});

test("the default of CONTACT_TO and SEED_ADMIN_EMAIL is the shop mailbox", () => {
  const config = require("../../src/lib/config");
  assert.equal(config.get("CONTACT_TO", {}), legal.CONTACT_EMAIL);
  assert.equal(config.get("SEED_ADMIN_EMAIL", {}), legal.CONTACT_EMAIL);
});
