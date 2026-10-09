const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { canonicalHost } = require("../../src/middleware/canonicalHost");

async function boot(env) {
  const app = express();
  app.use(canonicalHost({ env }));
  app.all("*splat", (req, res) => res.status(200).send("served"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const request = (method, path, host, extraHeaders = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers: { host, ...extraHeaders } }, (res) => {
      res.resume();
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    r.on("error", reject);
    r.end();
  });
  return { request, close: () => { server.close(); server.closeAllConnections(); } };
}

const LIVE = { NODE_ENV: "production", APP_BASE_URL: "https://umasbooks.org" };

test("live: GET/HEAD on another host is 301'd to the same path on APP_BASE_URL", async () => {
  const s = await boot(LIVE);
  try {
    for (const m of ["GET", "HEAD"]) {
      const r = await s.request(m, "/books.html?genre=x", "umas-books-cmvv.onrender.com");
      assert.equal(r.status, 301);
      assert.equal(r.location, "https://umasbooks.org/books.html?genre=x");
    }
    assert.equal((await s.request("GET", "/", "www.umasbooks.org")).status, 301);
  } finally { s.close(); }
});

test("live: the canonical host (any case) is served", async () => {
  const s = await boot(LIVE);
  try {
    assert.equal((await s.request("GET", "/x", "umasbooks.org")).status, 200);
    assert.equal((await s.request("GET", "/x", "UmasBooks.org")).status, 200);
  } finally { s.close(); }
});

test("live: a POST (or any non-GET) to another host is 421, never served and never redirected", async () => {
  const s = await boot(LIVE);
  try {
    for (const path of ["/login", "/signup", "/forgot-password", "/membership/join", "/admin/x"]) {
      for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
        const r = await s.request(m, path, "umas-books-cmvv.onrender.com");
        assert.equal(r.status, 421, `${m} ${path}`);
        assert.equal(r.location, undefined);
      }
    }
    // The canonical host is unaffected.
    assert.equal((await s.request("POST", "/login", "umasbooks.org")).status, 200);
  } finally { s.close(); }
});

test("live: never /healthz or the HelloAsso webhook, on any host or method", async () => {
  const s = await boot(LIVE);
  try {
    assert.equal((await s.request("GET", "/healthz", "umas-books-cmvv.onrender.com")).status, 200);
    for (const m of ["POST", "PUT", "DELETE"]) {
      assert.equal((await s.request(m, "/webhooks/helloasso", "umas-books-cmvv.onrender.com")).status, 200, m);
    }
  } finally { s.close(); }
});

test("off in preview, outside production, and when APP_BASE_URL is missing or not https", async () => {
  for (const env of [
    { ...LIVE, PREVIEW_MODE: "true" },
    { ...LIVE, NODE_ENV: "test" },
    { NODE_ENV: "production" },
    { NODE_ENV: "production", APP_BASE_URL: "http://umasbooks.org" },
    { NODE_ENV: "production", APP_BASE_URL: "not a url" },
  ]) {
    const s = await boot(env);
    try {
      assert.equal((await s.request("GET", "/x", "umas-books-cmvv.onrender.com")).status, 200, JSON.stringify(env));
    } finally { s.close(); }
  }
});

test("live: the 421 text is French for a French visitor (cookie or Accept-Language), English otherwise", async () => {
  const s = await boot(LIVE);
  try {
    const host = "umas-books-cmvv.onrender.com";
    assert.match((await s.request("POST", "/login", host)).body, /^Misdirected request: use https:\/\/umasbooks\.org$/);
    assert.match((await s.request("POST", "/login", host, { cookie: "umasbooks_lang=fr" })).body, /^Requête mal adressée : utilisez https:\/\/umasbooks\.org$/);
    assert.match((await s.request("POST", "/login", host, { "accept-language": "fr-FR,fr;q=0.9" })).body, /^Requête mal adressée/);
    assert.match((await s.request("POST", "/login", host, { cookie: "umasbooks_lang=en", "accept-language": "fr" })).body, /^Misdirected/);
  } finally { s.close(); }
});
