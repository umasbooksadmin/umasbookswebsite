const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "../../views/marketing/privacy-policy.ejs"),
  "utf8"
);

function dict(name) {
  const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`));
  assert.ok(m, `${name} not found`);
  return new Function(`return ${m[1]}`)();
}

const en = dict("pageI18nEn");
const fr = dict("pageI18nFr");

test("privacy policy: EN and FR have exactly the same keys", () => {
  assert.deepStrictEqual(Object.keys(fr).sort(), Object.keys(en).sort());
});

test("privacy policy: every data-i18n key used in the markup exists in both languages", () => {
  const used = [...src.matchAll(/data-i18n(?:-html)?="(pp\.[^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 20);
  for (const k of used) {
    assert.ok(k in en, `missing EN ${k}`);
    assert.ok(k in fr, `missing FR ${k}`);
  }
});

test("privacy policy: names the controller exactly as in the legal notice", () => {
  for (const d of [en, fr]) {
    assert.match(d["pp.s1.p"], /Uma’s Books/);
    assert.match(d["pp.s1.p"], /W811011706/);
    assert.match(d["pp.s1.p"], /109 441 147 00013/);
    assert.match(d["pp.s1.p"], /5, rue Hippolyte Savary, 81000 Albi/);
  }
});

test("privacy policy: states concrete retention periods, rights delay and CNIL", () => {
  assert.match(en["pp.s5.list"], /10 years/);
  assert.match(fr["pp.s5.list"], /10 ans/);
  assert.match(en["pp.s6.p1"], /one month/);
  assert.match(fr["pp.s6.p1"], /un mois/);
  for (const d of [en, fr]) assert.match(d["pp.s6.p2"], /CNIL/);
});

test("privacy policy: lists every processor", () => {
  for (const d of [en, fr]) {
    for (const name of ["HelloAsso", "Google", "Render", "Backblaze", "Anthropic"]) {
      assert.match(d["pp.s4.list"], new RegExp(name));
    }
    // Backups no longer go to GitHub; the policy must not claim they do.
    assert.doesNotMatch(d["pp.s4.list"], /GitHub/);
  }
});

test("privacy policy: no vague retention wording remains", () => {
  assert.doesNotMatch(en["pp.s5.list"], /as long as necessary|reasonable time/i);
  assert.doesNotMatch(fr["pp.s6.p1"], /délai raisonnable/);
});

test("privacy policy: promises the inactivity warning and keeps messages until asked", () => {
  assert.match(en["pp.s5.list"], /30 days before deleting/);
  assert.match(fr["pp.s5.list"], /30 jours avant la suppression/);
  assert.match(en["pp.s5.list"], /Messages you send us:<\/strong> until you ask/);
  assert.match(fr["pp.s5.list"], /jusqu’à ce que vous demandiez leur suppression/);
});

// Regression: the EN/FR dictionary strings once lost the space after every
// comma, semicolon and full stop ("e-mail,nom,mot de passe"), so the page read
// wrongly after the language toggle. Numbers (1,5), URLs, addresses and
// "word.tld" names are allowed; text is checked after removing markup.
function missingSpaces(value) {
  const text = value
    .replace(/<[^>]+>/g, "\u0001") // a tag boundary: judge only real text
    .replace(/https?:\/\/\S+|\S+@\S+|\b[a-z0-9-]+\.(?:fr|org|com|html)\b/gi, "x");
  return text.match(/[,;][A-Za-zÀ-ÿ]|[A-Za-zÀ-ÿ)]\.[A-ZÀ-Ý]|\)[A-Za-zÀ-ÿ]/g) || [];
}

test("privacy policy: no dictionary string lost its space after punctuation", () => {
  for (const [lang, d] of [["en", en], ["fr", fr]]) {
    for (const [k, v] of Object.entries(d)) {
      assert.deepStrictEqual(missingSpaces(v), [], `${lang} ${k} has punctuation with no following space`);
    }
  }
});

test("privacy policy: the spacing check catches the old bug and ignores numbers and addresses", () => {
  assert.ok(missingSpaces("e-mail,nom,mot de passe").length > 0);
  assert.ok(missingSpaces("<li>x</li>one,two").length > 0);
  assert.deepStrictEqual(missingSpaces("1,5 km, see cnil.fr or a@b.org, https://x.test/a,b"), []);
});

test("privacy policy: the toggled dictionary text matches the static English markup", () => {
  const body = src.split("<% const pageI18nEn")[0];
  const squash = (h) => h.replace(/>\s+</g, "><").trim();
  const re = /<(\w+)[^>]*data-i18n-html="(pp\.[^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let n = 0;
  for (const m of body.matchAll(re)) {
    n++;
    assert.strictEqual(squash(en[m[2]]), squash(m[3]), `${m[2]}: EN dictionary differs from the static page`);
  }
  assert.ok(n >= 6);
});
