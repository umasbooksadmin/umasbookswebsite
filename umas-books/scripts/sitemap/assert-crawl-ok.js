#!/usr/bin/env node
// Turns a crawl.json (from crawler.js) into a pass/fail CI gate. Fails on
// a server error (5xx) or an outright navigation failure — the two kinds
// of result that are never legitimate, no matter which persona hit them
// or what the route is gated by. A 4xx is left alone: every real auth
// gate in this app (src/middleware/auth.js) already responds with a
// redirect or a 403, never a 5xx, and a crawled-but-unseeded param route
// (e.g. /admin/inventory/:id with no matching row) correctly 404s —
// neither is a bug this check should be catching.
//
// Also checks that each authenticated persona's login actually succeeded
// — crawler.js silently falls back to crawling as anonymous if login
// fails (see its login()), which wouldn't produce any 4xx/5xx on its own
// and would otherwise make this check pass while testing nothing.
//
// Usage: node assert-crawl-ok.js crawl.json

const crawl = require(require("path").resolve(process.argv[2]));

const LANDING_PAGE = { member: "/dashboard", volunteer: "/dashboard", admin: "/admin" };

// A route that sends a file (Content-Disposition: attachment — currently
// just GET /events/:id/ics, src/routes/events.js) makes a real browser
// abort the navigation with net::ERR_ABORTED, because Chrome treats it
// as a download action rather than a page load. That's correct behavior,
// not a broken page — a plain HTTP client would get a normal 200 with
// the file body.
const DOWNLOAD_PATH = /\/ics(\?|$)/;

const failures = [];

for (const [persona, data] of Object.entries(crawl)) {
  for (const [url, result] of Object.entries(data.visited)) {
    if (DOWNLOAD_PATH.test(url)) continue;
    if (result.status === "ERROR") {
      failures.push(`[${persona}] ${url} — navigation error: ${result.error}`);
    } else if (typeof result.status === "number" && result.status >= 500) {
      failures.push(`[${persona}] ${url} — server error ${result.status}`);
    }
  }

  const landing = LANDING_PAGE[persona];
  if (landing) {
    const result = data.visited[landing];
    // 304 (Not Modified) is a real, successful response to a conditional
    // GET — not a sign the request never reached the page.
    const ok = result && typeof result.status === "number" && (result.status < 300 || result.status === 304);
    if (!ok) {
      failures.push(`[${persona}] login appears to have failed — ${landing} was never reached successfully (got ${result ? result.status : "not visited"})`);
    }
  }
}

if (failures.length) {
  console.error(`Smoke crawl found ${failures.length} problem(s):\n`);
  failures.forEach((f) => console.error(" - " + f));
  process.exit(1);
}

const pageCount = new Set(Object.values(crawl).flatMap((d) => Object.keys(d.visited))).size;
console.log(`Smoke crawl OK — ${pageCount} distinct page(s) across ${Object.keys(crawl).length} personas, no server errors or navigation failures.`);
