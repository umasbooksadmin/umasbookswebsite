// The cart and the RESERVATION step. Nothing is paid online for books and
// drop-in seats: the customer RESERVES, and pays in person at the shop (or at
// the class session). See lib/reservations.js for the life of a reservation
// (deadline, expiry, cancellation) and lib/orderActions.js for what the staff do
// ("Mark collected and paid"). Membership is the only thing paid online
// (HelloAsso, lib/membership.js): nothing in this file talks to HelloAsso.
//
// Browsing/"add to cart" is just a list of lines in the session — no inventory
// lock — so an abandoned cart never ties up a copy someone else could reserve.
// A copy is only held (status = 'reserved') once the customer presses
// "Reserve these books" (createReservation below).

const { enqueueEmail, deliverNow } = require("./outbox");
const { withTransaction } = require("../db");
const { alertOnError } = require("./errorAlert");
const { loadOrderItems, dropinLabel } = require("./orderItems");
const { buildOrderConfirmationText, orderConfirmationSubject } = require("./orderEmail");
const { configuredBaseUrl } = require("./baseUrl");
const { seatsTakenExpr } = require("./classCapacity");
const { SITE_TIME_ZONE } = require("./tz");
const { RESERVATION_DAYS, MAX_RESERVED_COPIES, MAX_ACTIVE_RESERVATIONS, SESSION_OVER_SQL } = require("./reservations");

// ---------- the reservation ----------

// Turns the cart's lines into a reservation, atomically: the order, its items,
// the held copies and the held seats exist together or not at all.
//   user:   { id, email } the confirmed account (the order is always under it)
//   items:  cart lines as loaded by routes/cart.js (kind 'book' | 'dropin', price > 0)
// Resolves the new order row. Rejects with an Error whose message is one of
//   SOLD_OUT                 something in the cart was taken in the meantime
//   TOO_MANY_RESERVATIONS    the account already has MAX_ACTIVE_RESERVATIONS open
//   TOO_MANY_COPIES          the account would hold more than MAX_RESERVED_COPIES books
//   PRICE_CHANGED            a price differs from what the customer saw (err.changes lists them)
//   BUSY                     deadlock twice in a row
// (Anything else is an unexpected failure.)
async function createReservation(pool, { user, name, phone = null, items, lang = null, hasDropin = false, acceptedVersion }) {
  const bookItems = items.filter((i) => i.kind === "book");
  const dropinItems = items.filter((i) => i.kind === "dropin");
  const cents = items.reduce((sum, i) => sum + Math.round(Number(i.price) * 100), 0);
  const total = cents / 100;
  const email = String(user.email).toLowerCase();

  const attempt = (client) => reserveInTransaction(client, { user, email, name, phone, bookItems, dropinItems, total, lang, hasDropin, acceptedVersion });
  let order;
  try {
    order = await withTransaction(pool, attempt);
  } catch (err) {
    if (err.code !== "40P01") throw err;
    // Postgres chose this one as the deadlock loser: everything rolled back, retry once.
    console.warn("Reservation deadlock detected, retrying once");
    try {
      order = await withTransaction(pool, attempt);
    } catch (retryErr) {
      if (retryErr.code === "40P01") throw new Error("BUSY", { cause: retryErr });
      throw retryErr;
    }
  }
  // The confirmation was stored in the same transaction (outbox); send it now.
  if (order.confirmationId) await deliverNow(pool, order.confirmationId);
  return order;
}

function priceChangedError(changes) {
  const err = new Error("PRICE_CHANGED");
  err.changes = changes;
  return err;
}

async function reserveInTransaction(client, { user, email, name, phone, bookItems, dropinItems, total, lang, hasDropin, acceptedVersion }) {
  // One reservation at a time per account, so the limits below cannot be raced past.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`reserve-user:${user.id}`]);

  const { rows: usage } = await client.query(
    `SELECT (SELECT COUNT(*) FROM orders WHERE user_id = $1 AND status = 'reserved')::int AS reservations,
            (SELECT COUNT(*) FROM book_copies c JOIN orders o ON o.id = c.cart_order_id
             WHERE o.user_id = $1 AND o.status = 'reserved' AND c.status = 'reserved')::int AS copies`,
    [user.id]
  );
  if (usage[0].reservations >= MAX_ACTIVE_RESERVATIONS) throw new Error("TOO_MANY_RESERVATIONS");
  if (usage[0].copies + bookItems.length > MAX_RESERVED_COPIES) throw new Error("TOO_MANY_COPIES");

  // The deadline: the end of the RESERVATION_DAYS-th day (Paris time) for books.
  // An order with only seats is set below, once its seats exist.
  const { rows: orderRows } = await client.query(
    `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, total_amount, status, withdrawal_waiver_at, lang,
                         cgv_accepted_at, cgv_version, user_id, reserved_until)
     VALUES ($1, $2, $3, $4, 'reserved', CASE WHEN $5::boolean THEN now() END, $6, now(), $7, $8,
             CASE WHEN $10::boolean THEN (((now() AT TIME ZONE '${SITE_TIME_ZONE}')::date + $9::int + 1)::timestamp AT TIME ZONE '${SITE_TIME_ZONE}') END)
     RETURNING *`,
    [name, email, phone, total, hasDropin, lang, acceptedVersion, user.id, RESERVATION_DAYS, bookItems.length > 0]
  );
  const order = orderRows[0];

  if (bookItems.length) {
    // Take the row locks in id order. Two carts sharing copies would
    // otherwise each lock them in their own order and deadlock.
    const copyIds = bookItems.map((i) => i.copyId).sort((a, b) => a - b);
    const { rows: locked } = await client.query(
      "SELECT id, price, status FROM book_copies WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
      [copyIds]
    );
    // The price is checked UNDER THE LOCK: a reprice (or an edit) between the moment the
    // customer saw the cart and now would otherwise leave order_items.price different from
    // book_copies.price. The customer is never charged a different price silently: the
    // reservation is refused (PRICE_CHANGED, rolled back) and they confirm again at the new one.
    const priceChanges = [];
    for (const row of locked) {
      if (row.status !== "in_stock" || row.price == null || Number(row.price) <= 0) continue; // taken or not for sale: the UPDATE below says SOLD_OUT
      const item = bookItems.find((i) => i.copyId === row.id);
      if (item && Math.round(Number(row.price) * 100) !== Math.round(Number(item.price) * 100)) {
        priceChanges.push({ kind: "book", id: row.id, title: item.title, oldPrice: Number(item.price), newPrice: Number(row.price) });
      }
    }
    if (priceChanges.length) throw priceChangedError(priceChanges);
    const { rows: held } = await client.query(
      `UPDATE book_copies
       SET status = 'reserved', reserved_by_name = $3, reserved_by_email = $4, reserved_by_phone = $5, reserved_at = now(),
           reminder_sent_at = NULL, cart_order_id = $1, cart_added_at = NULL, updated_at = now()
       WHERE id = ANY($2::int[]) AND status = 'in_stock' AND price IS NOT NULL AND price > 0 RETURNING id`,
      [order.id, copyIds, name, email, phone]
    );
    if (held.length !== bookItems.length) {
      // Someone else bought or reserved a copy between our read and this
      // write: bail out cleanly rather than hold fewer books than were shown.
      throw new Error("SOLD_OUT");
    }
    for (const i of bookItems) {
      await client.query(
        "INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, $3, $4)",
        [order.id, i.copyId, i.title, i.price]
      );
    }
  }

  if (dropinItems.length) {
    const wanted = new Map(); // classId -> requested seat count
    for (const i of dropinItems) wanted.set(i.classId, (wanted.get(i.classId) || 0) + 1);

    // Class rows are locked in id order too (see the copies above).
    for (const [classId, count] of [...wanted].sort((a, b) => a[0] - b[0])) {
      // Lock the class row so two simultaneous reservations for the same
      // session can't both read the same "spots left" and oversell it.
      // The lock and the count are TWO statements: a count computed in the
      // same statement as FOR UPDATE would use a snapshot taken BEFORE the
      // wait for the lock, and miss the seat the other reservation just
      // committed (READ COMMITTED re-checks the locked row, not subselects).
      await client.query("SELECT id FROM classes WHERE id = $1 FOR UPDATE", [classId]);
      const { rows: clsRows } = await client.query(
        `SELECT capacity, dropin_price, ${seatsTakenExpr("classes")}::int AS seats_taken
         FROM classes WHERE id = $1`,
        [classId]
      );
      const cls = clsRows[0];
      const spotsLeft = cls && cls.dropin_price != null && Number(cls.dropin_price) > 0
        ? (cls.capacity != null ? cls.capacity - cls.seats_taken : Infinity)
        : 0;
      if (!cls || spotsLeft < count) throw new Error("SOLD_OUT");

      const item = dropinItems.find((i) => i.classId === classId);
      if (Math.round(Number(cls.dropin_price) * 100) !== Math.round(Number(item.price) * 100)) {
        throw priceChangedError([{ kind: "dropin", id: classId, title: item.title, oldPrice: Number(item.price), newPrice: Number(cls.dropin_price) }]);
      }
      for (let n = 0; n < count; n++) {
        const { rows: seatRows } = await client.query(
          `INSERT INTO class_dropin_seats (class_id, status, order_id) VALUES ($1, 'reserved', $2) RETURNING id`,
          [classId, order.id]
        );
        await client.query(
          "INSERT INTO order_items (order_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, $3, $4)",
          [order.id, seatRows[0].id, dropinLabel(item.title, item.startsAt, "en"), item.price]
        );
      }
    }
    if (!bookItems.length) {
      // Only seats: held until the last of the sessions is over.
      await client.query(
        `UPDATE orders SET reserved_until = (
           SELECT MAX(${SESSION_OVER_SQL}) FROM class_dropin_seats s JOIN classes c ON c.id = s.class_id WHERE s.order_id = $1
         ) WHERE id = $1`,
        [order.id]
      );
    }
  }

  // The confirmation is stored in the same transaction: a reservation never
  // exists without its confirmation being queued (the savepoint inside
  // queueOrderConfirmation keeps a failure to BUILD the text from undoing the
  // reservation).
  const { rows: fresh } = await client.query("SELECT * FROM orders WHERE id = $1", [order.id]);
  const confirmationId = await queueOrderConfirmation(client, fresh[0]);
  return { ...fresh[0], confirmationId };
}

// ---------- confirmation e-mail (through the outbox) ----------

// Queues (never sends) the reservation confirmation. Returns the outbox id, or
// null when it could not be built or stored: the savepoint keeps the surrounding
// transaction alive in that case.
async function queueOrderConfirmation(db, order, { kind = "order_confirmation" } = {}) {
  const isClient = typeof db.release === "function";
  if (isClient) await db.query("SAVEPOINT order_confirmation");
  try {
    const items = await loadOrderItems(db, order.id);
    const base = configuredBaseUrl() || undefined;
    // Subject and body follow order.lang ('en' | 'fr' | null; null is English).
    const id = await enqueueEmail(db, {
      kind,
      lang: order.lang,
      relatedOrderId: order.id,
      to: order.buyer_email,
      subject: orderConfirmationSubject(order.lang),
      text: buildOrderConfirmationText(order, items, base),
    });
    if (isClient) await db.query("RELEASE SAVEPOINT order_confirmation");
    return id;
  } catch (err) {
    console.error(`Reservation confirmation could not be queued for order ${order.id}:`, err.message);
    if (isClient) await db.query("ROLLBACK TO SAVEPOINT order_confirmation");
    return null;
  }
}

// Admin "Resend confirmation": queue a fresh copy for a reserved order and try to
// send it now. Resolves { ok, sent } or { ok: false, reason }.
async function resendOrderConfirmation(pool, orderId) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status !== "reserved") return { ok: false, reason: "not_reserved" };
  if (/@erased\.invalid$/i.test(order.buyer_email)) return { ok: false, reason: "erased" };
  const id = await queueOrderConfirmation(pool, order, { kind: "order_confirmation" });
  if (!id) return { ok: false, reason: "queue_failed" };
  const result = await deliverNow(pool, id);
  return { ok: true, sent: result.sent, id };
}

// ---------- leftovers of the old online checkout ----------

// Before reservations, checkout put books in 'in_cart' and an order in 'pending'
// for up to an hour while the buyer paid at HelloAsso. Nothing creates those any
// more; this only cleans up any that were still open when the change went live,
// so no book stays stuck 'in_cart'. No HelloAsso lookup is made.
const CART_HOLD_TTL_MINUTES = 60;

async function expireStaleCartHolds(pool) {
  const { rows: stale } = await pool.query(
    `SELECT DISTINCT order_id FROM (
       SELECT cart_order_id AS order_id FROM book_copies
       WHERE status = 'in_cart' AND cart_added_at < now() - interval '${CART_HOLD_TTL_MINUTES} minutes'
       UNION ALL
       SELECT order_id FROM class_dropin_seats
       WHERE status = 'in_cart' AND order_id IS NOT NULL
         AND cart_added_at < now() - interval '${CART_HOLD_TTL_MINUTES} minutes'
     ) s`
  );
  // One order that always fails to release (bad data, a constraint) must
  // not stop every other stale hold from expiring on every run: isolate
  // each order, keep going, and alert once at the end.
  const failed = [];
  for (const { order_id } of stale) {
    try {
      // Via module.exports so tests can substitute the release step.
      await module.exports.releaseCartHold(pool, order_id, "expired");
    } catch (err) {
      failed.push(order_id);
      console.error(`Cart hold expiry failed for order ${order_id}:`, err.message);
    }
  }
  if (failed.length > 0) {
    await alertOnError(
      "Cart hold expiry failing for some reservations",
      `Could not release the expired cart hold for reservation(s): ${failed.join(", ")}. Other holds were released normally; these will be retried on the next sweep.`
    );
  }
}

// Puts a leftover old-style cart hold's copies back on the shelf and closes its
// pending order. An order that is somehow already 'paid' is left alone.
async function releaseCartHold(pool, orderId, status) {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (rows[0] && rows[0].status === "paid") {
      await client.query(
        `UPDATE book_copies SET status = 'sold', cart_order_id = NULL, cart_added_at = NULL, updated_at = now() WHERE cart_order_id = $1`,
        [orderId]
      );
      await client.query(`UPDATE class_dropin_seats SET status = 'sold', updated_at = now() WHERE order_id = $1 AND status = 'in_cart'`, [orderId]);
      return;
    }
    await client.query(
      `UPDATE book_copies SET status = 'in_stock', cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
       WHERE cart_order_id = $1 AND status = 'in_cart'`,
      [orderId]
    );
    await client.query(
      `UPDATE class_dropin_seats SET status = 'released', updated_at = now() WHERE order_id = $1 AND status = 'in_cart'`,
      [orderId]
    );
    await client.query(`UPDATE orders SET status = $1, client_ip = NULL WHERE id = $2 AND status = 'pending'`, [status, orderId]);
  });
}

// The 10-minute job: only the leftover cleanup above is left of the old cart job.
async function runCartMaintenance(pool) {
  try {
    await module.exports.expireStaleCartHolds(pool);
  } catch (err) {
    console.error("Cart hold expiry failed:", err);
  }
}

module.exports = {
  createReservation, queueOrderConfirmation, resendOrderConfirmation,
  runCartMaintenance, expireStaleCartHolds, releaseCartHold, CART_HOLD_TTL_MINUTES,
};
