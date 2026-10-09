// L6: POST /logout with a bad or missing CSRF token must NOT destroy the session. It shows a
// friendly "Please try again" page with a confirm button (a fresh token); the double-click case
// (the session already gone) still ends quietly at the home page. GET /logout only confirms.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { fetchCsrfToken } = require("../helpers/httpClient");

let h;
before(async () => { h = await tillHarness({ port: 6133, ip: "10.82.4.4", loginAdmin: false }); });
after(async () => { await h.stop(); });

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const rawPost = (path, jar, body) => fetch(`${h.app.base}${path}`, {
  method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": h.ip }, body,
});
const stillLoggedIn = async (jar) => {
  const r = await fetch(`${h.app.base}/account`, { redirect: "manual", headers: { cookie: jar.header(), "x-forwarded-for": h.ip } });
  return r.status === 200;
};

test("a logout POST with a bad token does not log out: it shows 'Please try again' with a working confirm button", async () => {
  const u = await h.makeUser({ name: "Logout Lou" });
  assert.equal(await stillLoggedIn(u.jar), true);

  for (const body of ["_csrf=wrong-token", ""]) {
    const bad = await rawPost("/logout", u.jar, body);
    assert.equal(bad.status, 403);
    const text = await bad.text();
    assert.match(text, /Please try again/);
    assert.match(text, /action="\/logout"/);
    assert.equal(await stillLoggedIn(u.jar), true, "the session survived the bad token");
    u.jar.capture(bad);
  }

  // the button on that page carries a token that works
  const page = await fetch(`${h.app.base}/logout`, { redirect: "manual", headers: { cookie: u.jar.header(), "x-forwarded-for": h.ip } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Please try again/);
  assert.equal(await stillLoggedIn(u.jar), true, "GET /logout does not log anyone out");
  const token = html.match(/name="_csrf" value="([0-9a-f]{64})"/)[1];
  const ok = await rawPost("/logout", u.jar, `_csrf=${token}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/");
  u.jar.capture(ok);
  assert.equal(await stillLoggedIn(u.jar), false, "the valid token logged out");
});

test("a bad-token page for a logged-in person offers a token that logs out", async () => {
  const u = await h.makeUser({ name: "Logout Lee" });
  const bad = await rawPost("/logout", u.jar, "_csrf=nope");
  const html = await bad.text();
  const token = html.match(/name="_csrf" value="([0-9a-f]{64})"/)[1];
  const ok = await rawPost("/logout", u.jar, `_csrf=${token}`);
  assert.equal(ok.status, 302);
  u.jar.capture(ok);
  assert.equal(await stillLoggedIn(u.jar), false);
});

test("nobody logged in (a double-click's second POST): a bad token just goes home, GET /logout goes home", async () => {
  const jar = require("../helpers/httpClient").makeCookieJar();
  await fetchCsrfToken(h.app.base, jar, { "x-forwarded-for": h.ip });
  const r = await rawPost("/logout", jar, "_csrf=nope");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/");
  const g = await fetch(`${h.app.base}/logout`, { redirect: "manual", headers: { cookie: jar.header(), "x-forwarded-for": h.ip } });
  assert.equal(g.status, 302);
  assert.equal(g.headers.get("location"), "/");
});

test("a valid-token logout still works (the normal button)", async () => {
  const u = await h.makeUser({ name: "Logout Liv" });
  const token = await fetchCsrfToken(h.app.base, u.jar, { "x-forwarded-for": h.ip });
  const ok = await rawPost("/logout", u.jar, `_csrf=${token}`);
  assert.equal(ok.status, 302);
  u.jar.capture(ok);
  assert.equal(await stillLoggedIn(u.jar), false);
});
