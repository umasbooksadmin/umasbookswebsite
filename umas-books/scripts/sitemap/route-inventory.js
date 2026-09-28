#!/usr/bin/env node
// Route inventory: extracted directly from the Express route files, not
// modeled by hand. Scans every src/routes/*.js for router.get/post calls
// and pulls out the method, path, and any auth middleware attached, by
// parsing the actual source text.
//
// Usage: node route-inventory.js /path/to/umas-books > routes.json

const fs = require("fs");
const path = require("path");

const root = process.argv[2];
if (!root) {
  console.error("Usage: node route-inventory.js /path/to/umas-books");
  process.exit(1);
}

const routesDir = path.join(root, "src", "routes");
const files = fs.readdirSync(routesDir).filter((f) => f.endsWith(".js"));

const KNOWN_MIDDLEWARE = new Set(["requireAuth", "requireMember", "requireAdmin", "requireVolunteer"]);

// A route with no gate of its own can still be effectively protected if
// all it does is redirect somewhere else — e.g. a legacy-bookmark shim
// like app.get("/admin/classes", (req,res) => res.redirect(301,
// "/admin/sessions"+qs(req))). Reporting that as flatly "public" is
// misleading: it IS unauthenticated, but it also has no content and no
// side effect, and the real page it points to has its own gate. Flag it
// instead of hiding it, so a route table doesn't cry wolf on it.
function detectRedirect(handlerBody) {
  const m = handlerBody.match(/res\.redirect\(\s*(?:\d+\s*,\s*)?["'`]([^"'`]+)["'`]/);
  return m ? m[1] : null;
}

const results = [];

for (const file of files) {
  const filePath = path.join(routesDir, file);
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  lines.forEach((line, idx) => {
    const m = line.match(/router\.(get|post)\(\s*(["'`])([^"'`]+)\2\s*,\s*(.+)$/);
    if (!m) return;
    const [, method, , routePath, rest] = m;
    const handlerStart = rest.search(/\(req\b|async\s*\(|function\s*\(/);
    const middlewarePart = handlerStart >= 0 ? rest.slice(0, handlerStart) : "";
    const middlewares = middlewarePart
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const gate = middlewares.find((mw) => KNOWN_MIDDLEWARE.has(mw)) || null;
    const redirectsTo = gate ? null : detectRedirect(rest);
    results.push({
      method: method.toUpperCase(),
      routePath,
      gate,
      redirectsTo,
      file: `src/routes/${file}`,
      line: idx + 1,
    });
  });
}

// Also pull the marketing (static) pages array and root-level app.get/redirects from index.js
const indexPath = path.join(root, "src", "index.js");
const indexSrc = fs.readFileSync(indexPath, "utf8");

const marketingMatch = indexSrc.match(/const MARKETING_PAGES = \[([\s\S]*?)\];/);
if (marketingMatch) {
  const pages = [...marketingMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  pages.forEach((p) => {
    results.push({ method: "GET", routePath: "/" + p, gate: null, file: "src/index.js (static, marketingCsp)", line: null });
  });
}

indexSrc.split("\n").forEach((line, idx) => {
  const m = line.match(/app\.(get|post)\(\s*(["'`])([^"'`]+)\2\s*,\s*(.+)$/);
  if (!m) return;
  const [, method, , routePath, rest] = m;
  const handlerStart = rest.search(/\(req\b|async\s*\(|function\s*\(/);
  const middlewarePart = handlerStart >= 0 ? rest.slice(0, handlerStart) : "";
  const middlewares = middlewarePart.split(",").map((s) => s.trim()).filter(Boolean);
  const gate = middlewares.find((mw) => KNOWN_MIDDLEWARE.has(mw)) || null;
  const redirectsTo = gate ? null : detectRedirect(rest);
  results.push({ method: method.toUpperCase(), routePath, gate, redirectsTo, file: "src/index.js", line: idx + 1 });
});

results.sort((a, b) => a.routePath.localeCompare(b.routePath));
console.log(JSON.stringify(results, null, 2));
