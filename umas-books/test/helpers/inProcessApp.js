// A tiny in-process Express harness for tests that must stub modules the
// real app can't be told to stub from outside (HelloAsso, the mailer) —
// startTestApp() runs src/index.js as a child process, so overriding
// module exports there is impossible. Here the real route modules are
// mounted on a minimal app with the same view engine and view locals, a
// MemoryStore session and NO CSRF check (that middleware has its own unit
// tests; these tests are about route behaviour).
//
// Callers must stub helloasso/mailer exports BEFORE requiring the routes
// (lib/cart.js, lib/membership.js and routes/contact.js destructure them
// at require time), and set DATABASE_URL via prepareDatabase() before
// anything requires src/db.

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");

// In-process admin routes are exercised without a second factor.
if (!process.env.ADMIN_2FA_REQUIRED) process.env.ADMIN_2FA_REQUIRED = "false";

// No test may reach Wikidata / NYT / Anthropic through the awards lookups
// (lib/awards); the tests of that feature switch them on explicitly.
if (!process.env.AWARDS_LOOKUPS) process.env.AWARDS_LOOKUPS = "off";

// Own throwaway database locally (createdb/dropdb); in CI DATABASE_URL is
// one shared database that every test file uses concurrently, so nothing
// is created or dropped there.
function prepareDatabase(label) {
  const ownsDatabase = !process.env.DATABASE_URL;
  const dbName = `umasbooks_${label}_test_${Date.now()}`;
  process.env.DATABASE_URL = process.env.DATABASE_URL || `postgres://localhost:5432/${dbName}`;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  return {
    create() {
      if (ownsDatabase) execFileSync("createdb", [dbName], { stdio: "inherit" });
      execFileSync("node", ["src/migrate.js"], { cwd: ROOT, env: process.env, stdio: "inherit" });
    },
    drop() {
      if (ownsDatabase) execFileSync("dropdb", ["--if-exists", dbName], { stdio: "inherit" });
    },
  };
}

// routers: express routers to mount. A request with an `x-test-user`
// header (JSON) is treated as logged in as that session user.
function buildApp(routers) {
  const express = require("express");
  require("express-async-errors");
  const session = require("express-session");

  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT, "views"));
  Object.assign(app.locals, require("../../src/lib/dates"));
  Object.assign(app.locals, require("../../src/lib/sessionTone"));
  app.use(express.urlencoded({ extended: false }));
  app.use(require("../../src/middleware/lang").langMiddleware);
  app.use(session({ secret: "in-process-test", resave: false, saveUninitialized: false, name: "test.sid" }));
  app.use((req, res, next) => {
    const hdr = req.get("x-test-user");
    if (hdr) req.session.user = JSON.parse(hdr);
    res.locals.user = req.session.user || null;
    res.locals.cartCount = Array.isArray(req.session.cart) ? req.session.cart.length : 0;
    res.locals.csrfToken = "test-csrf-token";
    next();
  });
  for (const r of routers) app.use(r);
  app.use((req, res) => res.status(404).render("404"));
  // Mirrors the production last-resort handler in src/index.js.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).type("text").send("Something went wrong. Please try again.");
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
      });
    });
  });
}

async function waitFor(fn, { timeoutMs = 3000, intervalMs = 25, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { prepareDatabase, buildApp, listen, waitFor };
