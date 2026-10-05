// Fonts are self-hosted (assets/fonts): nothing the site serves may load
// from Google's font hosts, since that sends people's IP addresses to Google.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../..");
const dirs = [
  path.join(root, "views"),
  path.join(root, "public"),
  path.join(root, "src"),
  path.join(root, "../assets"),
];
const TEXT = /\.(ejs|css|js|html|json|webmanifest)$/;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (TEXT.test(e.name)) yield p;
  }
}

test("no view, asset or CSP rule references Google's font hosts", () => {
  const offenders = [];
  for (const d of dirs) {
    for (const f of walk(d)) {
      const src = fs.readFileSync(f, "utf8");
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(src)) offenders.push(path.relative(root, f));
    }
  }
  assert.deepEqual(offenders, []);
});

test("every self-hosted font file referenced by the CSS exists", () => {
  for (const css of [path.join(root, "../assets/site.css"), path.join(root, "public/style.css")]) {
    const src = fs.readFileSync(css, "utf8");
    const files = [...src.matchAll(/url\(([^)]*fonts\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
    assert.ok(files.length >= 10, `${css} declares the fonts`);
    for (const f of files) {
      assert.ok(fs.existsSync(path.join(root, "../assets/fonts", path.basename(f))), `missing ${f}`);
    }
    assert.match(src, /font-display: swap/);
  }
});
