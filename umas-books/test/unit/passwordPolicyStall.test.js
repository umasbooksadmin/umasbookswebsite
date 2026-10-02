// The HIBP lookup's 3s abort must cover reading the response BODY: fetch()
// resolves on headers, so a server that stalls mid-body used to hang the
// request forever. Fail-open behaviour is unchanged.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isPasswordPwned } = require("../../src/lib/passwordPolicy");

test("a stalled response body is aborted and fails open", async () => {
  const realFetch = global.fetch;
  let aborted = false;
  global.fetch = async (url, { signal }) => ({
    ok: true,
    // Headers "arrived"; the body never does, until the abort signal fires.
    text: () => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    }),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const started = Date.now();
    const pwned = await Promise.race([
      isPasswordPwned("Correct-Horse-1"),
      new Promise((r) => setTimeout(() => r("hung"), 6000)),
    ]);
    assert.equal(pwned, false, "must fail open, not hang");
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 5000);
  } finally {
    global.fetch = realFetch;
    console.warn = warn;
  }
});

test("a normal response is still matched on the hash suffix", async () => {
  const realFetch = global.fetch;
  const crypto = require("node:crypto");
  const sha1 = crypto.createHash("sha1").update("hunter2").digest("hex").toUpperCase();
  global.fetch = async () => ({ ok: true, text: async () => `ABCDEF:1\n${sha1.slice(5)}:42\n` });
  try {
    assert.equal(await isPasswordPwned("hunter2"), true);
    assert.equal(await isPasswordPwned("some other passphrase"), false);
  } finally {
    global.fetch = realFetch;
  }
});
