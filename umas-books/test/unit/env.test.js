const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateEnv, checkEnv } = require("../../src/lib/env");

const FULL = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://x",
  SESSION_SECRET: "s",
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
  assert.equal(logs.warn.length, 2);
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
  assert.deepEqual(validateEnv({}).missing, ["DATABASE_URL", "SESSION_SECRET"]);
});
