// Reservations: books and drop-in seats are RESERVED online and PAID IN PERSON
// at the shop (Rue Peyrolière) or at the class session. Nothing is paid online.
//
// Two kinds of reservation share book_copies.status = 'reserved':
//
//  1. The older "held for someone" copies (an admin reserved a copy for a
//     customer or for a book request: reserved_by_name/email/phone, reserved_at,
//     no order). They expire RESERVATION_DAYS after reserved_at, with a reminder
//     3 days before (expireStaleReservations / sendPickupReminders below).
//  2. Online reservations: an ORDER with status 'reserved' (orders.reserved_until
//     is its deadline) whose copies are 'reserved' with cart_order_id pointing at
//     it, and whose drop-in seats are class_dropin_seats.status = 'reserved'.
//     The order's deadline, not the copies' reserved_at, governs them (an admin
//     can extend it once), so the copy-level sweeps skip copies that have an
//     order. Everything that changes an order's items runs in one transaction
//     with the order row locked first.
//
// expireStaleReservations is called at the top of any route that displays copy
// status (public book search/detail, admin inventory, the cart) so the shown
// status is always accurate regardless of whether the periodic backstop in
// index.js has run recently (the process can restart or be mid-deploy, so a timer alone
// isn't reliable; the public book page uses the throttled variant below). Mail is only ever sent from the periodic jobs
// (lib/orderSweeps.js), never from a page read.

const { sendEmail } = require("./outbox");
const { emailSafeName } = require("./validation");
const { emailTr } = require("./lang");
const legal = require("./legal");
const { parisPlusDaysSql } = require("./tz");
const { noReturnsShortPlain } = require("./legalText");
const { configuredBaseUrl } = require("./baseUrl");
const { cachedFor } = require("./runLimited");

// Single source: lib/legal.js.
const RESERVATION_DAYS = legal.RESERVATION_DAYS;
const RESERVATION_TTL_DAYS = RESERVATION_DAYS; // the older name, still used by callers
const REMINDER_AT_DAYS = RESERVATION_DAYS - 3;
const { RESERVATION_EXTENSION_DAYS, MAX_RESERVED_COPIES, MAX_ACTIVE_RESERVATIONS, SEAT_CANCEL_HOURS } = legal;

// A session is over at its end time, or this long after its start when it has
// none. An end that is not after the start is a typing mistake (the admin form
// refuses it, but older rows may have one): it counts as "no end time", so a bad
// row can never end a session at its start and release customers' seats early.
// `c` is the classes alias.
const SESSION_OVER_SQL = `CASE WHEN c.ends_at > c.starts_at THEN c.ends_at ELSE c.starts_at + interval '${legal.SEAT_FALLBACK_SESSION_HOURS} hours' END`;

// Loaded lazily: unit tests load this file without a database.
const lazyDb = () => require("../db");

// ---------- 1. copies held without an order (older kind) ----------

async function expireStaleReservations(pool) {
  await pool.query(
    `UPDATE book_copies
     SET status = 'in_stock', reserved_by_name = NULL, reserved_by_email = NULL,
         reserved_by_phone = NULL, reserved_at = NULL, reminder_sent_at = NULL, updated_at = now()
     WHERE status = 'reserved' AND cart_order_id IS NULL AND reserved_at < now() - interval '${RESERVATION_DAYS} days'`
  );
  // The reservations of online orders (their deadline is on the order).
  await expireOrderReservations(pool);
  await releaseEndedSeats(pool);
}

// The read-only public book page does not need a sweep per view (the jobs sweep
// every 6 h / 5 min, and the cart, checkout, till and admin paths still call
// expireStaleReservations directly, every time): at most one sweep per
// EXPIRY_THROTTLE_MS per process, with concurrent views sharing it. The
// worst case is a copy that expired in the last 30 s still showing as held.
const EXPIRY_THROTTLE_MS = 30 * 1000;
function makeThrottledExpiry(ttlMs = EXPIRY_THROTTLE_MS, clock = Date.now, sweep = expireStaleReservations) {
  const byPool = new WeakMap();
  return function throttledExpire(pool) {
    let get = byPool.get(pool);
    if (!get) {
      get = cachedFor(() => sweep(pool), ttlMs, clock);
      byPool.set(pool, get);
    }
    return get();
  };
}
const expireStaleReservationsThrottled = makeThrottledExpiry();

// Only meant to be called from the periodic backstop (not on every page
// read) — sending mail is a side effect that doesn't need to happen with
// page-load precision, and shouldn't add latency to a GET request.
async function sendPickupReminders(pool) {
  // Reservations without an email address can never be reminded (they would
  // otherwise be retried forever), so they are skipped.
  const { rows: due } = await pool.query(
    `SELECT id FROM book_copies
     WHERE status = 'reserved' AND cart_order_id IS NULL AND reminder_sent_at IS NULL AND reserved_by_email IS NOT NULL
       AND reserved_at <= now() - interval '${REMINDER_AT_DAYS} days'`
  );

  for (const { id } of due) {
    // Claim first, send second: the UPDATE only matches while nobody has
    // claimed the reminder, so two app instances overlapping during a
    // deploy cannot both send it. A failed send hands the claim back.
    const { rows } = await pool.query(
      `UPDATE book_copies c SET reminder_sent_at = now()
       FROM books b
       WHERE c.id = $1 AND b.id = c.book_id
         AND c.status = 'reserved' AND c.cart_order_id IS NULL AND c.reminder_sent_at IS NULL AND c.reserved_by_email IS NOT NULL
       RETURNING c.id, c.reserved_by_name, c.reserved_by_email, b.title`,
      [id]
    );
    const copy = rows[0];
    if (!copy) continue; // someone else claimed it, or it changed since the lookup

    try {
      // Language: the member account with this email, when there is one and
      // it has a language; otherwise English.
      const { rows: langRows } = await pool.query(
        "SELECT lang FROM users WHERE lower(email) = lower($1) AND lang IS NOT NULL LIMIT 1",
        [copy.reserved_by_email]
      );
      const tr = emailTr(langRows[0] && langRows[0].lang);
      // "Wishlist match" is a legacy reserved_by_name from the retired
      // wishlist feature — those reservations have no real person's name
      // to greet by, so fall back to a plain "Hi,".
      const legacy = copy.reserved_by_name === "Wishlist match";
      const greeting = legacy ? tr("Hi,", "Bonjour,") : tr(`Hi ${emailSafeName(copy.reserved_by_name)},`, `Bonjour ${emailSafeName(copy.reserved_by_name)},`);
      await sendEmail({
        kind: "reservation_reminder",
        lang: langRows[0] && langRows[0].lang,
        to: copy.reserved_by_email,
        subject: tr(`Reminder: your copy of "${copy.title}" is waiting for pickup`, `Rappel : votre exemplaire de « ${copy.title} » vous attend`),
        text: tr(
          `${greeting}\n\nJust a reminder that we're holding your reserved copy of "${copy.title}" at Uma's Books. Reservations are held for ${RESERVATION_DAYS / 7} weeks from when you reserved — please come by within the next 3 days to pick it up and pay in the shop, or it will go back on the shelf.\n\n${noReturnsShortPlain("en", configuredBaseUrl())}\n\nUma's Books\nRue Peyrolière, 81000 Albi`,
          `${greeting}\n\nPetit rappel : nous gardons votre exemplaire réservé de « ${copy.title} » à Uma's Books. Les réservations sont conservées ${RESERVATION_DAYS / 7} semaines à partir de la réservation. Merci de passer d’ici 3 jours pour le récupérer et le régler en boutique, faute de quoi il retournera en rayon.\n\n${noReturnsShortPlain("fr", configuredBaseUrl())}\n\nUma's Books\nRue Peyrolière, 81000 Albi`
        ),
      });
    } catch (err) {
      console.error(`Pickup reminder failed for copy ${copy.id}:`, err.message);
      try {
        await pool.query("UPDATE book_copies SET reminder_sent_at = NULL WHERE id = $1", [copy.id]);
      } catch (resetErr) {
        console.error(`Could not release reminder claim for copy ${copy.id}:`, resetErr.message);
      }
    }
  }
}

// ---------- 2. online reservations (orders with status 'reserved') ----------

// Gives one reservation's books back to the shelf and its seats back to the
// session, and closes the order as `status` ('cancelled' | 'expired') for
// `reason` ('customer' | 'admin' | 'expired' | 'no_show' | 'account_erased').
// ONE transaction, the order row locked first, so a release can never overlap
// a collection (lib/orderActions.js collectReservation takes the same lock).
// `guard(client, order)` runs under that lock and may return a result object to
// return INSTEAD of releasing (e.g. { outcome: "too_late" }); returning nothing
// lets the release go ahead.
// Resolves { outcome: 'released', copies, seats, order } | { outcome: 'not_found' }
// | { outcome: 'not_reserved', status } | whatever the guard returned.
async function releaseReservation(pool, orderId, { status = "cancelled", reason, guard } = {}) {
  const { withTransaction } = lazyDb();
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    const order = rows[0];
    if (!order) return { outcome: "not_found" };
    if (order.status !== "reserved") return { outcome: "not_reserved", status: order.status };
    if (guard) {
      const refused = await guard(client, order);
      if (refused) return refused;
    }
    const copies = await client.query(
      `UPDATE book_copies
       SET status = 'in_stock', reserved_by_name = NULL, reserved_by_email = NULL, reserved_by_phone = NULL,
           reserved_at = NULL, reminder_sent_at = NULL, cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
       WHERE cart_order_id = $1 AND status = 'reserved'`,
      [orderId]
    );
    const seats = await client.query(
      "UPDATE class_dropin_seats SET status = 'released', updated_at = now() WHERE order_id = $1 AND status = 'reserved'",
      [orderId]
    );
    await client.query(
      "UPDATE orders SET status = $2, released_at = now(), release_reason = $3, client_ip = NULL WHERE id = $1",
      [orderId, status, reason]
    );
    return { outcome: "released", copies: copies.rowCount, seats: seats.rowCount, order };
  });
}

// A drop-in seat is held until its OWN session is over (releaseEndedSeats), never by a book deadline. So a
// reservation that holds only seats has the end of its last session as its deadline. Sets that deadline on those of
// `orderIds` that are open, confirmed (an unconfirmed guest hold keeps its 2-hour limit, lib/guestOrders.js) and hold
// no book any more (a reservation with books keeps its book deadline). A guest's private manage link (valid
// MANAGE_DAYS after the deadline) is stretched with it, so it still works on the day of the session. `db` is a client
// inside the caller's transaction (or the pool). Resolves the ids whose deadline changed.
async function syncSeatOnlyDeadlines(db, orderIds) {
  if (!orderIds.length) return [];
  const { rows } = await db.query(
    `UPDATE orders o SET reserved_until = d.until
     FROM (SELECT s.order_id, MAX(${SESSION_OVER_SQL}) AS until
           FROM class_dropin_seats s JOIN classes c ON c.id = s.class_id
           WHERE s.order_id = ANY($1::int[]) AND s.status = 'reserved' GROUP BY s.order_id) d
     WHERE o.id = d.order_id AND o.status = 'reserved' AND NOT (o.is_guest AND o.guest_confirmed_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM book_copies b WHERE b.cart_order_id = o.id AND b.status = 'reserved')
       AND o.reserved_until IS DISTINCT FROM d.until
     RETURNING o.id`,
    [orderIds]
  );
  const changed = rows.map((r) => r.id);
  if (changed.length) {
    const { MANAGE_DAYS } = require("./guestOrders"); // lazily: guestOrders requires this file
    await db.query(
      `UPDATE guest_order_tokens t SET expires_at = GREATEST(t.expires_at, o.reserved_until + make_interval(days => $2))
       FROM orders o WHERE o.id = t.order_id AND t.order_id = ANY($1::int[]) AND t.purpose = 'manage'`,
      [changed, MANAGE_DAYS]
    );
  }
  return changed;
}

// Moves some still-held items of reservation `orderId` (locked by the caller) to a NEW reservation of the same
// customer (split_from_order_id = orderId), inside the caller's transaction. `rest`: order_items rows with id,
// price, book_copy_id, class_dropin_seat_id. The new reservation keeps the old deadline when it holds books, and
// the end of its last session when it holds only seats. A guest's private links follow the part that stays reserved.
// Resolves the new order's id.
async function splitOffReservation(client, orderId, rest) {
  const cents = (v) => Math.round(Number(v) * 100);
  const restTotal = rest.reduce((sum, i) => sum + cents(i.price), 0) / 100;
  const { rows: created } = await client.query(
    `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, total_amount, status, withdrawal_waiver_at, lang,
                         cgv_accepted_at, cgv_version, user_id, reserved_until, reservation_extended_at, confirmation_sent_at,
                         customer_pickup_reminder_sent_at, pickup_reminder_sent_at, split_from_order_id, is_guest, guest_confirmed_at)
     SELECT buyer_name, buyer_email, buyer_phone, $2, 'reserved', withdrawal_waiver_at, lang,
            cgv_accepted_at, cgv_version, user_id, reserved_until, reservation_extended_at, confirmation_sent_at,
            customer_pickup_reminder_sent_at, pickup_reminder_sent_at, id, is_guest, guest_confirmed_at
     FROM orders WHERE id = $1 RETURNING id`,
    [orderId, restTotal]
  );
  const newOrderId = created[0].id;
  await client.query("UPDATE guest_order_tokens SET order_id = $2 WHERE order_id = $1", [orderId, newOrderId]);
  const restCopies = rest.filter((i) => i.book_copy_id != null).map((i) => i.book_copy_id);
  const restSeats = rest.filter((i) => i.class_dropin_seat_id != null).map((i) => i.class_dropin_seat_id);
  await client.query("UPDATE order_items SET order_id = $2 WHERE id = ANY($1::int[])", [rest.map((i) => i.id), newOrderId]);
  if (restCopies.length) await client.query("UPDATE book_copies SET cart_order_id = $2, updated_at = now() WHERE id = ANY($1::int[])", [restCopies, newOrderId]);
  if (restSeats.length) await client.query("UPDATE class_dropin_seats SET order_id = $2, updated_at = now() WHERE id = ANY($1::int[])", [restSeats, newOrderId]);
  await syncSeatOnlyDeadlines(client, [newOrderId]);
  return newOrderId;
}

// Under the order lock, before an expiry: the seats whose session is still ahead are NOT released with the books.
//   - an unconfirmed guest hold: everything goes (nobody confirmed the address);
//   - books and live seats: the seats move to a reservation of their own (held until their session), the books
//     expire with this one (its "has ended" email then lists only them);
//   - only live seats (a deadline left behind by a rescheduled session): nothing is released, the deadline is reset.
// Returns { outcome: "skipped" } to stop the release, or nothing to let it go ahead.
async function keepLiveSeats(client, order) {
  if (order.is_guest && !order.guest_confirmed_at) return undefined;
  const { rows: live } = await client.query(
    `SELECT oi.id, oi.price, oi.book_copy_id, oi.class_dropin_seat_id
     FROM order_items oi JOIN class_dropin_seats s ON s.id = oi.class_dropin_seat_id JOIN classes c ON c.id = s.class_id
     WHERE oi.order_id = $1 AND s.order_id = $1 AND s.status = 'reserved' AND ${SESSION_OVER_SQL} >= now()
     ORDER BY s.id FOR UPDATE OF s`,
    [order.id]
  );
  if (!live.length) return undefined;
  const { rows: books } = await client.query("SELECT 1 FROM book_copies WHERE cart_order_id = $1 AND status = 'reserved' LIMIT 1", [order.id]);
  if (!books.length) {
    await syncSeatOnlyDeadlines(client, [order.id]);
    return { outcome: "skipped" };
  }
  await splitOffReservation(client, order.id, live);
  const moved = live.reduce((sum, i) => sum + Math.round(Number(i.price) * 100), 0) / 100;
  await client.query("UPDATE orders SET total_amount = total_amount - $2 WHERE id = $1", [order.id, moved]);
  return undefined;
}

// Every order past its deadline is released (status 'expired'), except the drop-in seats whose session is still
// ahead (keepLiveSeats). The email that tells the customer is sent by the periodic job (orderSweeps.js), once.
async function expireOrderReservations(pool) {
  const { rows } = await pool.query("SELECT id FROM orders WHERE status = 'reserved' AND reserved_until < now() ORDER BY id LIMIT 500");
  let released = 0;
  for (const { id } of rows) {
    try {
      // A guest reservation whose email link was never opened (lib/guestOrders.js, GUEST_CONFIRM_HOURS) ends the same
      // way, with the reason 'unconfirmed': no "your reservation has ended" email goes to an address nobody confirmed.
      const { rows: kind } = await pool.query("SELECT is_guest AND guest_confirmed_at IS NULL AS unconfirmed FROM orders WHERE id = $1", [id]);
      const reason = kind[0] && kind[0].unconfirmed ? "unconfirmed" : "expired";
      const r = await releaseReservation(pool, id, {
        status: "expired", reason,
        // Re-checked under the lock: an admin may have extended it meanwhile.
        guard: async (client, o) => (o.reserved_until && new Date(o.reserved_until).getTime() < Date.now() ? keepLiveSeats(client, o) : { outcome: "skipped" }),
      });
      if (r.outcome === "released") released++;
    } catch (err) {
      console.error(`Reservation expiry failed for order ${id}:`, err.message);
    }
  }
  return released;
}

// A drop-in seat nobody came for: once its session is over and the seat was not
// marked paid ('sold'), it is released. An order left with nothing reserved
// closes as 'expired'. Per order, with the order row locked first.
async function releaseEndedSeats(pool) {
  const { withTransaction } = lazyDb();
  const { rows } = await pool.query(
    `SELECT DISTINCT s.order_id FROM class_dropin_seats s JOIN classes c ON c.id = s.class_id
     WHERE s.status = 'reserved' AND s.order_id IS NOT NULL AND ${SESSION_OVER_SQL} < now()`
  );
  let released = 0;
  for (const { order_id: orderId } of rows) {
    try {
      released += await withTransaction(pool, async (client) => {
        const { rows: o } = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
        if (!o[0]) return 0;
        const r = await client.query(
          `UPDATE class_dropin_seats s SET status = 'released', updated_at = now()
           FROM classes c WHERE c.id = s.class_id AND s.order_id = $1 AND s.status = 'reserved' AND ${SESSION_OVER_SQL} < now()`,
          [orderId]
        );
        if (o[0].status === "reserved") {
          const { rows: left } = await client.query(
            `SELECT (SELECT COUNT(*) FROM book_copies WHERE cart_order_id = $1 AND status = 'reserved')
                  + (SELECT COUNT(*) FROM class_dropin_seats WHERE order_id = $1 AND status = 'reserved') AS n`,
            [orderId]
          );
          if (Number(left[0].n) === 0) {
            await client.query(
              "UPDATE orders SET status = 'expired', released_at = now(), release_reason = 'expired', client_ip = NULL WHERE id = $1",
              [orderId]
            );
          }
        }
        return r.rowCount;
      });
    } catch (err) {
      console.error(`Seat release failed for order ${orderId}:`, err.message);
    }
  }
  return released;
}

// The customer cancels their OWN reservation (owner-only: the caller passes the
// logged-in user's id). A drop-in seat can only be cancelled until
// SEAT_CANCEL_HOURS before its session starts; after that nothing changes and
// the customer is told to contact the shop (outcome 'too_late').
// Resolves { outcome: 'released' | 'not_found' | 'not_reserved' | 'too_late' }.
async function cancelReservationAsCustomer(pool, orderId, userId) {
  const { rows } = await pool.query("SELECT id FROM orders WHERE id = $1 AND user_id = $2", [orderId, userId]);
  if (!rows.length) return { outcome: "not_found" }; // not theirs and not there: the same answer
  return customerRelease(pool, orderId);
}

// The same cancellation for a GUEST, who proved it is theirs with the private manage link (lib/guestOrders.js
// resolves the link to the order id first): the same release, the same seat rule, the same reason 'customer'.
function cancelReservationAsGuest(pool, orderId) {
  return customerRelease(pool, orderId);
}

function customerRelease(pool, orderId) {
  return releaseReservation(pool, orderId, {
    status: "cancelled", reason: "customer",
    guard: async (client) => {
      const { rows: late } = await client.query(
        `SELECT 1 FROM class_dropin_seats s JOIN classes c ON c.id = s.class_id
         WHERE s.order_id = $1 AND s.status = 'reserved' AND c.starts_at < now() + make_interval(hours => $2) LIMIT 1`,
        [orderId, SEAT_CANCEL_HOURS]
      );
      return late.length ? { outcome: "too_late" } : undefined;
    },
  });
}

// An admin extends the deadline of a reservation holding books, ONCE, by
// RESERVATION_EXTENSION_DAYS. Resolves { outcome: 'extended', until } |
// 'not_found' | 'not_reserved' | 'already_extended' | 'no_books'.
async function extendReservation(pool, orderId) {
  const { withTransaction } = lazyDb();
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    const order = rows[0];
    if (!order) return { outcome: "not_found" };
    if (order.status !== "reserved") return { outcome: "not_reserved", status: order.status };
    if (order.reservation_extended_at) return { outcome: "already_extended" };
    const { rows: books } = await client.query("SELECT 1 FROM book_copies WHERE cart_order_id = $1 AND status = 'reserved' LIMIT 1", [orderId]);
    if (!books.length) return { outcome: "no_books" };
    const { rows: upd } = await client.query(
      `UPDATE orders SET reserved_until = ${parisPlusDaysSql("GREATEST(reserved_until, now())", "$2::int")},
              reservation_extended_at = now()
       WHERE id = $1 RETURNING reserved_until`,
      [orderId, RESERVATION_EXTENSION_DAYS]
    );
    return { outcome: "extended", until: upd[0].reserved_until };
  });
}

module.exports = {
  expireStaleReservations, expireStaleReservationsThrottled, makeThrottledExpiry, EXPIRY_THROTTLE_MS, sendPickupReminders, expireOrderReservations, releaseEndedSeats,
  releaseReservation, cancelReservationAsCustomer, cancelReservationAsGuest, extendReservation, syncSeatOnlyDeadlines, splitOffReservation,
  RESERVATION_DAYS, RESERVATION_TTL_DAYS, RESERVATION_EXTENSION_DAYS, MAX_RESERVED_COPIES, MAX_ACTIVE_RESERVATIONS, SEAT_CANCEL_HOURS,
  SESSION_OVER_SQL,
};
