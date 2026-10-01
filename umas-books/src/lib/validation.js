// Shared input checks for the public (no-login) forms — reserve, checkout,
// event signup, contact. Each of those used to hand-roll `(x || "").trim()`
// with no length cap and, for most, no email check at all.

// Exactly one address: nodemailer treats "a@x.com, b@y.com" in `to` as two
// recipients, which would turn any form that emails the submitter into a
// mail relay, so list separators and angle brackets are rejected outright.
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function isEmail(value) {
  return typeof value === "string" && value.length <= 200 && EMAIL_RE.test(value);
}

// Trimmed string, capped at `max` characters ("" for anything non-string —
// e.g. an array from a repeated form field).
function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

module.exports = { isEmail, clean };
