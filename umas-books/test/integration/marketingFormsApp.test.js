// The two marketing forms in the REAL app (child process): the pages carry a
// CSRF token and no mailto, a POST without it is refused, a repeated field name
// (the multi-select day/time lists) survives the app-wide body clean-up, the
// thank-you state exists in both languages, and the page's CSP allows only our
// own images.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar } = require("../helpers/httpClient");

const PORT = 3912;
let app;
before(async () => { app = await startTestApp({ port: PORT, isolated: true }); });
after(async () => { await app.stop(); });

async function page(path, jar, headers = {}) {
  const res = await fetch(`${app.base}${path}`, { headers: { cookie: jar.header(), ...headers } });
  jar.capture(res);
  return { res, html: await res.text() };
}
const tokenOf = (html) => /name="_csrf" value="([0-9a-f]{64})"/.exec(html)[1];
async function post(path, jar, fields, headers = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, x);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded", ...headers },
    body: body.toString(),
  });
  jar.capture(res);
  return { res, html: await res.text() };
}

const PREREG = {
  who: "child", childFirst: "Léa", childLast: "Martin", birthYear: String(new Date().getFullYear() - 8), guardian: "1", session: "young-adventurers",
  days: ["tue", "sat"], times: ["morning", "evening"],
  parent: "Claire Martin", email: "claire@example.test", phone: "0612345678", consent: "1",
};

test("both pages are server forms with a CSRF token, no mailto, not cacheable, own-images-only CSP", async () => {
  for (const [p, action] of [["/pre-registration.html", "/pre-registration"], ["/volunteer.html", "/volunteer-signup"]]) {
    const jar = makeCookieJar();
    const { res, html } = await page(p, jar);
    assert.equal(res.status, 200, p);
    assert.match(html, new RegExp(`<form[^>]*method="post"[^>]*action="${action}"`));
    assert.match(html, /name="_csrf" value="[0-9a-f]{64}"/);
    assert.doesNotMatch(html, /data-mailto|mailto:admin@umasbooks\.org\?subject/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /img-src 'self' data:(;|$)/);
    assert.doesNotMatch(csp, /openlibrary|archive\.org/);
  }
});

test("a POST without a valid CSRF token is refused (403) and nothing is accepted", async () => {
  for (const p of ["/pre-registration", "/volunteer-signup"]) {
    const jar = makeCookieJar();
    await page("/pre-registration.html", jar); // has a session now
    const noToken = await post(p, jar, PREREG);
    assert.equal(noToken.res.status, 403, p);
    const wrong = await post(p, jar, { ...PREREG, _csrf: "0".repeat(64) });
    assert.equal(wrong.res.status, 403, p);
  }
});

test("pre-registration end to end: invalid -> 400 keeping both chosen days; valid -> thank-you page (EN and FR)", async () => {
  const jar = makeCookieJar();
  const { html } = await page("/pre-registration.html", jar);
  const _csrf = tokenOf(html);

  const bad = await post("/pre-registration", jar, { ...PREREG, _csrf, email: "nope" });
  assert.equal(bad.res.status, 400);
  assert.match(bad.html, /role="alert"/);
  assert.match(bad.html, /<input type="checkbox" name="days" value="tue" checked/);
  assert.match(bad.html, /<input type="checkbox" name="days" value="sat" checked/, "the repeated days field was not collapsed to its first value");

  const ok = await post("/pre-registration", jar, { ...PREREG, _csrf });
  assert.equal(ok.res.status, 302);
  assert.equal(ok.res.headers.get("location"), "/pre-registration.html?sent=1");

  const en = await page("/pre-registration.html?sent=1", jar);
  assert.match(en.html, /data-form-sent/);
  assert.match(en.html, /Thank you, your pre-registration has been sent/);
  assert.doesNotMatch(en.html, /<form class="preg-form"/);
  const fr = await page("/pre-registration.html?sent=1", jar, { cookie: `${jar.header()}; umasbooks_lang=fr` });
  assert.match(fr.html, /Merci, votre pré-inscription a bien été envoyée/);
});

test("volunteer end to end, with the CSRF token from the page", async () => {
  const jar = makeCookieJar();
  const { html } = await page("/volunteer.html", jar);
  const _csrf = tokenOf(html);
  const ok = await post("/volunteer-signup", jar, { _csrf, name: "Sam", email: "sam@example.test", consent: "1" });
  assert.equal(ok.res.status, 302);
  assert.equal(ok.res.headers.get("location"), "/volunteer.html?sent=1");
  const sentPage = await page("/volunteer.html?sent=1", jar);
  assert.match(sentPage.html, /Thank you, your sign-up has been sent/);
  const noConsent = await post("/volunteer-signup", jar, { _csrf, name: "Sam", email: "sam@example.test" });
  assert.equal(noConsent.res.status, 400);
  assert.match(noConsent.html, /href="#vol-consent"/);
});
