// Valid ISBNs for tests: the lookup refuses a number whose check digit is wrong (lib/bookLookup.js isValidIsbn).
// isbn13From("978014312755") -> "9780143127550"; isbn13From takes the first 12 digits (or any digits: it pads/cuts).
function isbn13From(digits12) {
  const body = String(digits12).replace(/\D/g, "").padEnd(12, "0").slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
  return body + String((10 - (sum % 10)) % 10);
}
// ISBN-10 from 9 digits (check digit 10 is written X).
function isbn10From(digits9) {
  const body = String(digits9).replace(/\D/g, "").padEnd(9, "0").slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(body[i]);
  const check = (11 - (sum % 11)) % 11;
  return body + (check === 10 ? "X" : String(check));
}
module.exports = { isbn13From, isbn10From };
