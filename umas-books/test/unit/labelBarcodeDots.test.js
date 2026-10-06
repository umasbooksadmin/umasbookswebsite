// Barcodes on thermal labels are sized in whole printer dots per module.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const code128 = require("../../src/lib/code128");

test("203 dpi: 3 dots per module, 300 dpi: 4 dots; the width is a whole number of dots derived from the code", () => {
  const a = code128.fit("UB-1234", { dpi: 203, widthMm: 50 });
  assert.equal(a.moduleDots, 3);
  assert.equal(a.widthDots, (a.barModules + 2 * a.quietModules) * 3);
  assert.equal(a.widthMm, Math.round((a.widthDots * 25.4 * 1000) / 203) / 1000);
  assert.equal(a.warning, null);
  const b = code128.fit("UB-1234", { dpi: 300, widthMm: 50 });
  assert.equal(b.moduleDots, 4);
  assert.equal(b.widthDots % 4, 0);
  // a longer code is wider, the label width does not stretch the bars
  assert.ok(code128.fit("UB-123456", { widthMm: 80 }).widthDots > code128.fit("UB-1", { widthMm: 80 }).widthDots);
  assert.equal(code128.fit("UB-1", { widthMm: 80 }).moduleDots, 3);
});

test("unknown dpi falls back to 203", () => {
  assert.equal(code128.parseDpi("600"), 203);
  assert.equal(code128.parseDpi("300"), 300);
  assert.equal(code128.parseDpi(undefined), 203);
});

test("a label too narrow for the standard module warns, keeps whole dots and shrinks the text", () => {
  const f = code128.fit("UB-123456", { dpi: 203, widthMm: 40 });
  assert.match(f.warning, /too narrow/);
  assert.ok(f.moduleDots >= code128.MIN_DOTS && f.moduleDots < 3);
  assert.ok(Number.isInteger(f.moduleDots));
  assert.ok(f.fontScale < 1);
  const tiny = code128.fit("UB-123456", { widthMm: 20 });
  assert.match(tiny.warning, /too narrow/);
  assert.equal(tiny.quietModules, 0);
});

test("svgForLabel: bars on whole modules, width in mm from whole dots, crisp edges", () => {
  const { svg, fit } = code128.svgForLabel("UB-77", { dpi: 203, widthMm: 50 });
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, new RegExp(`style="width:${fit.widthMm}mm"`));
  assert.match(svg, /data-module-dots="3"/);
  const widths = [...svg.matchAll(/h(\d+)v1/g)].map((m) => Number(m[1]));
  assert.ok(widths.length > 10 && widths.every((w) => Number.isInteger(w) && w >= 1 && w <= 4));
});
