const { test } = require("node:test");
const assert = require("node:assert/strict");
const code128 = require("../../src/lib/code128");

test("every pattern is 11 modules wide (STOP 13) and all 107 are different", () => {
  assert.equal(code128.PATTERNS.length, 107);
  code128.PATTERNS.forEach((p, i) => {
    assert.equal([...p].reduce((a, x) => a + Number(x), 0), i === 106 ? 13 : 11, `pattern ${i}`);
  });
  assert.equal(new Set(code128.PATTERNS).size, 107);
});

test("known vectors: start B, values, check symbol, stop", () => {
  // "UB-1": U=53 B=34 -=13 1=17; check = (104 + 53*1 + 34*2 + 13*3 + 17*4) mod 103 = 332 mod 103 = 23
  assert.deepEqual(code128.values("UB-1"), [104, 53, 34, 13, 17, 23, 106]);
  // "A": 104 + 33 = 137 mod 103 = 34
  assert.deepEqual(code128.values("A"), [104, 33, 34, 106]);
  // "Hi": H=40 i=73 -> 104 + 40 + 146 = 290 mod 103 = 84
  assert.deepEqual(code128.values("Hi"), [104, 40, 73, 84, 106]);
});

test("modules: width, quiet bars, and the first symbol is START B (211214)", () => {
  const bits = code128.modules("UB-1234");
  assert.equal(bits.length, (1 + 7 + 1) * 11 + 13);
  assert.ok(bits.startsWith("11010010000"), "START B is the well-known 11010010000");
  assert.ok(bits.endsWith("1100011101011"), "STOP 2331112 then the final bar");
});

test("the barcode decodes back to its text (independent decoder)", () => {
  for (const text of ["UB-1", "UB-1234", "UB-987654321", "Hello 128"]) {
    const bits = code128.modules(text);
    const runs = bits.match(/1+|0+/g).map((r) => r.length);
    // split into 6-element symbols, last symbol has 7
    const syms = [];
    let i = 0;
    while (i < runs.length - 7) { syms.push(runs.slice(i, i + 6).join("")); i += 6; }
    syms.push(runs.slice(i).join(""));
    const vals = syms.map((s) => code128.PATTERNS.indexOf(s));
    assert.ok(vals.every((v) => v >= 0));
    assert.equal(vals[0], 104);
    assert.equal(vals[vals.length - 1], 106);
    const body = vals.slice(1, -2);
    const check = vals[vals.length - 2];
    assert.equal(body.map((v) => String.fromCharCode(v + 32)).join(""), text);
    assert.equal(check, (104 + body.reduce((a, v, k) => a + v * (k + 1), 0)) % 103);
  }
});

test("characters Code 128 B cannot encode are refused; svg is escaped inline markup", () => {
  assert.throws(() => code128.values("é"));
  assert.throws(() => code128.values(""));
  const svg = code128.svg("UB-5", { title: 'a"<b' });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 99 40"/);
  assert.match(svg, /aria-label="Barcode a&quot;&lt;b"/);
  assert.match(svg, /<path d="M10 0h2v40h-2z/, "first bar after the 10 module quiet zone");
});
