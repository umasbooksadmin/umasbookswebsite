#!/usr/bin/env node
// Real link-graph crawler, using an actual browser (Puppeteer) rather than
// plain HTTP fetches. That matters: a meaningful chunk of this site's
// navigation is injected by client-side JS after the page loads — the
// homepage's blog carousel ("Read more" links built by assets/blog.js
// from a /api/blog/posts fetch), the header's Admin/Member's Access
// icons and the Log In -> Log Out swap (assets/site.js, for the static
// marketing pages that can't render session state server-side) — none
// of which exist in the server's raw HTML response. A plain-HTTP crawl
// is blind to all of it; a real browser sees exactly what a person
// sees, because it runs the same JS a person's browser would.
//
// Usage: node crawler.js http://localhost:3099 routes.json > crawl.json

const puppeteer = require("puppeteer");
const config = require("../../src/lib/config");

const BASE = process.argv[2];
const routesPath = process.argv[3];
if (!BASE || !routesPath) {
  console.error("Usage: node crawler.js http://localhost:PORT routes.json");
  process.exit(1);
}
const routes = require(require("path").resolve(routesPath));

const PASSWORD = "TestAdmin123!secure";
const PERSONAS = {
  anonymous: null,
  account: "crawl-account@example.test",
  member: "crawl-member@example.test",
  volunteer: "crawl-volunteer@example.test",
  admin: "crawl-admin@example.test",
};

const ASSET_EXT = /\.(png|jpe?g|svg|ico|css|js|webmanifest|json|gif|woff2?|ttf|map)(\?|$)/i;
// File downloads (the Reports page's "Download CSV" links) are not pages: a
// browser navigating to one is aborted, which the crawl would count as a
// failure. Skip them like any other asset.
// Covers ?format=csv, ?format=csv&locale=fr (French Excel) and ?format=csv-fr.
const DOWNLOAD_QUERY = /[?&]format=csv(-fr)?(&|$)/i;
const SKIP_SCHEME = /^(mailto:|tel:|sms:|javascript:|#)/i;
const NAV_TIMEOUT = 15000;
// Some pages generate their own combinatorial query-string variants of
// themselves — the /events and /sessions calendars' Prev/Next links
// (month=2037-12, week=2015-06-01, ... unboundedly in both directions,
// an infinite walk that never drains the queue) and /admin/members'
// view/panel/sort/role filter links (every member row × every tab ×
// every sort order — finite, but well past a hundred for a handful of
// members). Neither is a real distinct "page" to a person following
// links; one or a few examples already prove the route and its markup.
// Cap how many query-string variants of the same base path get queued
// at all, per persona, rather than crawling every combination.
const QUERY_VARIANT_CAP = 6;

function toPath(absoluteUrl){
  try {
    const u = new URL(absoluteUrl);
    if (u.origin !== new URL(BASE).origin) return null; // external
    if (SKIP_SCHEME.test(absoluteUrl)) return null;
    const p = u.pathname + u.search;
    if (ASSET_EXT.test(p) || DOWNLOAD_QUERY.test(u.search) || /\.csv$/i.test(u.pathname)) return null;
    return p;
  } catch {
    return null;
  }
}

// Only <a href> and GET forms are real navigable pages worth visiting. A
// POST form's action is an action endpoint, not a page — visiting it
// with a plain navigation is the wrong verb and proves nothing, so it's
// recorded as a distinct edge type instead of being crawled. Reading
// the resolved .href/.action properties (not getAttribute) means the
// browser itself resolves relative URLs exactly as it would for a real
// click — no hand-rolled URL resolution needed.
async function extractLinks(page){
  const navigable = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
  const forms = await page.$$eval('form', (fs) =>
    fs.map((f) => ({ action: f.action, method: (f.getAttribute("method") || "get").toLowerCase() }))
  );
  const submitActions = forms.filter((f) => f.method === "post").map((f) => f.action);
  const getFormActions = forms.filter((f) => f.method !== "post").map((f) => f.action);
  return { navigable: navigable.concat(getFormActions), submits: submitActions };
}

async function login(page, email){
  if (!email) return;
  await page.goto(BASE + "/login", { waitUntil: "networkidle0", timeout: NAV_TIMEOUT });
  await page.type("#email", email);
  await page.type("#password", PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: NAV_TIMEOUT }),
    page.click('button[type="submit"]'),
  ]);
}

async function crawlPersona(browser, name, email, seeds){
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await login(page, email);
  } catch (err) {
    process.stderr.write(`  login failed for ${name}: ${err.message}\n`);
  }

  const visited = {};
  const edges = [];
  const queue = [...seeds];
  const queued = new Set(seeds);
  const queryVariantCounts = new Map();
  seeds.forEach((s) => {
    const q = s.indexOf("?");
    if (q === -1) return;
    const base = s.slice(0, q);
    queryVariantCounts.set(base, (queryVariantCounts.get(base) || 0) + 1);
  });
  function enqueue(link) {
    if (queued.has(link)) return;
    const q = link.indexOf("?");
    if (q !== -1) {
      const base = link.slice(0, q);
      const n = queryVariantCounts.get(base) || 0;
      if (n >= QUERY_VARIANT_CAP) return;
      queryVariantCounts.set(base, n + 1);
    }
    queue.push(link);
    queued.add(link);
  }

  while (queue.length) {
    const url = queue.shift();
    if (visited[url]) continue;
    process.stderr.write(`  [${name}] ${url}\n`);

    let response;
    try {
      response = await page.goto(BASE + url, { waitUntil: "networkidle0", timeout: NAV_TIMEOUT });
    } catch (err) {
      visited[url] = { status: "ERROR", error: err.message };
      continue;
    }
    if (!response) {
      visited[url] = { status: "ERROR", error: "no response" };
      continue;
    }

    const chain = response.request().redirectChain();
    if (chain.length) {
      const firstStatus = chain[0].response() ? chain[0].response().status() : null;
      const finalPath = toPath(response.url());
      visited[url] = { status: firstStatus, redirectTo: finalPath };
      if (finalPath) enqueue(finalPath);
      continue;
    }

    const status = response.status();
    visited[url] = { status };
    if (status >= 200 && status < 300) {
      const { navigable, submits } = await extractLinks(page);
      const navUniq = [...new Set(navigable.map(toPath).filter(Boolean))];
      const submitUniq = [...new Set(submits.map(toPath).filter(Boolean))];
      for (const link of navUniq) {
        edges.push({ from: url, to: link, type: "link" });
        enqueue(link);
      }
      for (const link of submitUniq) {
        edges.push({ from: url, to: link, type: "submit" });
      }
    }
  }

  await context.close();
  return { persona: name, visited, edges };
}

(async () => {
  const getRoutes = routes.filter((r) => r.method === "GET").map((r) => r.routePath);
  // Skip param routes we can't seed directly (e.g. /admin/inventory/:id) —
  // they'll still be discovered if something links to a real instance.
  const seeds = [...new Set(["/", ...getRoutes.filter((p) => !p.includes(":"))])];

  // GitHub Actions' ubuntu-latest runner restricts unprivileged user
  // namespaces (AppArmor), which Chrome's sandbox needs — without this,
  // launch() fails outright with "No usable sandbox!". Scoped to CI
  // (GitHub Actions sets CI=true) rather than applied unconditionally:
  // this only ever navigates to our own just-started localhost server,
  // never arbitrary web content, so disabling the sandbox here carries
  // none of the risk it would for a general-purpose browsing context —
  // but there's no reason to weaken a developer's local run that already
  // works fine with the sandbox on.
  const browser = await puppeteer.launch(config.get("CI") ? { args: ["--no-sandbox", "--disable-setuid-sandbox"] } : {});
  const results = {};
  try {
    for (const [name, email] of Object.entries(PERSONAS)) {
      process.stderr.write(`crawling as ${name}...\n`);
      results[name] = await crawlPersona(browser, name, email, seeds);
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
})();
