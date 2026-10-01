// No database needed. nodemailer.createTransport is replaced before any send.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");

const mailer = require("../../src/mailer");
const { buildTransportConfig, describeMailConfig, resolveFrom, sendMail, MAIL_TIMEOUT_MS } = mailer;

const GMAIL = { GMAIL_USER: "gm@example.org", GMAIL_APP_PASSWORD: "gmail-secret-pw" };
const SMTP = { SMTP_HOST: "smtp-relay.brevo.com", SMTP_USER: "login@smtp-brevo.com", SMTP_PASS: "brevo-secret-key" };

test("precedence: SMTP_HOST beats Gmail, Gmail beats console", () => {
  assert.equal(buildTransportConfig({ ...GMAIL, ...SMTP }).kind, "smtp");
  assert.equal(buildTransportConfig(GMAIL).kind, "gmail");
  assert.equal(buildTransportConfig({}).kind, "console");
  assert.equal(buildTransportConfig({}).options, null);
  assert.equal(buildTransportConfig({ GMAIL_USER: "x@y.z" }).kind, "console");
});

test("smtp defaults: port 587, secure false; 465 + SMTP_SECURE=true", () => {
  const d = buildTransportConfig(SMTP).options;
  assert.equal(d.host, "smtp-relay.brevo.com");
  assert.equal(d.port, 587);
  assert.equal(d.secure, false);
  assert.deepEqual(d.auth, { user: SMTP.SMTP_USER, pass: SMTP.SMTP_PASS });
  const s = buildTransportConfig({ ...SMTP, SMTP_PORT: "465", SMTP_SECURE: "true" }).options;
  assert.equal(s.port, 465);
  assert.equal(s.secure, true);
  assert.equal(buildTransportConfig({ ...SMTP, SMTP_PORT: "junk" }).options.port, 587);
});

test("every transport carries the 10s timeouts", () => {
  for (const env of [SMTP, GMAIL]) {
    const o = buildTransportConfig(env).options;
    assert.equal(MAIL_TIMEOUT_MS, 10000);
    assert.equal(o.connectionTimeout, MAIL_TIMEOUT_MS);
    assert.equal(o.greetingTimeout, MAIL_TIMEOUT_MS);
    assert.equal(o.socketTimeout, MAIL_TIMEOUT_MS);
  }
  assert.equal(buildTransportConfig(GMAIL).options.service, "gmail");
});

test("From: MAIL_FROM wins; else the authenticated mailbox; CR/LF rejected", () => {
  const branded = "Uma's Books <admin@umasbooks.org>";
  assert.equal(resolveFrom({ ...SMTP, ...GMAIL, MAIL_FROM: branded }), branded);
  assert.equal(resolveFrom(GMAIL), `"Uma's Books" <gm@example.org>`);
  assert.equal(resolveFrom(SMTP), `"Uma's Books" <login@smtp-brevo.com>`);
  assert.equal(resolveFrom({ SMTP_HOST: "h", SMTP_USER: "not-an-email" }), `"Uma's Books" <admin@umasbooks.org>`);
  assert.equal(resolveFrom({ ...GMAIL, MAIL_FROM: "a@b.c\r\nBcc: evil@x.org" }), `"Uma's Books" <gm@example.org>`);
});

test("describeMailConfig never contains credentials", () => {
  for (const env of [{ ...SMTP, ...GMAIL }, GMAIL, {}]) {
    const text = JSON.stringify(describeMailConfig(env));
    for (const secret of ["brevo-secret-key", "gmail-secret-pw"]) assert.ok(!text.includes(secret), text);
  }
  assert.deepEqual(describeMailConfig({ ...SMTP, MAIL_FROM: "A <a@b.c>" }), {
    kind: "smtp", enabled: true, from: "A <a@b.c>", host: "smtp-relay.brevo.com", port: 587, secure: false,
  });
});

// --- sendMail with a mocked createTransport -------------------------------
const realCreate = nodemailer.createTransport;
const saved = {};
const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "GMAIL_USER", "GMAIL_APP_PASSWORD", "MAIL_FROM"];
let created;
let sent;

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  created = [];
  sent = [];
  nodemailer.createTransport = (opts) => {
    created.push(opts);
    return { sendMail: async (msg) => { sent.push(msg); } };
  };
  mailer._resetForTests();
});

afterEach(() => {
  nodemailer.createTransport = realCreate;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  mailer._resetForTests();
});

test("sent message carries MAIL_FROM, ignores caller from, keeps replyTo", async () => {
  Object.assign(process.env, SMTP, { MAIL_FROM: "Uma's Books <admin@umasbooks.org>" });
  const replyTo = { name: "Visitor", address: "v@example.com" };
  await sendMail({ to: "a@example.com", subject: "S", text: "T", replyTo, from: "evil@x.org" });
  assert.equal(created.length, 1);
  assert.equal(created[0].host, "smtp-relay.brevo.com");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "Uma's Books <admin@umasbooks.org>");
  assert.deepEqual(sent[0].replyTo, replyTo);
  assert.equal(sent[0].to, "a@example.com");
});

test("Gmail setup still works without MAIL_FROM", async () => {
  Object.assign(process.env, GMAIL);
  await sendMail({ to: "a@example.com", subject: "S", text: "T" });
  assert.equal(created[0].service, "gmail");
  assert.equal(sent[0].from, `"Uma's Books" <gm@example.org>`);
  assert.ok(!("replyTo" in sent[0]));
});

test("nothing is sent (and no transport created) when unconfigured", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await sendMail({ to: "a@example.com", subject: "S", text: "T" });
  } finally {
    console.warn = warn;
  }
  assert.equal(created.length, 0);
  assert.equal(sent.length, 0);
});

test("multi-recipient or injected `to` is refused", async () => {
  Object.assign(process.env, SMTP);
  for (const to of ["a@x.com, b@y.com", "a@x.com\r\nBcc: z@y.com", "", undefined, ["a@x.com"]]) {
    await assert.rejects(sendMail({ to, subject: "S", text: "T" }), /single email/);
  }
  assert.equal(sent.length, 0);
});
