// In-process (no DB, no server) coverage for mail behavior that must not
// leak through response time or hang a request:
//  - forgot-password / signup respond without waiting for the mail send
//    (a send only happens for existing / new accounts respectively, so
//    awaiting it made response time reveal which case it was)
//  - the SMTP transport has connection/greeting/socket timeouts.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/never_connected";
process.env.PGSSLMODE = "disable";

const NEVER = new Promise(() => {});

const passwordReset = require("../../src/lib/passwordReset");
const emailVerification = require("../../src/lib/emailVerification");
let resetCalls = 0;
let verifyCalls = 0;
let attemptCalls = 0;
// Hang forever / reject: a response that waited on either would stall.
passwordReset.sendResetLink = () => { resetCalls++; return NEVER; };
emailVerification.sendVerificationEmail = () => { verifyCalls++; return NEVER; };
emailVerification.sendSignupAttemptEmail = () => { attemptCalls++; return Promise.reject(new Error("smtp down")); };

const { pool } = require("../../src/db");
let existingUser = null;
pool.query = async (sql) => {
  if (/FROM users WHERE email/.test(sql)) return { rows: existingUser ? [existingUser] : [] };
  if (/INSERT INTO users/.test(sql)) return { rows: [{ id: 99, email: "new@example.test", display_name: "New" }] };
  throw new Error(`unexpected query: ${sql}`);
};

const authRouter = require("../../src/routes/auth");

// A minimal in-memory session (cookie "sid"): the handlers answer 303 and leave their message in the
// session for the GET page, so the stand-in must keep it between the two requests.
const sessions = new Map();
function makeServer() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    let sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    if (!sid || !sessions.has(sid)) {
      sid = `s${sessions.size + 1}-${Math.random().toString(36).slice(2)}`;
      sessions.set(sid, {});
      res.setHeader("set-cookie", `sid=${sid}; Path=/`);
    }
    req.session = sessions.get(sid);
    req.session.save = (cb) => cb();
    next();
  });
  app.use((req, res, next) => {
    req.tr = (en) => en;
    res.render = (view, locals) => res.json({ view, ...locals });
    next();
  });
  app.use(authRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Answers with the 303 itself (status, location) and the JSON of the page it leads to (`json()`),
// fetched in the same session like a browser would.
async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(3000),
  });
  const location = res.headers.get("location");
  if (res.status !== 303) return res;
  const cookie = (res.headers.getSetCookie()[0] || "").split(";")[0];
  const page = await fetch(new URL(location, base), { redirect: "manual", headers: { cookie }, signal: AbortSignal.timeout(3000) });
  const data = await page.json();
  return { status: 303, location, json: async () => data };
}

test("forgot-password responds without waiting for the reset email to send", async () => {
  existingUser = { id: 1, email: "a@example.test", display_name: "A" };
  const { server, base } = await makeServer();
  try {
    const res = await post(base, "/forgot-password", "email=a%40example.test");
    assert.equal(res.status, 303);
    assert.equal(res.location, "/forgot-password");
    assert.equal((await res.json()).view, "forgot_password");
    assert.match((await res.json()).notice, /If an account exists/);
    assert.equal(resetCalls, 1);
  } finally {
    server.close();
  }
});

test("signup responds without waiting for mail, and identically for new and existing emails", async () => {
  const { server, base } = await makeServer();
  try {
    const form = (e) => `email=${encodeURIComponent(e)}&password=Correct-Horse-1&displayName=Name`;
    existingUser = null;
    const fresh = await post(base, "/signup", form("new@example.test"));
    existingUser = { id: 1, email: "old@example.test", display_name: "Old" };
    const dup = await post(base, "/signup", form("old@example.test"));
    assert.equal(fresh.status, 303);
    assert.equal(fresh.status, dup.status);
    assert.equal(fresh.location, dup.location);
    assert.deepEqual(await fresh.json(), await dup.json());
    assert.equal(verifyCalls, 1);
    assert.equal(attemptCalls, 1);
    // The rejected signup-attempt send must have been caught (an unhandled
    // rejection would have crashed this process by now).
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    server.close();
  }
});

test("the SMTP transport sets connection, greeting and socket timeouts", async () => {
  process.env.GMAIL_USER = "x@example.test";
  process.env.GMAIL_APP_PASSWORD = "pw";
  const nodemailer = require("nodemailer");
  let captured;
  const original = nodemailer.createTransport;
  nodemailer.createTransport = (opts) => { captured = opts; return { sendMail: async () => {} }; };
  try {
    delete require.cache[require.resolve("../../src/mailer")];
    const mailer = require("../../src/mailer");
    await mailer.sendMail({ to: "a@example.test", subject: "s", text: "t" });
    for (const key of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) {
      assert.ok(captured[key] > 0 && captured[key] <= 30000, `${key} should be a finite timeout`);
    }
  } finally {
    nodemailer.createTransport = original;
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
  }
});
