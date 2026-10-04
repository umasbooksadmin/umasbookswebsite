// ISBN-10 or ISBN-13 (hyphens and spaces ignored) -> ISBN-13 digits, or null
// when it is not one. The check digit is not verified, matching how ISBNs are
// stored elsewhere in the app.
function toIsbn13(value) {
  const s = String(value == null ? "" : value).replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) return s;
  if (/^\d{9}[\dX]$/.test(s)) {
    const body = "978" + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
    return body + String((10 - (sum % 10)) % 10);
  }
  return null;
}

module.exports = { toIsbn13 };
