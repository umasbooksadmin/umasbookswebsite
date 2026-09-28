#!/usr/bin/env node
// Real link-graph crawler. No hand modeling: logs in as each real persona
// against the actual running app, fetches every page it can reach (seeded
// with the route inventory so nothing is missed even if unlinked), and
// extracts every <a href> / <form action> it actually finds in the
// rendered HTML. The graph this produces is only as good as what the
// server actually sent back.
//
// Usage: node crawler.js http://localhost:3099 routes.json > crawl.json

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
const SKIP_SCHEME = /^(mailto:|tel:|sms:|javascript:|#)/i;

// Only <a href> and GET forms are real navigable pages worth fetching.
// A POST form's action is an action endpoint, not a page — GETting it
// produces meaningless 404s/500s (wrong verb), so those are recorded as
// a distinct edge type instead of being crawled.
function extractLinks(html) {
  const navigable = new Set();
  const submits = new Set();
  for (const m of html.matchAll(/<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi)) navigable.add(m[1]);
  for (const m of html.matchAll(/<form\b([^>]*)>/gi)) {
    const attrs = m[1];
    const actionM = attrs.match(/action\s*=\s*["']([^"']+)["']/i);
    if (!actionM) continue;
    const methodM = attrs.match(/method\s*=\s*["']([^"']+)["']/i);
    const method = (methodM ? methodM[1] : "get").toLowerCase();
    (method === "post" ? submits : navigable).add(actionM[1]);
  }
  return { navigable: [...navigable], submits: [...submits] };
}

// The static marketing pages link to each other with relative hrefs
// (e.g. books.html has href="about.html#donate", not "/about.html") —
// resolving those correctly means resolving against the page that
// contains them, not just checking for a leading slash. A relative href
// resolves against its page's own path the same way a browser does: on
// a page at /books.html, "about.html" replaces the last path segment
// and becomes /about.html, not /books.html/about.html.
function normalize(url, fromPath) {
  if (SKIP_SCHEME.test(url)) return null;
  let resolved;
  try {
    resolved = new URL(url, "http://sitemap-crawler.invalid" + fromPath);
  } catch (e) {
    return null;
  }
  if (resolved.hostname !== "sitemap-crawler.invalid") return null; // external host
  const u = resolved.pathname;
  if (ASSET_EXT.test(u)) return null;
  return u;
}

async function getCsrfAndCookie(cookieJar) {
  const res = await fetch(BASE + "/login", { headers: cookieHeader(cookieJar) });
  updateJar(cookieJar, res);
  const html = await res.text();
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

function cookieHeader(jar) {
  const pairs = Object.entries(jar).map(([k, v]) => `${k}=${v}`);
  return pairs.length ? { Cookie: pairs.join("; ") } : {};
}

function updateJar(jar, res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  for (const line of raw) {
    const [pair] = line.split(";");
    const [k, v] = pair.split("=");
    if (k && v !== undefined) jar[k.trim()] = v.trim();
  }
}

async function login(email) {
  const jar = {};
  if (!email) return jar;
  const csrf = await getCsrfAndCookie(jar);
  const body = new URLSearchParams({ email, password: PASSWORD, _csrf: csrf || "" });
  const res = await fetch(BASE + "/login", {
    method: "POST",
    headers: { ...cookieHeader(jar), "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
  updateJar(jar, res);
  return jar;
}

async function crawlPersona(name, jar, seeds) {
  const visited = {};
  const edges = [];
  const queue = [...seeds];
  const queued = new Set(seeds);

  while (queue.length) {
    const url = queue.shift();
    if (visited[url]) continue;
    let res;
    try {
      res = await fetch(BASE + url, { headers: cookieHeader(jar), redirect: "manual" });
    } catch (err) {
      visited[url] = { status: "ERROR", error: err.message };
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      visited[url] = { status: res.status, redirectTo: loc };
      const norm = loc ? normalize(loc, url) : null;
      if (norm && !queued.has(norm)) { queue.push(norm); queued.add(norm); }
      continue;
    }
    let html = "";
    try { html = await res.text(); } catch (e) {}
    visited[url] = { status: res.status };
    if (res.status >= 200 && res.status < 300 && html) {
      const { navigable, submits } = extractLinks(html);
      const navUniq = [...new Set(navigable.map((l) => normalize(l, url)).filter(Boolean))];
      const submitUniq = [...new Set(submits.map((l) => normalize(l, url)).filter(Boolean))];
      for (const link of navUniq) {
        edges.push({ from: url, to: link, type: "link" });
        if (!queued.has(link)) { queue.push(link); queued.add(link); }
      }
      for (const link of submitUniq) {
        edges.push({ from: url, to: link, type: "submit" });
        // Not queued for fetching — it's a POST action endpoint, not a page.
      }
    }
  }
  return { persona: name, visited, edges };
}

(async () => {
  const getRoutes = routes.filter((r) => r.method === "GET").map((r) => r.routePath);
  // Skip param routes we can't seed directly (e.g. /admin/inventory/:id) —
  // they'll still be discovered if something links to a real instance.
  const seeds = [...new Set(["/", ...getRoutes.filter((p) => !p.includes(":"))])];

  const results = {};
  for (const [name, email] of Object.entries(PERSONAS)) {
    process.stderr.write(`crawling as ${name}...\n`);
    const jar = await login(email);
    results[name] = await crawlPersona(name, jar, seeds);
  }
  console.log(JSON.stringify(results, null, 2));
})();
