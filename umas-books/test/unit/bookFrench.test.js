// "Update the French from the English" (public/book-french.js) on the book edit page and the Add Book form. The script
// runs in a bare vm context with a small fake DOM and fetch, so the fill logic, the confirmation, the status line, the busy
// state and the "English changed" hint are driven without a browser. (The look is checked by screenshots, see the PR.)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const CONFIRM = "Replace the French genres and description with a fresh translation of the English? Your current French text in those boxes will be overwritten (nothing is saved until you press Save changes).";

function el(id, extra = {}) {
  const attrs = { ...(extra.attrs || {}) };
  const classes = new Set();
  return {
    id, value: extra.value || "", textContent: "", hidden: Boolean(extra.hidden), attrs,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = String(v); },
    removeAttribute: (n) => { delete attrs[n]; },
    classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, has: (c) => classes.has(c) },
  };
}

// opts: values (English/French boxes), confirmAnswer, fetchImpl
function setup({ genre = "Fantasy", desc = "A dragon.", genreFr = "", descFr = "", confirmAnswer = true, fetchImpl } = {}) {
  const csrf = el("", { value: "tok" });
  const genreEl = el("genre", { value: genre });
  const genreFrEl = el("genreFr", { value: genreFr });
  const descEl = el("description", { value: desc });
  const descFrEl = el("descriptionFr", { value: descFr });
  const status = el("fr-sync-status");
  const tools = el("", { hidden: true });
  const btn = el("", { attrs: { "data-fr-sync": "", "data-fr-url": "/admin/inventory/translate-french", "data-fr-genre": "genre", "data-fr-genre-fr": "genreFr", "data-fr-desc": "description", "data-fr-desc-fr": "descriptionFr", "data-fr-status": "fr-sync-status", "data-fr-save-label": "Save changes" } });
  btn.textContent = "Update the French from the English";
  const form = { querySelector: (sel) => (sel === "[name=_csrf]" ? csrf : null) };
  btn.closest = (sel) => (sel === "form" ? form : sel === "[data-fr-sync]" ? btn : null);
  const hintG = el("", { hidden: true, attrs: { "data-fr-stale": "genreFr", "data-fr-english": "genre" } });
  const hintD = el("", { hidden: true, attrs: { "data-fr-stale": "descriptionFr", "data-fr-english": "description" } });
  const byId = { genre: genreEl, genreFr: genreFrEl, description: descEl, descriptionFr: descFrEl, "fr-sync-status": status };
  const listeners = [];
  const asked = [];
  const fetches = [];
  const document = {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => (sel === "[data-fr-sync-tools]" ? [tools] : sel === "[data-fr-stale]" ? [hintG, hintD] : []),
    querySelector: () => null,
  };
  const window = { addEventListener() {}, confirm: (m) => { asked.push(m); return confirmAnswer; } };
  const fetchFn = (url, init) => { fetches.push({ url, init, params: new URLSearchParams(init.body) }); return fetchImpl(url, init); };
  vm.runInNewContext(read("public/book-french.js"), { document, window, fetch: fetchFn, URLSearchParams, setTimeout, clearTimeout });
  const emit = (type, ev) => listeners.filter((l) => l.type === type).forEach((l) => l.fn(ev));
  const click = () => { const ev = { target: { closest: (s) => (s === "[data-fr-sync]" ? btn : null) }, prevented: false, preventDefault() { this.prevented = true; } }; emit("click", ev); return ev; };
  const typeIn = (box) => emit("input", { target: box });
  const settle = () => new Promise((r) => setImmediate(r));
  return { genreEl, genreFrEl, descEl, descFrEl, status, tools, btn, hintG, hintD, asked, fetches, click, typeIn, settle };
}

const answer = (body, ok = true) => async () => ({ ok, json: async () => body });

test("the button's wrapper is shown by the script (it is hidden in the page, so no button appears without JavaScript)", () => {
  const t = setup({ fetchImpl: answer({}) });
  assert.equal(t.tools.hidden, false);
  for (const view of ["views/admin/inventory/show.ejs", "views/admin/inventory/new.ejs"]) {
    const src = read(view);
    assert.match(src, /<div data-fr-sync-tools hidden>\s*<div class="fr-tools">/, "the hidden wrapper has no class: a class with display: flex would override [hidden] and show the button without JavaScript");
    assert.match(src, /btn btn-outline btn-small" data-fr-sync /);
    assert.match(src, />Update the French from the English<\/button>/);
    assert.match(src, /role="status" aria-live="polite"/);
    assert.match(src, /book-french\.js/);
    assert.match(src, /data-fr-stale="genreFr" data-fr-english="genre" hidden>English changed: use "Update the French from the English"\.</);
    assert.match(src, /data-fr-stale="descriptionFr" data-fr-english="description" hidden>/);
  }
  assert.match(read("views/admin/inventory/show.ejs"), /data-fr-save-label="Save changes"/);
  assert.match(read("views/admin/inventory/new.ejs"), /data-fr-save-label="Save book"/);
});

test("empty French boxes: no question, the CURRENT English values are sent, both boxes are filled, nothing is submitted", async () => {
  const t = setup({ genre: "Fantasy, Young Adult", desc: "Edited, unsaved text.", fetchImpl: answer({ genreFr: "Fantasy, Jeune adulte", descriptionFr: "Texte modifié.", aiMessage: null }) });
  const ev = t.click();
  assert.equal(ev.prevented, true);
  assert.deepEqual(t.asked, []);
  assert.equal(t.fetches.length, 1);
  assert.equal(t.fetches[0].url, "/admin/inventory/translate-french");
  assert.equal(t.fetches[0].init.method, "POST");
  assert.equal(t.fetches[0].params.get("_csrf"), "tok");
  assert.equal(t.fetches[0].params.get("genre"), "Fantasy, Young Adult");
  assert.equal(t.fetches[0].params.get("description"), "Edited, unsaved text.");
  assert.equal(t.btn.getAttribute("aria-disabled"), "true", "busy: aria-disabled, never disabled (focus stays)");
  assert.equal(t.btn.attrs.disabled, undefined);
  assert.equal(t.btn.textContent, "Updating…");
  await t.settle();
  assert.equal(t.genreFrEl.value, "Fantasy, Jeune adulte");
  assert.equal(t.descFrEl.value, "Texte modifié.");
  assert.equal(t.status.textContent, "French updated from the English. Check it, then press Save changes.");
  assert.equal(t.status.classList.has("fr-error"), false);
  assert.equal(t.btn.getAttribute("aria-disabled"), null);
  assert.equal(t.btn.textContent, "Update the French from the English");
});

test("a French box with text asks first, with the exact sentence; Cancel changes nothing and sends nothing", async () => {
  const t = setup({ genreFr: "Mon genre", confirmAnswer: false, fetchImpl: answer({ genreFr: "X", descriptionFr: "Y" }) });
  t.click();
  assert.deepEqual(t.asked, [CONFIRM]);
  await t.settle();
  assert.equal(t.fetches.length, 0);
  assert.equal(t.genreFrEl.value, "Mon genre");
  assert.equal(t.btn.getAttribute("aria-disabled"), null);
  assert.equal(t.status.textContent, "");
});

test("a French description alone also asks; OK goes ahead and overwrites", async () => {
  const t = setup({ descFr: "Ma description", confirmAnswer: true, fetchImpl: answer({ genreFr: "Fantasy", descriptionFr: "Nouvelle", aiMessage: null }) });
  t.click();
  assert.deepEqual(t.asked, [CONFIRM]);
  await t.settle();
  assert.equal(t.descFrEl.value, "Nouvelle");
  assert.equal(t.genreFrEl.value, "Fantasy");
});

test("the Add Book form's save button name is used in the question and the status", async () => {
  const t = setup({ genreFr: "x", fetchImpl: answer({ genreFr: "Y", descriptionFr: "Z", aiMessage: null }) });
  t.btn.attrs["data-fr-save-label"] = "Save book";
  t.click();
  assert.match(t.asked[0], /until you press Save book\)\.$/);
  await t.settle();
  assert.equal(t.status.textContent, "French updated from the English. Check it, then press Save book.");
});

test("AI failure: the genres are still updated, the description box is left alone, the sentence is shown as an error", async () => {
  const msg = "The translation could not be made right now (the AI service has no credit left). The French genres were still updated.";
  const t = setup({ descFr: "Ancien texte", fetchImpl: answer({ genreFr: "Humour", descriptionFr: null, aiMessage: msg }) });
  t.click();
  await t.settle();
  assert.equal(t.genreFrEl.value, "Humour");
  assert.equal(t.descFrEl.value, "Ancien texte");
  assert.equal(t.status.textContent, msg);
  assert.equal(t.status.classList.has("fr-error"), true);
  assert.equal(t.btn.getAttribute("aria-disabled"), null);
});

test("no English genres or description: that French box is left as it was", async () => {
  const t = setup({ genre: "", desc: "", genreFr: "Garde", descFr: "Garde aussi", fetchImpl: answer({ genreFr: "", descriptionFr: null, aiMessage: null }) });
  t.click();
  await t.settle();
  assert.equal(t.genreFrEl.value, "Garde");
  assert.equal(t.descFrEl.value, "Garde aussi");
});

test("a refused request (rate limit) and a lost connection show a plain sentence and change nothing", async () => {
  let t = setup({ genreFr: "", fetchImpl: answer({ error: "Too many AI requests: wait a minute and try again." }, false) });
  t.click();
  await t.settle();
  assert.equal(t.status.textContent, "Too many AI requests: wait a minute and try again.");
  assert.equal(t.status.classList.has("fr-error"), true);
  assert.equal(t.genreFrEl.value, "");
  t = setup({ fetchImpl: async () => { throw new Error("offline"); } });
  t.click();
  await t.settle();
  assert.match(t.status.textContent, /^Could not reach the server\./);
  assert.equal(t.btn.getAttribute("aria-disabled"), null, "usable again");
});

test("a second press while working is ignored (one AI call)", async () => {
  const t = setup({ fetchImpl: answer({ genreFr: "A", descriptionFr: "B", aiMessage: null }) });
  t.click();
  t.click();
  assert.equal(t.fetches.length, 1);
  await t.settle();
  t.click();
  assert.equal(t.fetches.length, 2, "and works again afterwards");
});

test("'English changed' hint: shown after editing the English above a French box that has text; hidden when the French is empty; cleared by an update", async () => {
  const t = setup({ genreFr: "Fantasy", descFr: "", fetchImpl: answer({ genreFr: "Fantasy", descriptionFr: "Neuf", aiMessage: null }) });
  assert.equal(t.hintG.hidden, true, "not shown on load");
  t.typeIn(t.genreEl);
  assert.equal(t.hintG.hidden, false);
  assert.equal(t.hintD.hidden, true, "the description is not touched");
  t.typeIn(t.descEl);
  assert.equal(t.hintD.hidden, true, "its French box is empty: nothing to go stale");
  t.descFrEl.value = "du texte";
  t.typeIn(t.descFrEl);
  assert.equal(t.hintD.hidden, false, "typing French under an edited English shows it");
  t.genreFrEl.value = "";
  t.typeIn(t.genreFrEl);
  assert.equal(t.hintG.hidden, true, "emptying the French hides it");
  t.genreFrEl.value = "Fantasy";
  t.typeIn(t.genreFrEl);
  assert.equal(t.hintG.hidden, false);
  t.click();
  assert.deepEqual(t.asked.length, 1);
  await t.settle();
  assert.equal(t.hintG.hidden, true, "an update clears it");
  assert.equal(t.hintD.hidden, true);
});

test("script has no inline handlers and nothing in it submits a form", () => {
  const src = read("public/book-french.js");
  assert.doesNotMatch(src, /\.submit\(|requestSubmit|innerHTML/);
});
