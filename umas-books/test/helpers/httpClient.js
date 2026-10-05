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
// different clients — /api/csrf-token is rate limited per IP for people
// that have no session cookie yet.
function fetchCsrfToken(base, cookieJar, extraHeaders = {}) {
  return fetch(`${base}/api/csrf-token`, { headers: { cookie: cookieJar.header(), ...extraHeaders } }).then(async (res) => {
    cookieJar.capture(res);
    const body = await res.json();
    return body.token;
  });
}

module.exports = { makeCookieJar, fetchCsrfToken };
