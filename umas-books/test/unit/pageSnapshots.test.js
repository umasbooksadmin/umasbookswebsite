"use strict";

// Output-identity guard for the association's identity and contact facts (email, SIREN, SIRET, RNA, registered
// office). They used to be typed in dozens of views and emails; they now come from src/lib/legal.js. This test
// renders the legal notice, terms of sale, privacy policy, membership terms, visit, contact, home, about, events,
// the 404 / 500 pages, the "too many attempts" and reservation-receipt views and the order emails, in English
// and French (scripts/snapshot-pages.js), and checks every occurrence of a fact, with 60 characters of context,
// against test/fixtures/identity-snippets.json - which was generated from the code BEFORE the facts moved. So a
// moved fact that changed a word, a space, a link or a language around it fails here.
//
// A legitimate edit of one of these sentences changes a snippet: regenerate with
//   UPDATE_SNAPSHOTS=1 node --test test/unit/pageSnapshots.test.js
// and read the diff of the fixture before committing it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startInProcessApp } = require("../helpers/testApp");
const { snapshot, identitySnippets } = require("../../scripts/snapshot-pages");

const ROOT = path.join(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "identity-snippets.json");

test("every identity fact renders with exactly the words around it that it had before it moved into legal.js", async (t) => {
  const app = await startInProcessApp();
  t.after(() => app.stop());
  const now = identitySnippets(await snapshot(ROOT, { base: app.base }));
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    fs.writeFileSync(FIXTURE, `${JSON.stringify(now, null, 1)}\n`);
    return;
  }
  const before = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(Object.keys(now), Object.keys(before), "the same pages carry the facts");
  for (const name of Object.keys(before)) assert.deepEqual(now[name], before[name], `${name}: a fact or its surrounding text changed`);
});

test("the fixture covers the pages the refactor touched, in both languages", () => {
  const before = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const lang of ["en", "fr"]) {
    for (const f of ["mentions-legales-html", "terms-of-sale-html", "privacy-policy-html", "membership-terms-html", "contact", "visit-html"]) {
      assert.ok(before[`page-${lang}-${f}.txt`], `no snippets for ${lang} ${f}`);
    }
    assert.ok(before[`email-${lang}-confirmation.txt`], `no snippets for the ${lang} order email`);
    assert.ok(before[`view-${lang}-500.txt`], `no snippets for the ${lang} 500 page`);
  }
  assert.match(JSON.stringify(before["page-fr-mentions-legales-html.txt"]), /109 441 147 00013/);
});
