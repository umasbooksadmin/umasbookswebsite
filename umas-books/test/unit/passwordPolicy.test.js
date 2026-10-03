// lib/passwordPolicy.js: length and complexity rules, plus the HIBP
// k-anonymity breach check with global.fetch stubbed (breached, clean,
// API down -> fail open). Nothing real is ever contacted.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { validateNewPassword, isPasswordPwned, MIN_LENGTH } = require("../../src/lib/passwordPolicy");

const realFetch = global.fetch;
const calls = [];
let handler;

beforeEach(() => {
  calls.length = 0;
  handler = async () => new Response("0000000000000000000000000000000000A:1\r\n", { status: 200 });
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    assert.ok(u.startsWith("https://api.pwnedpasswords.com/range/"), `unexpected fetch ${u}`);
    calls.push({ url: u, init });
    return handler(u, init);
  };
  mock.method(console, "warn", () => {});
});
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  global.fetch = realFetch;
});

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex").toUpperCase();

test("MIN_LENGTH is 8", () => assert.equal(MIN_LENGTH, 8));

test("too short, empty or missing passwords are rejected before any network call", async () => {
  const msg = `Password must be at least ${MIN_LENGTH} characters.`;
  assert.equal(await validateNewPassword("Ab1!xyz"), msg, "7 chars");
  assert.equal(await validateNewPassword(""), msg);
  assert.equal(await validateNewPassword(undefined), msg);
  assert.equal(await validateNewPassword(null), msg);
  assert.equal(calls.length, 0);
});

test("exactly 8 characters passes the length rule", async () => {
  assert.equal(await validateNewPassword("Abcdef1!"), null);
});

test("complexity: each missing class is named, in order, and no network call is made", async () => {
  assert.equal(await validateNewPassword("alllowercase"), "Password must include an uppercase letter, a number, a symbol.");
  assert.equal(await validateNewPassword("ALLUPPERCASE1!"), "Password must include a lowercase letter.");
  assert.equal(await validateNewPassword("NoDigitsHere!"), "Password must include a number.");
  assert.equal(await validateNewPassword("NoSymbols123"), "Password must include a symbol.");
  assert.equal(await validateNewPassword("12345678"), "Password must include a lowercase letter, an uppercase letter, a symbol.");
  assert.equal(calls.length, 0);
});

test("a non-ASCII character counts as a symbol", async () => {
  assert.equal(await validateNewPassword("Passw0rdé"), null);
});

test("breach check sends only the 5-char SHA-1 prefix, never the password or full hash", async () => {
  const pw = "Tr0ub4dor&3-clean";
  assert.equal(await isPasswordPwned(pw), false);
  assert.equal(calls.length, 1);
  const hash = sha1(pw);
  assert.equal(calls[0].url, `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
  assert.equal(calls[0].init.headers["Add-Padding"], "true");
  assert.ok(!calls[0].url.includes(hash.slice(5)));
  assert.ok(!calls[0].url.includes(pw));
  assert.ok(!JSON.stringify(calls[0].init.headers).includes(pw));
});

test("a breached password (suffix present in the range response) is rejected", async () => {
  const pw = "Summer2020!breached";
  const suffix = sha1(pw).slice(5);
  handler = async () => new Response(`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:2\r\n${suffix}:48211\r\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:0`, { status: 200 });
  assert.equal(await isPasswordPwned(pw), true);
  assert.match(await validateNewPassword(pw), /known data breach/);
});

test("suffix matching is case-insensitive and tolerant of whitespace", async () => {
  const pw = "Winter2021!breached";
  handler = async () => new Response(`  ${sha1(pw).slice(5).toLowerCase()} :7\n`, { status: 200 });
  assert.equal(await isPasswordPwned(pw), true);
});

test("a partial suffix match is not a hit", async () => {
  const pw = "Autumn2022!clean";
  handler = async () => new Response(`${sha1(pw).slice(5, 20)}:5\r\n`, { status: 200 });
  assert.equal(await isPasswordPwned(pw), false);
});

test("a clean password passes validation", async () => {
  assert.equal(await validateNewPassword("Zebra-Quilt-42-plum"), null);
  assert.equal(calls.length, 1);
});

test("padding rows with a count of 0 for other suffixes don't flag a clean password", async () => {
  handler = async () => new Response("ABCDEF0123456789ABCDEF0123456789ABC:0\r\n", { status: 200 });
  assert.equal(await validateNewPassword("Zebra-Quilt-42-plum"), null);
});

test("API down fails open: HTTP error, network error", async () => {
  handler = async () => new Response("down", { status: 503 });
  assert.equal(await isPasswordPwned("Zebra-Quilt-42-plum"), false);
  assert.equal(await validateNewPassword("Zebra-Quilt-42-plum"), null);

  handler = async () => { throw new TypeError("fetch failed"); };
  assert.equal(await isPasswordPwned("Zebra-Quilt-42-plum"), false);
  assert.equal(await validateNewPassword("Zebra-Quilt-42-plum"), null);
});

test("API hanging fails open after the 3s timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  handler = (_u, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const p = isPasswordPwned("Zebra-Quilt-42-plum");
  await new Promise((r) => setImmediate(r));
  mock.timers.tick(3000);
  assert.equal(await p, false);
  assert.equal(calls[0].init.signal.aborted, true);
});
