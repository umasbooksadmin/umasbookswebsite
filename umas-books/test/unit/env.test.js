const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateEnv, checkEnv } = require("../../src/lib/env");

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
  RENDER_EXTERNAL_URL: "https://example.onrender.com",
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

test("warns when neither APP_BASE_URL nor RENDER_EXTERNAL_URL is set", () => {
  const env = { ...FULL };
  delete env.RENDER_EXTERNAL_URL;
  assert.match(validateEnv(env).warnings.join("\n"), /APP_BASE_URL/);
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
