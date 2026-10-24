const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateEnv, checkEnv, sendLaunchAlerts } = require("../../src/lib/env");

const FULL = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://x",
  SESSION_SECRET: "s",
  TOTP_ENCRYPTION_KEY: "t",
  GMAIL_USER: "a@b.c",
  GMAIL_APP_PASSWORD: "pw",
  HELLOASSO_CLIENT_ID: "id",
  HELLOASSO_CLIENT_SECRET: "secret",
  HELLOASSO_ORG_SLUG: "org",
  APP_BASE_URL: "https://umasbooks.example",
  CONTACT_TO: "admin@umasbooks.example",
  ALERT_TO: "admin@umasbooks.example, backup@other-provider.example",
};

function run(env) {
  const logs = { warn: [], error: [] };
  let exitCode;
  const result = checkEnv({
    env,
    log: { warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) },
    exit: (c) => { exitCode = c; },
  });
  return { result, logs, exitCode };
}

test("fully configured production env: no failure, no warnings", () => {
  const { logs, exitCode } = run(FULL);
  assert.equal(exitCode, undefined);
  assert.deepEqual(logs.warn, []);
  assert.deepEqual(logs.error, []);
});

test("fails with ALL missing required vars listed in one message", () => {
  const { logs, exitCode } = run({ NODE_ENV: "production" });
  assert.equal(exitCode, 1);
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0], /DATABASE_URL/);
  assert.match(logs.error[0], /SESSION_SECRET/);
  assert.match(logs.error[0], /TOTP_ENCRYPTION_KEY/);
});

test("lists only the one that is missing, and treats blank as missing", () => {
  const { logs, exitCode } = run({ ...FULL, SESSION_SECRET: "   " });
  assert.equal(exitCode, 1);
  assert.match(logs.error[0], /SESSION_SECRET/);
  assert.doesNotMatch(logs.error[0], /DATABASE_URL/);
});

test("missing optional vars warn loudly but do not fail", () => {
  const env = { ...FULL };
  delete env.GMAIL_APP_PASSWORD;
  delete env.HELLOASSO_ORG_SLUG;
  const { logs, exitCode } = run(env);
  assert.equal(exitCode, undefined);
  assert.equal(logs.warn.length, 3);
  assert.match(logs.warn.join("\n"), /GMAIL_APP_PASSWORD.*email/is);
  assert.match(logs.warn.join("\n"), /HELLOASSO_ORG_SLUG.*payment/is);
});

test("in preview, either APP_BASE_URL or RENDER_EXTERNAL_URL is enough; neither warns", () => {
  const env = { ...FULL, PREVIEW_MODE: "true", RENDER_EXTERNAL_URL: "https://x.onrender.com" };
  delete env.APP_BASE_URL;
  assert.deepEqual(validateEnv(env).warnings, []);
  delete env.RENDER_EXTERNAL_URL;
  assert.match(validateEnv(env).warnings.join("\n"), /APP_BASE_URL/);
  assert.deepEqual(validateEnv(env).alerts, []);
});

// ---- launch guards: preview OFF means the site is live ----
const labels = (env) => validateEnv(env).alerts.map((a) => a.label);

test("live site without APP_BASE_URL: warning + alert, RENDER_EXTERNAL_URL does not count", () => {
  const env = { ...FULL, RENDER_EXTERNAL_URL: "https://x.onrender.com" };
  delete env.APP_BASE_URL;
  const r = validateEnv(env);
  assert.match(r.warnings.join("\n"), /APP_BASE_URL is not set/);
  assert.deepEqual(labels(env), ["APP_BASE_URL missing"]);
});

test("live site with a non-https APP_BASE_URL: warning + alert", () => {
  const env = { ...FULL, APP_BASE_URL: "http://umasbooks.example" };
  assert.match(validateEnv(env).warnings.join("\n"), /not an https/);
  assert.match(labels(env)[0], /APP_BASE_URL missing/);
});

test("live site still on the HelloAsso sandbox: loud warning + alert, boot continues", () => {
  const env = { ...FULL, HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5" };
  assert.match(validateEnv(env).warnings.join("\n"), /SANDBOX/);
  assert.deepEqual(labels(env), ["HelloAsso is still in SANDBOX mode: real membership payments will not work"]);
  const { exitCode } = run(env);
  assert.equal(exitCode, undefined);
});

test("live site with the production HelloAsso API base: no sandbox alert", () => {
  assert.deepEqual(labels({ ...FULL, HELLOASSO_API_BASE: "https://api.helloasso.com/v5" }), []);
});

test("live site missing HelloAsso credentials: alert", () => {
  for (const name of ["HELLOASSO_CLIENT_ID", "HELLOASSO_CLIENT_SECRET", "HELLOASSO_ORG_SLUG"]) {
    const env = { ...FULL };
    delete env[name];
    const r = validateEnv(env);
    assert.equal(r.alerts.length, 1, name);
    assert.match(r.alerts[0].label, /HelloAsso credentials missing/);
    assert.match(r.alerts[0].message, new RegExp(name));
  }
});

test("live site without CONTACT_TO: warning only, no alert", () => {
  const env = { ...FULL };
  delete env.CONTACT_TO;
  const r = validateEnv(env);
  assert.match(r.warnings.join("\n"), /CONTACT_TO/);
  assert.deepEqual(r.alerts, []);
});

test("in preview mode none of the launch guards fire", () => {
  const env = { ...FULL, PREVIEW_MODE: "true", HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5", APP_BASE_URL: "http://x" };
  delete env.CONTACT_TO;
  delete env.HELLOASSO_CLIENT_ID;
  const r = validateEnv(env);
  assert.deepEqual(r.alerts, []);
  assert.doesNotMatch(r.warnings.join("\n"), /SANDBOX|CONTACT_TO|https/);
});

test("a fully configured live site has no alerts", () => {
  assert.deepEqual(validateEnv(FULL).alerts, []);
});

test("non-production environments are untouched", () => {
  for (const NODE_ENV of ["test", "development", undefined]) {
    const { logs, exitCode } = run({ NODE_ENV });
    assert.equal(exitCode, undefined);
    assert.deepEqual(logs.warn, []);
    assert.deepEqual(logs.error, []);
  }
});

test("validateEnv is pure: reports missing without exiting", () => {
  assert.deepEqual(validateEnv({}).missing, ["DATABASE_URL", "SESSION_SECRET", "TOTP_ENCRYPTION_KEY"]);
});

test("production refuses to boot without TOTP_ENCRYPTION_KEY (no silent SESSION_SECRET fallback)", () => {
  const env = { ...FULL };
  delete env.TOTP_ENCRYPTION_KEY;
  const { logs, exitCode } = run(env);
  assert.equal(exitCode, 1);
  assert.match(logs.error[0], /TOTP_ENCRYPTION_KEY/);
  assert.doesNotMatch(logs.error[0], /DATABASE_URL|SESSION_SECRET/);
});

test("outside production the TOTP key is not required", () => {
  const { exitCode } = run({ NODE_ENV: "development", DATABASE_URL: "x", SESSION_SECRET: "s" });
  assert.equal(exitCode, undefined);
});

test("warns that error alerts are disabled when Gmail is missing and preview mode is off", () => {
  const env = { ...FULL };
  delete env.GMAIL_USER;
  const w = validateEnv(env).warnings.join("\n");
  assert.match(w, /error alerts .*DISABLED/i);
});

test("no 'alerts disabled' warning in preview mode, or when Gmail is configured", () => {
  const preview = { ...FULL, PREVIEW_MODE: "true" };
  delete preview.GMAIL_USER;
  assert.doesNotMatch(validateEnv(preview).warnings.join("\n"), /error alerts .*DISABLED/i);
  assert.doesNotMatch(validateEnv(FULL).warnings.join("\n"), /DISABLED/);
});

test("sendLaunchAlerts sends each alert once, unthrottled; nothing when there are none", () => {
  const sent = [];
  const env = { ...FULL, HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5" };
  delete env.HELLOASSO_ORG_SLUG;
  sendLaunchAlerts(validateEnv(env).alerts, (label, msg, opts) => sent.push({ label, msg, opts }));
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => s.opts.force === true));
  assert.match(sent[0].label, /SANDBOX/);
  sendLaunchAlerts([], () => assert.fail("no alerts"));
  sendLaunchAlerts(undefined, () => assert.fail("no alerts"));
});

test("launchBannerAlerts: production only, live-site problems only, the sandbox has its own banner", () => {
  const { launchBannerAlerts } = require("../../src/lib/env");
  const env = { ...FULL, NODE_ENV: "production", HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5" };
  delete env.APP_BASE_URL;
  delete env.PREVIEW_MODE;
  const banner = launchBannerAlerts(env);
  assert.ok(banner.some((a) => /APP_BASE_URL/.test(a.label)));
  assert.ok(!banner.some((a) => /SANDBOX/.test(a.label)), "sandbox excluded (own banner)");
  assert.deepEqual(launchBannerAlerts({ ...env, NODE_ENV: "test" }), [], "never outside production");
  assert.deepEqual(launchBannerAlerts({ ...FULL, NODE_ENV: "production", PREVIEW_MODE: "true" }), [], "preview mode: nothing");
});

test("ALERT_TO unset on a live site is a warning (alerts then go to the default address)", () => {
  const env = { ...FULL };
  delete env.PREVIEW_MODE;
  delete env.ALERT_TO;
  assert.match(validateEnv(env).warnings.join("\n"), /ALERT_TO is not set/);
  assert.doesNotMatch(validateEnv({ ...env, ALERT_TO: "a@one.test, b@two.test" }).warnings.join("\n"), /ALERT_TO is not set/);
});

test("PREVIEW_MODE with an unrecognised value (a typo) is read as ON and raises a launch alert, a banner and a boot warning", () => {
  const { launchBannerAlerts } = require("../../src/lib/env");
  for (const v of ["yse", "enable", "maybe"]) {
    const env = { ...FULL, NODE_ENV: "production", PREVIEW_MODE: v };
    const r = validateEnv(env);
    assert.ok(r.alerts.some((a) => a.code === "preview_mode_value" && /treating it as ON/.test(a.message)), v);
    assert.match(r.warnings.join("\n"), /PREVIEW_MODE/);
    assert.ok(launchBannerAlerts(env).some((a) => /PREVIEW_MODE not recognised/.test(a.label)), `${v}: red banner on the admin pages`);
    const logged = [];
    require("../../src/lib/config").warnInvalid({ env, log: { warn: (l) => logged.push(l) } });
    assert.ok(logged.some((l) => /PREVIEW_MODE/.test(l) && /fail closed/.test(l)), `${v}: boot log`);
  }
  for (const v of ["true", "on", "yes", "enabled", "false", "off", "disabled", "0", ""]) {
    const env = { ...FULL, NODE_ENV: "production", PREVIEW_MODE: v };
    assert.ok(!validateEnv(env).alerts.some((a) => a.code === "preview_mode_value"), `${v} is recognised: no alert`);
  }
});
