// lib/sanitizeHtml.js: allow-list behaviour of the rich-text sanitiser
// (admin announcements/dashboard text shown to every member).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeHtml } = require("../../src/lib/sanitizeHtml");

test("empty/missing input becomes an empty string", () => {
  assert.equal(sanitizeHtml(""), "");
  assert.equal(sanitizeHtml(null), "");
  assert.equal(sanitizeHtml(undefined), "");
});

test("allowed formatting tags survive untouched", () => {
  const html = "<p><b>bold</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u></p><ul><li>one</li></ul><ol><li>two</li></ol><blockquote>q</blockquote><div>d<br />x</div><span>s</span>";
  assert.equal(sanitizeHtml(html), html);
});

test("an http link is kept and forced to open safely in a new tab", () => {
  const out = sanitizeHtml('<a href="https://example.org/x?a=1&b=2" onclick="evil()" style="x:y">go</a>');
  assert.match(out, /^<a href="https:\/\/example\.org\/x\?a=1&amp;b=2" target="_blank" rel="noopener">go<\/a>$/);
});

test("mailto links are allowed", () => {
  assert.match(sanitizeHtml('<a href="mailto:hi@example.org">m</a>'), /href="mailto:hi@example\.org"/);
});

test("a link with no href keeps its text but gets a neutral '#'", () => {
  assert.equal(sanitizeHtml("<a>text</a>"), '<a href="#" target="_blank" rel="noopener">text</a>');
});

test("tags outside the allow-list are dropped but harmless text is kept", () => {
  assert.equal(sanitizeHtml("<h1>Title</h1><font color=red>x</font>"), "Titlex");
});

test("script and style bodies are removed entirely, not just their tags", () => {
  assert.equal(sanitizeHtml("a<script>alert(1)</script>b<style>body{display:none}</style>c"), "abc");
});

const XSS_PAYLOADS = [
  "<script>alert(1)</script>",
  "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
  "<img src=x onerror=alert(1)>",
  '<img src="x" onerror="alert(1)">',
  "<svg onload=alert(1)>",
  "<svg><script>alert(1)</script></svg>",
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="  javascript:alert(1)">x</a>',
  '<a href="java\nscript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  "<body onload=alert(1)>",
  '<div onmouseover="alert(1)">x</div>',
  '<p style="background:url(javascript:alert(1))">x</p>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><input type=submit></form>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel=stylesheet href="javascript:alert(1)">',
  '<a href="x" onfocus=alert(1) autofocus>x</a>',
  '"><script>alert(1)</script>',
  "<img src=`x`onerror=alert(1)>",
];

for (const payload of XSS_PAYLOADS) {
  test(`XSS payload is neutralised: ${payload.slice(0, 50).replace(/\n/g, "\\n")}`, () => {
    const out = sanitizeHtml(payload);
    assert.doesNotMatch(out, /<script|<img|<svg|<iframe|<object|<embed|<form|<input|<meta|<link|<body|<math/i);
    assert.doesNotMatch(out, /\son\w+\s*=/i, "no event-handler attributes");
    assert.doesNotMatch(out, /javascript:|vbscript:|data:text/i, "no dangerous URL scheme");
    assert.doesNotMatch(out, /style\s*=/i);
  });
}
