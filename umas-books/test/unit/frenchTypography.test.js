const { test } = require("node:test");
const assert = require("node:assert/strict");
const { frenchTypography: fr, NBSP } = require("../../src/lib/frenchTypography");

test("a plain space before ; : ! ? and » (and after «) becomes a no-break space", () => {
  assert.equal(fr("<p>Total : 5 € ! Vraiment ? Oui ; non « ok »</p>"), `<p>Total${NBSP}: 5 €${NBSP}! Vraiment${NBSP}? Oui${NBSP}; non «${NBSP}ok${NBSP}»</p>`);
});

test("straight apostrophes (and their HTML entities) become curly, in text only", () => {
  assert.equal(fr("<p>l'œil d&#39;Uma &apos;x&apos;</p>"), "<p>l’œil d’Uma ’x’</p>");
});

test("attributes, scripts, styles, textareas, code and comments are never touched", () => {
  const html = `<a href="/x?q=l'a :" title="Total :">ok</a><script>var s = "l' :";</script><style>a::after{content:'x :'}</style><textarea>l' :</textarea><pre>l' :</pre><code>a ?</code><!-- l' : -->`;
  assert.equal(fr(html), html);
});

test("in headings a hyphenated imperative stays on one line; elsewhere (and in <title>/<option>) no markup is added", () => {
  assert.equal(fr("<h1>Demandez-nous</h1>"), '<h1><span class="nobr">Demandez-nous</span></h1>');
  assert.equal(fr("<p>Demandez-nous</p><h2>Dites-moi</h2><p>Connectez-vous</p>"), '<p>Demandez-nous</p><h2><span class="nobr">Dites-moi</span></h2><p>Connectez-vous</p>');
  assert.equal(fr("<title>Dites-moi : x</title>"), `<title>Dites-moi${NBSP}: x</title>`);
  assert.equal(fr("<option>Dites-moi</option>"), "<option>Dites-moi</option>");
  assert.equal(fr("<p>peut-être</p>"), "<p>peut-être</p>");
});

test("it is idempotent and leaves English-only markup alone", () => {
  const once = fr("<p>Merci : l'équipe !</p>");
  assert.equal(fr(once), once);
  assert.equal(fr("<p>Hello world</p>"), "<p>Hello world</p>");
});
