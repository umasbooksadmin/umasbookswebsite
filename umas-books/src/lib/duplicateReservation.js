// A second press of "Reserve" for a reservation that has just been made (review 6B M6).
//
// On a slow phone the customer taps Reserve twice. The first request reserves; the second, sent with the same cart, used to
// find the copies already held (by the customer's own new reservation) and showed "something in your cart was just taken
// by someone else" with an empty cart, although the confirmation email was on its way. A seat-only cart could even be
// reserved twice. Now the second request is recognised and sent to the first one's reservation page instead.
//
// A reservation counts as "the same one" only when ALL of this holds:
//   - it is the same customer: the account (user_id), or for a guest the same email address AND the same connection
//     (orders.client_ip, kept while the hold is unconfirmed), so nobody reaches someone else's reservation page by
//     typing their address;
//   - it is still open ('reserved') and was made in the last DUPLICATE_WINDOW_SECONDS;
//   - it holds exactly the cart's copies, the same number of seats in the same sessions, and the same educational items
//     in the same quantities (one order line per unit, lib/cart.js);
//   - it was made AFTER the reserve form was shown (formShownAt, a hidden field of the form): a cart filled and reserved
//     again later, from a fresh page, is a new reservation (for example a second seat for the same session). A form
//     without the field (a page cached from before this change) relies on the time window alone.
//
// When the first press has already finished before the second one is read, the second arrives with the cart the first
// emptied: then the session itself says what was just reserved (justReservedInSession below), so nothing typed (an
// email address) can lead to somebody else's reservation.
//
// lines: cart lines or cart items ({ kind: 'book', copyId } | { kind: 'dropin', classId } | { kind: 'edu', eduItemId, qty }).
// owner: { userId } | { email, ip }. -> the order row (id, access_token) or null.

const DUPLICATE_WINDOW_SECONDS = 120;

// The form's hidden formShownAt (milliseconds, written by the server when the page was rendered) -> a number or null.
function parseFormShownAt(raw) {
  const n = Number(String(raw ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function findJustMadeReservation(db, owner, lines, { formShownAt = null } = {}) {
  const copyIds = lines.filter((l) => l.kind === "book").map((l) => Number(l.copyId)).sort((a, b) => a - b);
  const classIds = lines.filter((l) => l.kind === "dropin").map((l) => Number(l.classId)).sort((a, b) => a - b);
  const eduIds = lines.filter((l) => l.kind === "edu").flatMap((l) => Array(Math.max(1, Number(l.qty) || 1)).fill(Number(l.eduItemId))).sort((a, b) => a - b);
  if (!copyIds.length && !classIds.length && !eduIds.length) return null;
  let who;
  let params;
  if (owner && owner.userId) {
    who = "o.user_id = $1";
    params = [owner.userId];
  } else if (owner && owner.email && owner.ip) {
    who = "o.is_guest AND lower(o.buyer_email) = lower($1) AND o.client_ip = $2 AND o.guest_confirmed_at IS NULL";
    params = [owner.email, owner.ip];
  } else {
    return null;
  }
  const n = params.length;
  const { rows } = await db.query(
    `SELECT o.id, o.access_token FROM orders o
     WHERE ${who} AND o.status = 'reserved'
       AND o.created_at > now() - make_interval(secs => $${n + 3})
       AND ($${n + 4}::bigint IS NULL OR o.created_at >= to_timestamp($${n + 4}::bigint / 1000.0))
       AND (SELECT COALESCE(array_agg(c.id ORDER BY c.id), '{}') FROM book_copies c
            WHERE c.cart_order_id = o.id AND c.status = 'reserved') = $${n + 1}::int[]
       AND (SELECT COALESCE(array_agg(oi.edu_item_id ORDER BY oi.edu_item_id), '{}') FROM order_items oi
            WHERE oi.order_id = o.id AND oi.edu_item_id IS NOT NULL) = $${n + 5}::int[]
       AND (SELECT COALESCE(array_agg(s.class_id ORDER BY s.class_id), '{}') FROM class_dropin_seats s
            WHERE s.order_id = o.id AND s.status = 'reserved') = $${n + 2}::int[]
     ORDER BY o.created_at DESC LIMIT 1`,
    [...params, copyIds, classIds, DUPLICATE_WINDOW_SECONDS, formShownAt, eduIds]
  );
  return rows[0] || null;
}

// What a reservation leaves in the session (routes/cart.js), read back by a second press that arrives after it.
const rememberReservation = (session, order, now = Date.now()) => { session.lastReservation = { token: order.access_token, at: now }; };

// The access token of the reservation this session made in the last DUPLICATE_WINDOW_SECONDS, when the posted form was
// shown before it (formShownAt): the second press of a double tap whose first press has already finished. A form
// without formShownAt (a page cached from before this change) gets null: it is told its cart is empty, as before.
function justReservedInSession(session, formShownAt, now = Date.now()) {
  const last = session && session.lastReservation;
  if (!last || typeof last.token !== "string" || !Number.isFinite(last.at) || formShownAt == null) return null;
  if (now - last.at > DUPLICATE_WINDOW_SECONDS * 1000 || formShownAt > last.at) return null;
  return last.token;
}

module.exports = { findJustMadeReservation, parseFormShownAt, rememberReservation, justReservedInSession, DUPLICATE_WINDOW_SECONDS };
