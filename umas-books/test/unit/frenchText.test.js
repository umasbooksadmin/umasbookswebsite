// lib/frenchText.js: when a French version is READY, which text a page gets, and how a form's French fields are read.
const test = require("node:test");
const assert = require("node:assert/strict");
const { frenchState, localize, readFrench, hasText } = require("../../src/lib/frenchText");

test("events: missing / draft / ready; the description is needed only when the English has one; the place is optional", () => {
  assert.equal(frenchState("event", { title: "T", description: "D" }), "missing");
  assert.equal(frenchState("event", { title: "T", description: "D", title_fr: "  ", description_fr: "" }), "missing", "blank is nothing");
  assert.equal(frenchState("event", { title: "T", description: "D", title_fr: "A" }), "draft");
  assert.equal(frenchState("event", { title: "T", description: "D", description_fr: "B" }), "draft");
  assert.equal(frenchState("event", { title: "T", description: "D", location: "L", title_fr: "A", description_fr: "B" }), "ready", "no French place needed");
  assert.equal(frenchState("event", { title: "T", description: null, title_fr: "A" }), "ready");
  assert.equal(frenchState("event", { title: "T", description: "D", location_fr: "Ici" }), "draft");
});

test("sessions need a French title; announcements a title and content (and a summary when the English has one); an editor of empty paragraphs is nothing", () => {
  assert.equal(frenchState("session", { title: "T", title_fr: "A" }), "ready");
  assert.equal(frenchState("session", { title: "T" }), "missing");
  const base = { title: "T", body: "<p>x</p>" };
  assert.equal(frenchState("announcement", { ...base, title_fr: "A", body_fr: "<p>B</p>" }), "ready");
  assert.equal(frenchState("announcement", { ...base, title_fr: "A", body_fr: "<p><br></p><div>&nbsp;</div>" }), "draft");
  assert.equal(frenchState("announcement", { ...base, body_fr: "<p><br></p>" }), "missing");
  assert.equal(frenchState("announcement", { ...base, excerpt: "S", title_fr: "A", body_fr: "<p>B</p>" }), "draft");
  assert.equal(frenchState("announcement", { ...base, excerpt: "S", title_fr: "A", body_fr: "<p>B</p>", excerpt_fr: "R" }), "ready");
  assert.equal(frenchState("charity", { description: "D", description_fr: "F" }), "ready");
  assert.equal(frenchState("charity", { description: "D" }), "missing");
  assert.equal(frenchState("round", { title: "T", title_fr: "F" }), "ready");
  assert.ok(hasText("<p>a</p>") && !hasText("<p> <br></p>&nbsp;") && !hasText(null));
});

test("localize: French text only for lang fr and a ready row; otherwise the English text, flagged as a fallback on French pages", () => {
  const row = { id: 1, title: "Title", description: "Desc", location: "Place", title_fr: "Titre", description_fr: "Description", location_fr: null };
  const fr = localize("event", row, "fr");
  assert.deepEqual([fr.title, fr.description, fr.location, fr.frLang, fr.fallback], ["Titre", "Description", "Place", "fr", false]);
  assert.equal(fr.title_en, "Title");
  assert.equal(row.title, "Title", "the row is not changed");
  const en = localize("event", row, "en");
  assert.deepEqual([en.title, en.description, en.frLang, en.fallback], ["Title", "Desc", "en", false]);
  const draft = localize("event", { ...row, description_fr: null }, "fr");
  assert.deepEqual([draft.title, draft.description, draft.frLang, draft.fallback], ["Title", "Desc", "en", true]);
  const nothingToShow = localize("charity", { description: null, description_fr: null }, "fr");
  assert.equal(nothingToShow.fallback, false, "no English text, so nothing to label");
});

test("localize sanitises a French HTML text (and leaves the English one as stored)", () => {
  const row = { title: "T", body: "<p>E</p><script>x()</script>", title_fr: "A", body_fr: '<p onclick="x()">F</p><script>y()</script><b>ok</b>' };
  const fr = localize("announcement", row, "fr");
  assert.equal(fr.body, "<p>F</p><b>ok</b>");
  assert.equal(localize("announcement", row, "en").body, row.body);
});

test("readFrench: trims, blank -> null, sanitises HTML, takes the first of repeated fields", () => {
  assert.deepEqual(readFrench("event", { title_fr: "  Titre ", description_fr: "", location_fr: undefined }), { title_fr: "Titre", description_fr: null, location_fr: null });
  assert.deepEqual(readFrench("announcement", { title_fr: ["A", "B"], excerpt_fr: " ", body_fr: '<p onclick="x()">F</p><script>y()</script>' }), { title_fr: "A", excerpt_fr: null, body_fr: "<p>F</p>" });
  assert.deepEqual(readFrench("announcement", { body_fr: "<p><br></p>" }), { title_fr: null, excerpt_fr: null, body_fr: null });
});
