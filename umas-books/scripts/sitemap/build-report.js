#!/usr/bin/env node
// Merges route-inventory.json + crawl.json into one report.json. Nothing
// in here is typed by hand — every field comes from parsing the real
// route files or from real HTTP responses recorded by the crawler.

const fs = require("fs");
const path = require("path");

const routes = require(path.resolve(process.argv[2]));
const crawl = require(path.resolve(process.argv[3]));

const PERSONAS = ["anonymous", "account", "member", "volunteer", "admin"];

const getRoutes = routes.filter((r) => r.method === "GET");
const byPath = {};
getRoutes.forEach((r) => { byPath[r.routePath] = { path: r.routePath, gate: r.gate, redirectsTo: r.redirectsTo || null, file: r.file, line: r.line }; });

// Union in any GET page the crawler actually found even if it wasn't a
// literal router.get() match (e.g. static files served without an
// explicit route, or a param route instantiated with a real id).
for (const persona of PERSONAS) {
  for (const url of Object.keys(crawl[persona].visited)) {
    if (!byPath[url]) byPath[url] = { path: url, gate: null, file: null, line: null, discoveredByCrawlOnly: true };
  }
}

for (const page of Object.values(byPath)) {
  page.status = {};
  page.linksTo = {};
  page.linkedFrom = {};
  page.submitsTo = {};
  for (const persona of PERSONAS) {
    const v = crawl[persona].visited[page.path];
    page.status[persona] = v ? (v.redirectTo ? `${v.status} -> ${v.redirectTo}` : String(v.status)) : "not reached";
  }
}

for (const persona of PERSONAS) {
  for (const edge of crawl[persona].edges) {
    if (edge.type === "submit") {
      if (byPath[edge.from]) {
        byPath[edge.from].submitsTo[persona] = byPath[edge.from].submitsTo[persona] || [];
        if (!byPath[edge.from].submitsTo[persona].includes(edge.to)) byPath[edge.from].submitsTo[persona].push(edge.to);
      }
      continue;
    }
    if (byPath[edge.from]) {
      byPath[edge.from].linksTo[persona] = byPath[edge.from].linksTo[persona] || [];
      if (!byPath[edge.from].linksTo[persona].includes(edge.to)) byPath[edge.from].linksTo[persona].push(edge.to);
    }
    if (byPath[edge.to]) {
      byPath[edge.to].linkedFrom[persona] = byPath[edge.to].linkedFrom[persona] || [];
      if (!byPath[edge.to].linkedFrom[persona].includes(edge.from)) byPath[edge.to].linkedFrom[persona].push(edge.from);
    }
  }
}

const pages = Object.values(byPath).sort((a, b) => a.path.localeCompare(b.path));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), personas: PERSONAS, pages }, null, 2));
