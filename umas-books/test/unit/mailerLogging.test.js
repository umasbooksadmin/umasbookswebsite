// mailer.js with no Gmail credentials: the body of a reset or verification
// mail is a live login link, so production logs must not contain it.

const { test, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const MAILER = require.resolve("../../src/mailer");
const saved = { env: process.env.NODE_ENV, user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD };

function freshMailer(nodeEnv) {
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  process.env.NODE_ENV = nodeEnv;
  delete require.cache[MAILER]; // the transporter is cached per module instance
  return require(MAILER);
}

afterEach(() => {
  mock.restoreAll();
  for (const [k, v] of [["NODE_ENV", saved.env], ["GMAIL_USER", saved.user], ["GMAIL_APP_PASSWORD", saved.pass]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  delete require.cache[MAILER];
});

const MSG = { to: "someone@example.test", subject: "Reset your password", text: "Click https://umasbooks.org/reset-password/SECRETTOKEN123" };

function logged() {
  return mock.method(console, "warn", () => {});
}
const allText = (m) => m.mock.calls.map((c) => c.arguments.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");

test("production: unconfigured mail THROWS (so the outbox retries it instead of marking it sent) and logs only recipient and subject", async () => {
  const { sendMail } = freshMailer("production");
  const warn = logged();
  const err = mock.method(console, "error", () => {});
  await assert.rejects(() => sendMail(MSG), /not configured/i);
  const out = allText(warn) + allText(err);
  assert.match(out, /someone@example\.test/);
  assert.match(out, /Reset your password/);
  assert.doesNotMatch(out, /SECRETTOKEN123|reset-password/);
});

test("non-production: the full body is still logged for local development", async () => {
  const { sendMail } = freshMailer("development");
  const warn = logged();
  await sendMail(MSG); // does not throw outside production
  assert.match(allText(warn), /SECRETTOKEN123/);
});

test("nodemailer accepts a comma-separated recipient list (ALERT_TO / CONTACT_TO may hold several addresses)", async () => {
  const nodemailer = require("nodemailer");
  const t = nodemailer.createTransport({ jsonTransport: true });
  const info = await t.sendMail({ from: "a@example.test", to: "one@example.test, two@other.example", subject: "s", text: "t" });
  assert.deepEqual(info.envelope.to, ["one@example.test", "two@other.example"]);
});
