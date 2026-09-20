const crypto = require("crypto");

const MIN_LENGTH = 8;

const COMPLEXITY_RULES = [
  { test: (pw) => /[a-z]/.test(pw), label: "a lowercase letter" },
  { test: (pw) => /[A-Z]/.test(pw), label: "an uppercase letter" },
  { test: (pw) => /[0-9]/.test(pw), label: "a number" },
  { test: (pw) => /[^A-Za-z0-9]/.test(pw), label: "a symbol" },
];

// Checks the password against the HaveIBeenPwned k-anonymity range API:
// only the first 5 chars of the SHA-1 hash are ever sent, never the
// password itself. Fails open (treats as "not pwned") on any network
// error or timeout so a third-party outage never blocks signup/login.
async function isPasswordPwned(password) {
  try {
    const sha1 = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let res;
    try {
      res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) return false;
    const text = await res.text();
    return text.split("\n").some((line) => line.split(":")[0].trim().toUpperCase() === suffix);
  } catch (err) {
    console.warn("Pwned-password check skipped (treating as OK):", err.message);
    return false;
  }
}

// Returns an error message string if the password should be rejected,
// or null if it's acceptable.
async function validateNewPassword(password) {
  if (!password || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters.`;
  }
  const missing = COMPLEXITY_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.label);
  if (missing.length > 0) {
    return `Password must include ${missing.join(", ")}.`;
  }
  if (await isPasswordPwned(password)) {
    return "That password has appeared in a known data breach. Please choose a different one.";
  }
  return null;
}

module.exports = { validateNewPassword, isPasswordPwned, MIN_LENGTH };
