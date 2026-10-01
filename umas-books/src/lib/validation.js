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

// Absolute http(s) URL, or null. Anything else ("javascript:", "data:",
// a bare "example.com", an over-long value) is dropped rather than stored,
// since these end up in href attributes. Not truncated: a cut-off URL is
// a different (broken) URL.
function cleanHttpUrl(value, max = 300) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > max) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

// A positive int4 from a route param, or null. `Number("abc")` is NaN,
// which Postgres rejects (22P02), a 500 for what is just a bad URL.
// Values past int4 overflow the same way (22003), so they are rejected too.
function parseId(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const n = Number(value);
  return n <= 2147483647 ? n : null;
}

// A visitor-supplied name made safe to drop into an email body or subject.
// The name is free text, so on the public forms it is a way to get a link
// or markup into a message that arrives from our own address (phishing
// with our sender reputation). Strips URLs (http(s)://, www.), control
// characters (incl. CR/LF, which would also break headers) and angle
// brackets, then collapses whitespace. Only for what is emailed — what is
// stored is unchanged.
function emailSafeName(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/(?:https?:\/\/|www\.)\S*/gi, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { isEmail, clean, cleanHttpUrl, parseId, emailSafeName };
