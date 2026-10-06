const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { applyPageDictionary, commonDictionary } = require("../../src/lib/pageDictionary");

test("data-i18n sets escaped text, data-i18n-html sets markup, data-i18n-attr sets attributes", () => {
  const html = [
    '<h1 class="x" data-i18n="a">Hello</h1>',
    '<p data-i18n-html="b">Hi <em>there</em></p>',
    '<meta name="description" content="old" data-i18n-attr="content:c">',
    '<a href="#" title="t" data-i18n-attr="title:d;aria-label:e" data-i18n="a">x</a>',
    '<div data-i18n-html="b"><div>nested</div> tail</div><span>after</span>',
  ].join("\n");
  const out = applyPageDictionary(html, { a: "Bonjour & <b>", b: "Salut <strong>toi</strong>", c: "Une « description »", d: "Titre", e: "Étiquette" });
  assert.match(out, /<h1 class="x" data-i18n="a">Bonjour &amp; &lt;b&gt;<\/h1>/);
  assert.match(out, /<p data-i18n-html="b">Salut <strong>toi<\/strong><\/p>/);
  assert.match(out, /<meta name="description" content="Une « description »" data-i18n-attr="content:c">/);
  assert.match(out, /title="Titre"/);
  assert.match(out, /aria-label="Étiquette"/);
  assert.match(out, /<div data-i18n-html="b">Salut <strong>toi<\/strong><\/div><span>after<\/span>/);
});

test("a key missing from the dictionary leaves the English; scripts and styles are never touched", () => {
  const html = '<p data-i18n="zzz">Keep me</p><script>var s = \'<p data-i18n="a">x</p>\';</script>';
  assert.equal(applyPageDictionary(html, { a: "Changé" }), html);
});

test("attribute values containing > do not confuse the tag scanner", () => {
  const out = applyPageDictionary('<a title="a > b" data-i18n="a">Hi</a>', { a: "Salut" });
  assert.equal(out, '<a title="a > b" data-i18n="a">Salut</a>');
});

test("the COMMON dictionary comes from assets/site.js (one copy), EN and FR have the same keys", () => {
  const en = commonDictionary("en"), fr = commonDictionary("fr");
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  assert.equal(fr["nav.back"], "← Retour");
  assert.equal(en["a11y.skip"], "Skip to main content");
});

test("French typography in every marketing FR dictionary and in COMMON: no ordinary space before ; : ! ? € or inside « »", () => {
  const files = fs.readdirSync(path.join(__dirname, "../../views/marketing")).filter((f) => f.endsWith(".ejs"));
  const bad = [];
  const check = (where, key, value) => {
    const text = String(value).replace(/<[^>]*>/g, "");
    if (/ [;:!?€»]|« /.test(text)) bad.push(`${where} ${key}: ${text.match(/.{0,15}( [;:!?€»]|« ).{0,5}/)[0]}`);
  };
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, "../../views/marketing", f), "utf8");
    for (const name of ["pageI18nFr", "memNewFr"]) {
      const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\s*\\});`)) || src.match(new RegExp(`const ${name} = (\\{[^\\n]*\\});`));
      if (!m) continue;
      const d = new Function(`return ${m[1]}`)();
      for (const [k, v] of Object.entries(d)) check(f, k, v);
    }
  }
  for (const [k, v] of Object.entries(commonDictionary("fr"))) check("site.js", k, v);
  assert.deepEqual(bad, []);
});
