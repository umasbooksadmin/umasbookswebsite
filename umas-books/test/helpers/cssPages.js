// Which stylesheets does each page load? Worked out from the templates themselves (the <link> tags of the three
// layouts and each page's `extraCss: [...]`), so it cannot drift from what the browser really gets.
//
//   const { pageTypes } = require("./cssPages");
//   pageTypes()  ->  [{ key: "mkt+blog.css", sheets: ["site.css", "site-header.css", "print.css", "blog.css"], views: ["marketing/blog.ejs"] }, ...]
//
// The three layouts are three separate design systems:
//   partials/header.ejs                  members area / shop: style.css + site-header.css (+ print.css)
//   partials/admin_header.ejs            admin: style.css + admin.css
//   marketing/partials/mkt_header.ejs    marketing site: site.css + site-header.css (+ print.css)
// style.css and site.css are two alternative base sheets and never load on the same page.

const fs = require("node:fs");
const path = require("node:path");

const VIEWS = path.join(__dirname, "..", "..", "views");

const LAYOUTS = [
  { name: "app", partial: "partials/header.ejs", includes: /include\(\s*['"](?:\.\.\/)*(?:partials\/)?header['"]/ },
  { name: "admin", partial: "partials/admin_header.ejs", includes: /include\(\s*['"](?:\.\.\/)*(?:partials\/)?admin_header['"]/ },
  { name: "mkt", partial: "marketing/partials/mkt_header.ejs", includes: /include\(\s*['"](?:\.\.\/)*(?:partials\/)?mkt_header['"]/ },
];

const base = (s) => path.basename(s.split("?")[0]);

// the stylesheets a template links itself, in order: [{ file, media }]. <noscript> blocks are left out (a fallback
// for visitors without JavaScript, never loaded together with the scripted page).
function linkedSheets(ejs) {
  const text = ejs.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
  const out = [];
  // `%>` contains a ">", so cut the text at each "<link" rather than looking for the tag's closing bracket
  for (const chunk of text.split(/<link\b/).slice(1)) {
    const tag = chunk.split("\n")[0];
    if (!/rel="stylesheet"/.test(tag)) continue;
    const href = /href="(?:<%=\s*assetUrl\(\s*['"]([^'"]+)['"]\s*\)\s*%>|([^"<]+))"/.exec(tag);
    if (!href) continue;
    const media = (/media="([^"]+)"/.exec(tag) || [])[1] || "";
    out.push({ file: base(href[1] || href[2]), media });
  }
  return out;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function pageTypes() {
  const baseSheets = {};
  for (const l of LAYOUTS) baseSheets[l.name] = linkedSheets(fs.readFileSync(path.join(VIEWS, l.partial), "utf8"));
  const types = new Map();
  const add = (key, sheets, view) => {
    if (!types.has(key)) types.set(key, { key, sheets, views: [] });
    types.get(key).views.push(view);
  };
  for (const file of walk(VIEWS).filter((f) => f.endsWith(".ejs"))) {
    const rel = path.relative(VIEWS, file).split(path.sep).join("/");
    if (LAYOUTS.some((l) => l.partial === rel)) continue;
    const ejs = fs.readFileSync(file, "utf8");
    const layout = LAYOUTS.find((l) => l.includes.test(ejs));
    const own = linkedSheets(ejs);
    if (!layout && !own.length) continue; // a partial or a fragment, not a page
    const extra = ((/extraCss:\s*\[([^\]]*)\]/.exec(ejs) || [])[1]) || "";
    const extras = [...extra.matchAll(/['"]([^'"]+)['"]/g)].map((m) => ({ file: base(m[1]), media: "" }));
    const sheets = [...(layout ? baseSheets[layout.name] : []), ...own, ...extras];
    add(`${layout ? layout.name : "standalone"}:${sheets.map((s) => s.file).join("+")}`, sheets, rel);
  }
  return [...types.values()];
}

module.exports = { pageTypes, linkedSheets, LAYOUTS };
