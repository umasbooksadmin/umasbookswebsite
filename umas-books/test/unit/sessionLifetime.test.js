// Pure pieces of "anonymous load protection": session lifetimes, the guest-session
// counter, and NUL stripping.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  lifetimeFor, applyLifetime, sessionLifetime, LOGGED_IN_MAX_AGE_MS, GUEST_CART_MAX_AGE_MS, GUEST_MAX_AGE_MS,
} = require("../../src/lib/sessionLifetime");
const { createAnonSessionGuard, limitFromEnv } = require("../../src/lib/anonSessionGuard");
const { stripNulDeep, rejectNulInPath, stripNulFromInput } = require("../../src/middleware/stripNul");
const { clean } = require("../../src/lib/validation");

const HOUR = 3600 * 1000;

test("lifetimes: logged in 30 days, guest with cart 24 h, other guests 2 h", () => {
  assert.equal(LOGGED_IN_MAX_AGE_MS, 30 * 24 * HOUR);
  assert.equal(GUEST_CART_MAX_AGE_MS, 24 * HOUR);
  assert.equal(GUEST_MAX_AGE_MS, 2 * HOUR);
  assert.equal(lifetimeFor({}), GUEST_MAX_AGE_MS);
  assert.equal(lifetimeFor({ csrfToken: "x" }), GUEST_MAX_AGE_MS);
  assert.equal(lifetimeFor({ cart: [] }), GUEST_MAX_AGE_MS);
  assert.equal(lifetimeFor({ cart: [{ kind: "book" }] }), GUEST_CART_MAX_AGE_MS);
  assert.equal(lifetimeFor({ user: { id: 1 } }), LOGGED_IN_MAX_AGE_MS);
  assert.equal(lifetimeFor({ user: { id: 1, isAdmin: true }, cart: [1] }), LOGGED_IN_MAX_AGE_MS);
  assert.equal(lifetimeFor({ user: null }), GUEST_MAX_AGE_MS, "a signed-out session (user=null) is a guest");
});

test("applyLifetime sets maxAge, expires and originalMaxAge (touch() resets from it)", () => {
  const session = { cookie: { originalMaxAge: 1, maxAge: 1, expires: null } };
  Object.defineProperty(session.cookie, "maxAge", { set(ms) { this.expires = new Date(Date.now() + ms); }, get() { return this.expires - Date.now(); }, configurable: true });
  assert.equal(applyLifetime(session), GUEST_MAX_AGE_MS);
  assert.equal(session.cookie.originalMaxAge, GUEST_MAX_AGE_MS);
  assert.ok(Math.abs(session.cookie.expires - (Date.now() + GUEST_MAX_AGE_MS)) < 2000);
  session.user = { id: 3 };
  applyLifetime(session);
  assert.equal(session.cookie.originalMaxAge, LOGGED_IN_MAX_AGE_MS);
  assert.equal(applyLifetime(undefined), null);
  assert.equal(applyLifetime({}), null);
});

test("sessionLifetime middleware applies the lifetime just before the headers go out", () => {
  const session = { cookie: {}, user: { id: 1 } };
  const res = { writeHead() { return "written"; } };
  sessionLifetime({ session }, res, () => {});
  assert.equal(res.writeHead(200), "written");
  assert.equal(session.cookie.originalMaxAge, LOGGED_IN_MAX_AGE_MS);
});

function fakeReq({ ip = "1.2.3.4", method = "GET", path = "/login", isNew = true, session = {} } = {}) {
  return { ip, method, path, sessionIsNew: isNew, session: { cookie: {}, ...session }, tr: (en) => en };
}
function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: null, writeHead() { return this; } };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.type = () => res;
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test("anon session guard: counts new guest sessions that hold something, blocks the next cookie-less GET", () => {
  let t = 1000;
  const guard = createAnonSessionGuard({ max: 3, windowMs: 1000, now: () => t, keyOf: (r) => r.ip });
  const make = (opts) => {
    const req = fakeReq(opts); const res = fakeRes(); let nexted = false;
    guard(req, res, () => { nexted = true; });
    return { req, res, nexted };
  };
  for (let i = 0; i < 3; i++) {
    const { req, res, nexted } = make({});
    assert.ok(nexted);
    req.session.csrfToken = "t"; // the page stored a token
    res.writeHead(200);
  }
  const blocked = make({});
  assert.equal(blocked.nexted, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.ok(blocked.res.headers["Retry-After"]);
  assert.equal(make({ path: "/api/csrf-token" }).res.statusCode, 429);
  assert.equal(make({ path: "/api/csrf-token" }).res.body.error, "rate_limited");
  // a request that already has a session, a POST, another address, and /api/session are not blocked
  assert.ok(make({ isNew: false }).nexted);
  assert.ok(make({ method: "POST" }).nexted);
  assert.ok(make({ ip: "9.9.9.9" }).nexted);
  assert.ok(make({ path: "/api/session" }).nexted);
  // window passes: allowed again
  t += 1001;
  assert.ok(make({}).nexted);
});

test("anon session guard: pages that store nothing (marketing pages) and logins are never counted", () => {
  const guard = createAnonSessionGuard({ max: 1, windowMs: 1000, keyOf: (r) => r.ip });
  for (let i = 0; i < 5; i++) {
    const req = fakeReq(); const res = fakeRes();
    guard(req, res, () => {});
    res.writeHead(200); // session untouched: no row is written
  }
  const next = fakeRes(); let ok = false;
  guard(fakeReq(), next, () => { ok = true; });
  assert.ok(ok);
  for (let i = 0; i < 5; i++) {
    const req = fakeReq({ session: { user: { id: 1 } } }); const res = fakeRes();
    guard(req, res, () => {});
    res.writeHead(302);
  }
  ok = false;
  guard(fakeReq(), fakeRes(), () => { ok = true; });
  assert.ok(ok, "logins create sessions with a user: not counted");
});

test("NUL: clean() and the request filters remove it, a NUL in the path is a 400", () => {
  assert.equal(clean("a\u0000b", 50), "ab");
  assert.equal(clean("  a\u0000\u0000 ", 50), "a");
  assert.equal(clean(["a"], 50), "");
  assert.deepEqual(stripNulDeep({ a: "x\u0000y", b: ["1\u0000", "2"], c: 3 }), { a: "xy", b: ["1", "2"], c: 3 });

  const req = { query: { q: "a\u0000b", genre: ["c\u0000"] }, body: { title: "t\u0000" } };
  let called = false;
  stripNulFromInput(req, {}, () => { called = true; });
  assert.ok(called);
  assert.deepEqual(req.query, { q: "ab", genre: ["c"] });
  assert.deepEqual(req.body, { title: "t" });

  for (const url of ["/books/a%00b", "/my-requests/%00", "/x/%00?y=1", "/x/\u0000"]) {
    const res = fakeRes(); let passed = false;
    rejectNulInPath({ url }, res, () => { passed = true; });
    assert.equal(passed, false, url);
    assert.equal(res.statusCode, 400, url);
  }
  let passed = false;
  rejectNulInPath({ url: "/api/books/search?q=a%00b" }, fakeRes(), () => { passed = true; });
  assert.ok(passed, "a NUL in the QUERY STRING is stripped, not refused");
});

test("ANON_SESSION_LIMIT: a whole number from 1 to 1,000,000, otherwise the default 60", () => {
  assert.equal(limitFromEnv({}), 60);
  assert.equal(limitFromEnv({ ANON_SESSION_LIMIT: "500" }), 500);
  for (const bad of ["0", "-3", "abc", "1.5", "2000000", ""]) assert.equal(limitFromEnv({ ANON_SESSION_LIMIT: bad }), 60, bad);
});
