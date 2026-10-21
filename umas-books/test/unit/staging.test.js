// Test system (APP_ENV=staging, src/lib/staging.js): the email guard, the boot
// guards, and "without APP_ENV nothing changes".

const { test } = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");
const { isStaging, stagingBootProblems, enforceStagingBoot, stagingMail } = require("../../src/lib/staging");

const SANDBOX = "https://api.helloasso-sandbox.com/v5";

test("isStaging is true only for APP_ENV=staging (any case, spaces ignored)", () => {
  assert.equal(isStaging({ APP_ENV: "staging" }), true);
  assert.equal(isStaging({ APP_ENV: " Staging " }), true);
  for (const v of [undefined, "", "production", "stagingx", "true"]) assert.equal(isStaging({ APP_ENV: v }), false, String(v));
  assert.equal(isStaging({}), false);
});

// ---- boot guards ----

test("without APP_ENV=staging nothing is ever refused (live keys, production host)", () => {
  const env = { HELLOASSO_CLIENT_ID: "live", HELLOASSO_CLIENT_SECRET: "live", HELLOASSO_ORG_SLUG: "o", PRODUCTION_DATABASE_HOST: "db.example", DATABASE_URL: "postgres://u:p@db.example/x" };
  assert.deepEqual(stagingBootProblems(env), []);
  let exited = false;
  enforceStagingBoot({ env, log: { error() {} }, exit: () => { exited = true; } });
  assert.equal(exited, false);
});

test("staging refuses live HelloAsso credentials (no API base, or the production API base)", () => {
  const creds = { APP_ENV: "staging", PRODUCTION_DATABASE_HOST: "dpg-prod123-a", HELLOASSO_CLIENT_ID: "a", HELLOASSO_CLIENT_SECRET: "b", HELLOASSO_ORG_SLUG: "c" };
  for (const base of [undefined, "", "https://api.helloasso.com/v5"]) {
    const p = stagingBootProblems({ ...creds, ...(base === undefined ? {} : { HELLOASSO_API_BASE: base }) });
    assert.equal(p.length, 1, String(base));
    assert.match(p[0], /SANDBOX/);
  }
  // even one live credential alone is enough to refuse
  assert.equal(stagingBootProblems({ APP_ENV: "staging", PRODUCTION_DATABASE_HOST: "dpg-prod123-a", HELLOASSO_CLIENT_ID: "a" }).length, 1);
});

test("staging accepts sandbox credentials, or none at all", () => {
  assert.deepEqual(stagingBootProblems({ APP_ENV: "staging", HELLOASSO_CLIENT_ID: "a", HELLOASSO_CLIENT_SECRET: "b", HELLOASSO_ORG_SLUG: "c", HELLOASSO_API_BASE: SANDBOX, PRODUCTION_DATABASE_HOST: "dpg-prod123-a" }), []);
  assert.deepEqual(stagingBootProblems({ APP_ENV: "staging", PRODUCTION_DATABASE_HOST: "dpg-prod123-a" }), []);
});

test("staging refuses a DATABASE_URL on the production database host (full or short host name)", () => {
  const env = { APP_ENV: "staging", PRODUCTION_DATABASE_HOST: "dpg-prod123-a.frankfurt-postgres.render.com" };
  assert.equal(stagingBootProblems({ ...env, DATABASE_URL: "postgres://u:p@dpg-prod123-a.frankfurt-postgres.render.com/umas_books" }).length, 1);
  assert.equal(stagingBootProblems({ ...env, DATABASE_URL: "postgres://u:p@dpg-prod123-a/umas_books" }).length, 1);
  assert.equal(stagingBootProblems({ ...env, DATABASE_URL: "postgres://u:p@dpg-stage456-a/umas_books" }).length, 0);
});

test("staging REQUIRES PRODUCTION_DATABASE_HOST: unset, empty or blank is refused with a clear message", () => {
  for (const v of [undefined, "", "   "]) {
    const env = { APP_ENV: "staging", DATABASE_URL: "postgres://u:p@dpg-stage456-a/x", ...(v === undefined ? {} : { PRODUCTION_DATABASE_HOST: v }) };
    const p = stagingBootProblems(env);
    assert.equal(p.length, 1, JSON.stringify(v));
    assert.match(p[0], /PRODUCTION_DATABASE_HOST is not set.*REQUIRED/);
  }
  // not staging: never refused for this reason
  assert.deepEqual(stagingBootProblems({ DATABASE_URL: "postgres://u:p@dpg-prod123-a/x" }), []);
});

test("enforceStagingBoot logs a clear message and exits 1 on a problem", () => {
  const errors = [];
  let code = null;
  enforceStagingBoot({ env: { APP_ENV: "staging", HELLOASSO_CLIENT_ID: "a" }, log: { error: (m) => errors.push(m) }, exit: (c) => { code = c; } });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /\[staging\] FATAL: HelloAsso credentials/);
  assert.match(errors.join("\n"), /Refusing to start/);
});

// ---- the email guard ----

test("stagingMail: redirects to STAGING_MAIL_TO, original recipient in subject and body, no reply-to", () => {
  const out = stagingMail(
    { to: "real.member@example.org", subject: "Your reservation", text: "Hello", html: "<p>Hello</p>", replyTo: "other@example.org", headers: { "X-A": "1" } },
    { STAGING_MAIL_TO: " me@example.org " }
  );
  assert.equal(out.to, "me@example.org");
  assert.equal(out.subject, "[STAGING] Your reservation (to: real.member@example.org)");
  assert.match(out.text, /^\[TEST SITE\] This email was addressed to: real\.member@example\.org/);
  assert.ok(out.text.endsWith("Hello"));
  assert.match(out.html, /real\.member@example\.org/);
  assert.ok(out.html.endsWith("<p>Hello</p>"));
  assert.equal(out.replyTo, undefined);
  assert.deepEqual(out.headers, { "X-A": "1" });
});

test("stagingMail: HTML-escapes the original recipient; no html in, no html out; null without STAGING_MAIL_TO", () => {
  const out = stagingMail({ to: '"<b>x</b>" <a@b.c>', subject: "s", text: "t", html: "<i>h</i>" }, { STAGING_MAIL_TO: "me@example.org" });
  assert.ok(!out.html.includes("<b>x</b>"));
  assert.equal(stagingMail({ to: "a@b.c", subject: "s", text: "t" }, { STAGING_MAIL_TO: "me@example.org" }).html, undefined);
  assert.equal(stagingMail({ to: "a@b.c", subject: "s", text: "t" }, {}), null);
  assert.equal(stagingMail({ to: "a@b.c", subject: "s", text: "t" }, { STAGING_MAIL_TO: "  " }), null);
});

// mailer.js against a fake SMTP transport: what really leaves the server.
function loadMailer(env) {
  const saved = {};
  for (const k of ["APP_ENV", "STAGING_MAIL_TO", "GMAIL_USER", "GMAIL_APP_PASSWORD", "NODE_ENV"]) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const sent = [];
  const realCreate = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ sendMail: async (m) => { sent.push(m); } });
  delete require.cache[require.resolve("../../src/mailer")];
  const mailer = require("../../src/mailer");
  return {
    mailer,
    sent,
    restore() {
      nodemailer.createTransport = realCreate;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      delete require.cache[require.resolve("../../src/mailer")];
    },
  };
}
const MAIL = { to: "real.member@example.org", subject: "Hello", text: "Body", html: "<p>Body</p>", replyTo: "x@example.org" };
const GMAIL = { GMAIL_USER: "shop@example.org", GMAIL_APP_PASSWORD: "pw" };

test("mailer on staging with STAGING_MAIL_TO: the only message sent goes to that address", async () => {
  const m = loadMailer({ ...GMAIL, APP_ENV: "staging", STAGING_MAIL_TO: "me@example.org" });
  try {
    await m.mailer.sendMail(MAIL);
    assert.equal(m.sent.length, 1);
    assert.equal(m.sent[0].to, "me@example.org");
    assert.match(m.sent[0].subject, /^\[STAGING\] Hello \(to: real\.member@example\.org\)$/);
    assert.equal(m.sent[0].replyTo, undefined);
    assert.ok(!JSON.stringify(m.sent[0]).includes('"to":"real.member'));
  } finally { m.restore(); }
});

test("mailer on staging without STAGING_MAIL_TO: nothing is sent, it is logged, and it does not throw", async () => {
  const m = loadMailer({ ...GMAIL, APP_ENV: "staging", NODE_ENV: "production" });
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    await m.mailer.sendMail(MAIL);
    assert.deepEqual(m.sent, []);
    assert.match(warns.join("\n"), /\[staging\] STAGING_MAIL_TO is not set - email NOT sent/);
  } finally { console.warn = realWarn; m.restore(); }
});

test("mailer WITHOUT APP_ENV is unchanged: the message goes to the real recipient, untouched (STAGING_MAIL_TO ignored)", async () => {
  const m = loadMailer({ ...GMAIL, STAGING_MAIL_TO: "me@example.org" });
  try {
    await m.mailer.sendMail(MAIL);
    assert.equal(m.sent.length, 1);
    assert.deepEqual(
      { to: m.sent[0].to, subject: m.sent[0].subject, text: m.sent[0].text, html: m.sent[0].html, replyTo: m.sent[0].replyTo },
      { to: "real.member@example.org", subject: "Hello", text: "Body", html: "<p>Body</p>", replyTo: "x@example.org" }
    );
  } finally { m.restore(); }
});

test("every place that sends mail goes through mailer.sendMail (the single guarded choke point)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const offenders = walk(path.join(__dirname, "..", "..", "src"))
    .filter((f) => f.endsWith(".js") && !f.endsWith(path.join("src", "mailer.js")))
    .filter((f) => /createTransport|\.sendMail\(/.test(fs.readFileSync(f, "utf8").replace(/mailer\.sendMail\(|\bsendMail\(\{/g, "")));
  assert.deepEqual(offenders, []);
});

test("staging counts as 'not live': no launch alerts, no canonical-host redirect, no live base-URL rule (even with PREVIEW_MODE off)", () => {
  const { validateEnv } = require("../../src/lib/env");
  const { isNonLive } = require("../../src/lib/preview");
  const base = { NODE_ENV: "production", DATABASE_URL: "x", SESSION_SECRET: "x", TOTP_ENCRYPTION_KEY: "x", HELLOASSO_API_BASE: SANDBOX };
  assert.deepEqual(validateEnv({ ...base, APP_ENV: "staging" }).alerts, []);
  assert.ok(validateEnv({ ...base }).alerts.length > 0, "the same settings WITHOUT APP_ENV still raise the live-site alerts");
  assert.equal(isNonLive({ APP_ENV: "staging" }), true);
  assert.equal(isNonLive({ PREVIEW_MODE: "true" }), true);
  assert.equal(isNonLive({}), false);
});

test("render.staging.yaml: separate file, staging names, no production secrets, production render.yaml untouched by staging", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "..", "..");
  const y = fs.readFileSync(path.join(root, "render.staging.yaml"), "utf8");
  const prod = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
  assert.ok(!/staging/i.test(prod.replace(/#.*$/gm, "")), "render.yaml must not mention staging resources");
  assert.match(y, /name: umas-books-staging-db/);
  assert.match(y, /name: umas-books-staging\n/);
  assert.match(y, /key: APP_ENV\n\s+value: staging/);
  assert.ok(!/key: PREVIEW_MODE/.test(y.replace(/#.*$/gm, "")), "PREVIEW_MODE is not set on staging, so reservations work");
  assert.match(y, /key: TRUST_PROXY_HOPS\n\s+value: "2"/);
  assert.match(y, /region: frankfurt/);
  assert.match(y, /healthCheckPath: \/healthz/);
  assert.match(y, /preDeployCommand: npm run migrate/);
  assert.match(y, /startCommand: npm run seed; exec node src\/index\.js/);
  assert.match(y, /key: SESSION_SECRET\n\s+generateValue: true/);
  assert.match(y, /key: STAGING_MAIL_TO\n\s+sync: false/);
  assert.match(y, /key: PRODUCTION_DATABASE_HOST\n\s+sync: false/);
  assert.match(y, /REQUIRED/);
  assert.ok(!/umasbooks\.org|HELLOASSO_CLIENT|ANTHROPIC|domains?:/.test(y.replace(/#.*$/gm, "")), "no production address, HelloAsso or Anthropic keys, no custom domain");
});
