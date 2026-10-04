const crypto = require("crypto");
const { translator } = require("./lang");

const MIN_LENGTH = 8;
const HIBP_TIMEOUT_MS = 3000;

const COMPLEXITY_RULES = [
  { test: (pw) => /[a-z]/.test(pw), label: "a lowercase letter", fr: "une lettre minuscule" },
  { test: (pw) => /[A-Z]/.test(pw), label: "an uppercase letter", fr: "une lettre majuscule" },
  { test: (pw) => /[0-9]/.test(pw), label: "a number", fr: "un chiffre" },
  { test: (pw) => /[^A-Za-z0-9]/.test(pw), label: "a symbol", fr: "un symbole" },
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

    // The abort signal must cover reading the BODY too: fetch() resolves
    // once headers arrive, so a server that then stalls mid-body would
    // otherwise hang this (and the signup/reset request awaiting it).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);
    let text;
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true" },
        signal: controller.signal,
      });
      if (!res.ok) return false;
      text = await res.text();
    } finally {
      clearTimeout(timeout);
    }

    return text.split("\n").some((line) => line.split(":")[0].trim().toUpperCase() === suffix);
  } catch (err) {
    console.warn("Pwned-password check skipped (treating as OK):", err.message);
    return false;
  }
}

// Returns an error message string if the password should be rejected,
// or null if it's acceptable. `tr` is the request's translator (req.tr);
// without one the message is English.
async function validateNewPassword(password, tr = translator("en")) {
  if (!password || password.length < MIN_LENGTH) {
    return tr("Password must be at least {n} characters.", "Le mot de passe doit contenir au moins {n} caractères.", { n: MIN_LENGTH });
  }
  const failed = COMPLEXITY_RULES.filter((rule) => !rule.test(password));
  if (failed.length > 0) {
    return tr("Password must include {list}.", "Le mot de passe doit contenir {list}.", {
      list: failed.map((rule) => tr(rule.label, rule.fr)).join(", "),
    });
  }
  if (await isPasswordPwned(password)) {
    return tr(
      "That password has appeared in a known data breach. Please choose a different one.",
      "Ce mot de passe figure dans une fuite de données connue. Veuillez en choisir un autre."
    );
  }
  return null;
}

module.exports = { validateNewPassword, isPasswordPwned, MIN_LENGTH };
