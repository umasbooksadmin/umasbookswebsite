// EXTENSION POINT: collecting an online reservation at the till.
//
// Not built yet: it needs the "Reserve online, pay at the shop" feature (orders
// with status 'reserved' and an admin "Mark collected and paid" action), which
// had not been merged when the till was written. When it is:
//   1. In lib/till.js `lookupScan`, for `{type: "order"}` call loadReservation(),
//      return its lines (copies already reserved for THAT order) to the till.
//   2. In `completeSale`, allow a copy whose status is 'reserved' when its
//      reservation belongs to the order being collected, and pay the order by
//      calling that feature's collection function (do not duplicate it), with
//      the till's payment method.
// Until then scanning ORDER-<n> shows the message below.
async function loadReservation() {
  return { error: "Collecting a reservation at the till is not available yet. Use the order page in Books & Orders." };
}

module.exports = { loadReservation };
