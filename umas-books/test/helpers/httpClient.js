// A tiny cookie jar — good enough for one session across several fetch()
// calls, which is all these integration tests need (no external
// dependency for it).
function makeCookieJar() {
  const cookies = new Map();
  return {
    capture(res) {
      for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

// Admin forms answer a refused or "show the result" POST with 303 and a GET
// page (Post/Redirect/Get, so Back never offers to resubmit it). A browser
// follows that at once with the same session; this does the same. Any other
// answer (200, 302, 4xx...) is returned untouched, so tests of ordinary
// redirects still see them.
async function followSeeOther(res, { base, jar, headers = {} }) {
  if (res.status !== 303) return res;
  const next = await fetch(new URL(res.headers.get("location"), base), { redirect: "manual", headers: { cookie: jar.header(), ...headers } });
  jar.capture(next);
  return next;
}

// extraHeaders: e.g. { "x-forwarded-for": ip } for tests that simulate many
// different clients — /api/csrf-token is rate limited per IP for people
// that have no session cookie yet.
function fetchCsrfToken(base, cookieJar, extraHeaders = {}) {
  return fetch(`${base}/api/csrf-token`, { headers: { cookie: cookieJar.header(), ...extraHeaders } }).then(async (res) => {
    cookieJar.capture(res);
    const body = await res.json();
    return body.token;
  });
}

// Waits until the session behind `cookieJar` reports `expected` cart lines
// (GET /api/cart/count — read-only, never creates a session).
//
// Why a test needs this: express-session answers a request that modified
// the session (a 302 from /cart/add, say) BEFORE its store write finishes
// (see src/lib/session.js). A test that follows up at once can read the old
// session, so "add to cart, then GET /cart" fails at random when the
// database is busy — and it is the shared CI database, so it often is. A
// real browser has a network round trip to hide this; a test does not.
// Polling what the app itself reports is deterministic (no fixed sleep): it
// returns as soon as the write has landed and fails loudly if it never does.
async function waitForCartCount(base, cookieJar, expected, { timeoutMs = 5000, headers = {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const res = await fetch(`${base}/api/cart/count`, { headers: { cookie: cookieJar.header(), ...headers } });
    last = (await res.json()).count;
    if (last === expected) return;
    if (Date.now() > deadline) throw new Error(`session never reported ${expected} cart line(s); last saw ${last}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// What a person does with the emailed confirmation link: the link opens a page
// with a "Confirm my email" button (a GET changes nothing, so mail scanners
// that prefetch links cannot use the token up), and pressing the button POSTs.
// Returns the POST response (redirect: "manual"). If the link is invalid the
// GET answer (400) is returned instead: there is no button to press.
// `link` is a path (/verify-email/<token>) or a full URL.
async function clickConfirmationLink(base, link, { jar = makeCookieJar(), headers = {} } = {}) {
  const path = link.startsWith("http") ? new URL(link).pathname : link;
  const page = await fetch(`${base}${path}`, { redirect: "manual", headers: { cookie: jar.header(), ...headers } });
  jar.capture(page);
  if (page.status !== 200) return page;
  const html = await page.text();
  const csrf = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  if (!csrf || !/Confirm my email/.test(html)) throw new Error("confirmation page has no button/CSRF field");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  jar.capture(res);
  return res;
}

module.exports = { makeCookieJar, followSeeOther, fetchCsrfToken, waitForCartCount, clickConfirmationLink };
