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

// extraHeaders: e.g. { "x-forwarded-for": ip } for tests that simulate many
// different clients — /api/csrf-token is rate limited per IP for visitors
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

module.exports = { makeCookieJar, fetchCsrfToken, waitForCartCount };
