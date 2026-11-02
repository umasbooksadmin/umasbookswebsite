// Barcodes of educational items (edu_items.barcode, migration 116; owner-approved 2026-11-02). Admin only: never shown
// to customers.
//
// What is accepted (after removing spaces and hyphens): EAN-8 (8 digits), UPC-A (12), EAN-13 (13) or GTIN-14 (14), with
// a correct check digit (the GS1 rule: weights 3 and 1 from the right). An ISBN-10 (9 digits then a digit or X, a correct
// ISBN-10 check) is turned into its ISBN-13 (978...), exactly like the book intake does (lib/bookSources.js isbn10to13),
// because that is the number printed under the barcode. The stored value is digits only.
//
// Two codes are the SAME product when they are equal once padded to 14 digits with zeros on the left (a UPC-A
// 012345678905 is the EAN-13 0012345678905: some scanners send one, some the other). The unique index of migration 116
// and the find-by-barcode search compare that padded form (gtinKey).

const { isValidIsbn } = require("./bookLookup");
const { isbn10to13 } = require("./bookSources");

const LENGTHS = [8, 12, 13, 14];

// The check digit the first n-1 digits of `digits` call for (GS1 mod 10).
function gtinCheckDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const fromRight = body.length - i; // 1 for the digit just before the check digit
    sum += Number(body[i]) * (fromRight % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

// What the admin typed or scanned -> { value } (digits, or null for blank) or { error } (one sentence, nothing saved).
function parseBarcode(raw) {
  const s = String(raw ?? "").replace(/[\s-]+/g, "").toUpperCase();
  if (!s) return { value: null };
  if (s.length > 20) return { error: "A barcode has 8, 12, 13 or 14 digits (or 10 for an old ISBN). Check the number." };
  // An ISBN-10 (the old 10-character ISBN, last character may be X): saved as its ISBN-13.
  if (/^\d{9}[\dX]$/.test(s)) {
    if (!isValidIsbn(s)) return { error: `"${s}" looks like a 10-digit ISBN, but its last character is not right for the other nine. Check the number or scan the barcode instead.` };
    return { value: isbn10to13(s), fromIsbn10: s };
  }
  if (!/^\d+$/.test(s)) return { error: "A barcode is made of digits only. Check the number." };
  if (!LENGTHS.includes(s.length)) return { error: `A barcode has 8, 12, 13 or 14 digits (or 10 for an old ISBN); this one has ${s.length}. Check the number.` };
  const want = gtinCheckDigit(s.slice(0, -1));
  if (want !== Number(s[s.length - 1])) {
    return { error: `The last digit of the barcode ${s} should be ${want} for the digits before it: one digit was probably mistyped. Check it or scan it again.` };
  }
  return { value: s };
}

// The 14-digit form two codes are compared by (the same expression as the unique index of migration 116).
const gtinKey = (code) => String(code).padStart(14, "0");

// Is this (valid, stored) barcode a book number: an ISBN-13 (978 or 979)?
const isIsbnBarcode = (code) => /^97[89]\d{10}$/.test(String(code || ""));

module.exports = { parseBarcode, gtinCheckDigit, gtinKey, isIsbnBarcode, LENGTHS };
