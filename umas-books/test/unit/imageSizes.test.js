// Every image the site serves (assets/, public/, the root logo.png) must stay
// small: the review found 240-550 KB PNGs shown at ~110 px. Re-run
// `node scripts/optimize-images.js` (originals live in assets-src/, which is
// not served) instead of raising the limit.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MAX = 150 * 1024;
const repo = path.join(__dirname, "..", "..", "..");
const ROOTS = [path.join(repo, "assets"), path.join(repo, "umas-books", "public"), path.join(repo, "logo.png")];
// Justified exceptions (path relative to the repo root): none today.
const ALLOW = new Set([]);

function* walk(p) {
  const st = fs.statSync(p);
  if (st.isFile()) { yield p; return; }
  for (const f of fs.readdirSync(p)) yield* walk(path.join(p, f));
}

test(`no served image is larger than ${MAX / 1024} KB`, () => {
  const tooBig = [];
  let seen = 0;
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      if (!/\.(png|jpe?g|webp|avif|gif)$/i.test(file)) continue;
      seen++;
      const rel = path.relative(repo, file);
      if (!ALLOW.has(rel) && fs.statSync(file).size > MAX) tooBig.push(`${rel} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
    }
  }
  assert.ok(seen > 10, "found the images");
  assert.deepEqual(tooBig, []);
});

test("the unoptimised originals are not in a served folder", () => {
  assert.ok(fs.existsSync(path.join(repo, "assets-src", "hero-left.png")));
  assert.ok(!fs.existsSync(path.join(repo, "assets", "img", "logo-wordmark-framed.png")) ||
    fs.statSync(path.join(repo, "assets", "img", "logo-wordmark-framed.png")).size < MAX);
});
