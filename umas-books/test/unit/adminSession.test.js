const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveAdminSessionConfig, evaluateAdminSession, stampAdminLogin, enforceAdminSession, wantsJson, returnToFor, ACTIVITY_WRITE_EVERY_MS,
} = require("../../src/lib/adminSession");

const H = 60 * 60 * 1000;
const D = 24 * H;
const cfg = resolveAdminSessionConfig({});
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const admin = (extra = {}) => ({ user: { id: 1, isAdmin: true }, adminLoginAt: T0, adminLastActivity: T0, ...extra });

test("defaults are 8 hours idle and 7 days absolute", () => {
  assert.equal(cfg.idleMs, 8 * H);
  assert.equal(cfg.maxMs, 7 * D);
  assert.deepEqual(cfg.warnings, []);
});

test("an admin idle for 8 hours is expired, one idle for 7h59 is not", () => {
  assert.equal(evaluateAdminSession(admin(), T0 + 8 * H, cfg).expired, "idle");
  assert.equal(evaluateAdminSession(admin(), T0 + 8 * H - 60000, cfg).expired, false);
});

test("an active admin is expired 7 days after the login anyway", () => {
  const s = admin({ adminLastActivity: T0 + 7 * D - 60000 });
  assert.equal(evaluateAdminSession(s, T0 + 7 * D, cfg).expired, "max");
  assert.equal(evaluateAdminSession(s, T0 + 7 * D - 1000, cfg).expired, false);
});

test("lastActivity is written only when it is 5 minutes old (no write per request)", () => {
  assert.deepEqual(evaluateAdminSession(admin(), T0 + 60000, cfg).set, {});
  assert.deepEqual(evaluateAdminSession(admin(), T0 + ACTIVITY_WRITE_EVERY_MS, cfg).set, { adminLastActivity: T0 + ACTIVITY_WRITE_EVERY_MS });
});

test("non-admin roles are never expired, however old the session", () => {
  for (const user of [{ id: 2 }, { id: 2, isMember: true }, { id: 2, isVolunteer: true }]) {
    const r = evaluateAdminSession({ user, adminLoginAt: undefined }, T0 + 29 * D, cfg);
    assert.equal(r.expired, false);
    assert.deepEqual(r.set, {});
  }
  assert.equal(evaluateAdminSession({}, T0, cfg).expired, false); // no user at all
});

test("a till account gets the same limits", () => {
  const s = { user: { id: 3, isTill: true }, adminLoginAt: T0, adminLastActivity: T0 };
  assert.equal(evaluateAdminSession(s, T0 + 9 * H, cfg).expired, "idle");
});

test("promoted mid-session: the clocks start at that moment, no instant expiry", () => {
  const r = evaluateAdminSession({ user: { id: 1, isAdmin: true } }, T0 + 20 * D, cfg);
  assert.equal(r.expired, false);
  assert.deepEqual(r.set, { adminLoginAt: T0 + 20 * D, adminLastActivity: T0 + 20 * D });
});

test("a demoted admin's clocks are forgotten, so a later promotion starts fresh", () => {
  const r = evaluateAdminSession({ user: { id: 1 }, adminLoginAt: T0, adminLastActivity: T0 }, T0 + D, cfg);
  assert.equal(r.expired, false);
  assert.ok("adminLoginAt" in r.set);
});

test("environment overrides", () => {
  const c = resolveAdminSessionConfig({ ADMIN_SESSION_IDLE_HOURS: "2", ADMIN_SESSION_MAX_DAYS: "1" });
  assert.equal(c.idleMs, 2 * H);
  assert.equal(c.maxMs, D);
  assert.equal(evaluateAdminSession(admin(), T0 + 2 * H, c).expired, "idle");
  assert.equal(evaluateAdminSession(admin({ adminLastActivity: T0 + D - 1000 }), T0 + D, c).expired, "max");
  assert.equal(resolveAdminSessionConfig({ ADMIN_SESSION_IDLE_HOURS: "0.5" }).idleMs, 0.5 * H);
});

test("bad environment values are ignored with a warning", () => {
  for (const bad of ["abc", "0", "-3", "1000", "NaN", "Infinity", "8h"]) {
    const c = resolveAdminSessionConfig({ ADMIN_SESSION_IDLE_HOURS: bad, ADMIN_SESSION_MAX_DAYS: bad });
    assert.equal(c.idleMs, 8 * H, bad);
    assert.equal(c.maxMs, 7 * D, bad);
    assert.equal(c.warnings.length, 2, bad);
    assert.match(c.warnings[0], /ADMIN_SESSION_IDLE_HOURS/);
  }
  assert.deepEqual(resolveAdminSessionConfig({ ADMIN_SESSION_IDLE_HOURS: "", ADMIN_SESSION_MAX_DAYS: "  " }).warnings, []);
  assert.equal(resolveAdminSessionConfig({ ADMIN_SESSION_MAX_DAYS: "31" }).warnings.length, 1);
});

test("stampAdminLogin only stamps admin and till logins", () => {
  const a = {}; stampAdminLogin(a, { is_admin: true }, 5);
  assert.deepEqual(a, { adminLoginAt: 5, adminLastActivity: 5 });
  const t = {}; stampAdminLogin(t, { is_till: true }, 5);
  assert.equal(t.adminLoginAt, 5);
  const m = {}; stampAdminLogin(m, { is_member: true }, 5);
  assert.deepEqual(m, {});
});

function fakeReq(over = {}) {
  return {
    method: "GET", path: "/admin/orders", originalUrl: "/admin/orders?page=2",
    headers: {}, accepts: () => "html", get: (h) => (over.headers || {})[h.toLowerCase()],
    session: { user: { id: 1, isAdmin: true }, adminLoginAt: T0, adminLastActivity: T0, destroy(cb) { this.destroyed = true; cb(); } },
    ...over,
  };
}
function fakeRes() {
  const r = { headers: {}, cleared: [] };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.redirect = (c, u) => { r.redirected = [c, u]; return r; };
  r.clearCookie = (n) => { r.cleared.push(n); };
  return r;
}

test("middleware: an expired page request is destroyed and redirected to /login with returnTo and the notice flag", () => {
  const req = fakeReq(); const res = fakeRes(); let nexted = false;
  enforceAdminSession(cfg, () => T0 + 9 * H)(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(req.session.destroyed, true);
  assert.deepEqual(res.redirected, [303, "/login?expired=1&returnTo=%2Fadmin%2Forders%3Fpage%3D2"]);
});

test("middleware: an expired fetch gets 401 JSON session_expired", () => {
  const req = fakeReq({ method: "POST", path: "/admin/till/scan", originalUrl: "/admin/till/scan", accepts: () => "json" });
  const res = fakeRes();
  enforceAdminSession(cfg, () => T0 + 9 * H)(req, res, () => assert.fail("must not continue"));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "session_expired");
});

test("middleware: a live session continues and an unsafe Referer is not used as returnTo", () => {
  const req = fakeReq(); let nexted = false;
  enforceAdminSession(cfg, () => T0 + H)(req, fakeRes(), () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(returnToFor(fakeReq({ method: "POST", headers: { referer: "https://evil.example/x", host: "umasbooks.org" } })), null);
});

test("wantsJson recognises the till and scan endpoints", () => {
  assert.equal(wantsJson({ method: "POST", path: "/admin/till/sale", accepts: () => "html" }), true);
  assert.equal(wantsJson({ method: "GET", path: "/admin/orders", accepts: () => "html" }), false);
  assert.equal(wantsJson({ method: "GET", path: "/x", accepts: () => "json" }), true);
});
