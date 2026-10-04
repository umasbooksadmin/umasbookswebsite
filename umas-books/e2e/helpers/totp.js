// RFC 6238 one-time codes for the admin test account, computed with the
// app's own helpers (src/lib/totp.js: HMAC-SHA1, 30 s steps, 6 digits).
// The server refuses a code from a step it has already accepted for the
// account, so two logins in the same 30-second step would fail: freshCode()
// waits for the next step when needed.

const { hotp, currentStep } = require("../../src/lib/totp");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastStep = 0;

async function freshCode(secretB32) {
  while (currentStep() <= lastStep) await sleep(1000);
  lastStep = currentStep();
  return hotp(secretB32, lastStep);
}

module.exports = { freshCode, sleep };
