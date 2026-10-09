// Source-level guard for the French text (no app, no database): every
// tr(english, french) pair in the customer-facing code, and every marketing
// page dictionary, must have a real French side. The page-level guard (the
// crawler) is test/integration/i18nCrawler.test.js; this one catches a
// missing or English "French" at the place it is written.
//
// Rules: French present and different from the English (a few words are the
// same in both languages: SAME_WORD), no English function words left in it,
// "e-mail" with a hyphen (the legal pages' spelling), the same {placeholders}
// on both sides. To add a text: write tr('English', 'Français'); see
// docs/i18n-audit.md ("Definition of done").
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pairs, problems } = require("../helpers/i18nPairs");

// Words that are spelled the same in French. Exact English text of the pair.
const SAME_WORD = new Set(["Message", "Forum", "Code", "1 vote"]);

test("every tr(english, french) pair has a real French side", () => {
  const ps = pairs();
  assert.ok(ps.length > 500, `found ${ps.length} pairs: is the scanner still reading the views and routes?`);
  const bad = [];
  for (const p of ps) {
    if (SAME_WORD.has(p.en.trim())) continue;
    const pr = problems(p);
    if (pr.length) bad.push(`${p.file}:${p.line} ${pr.join(", ")}: "${p.en.slice(0, 60)}" / "${String(p.fr).slice(0, 60)}"`);
  }
  assert.deepEqual(bad, []);
});

test("both sides of a tr() pair use the same {placeholders}", () => {
  const holes = (s) => (String(s).match(/\{[a-zA-Z]\w*\}/g) || []).sort().join(",");
  const bad = [];
  for (const p of pairs()) {
    if (p.fr === null) continue;
    for (const alt of p.alts || [p.fr]) if (holes(p.en) !== holes(alt) && !(p.alts && holes(alt) === "")) bad.push(`${p.file}:${p.line} ${holes(p.en)} vs ${holes(p.fr)}`);
  }
  assert.deepEqual(bad, []);
});

// ---- marketing page dictionaries (views/marketing/*.ejs) and assets/site.js COMMON

function dictionaries() {
  const dir = path.join(__dirname, "../../views/marketing");
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ejs"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const grab = (name) => {
      const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\s*\\});`)) || src.match(new RegExp(`const ${name} = (\\{[^\\n]*\\});`));
      return m ? vm.runInNewContext(`(${m[1]})`, { legalText: new Proxy({}, { get: () => "" }) }) : null;
    };
    for (const [en, fr] of [["pageI18nEn", "pageI18nFr"], ["memNewEn", "memNewFr"]]) {
      const e = grab(en), r = grab(fr);
      if (e || r) out.push({ file: f, name: en, en: e || {}, fr: r || {} });
    }
  }
  return out;
}

test("marketing dictionaries: every English key has a French one and the other way round", () => {
  const bad = [];
  for (const d of dictionaries()) {
    for (const k of Object.keys(d.en)) if (!(k in d.fr)) bad.push(`${d.file} ${d.name}: ${k} has no French`);
    for (const k of Object.keys(d.fr)) if (!(k in d.en)) bad.push(`${d.file} ${d.name}: ${k} has no English`);
  }
  assert.deepEqual(bad, []);
});

test("marketing dictionaries: the French values are French (not copied English, no 'email')", () => {
  const bad = [];
  for (const d of dictionaries()) {
    for (const [k, v] of Object.entries(d.fr)) {
      const fr = String(v).replace(/<[^>]*>/g, " ").trim();
      const en = String(d.en[k] || "").replace(/<[^>]*>/g, " ").trim();
      const p = { en, fr, file: d.file, line: 0 };
      const letters = (fr.match(/\p{L}/gu) || []).length;
      // short labels (names, numbers, one word) may legitimately be the same in both languages
      const issues = problems(p).filter((x) => x !== "French equals English" || (letters >= 25 && en.split(/\s+/).length >= 4));
      if (issues.length) bad.push(`${d.file} ${k}: ${issues.join(", ")}: "${fr.slice(0, 60)}"`);
    }
  }
  assert.deepEqual(bad, []);
});
