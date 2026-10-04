// Removes the personal data most likely to end up in log lines and alert
// emails by accident: email addresses and long digit runs (phone numbers,
// card/IBAN fragments, national ids). Deliberately blunt; it is applied to
// free text only, never to anything the app itself uses.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// 9 or more digits, allowing single spaces, dots or dashes between them
// ("06 12 34 56 78", "+33 6.12.34.56.78").
const DIGITS_RE = /\+?\d(?:[ .-]?\d){8,}/g;

function scrubPersonalData(text) {
  return String(text).replace(EMAIL_RE, "[email]").replace(DIGITS_RE, "[number]");
}

module.exports = { scrubPersonalData };
