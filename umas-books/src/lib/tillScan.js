// What the till's scan box typed: a keyboard-wedge scanner types the code then
// Enter. Recognised, in this order:
//   UB-<id>      a copy label (this shop's own barcode, see lib/code128.js)
//   ORDER-<n>    a reservation to collect (collected through lib/tillReservations.js)
//   an ISBN      10 or 13 digits, hyphens and spaces ignored
// Anything else is "unknown".
const { parseScan } = require("./inventory");

function parseTillScan(value) {
  const raw = String(value == null ? "" : value).trim();
  let m = /^UB[-_ ]?(\d{1,9})$/i.exec(raw);
  if (m) return { type: "copy", copyId: Number(m[1]) };
  m = /^ORDER[-_ ]?(\d{1,9})$/i.exec(raw);
  if (m) return { type: "order", orderId: Number(m[1]) };
  const isbn = parseScan(raw);
  if (isbn.type === "isbn") return { type: "isbn", isbn: isbn.isbn };
  return { type: "unknown" };
}

// "UB-1234" for a copy id.
const copyCode = (id) => `UB-${id}`;

module.exports = { parseTillScan, copyCode };
