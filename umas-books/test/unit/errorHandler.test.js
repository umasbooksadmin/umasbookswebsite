// The last-resort error handler: honours a 4xx err.status (friendly page,
// NO alert email), and keeps tokens out of the alert subject.
// The mailer is stubbed before errorAlert loads (it destructures sendMail).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const mailer = require("../../src/mailer");
const sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };

const express = require("express");
const { errorHandler, redactedPath } = require("../../src/lib/errorHandler");

let server;
let base;
before(async () => {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "..", "views"));
  app.use((req, res, next) => { res.locals.user = null; res.locals.cartCount = 0; next(); });
  app.get("/boom/:kind", (req, res, next) => {
    const err = new Error(`kaboom ${req.params.kind}`);
    if (req.params.kind === "413") { err.status = 413; err.code = "LIMIT_FILE_SIZE"; }
    if (req.params.kind === "400") err.statusCode = 400;
    if (req.params.kind === "multer") { err.name = "MulterError"; err.code = "LIMIT_FILE_SIZE"; }
    if (req.params.kind === "999") err.status = 999;
    next(err);
  });
  app.get("/reset-password/:token", (req, res, next) => next(new Error("db down")));
  app.use(errorHandler);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); server.closeAllConnections(); });

// Keep first: alertOnError throttles to one email per 15 minutes, so the
// "no alert for 4xx" assertions must run before any 5xx has been sent.
test("4xx err.status is honoured with a friendly page and no alert", async () => {
  const r413 = await fetch(`${base}/boom/413`);
  assert.equal(r413.status, 413);
  assert.match(await r413.text(), /too large/i);
  const rMulter = await fetch(`${base}/boom/multer`);
  assert.equal(rMulter.status, 413, "a MulterError (no err.status) is mapped from its code");
  await rMulter.text();
  const r400 = await fetch(`${base}/boom/400`);
  assert.equal(r400.status, 400);
  await r400.text();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 0, "a client error must not email an alert");
});

test("a 5xx alerts, and the subject carries only method + path with the token and query redacted", async () => {
  const res = await fetch(`${base}/reset-password/abcdef0123456789SECRETTOKENVALUE?order=SECRET2`);
  assert.equal(res.status, 500);
  await res.text();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "[umas-books] Error on GET /reset-password/:token");
});

test("an out-of-range err.status is a plain 500", async () => {
  const res = await fetch(`${base}/boom/999`);
  assert.equal(res.status, 500);
  await res.text();
});

test("the 500 page is French for a visitor who chose French, even without the language middleware", async () => {
  const fr = await fetch(`${base}/boom/999`, { headers: { cookie: "umasbooks_lang=fr" } });
  assert.equal(fr.status, 500);
  const html = await fr.text();
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /Une erreur est survenue/);
  assert.match(await (await fetch(`${base}/boom/999`)).text(), /Something went wrong/);
});

test("redactedPath drops the query string and token segments", () => {
  const r = (url) => redactedPath({ originalUrl: url });
  assert.equal(r("/reset-password/abc123"), "/reset-password/:token");
  assert.equal(r("/verify-email/abc123"), "/verify-email/:token");
  assert.equal(r("/cart/return?order=SECRETSECRETSECRETSECRET"), "/cart/return");
  assert.equal(r("/orders/0123456789abcdef0123456789abcdef"), "/orders/:token");
  assert.equal(r("/books/42?q=x"), "/books/42");
  assert.equal(r("/"), "/");
});
