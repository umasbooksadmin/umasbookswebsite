const express = require("express");
const { pool, withTransaction } = require("../db");
const helloasso = require("../lib/helloasso");
const { releaseCartHold, reconcileOrder } = require("../lib/cart");
const { expireStaleReservations } = require("../lib/reservations");
const { seatsTakenExpr } = require("../lib/classCapacity");
const { baseUrl } = require("../lib/baseUrl");
const { isEmail, clean } = require("../lib/validation");
const { checkoutLimiter, cartEditLimiter } = require("../middleware/rateLimits");

const router = express.Router();

// A same-origin, path-only redirect target: "/foo" is fine, but "//evil"
// or "/\evil" is a protocol-relative URL — browsers treat a Location
// starting with // as "same scheme, different host" and follow it
// off-site, so startsWith("/") alone isn't enough to keep backTo local.
function isSafeLocalPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

// Public — no login required (matches /books and /sessions). The cart
// itself is just a list of lines in the session; nothing is locked in
// the database until checkout actually starts (see src/lib/cart.js for
// why). A line is either a book copy ({ kind: "book", copyId }) or a
// drop-in session seat ({ kind: "dropin", classId }) — see
// migrations/015_dropin_seats.sql. Each line gets a lineId (from
// cartSeq) so multiple seats for the same session can be added and
// removed independently, unlike book copies which are unique already.

function getCart(req) {
  if (!Array.isArray(req.session.cart)) req.session.cart = [];
  // Normalize any pre-existing session cookie from before cart lines
  // carried a kind/lineId (a plain array of copy ids).
  req.session.cart = req.session.cart.map((line) => {
    if (typeof line === "number") return { kind: "book", lineId: nextLineId(req), copyId: line };
    return line;
  });
  return req.session.cart;
}

function nextLineId(req) {
  req.session.cartSeq = (req.session.cartSeq || 0) + 1;
  return req.session.cartSeq;
}

async function loadCartItems(cart) {
  const bookLines = cart.filter((l) => l.kind === "book");
  const dropinLines = cart.filter((l) => l.kind === "dropin");
  const items = [];

  if (bookLines.length) {
    const { rows } = await pool.query(
      `SELECT c.id, c.price, c.condition, b.title, b.authors, b.cover_url
       FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE c.id = ANY($1::int[]) AND c.status = 'in_stock'
       ORDER BY c.id ASC`,
      [bookLines.map((l) => l.copyId)]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const line of bookLines) {
      const r = byId.get(line.copyId);
      if (!r) continue; // no longer in stock — dropped, same as before
      items.push({
        kind: "book", lineId: line.lineId, copyId: r.id,
        title: r.title, authors: r.authors, coverUrl: r.cover_url, price: Number(r.price),
      });
    }
  }

  if (dropinLines.length) {
    const classIds = [...new Set(dropinLines.map((l) => l.classId))];
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.starts_at, c.capacity, c.dropin_price, ${seatsTakenExpr("c")}::int AS seats_taken
       FROM classes c WHERE c.id = ANY($1::int[])`,
      [classIds]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Multiple lines can share a class (multiple seats) — only keep as
    // many as the class can actually still fit, counting each already-
    // accepted line from this same cart against its capacity.
    const acceptedPerClass = new Map();
    for (const line of dropinLines) {
      const cls = byId.get(line.classId);
      if (!cls || cls.dropin_price == null) continue; // no longer sold as drop-in — dropped
      const alreadyAccepted = acceptedPerClass.get(cls.id) || 0;
      const spotsLeft = cls.capacity != null ? Math.max(0, cls.capacity - cls.seats_taken) : Infinity;
      if (alreadyAccepted >= spotsLeft) continue; // this class filled up — dropped
      acceptedPerClass.set(cls.id, alreadyAccepted + 1);
      items.push({
        kind: "dropin", lineId: line.lineId, classId: cls.id,
        title: cls.title, startsAt: cls.starts_at, price: Number(cls.dropin_price),
      });
    }
  }

  return items;
}

// Same-origin JSON for the site header's "Cart (n)" (assets/site.js).
router.get("/api/cart/count", (req, res) => {
  res.set("Cache-Control", "no-store");
  // Read without getCart() so a visitor with no cart doesn't get a session created.
  res.json({ count: Array.isArray(req.session.cart) ? req.session.cart.length : 0 });
});

router.get("/cart", async (req, res) => {
  await expireStaleReservations(pool);
  const cart = getCart(req);
  const items = await loadCartItems(cart);
  // Drop anything that's no longer actually available (someone else
  // bought it, or a drop-in session filled up, while it sat in this
  // cart) so the total shown always matches what checkout would charge.
  req.session.cart = items.map((i) => ({
    kind: i.kind, lineId: i.lineId,
    ...(i.kind === "book" ? { copyId: i.copyId } : { classId: i.classId }),
  }));
  const total = items.reduce((sum, i) => sum + i.price, 0);
  res.render("cart", { items, total, error: null, helloassoReady: helloasso.isConfigured() });
});

// Upper bound on lines per cart — checkout locks every copy in the cart
// for an hour, so an unbounded cart is an inventory-lock lever.
const MAX_CART_LINES = 20;

router.post("/cart/add", cartEditLimiter, async (req, res) => {
  const copyId = Number(req.body.copyId);
  const backTo = isSafeLocalPath(req.body.backTo) ? req.body.backTo : "/cart";
  if (copyId) {
    const { rows } = await pool.query("SELECT id FROM book_copies WHERE id = $1 AND status = 'in_stock'", [copyId]);
    if (rows.length) {
      const cart = getCart(req);
      if (cart.length < MAX_CART_LINES && !cart.some((l) => l.kind === "book" && l.copyId === copyId)) {
        cart.push({ kind: "book", lineId: nextLineId(req), copyId });
      }
    }
  }
  res.redirect(backTo);
});

router.post("/cart/add-dropin", cartEditLimiter, async (req, res) => {
  const classId = Number(req.body.classId);
  const backTo = isSafeLocalPath(req.body.backTo) ? req.body.backTo : "/sessions";
  if (classId) {
    const { rows } = await pool.query(
      `SELECT capacity, dropin_price, ${seatsTakenExpr("classes")}::int AS seats_taken
       FROM classes WHERE id = $1`,
      [classId]
    );
    const cls = rows[0];
    if (cls && cls.dropin_price != null) {
      const cart = getCart(req);
      const alreadyInCart = cart.filter((l) => l.kind === "dropin" && l.classId === classId).length;
      const spotsLeft = cls.capacity != null ? cls.capacity - cls.seats_taken - alreadyInCart : Infinity;
      // A soft, early check for a friendly redirect — checkout below is
      // the real, race-condition-safe enforcement.
      if (spotsLeft > 0 && cart.length < MAX_CART_LINES) cart.push({ kind: "dropin", lineId: nextLineId(req), classId });
    }
  }
  res.redirect(backTo);
});

router.post("/cart/remove", (req, res) => {
  const lineId = Number(req.body.lineId);
  const cart = getCart(req);
  req.session.cart = cart.filter((l) => l.lineId !== lineId);
  res.redirect("/cart");
});

router.post("/cart/checkout", checkoutLimiter, async (req, res) => {
  const cart = getCart(req);
  const name = clean(req.body.name, 100);
  const email = clean(req.body.email, 200).toLowerCase();
  const phone = clean(req.body.phone, 30) || null;

  const items = await loadCartItems(cart);
  req.session.cart = items.map((i) => ({
    kind: i.kind, lineId: i.lineId,
    ...(i.kind === "book" ? { copyId: i.copyId } : { classId: i.classId }),
  }));

  const renderCart = (extra) =>
    res.render("cart", { items, total: items.reduce((sum, i) => sum + i.price, 0), helloassoReady: helloasso.isConfigured(), error: null, ...extra });

  if (!items.length) return renderCart({ items: [], total: 0, error: "Your cart is empty." });
  if (!name || !isEmail(email)) return renderCart({ error: "Please enter your name and a valid email address." });
  if (!helloasso.isConfigured()) {
    return renderCart({ helloassoReady: false, error: "Online payment isn't set up yet — please check back soon, or come by the shop in person." });
  }

  const bookItems = items.filter((i) => i.kind === "book");
  const dropinItems = items.filter((i) => i.kind === "dropin");
  const total = items.reduce((sum, i) => sum + i.price, 0);

  let order;
  try {
    order = await withTransaction(pool, async (client) => {
      const { rows: orderRows } = await client.query(
        `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, total_amount) VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, email, phone, total]
      );
      const newOrder = orderRows[0];

      if (bookItems.length) {
        const { rows: locked } = await client.query(
          `UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now(), updated_at = now()
           WHERE id = ANY($2::int[]) AND status = 'in_stock' RETURNING id`,
          [newOrder.id, bookItems.map((i) => i.copyId)]
        );
        if (locked.length !== bookItems.length) {
          // Someone else bought/reserved a copy in the moment between our
          // read above and this write — bail out cleanly rather than
          // charge for fewer books than were actually locked.
          throw new Error("SOLD_OUT");
        }
        for (const i of bookItems) {
          await client.query(
            "INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, $3, $4)",
            [newOrder.id, i.copyId, i.title, i.price]
          );
        }
      }

      if (dropinItems.length) {
        const wanted = new Map(); // classId -> requested seat count
        for (const i of dropinItems) wanted.set(i.classId, (wanted.get(i.classId) || 0) + 1);

        for (const [classId, count] of wanted) {
          // Lock the class row so two simultaneous checkouts for the same
          // session can't both read the same "spots left" and oversell it.
          const { rows: clsRows } = await client.query(
            `SELECT capacity, dropin_price, ${seatsTakenExpr("classes")}::int AS seats_taken
             FROM classes WHERE id = $1 FOR UPDATE`,
            [classId]
          );
          const cls = clsRows[0];
          const spotsLeft = cls && cls.dropin_price != null
            ? (cls.capacity != null ? cls.capacity - cls.seats_taken : Infinity)
            : 0;
          if (!cls || spotsLeft < count) throw new Error("SOLD_OUT");

          for (let n = 0; n < count; n++) {
            const { rows: seatRows } = await client.query(
              `INSERT INTO class_dropin_seats (class_id, status, order_id, cart_added_at) VALUES ($1, 'in_cart', $2, now()) RETURNING id`,
              [classId, newOrder.id]
            );
            const item = dropinItems.find((i) => i.classId === classId);
            const label = `${item.title} — ${item.startsAt.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${item.startsAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
            await client.query(
              "INSERT INTO order_items (order_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, $3, $4)",
              [newOrder.id, seatRows[0].id, label, item.price]
            );
          }
        }
      }

      return newOrder;
    });
  } catch (err) {
    if (err.message !== "SOLD_OUT") {
      console.error("Checkout failed to create order:", err.message);
      return renderCart({ error: "Something went wrong starting checkout. Please try again." });
    }
    const fresh = await loadCartItems(cart);
    req.session.cart = fresh.map((i) => ({
      kind: i.kind, lineId: i.lineId,
      ...(i.kind === "book" ? { copyId: i.copyId } : { classId: i.classId }),
    }));
    return renderCart({
      items: fresh, total: fresh.reduce((sum, i) => sum + i.price, 0),
      error: "Sorry, something in your cart was just taken by someone else. Please review your cart and try again.",
    });
  }

  // access_token (an unguessable UUID, see migrations/019) rather than
  // order.id — the id is sequential, and this URL is public (it's where
  // HelloAsso sends the buyer back to, with no secret of its own).
  const returnUrl = `${baseUrl(req)}/cart/return?order=${order.access_token}`;
  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ") || ".";

  let intent;
  try {
    intent = await helloasso.createCheckoutIntent({
      amountCents: Math.round(total * 100),
      itemName: items.map((i) => i.title).join(", ").slice(0, 250),
      backUrl: `${baseUrl(req)}/cart`,
      errorUrl: returnUrl,
      returnUrl,
      payer: { firstName, lastName, email },
      metadata: { orderId: order.id },
    });
  } catch (err) {
    console.error(`HelloAsso checkout-intent creation failed for order ${order.id}:`, err.message);
    await releaseCartHold(pool, order.id, "cancelled");
    return renderCart({ error: "Couldn't reach the payment provider right now. Please try again in a moment." });
  }

  await pool.query("UPDATE orders SET checkout_intent_id = $1 WHERE id = $2", [String(intent.id), order.id]);
  req.session.cart = [];
  res.redirect(intent.redirectUrl);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/cart/return", async (req, res) => {
  const token = String(req.query.order || "");
  if (!UUID_RE.test(token)) return res.status(404).render("404");

  const { rows } = await pool.query("SELECT * FROM orders WHERE access_token = $1", [token]);
  const order = rows[0];
  if (!order) return res.status(404).render("404");

  const status = order.status === "pending" ? await reconcileOrder(pool, order) : order.status;

  const { rows: orderItems } = await pool.query("SELECT item_title, price FROM order_items WHERE order_id = $1", [order.id]);
  res.render("cart_return", { order, items: orderItems, status });
});

module.exports = router;
