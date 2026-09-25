// A class's capacity is shared by two different kinds of attendee that
// were never in the same pool before: legacy free sign-ups
// (class_signups — no new writer since /sessions became a paid drop-in
// calendar, but old rows still occupy a seat) and paid drop-in seats
// (class_dropin_seats, in_cart or sold — see migrations/015_dropin_seats.sql).
// Every place that shows or enforces "spots left" must count both, or
// the room can be oversold.
function seatsTakenExpr(alias) {
  return `(
    (SELECT COUNT(*) FROM class_signups s WHERE s.class_id = ${alias}.id) +
    (SELECT COUNT(*) FROM class_dropin_seats d WHERE d.class_id = ${alias}.id AND d.status IN ('in_cart', 'sold'))
  )`;
}

function spotsLeft(cls) {
  if (cls.capacity == null) return null;
  return Math.max(0, cls.capacity - Number(cls.seats_taken || 0));
}

module.exports = { seatsTakenExpr, spotsLeft };
