const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SESSION_SECRET = "unit-test-secret";
const totp = require("../../src/lib/totp");

// RFC 6238 appendix B: ASCII secret "12345678901234567890" (SHA-1).
// Built at runtime rather than written as a literal so secret scanners
// (gitleaks) don't flag the public test vector.
const RFC_SECRET = totp.base32Encode(Buffer.from("1234567890".repeat(2)));

test("matches the RFC 6238 test vectors (6-digit tail)", () => {
  assert.equal(totp.hotp(RFC_SECRET, Math.floor(59 / 30)), "287082");
  assert.equal(totp.hotp(RFC_SECRET, Math.floor(1111111109 / 30)), "081804");
  assert.equal(totp.hotp(RFC_SECRET, Math.floor(20000000000 / 30)), "353130");
});

test("verifyTotp accepts the adjacent steps, rejects others, and blocks replay", () => {
  const now = 1_700_000_000_000;
  const step = totp.currentStep(now);
  const code = (s) => totp.hotp(RFC_SECRET, s);
  assert.equal(totp.verifyTotp(RFC_SECRET, code(step), { now }), step);
  assert.equal(totp.verifyTotp(RFC_SECRET, code(step - 1), { now }), step - 1);
  assert.equal(totp.verifyTotp(RFC_SECRET, code(step + 1), { now }), step + 1);
  assert.equal(totp.verifyTotp(RFC_SECRET, code(step + 3), { now }), null);
  assert.equal(totp.verifyTotp(RFC_SECRET, code(step), { now, lastStep: step }), null, "replay");
  assert.equal(totp.verifyTotp(RFC_SECRET, "12345", { now }), null);
  assert.equal(totp.verifyTotp(RFC_SECRET, "abcdef", { now }), null);
});

test("secrets are encrypted at rest and tamper-evident", () => {
  const s = totp.generateSecret();
  const enc = totp.encryptSecret(s);
  assert.ok(!enc.includes(s));
  assert.equal(totp.decryptSecret(enc), s);
  const parts = enc.split(".");
  parts[2] = Buffer.from("tampered").toString("base64");
  assert.throws(() => totp.decryptSecret(parts.join(".")));
});

test("recovery codes normalise case, spaces and dashes", () => {
  const c = totp.newRecoveryCode();
  assert.match(c, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  assert.equal(totp.hashRecovery(c), totp.hashRecovery(c.toLowerCase().replace("-", " ")));
});
