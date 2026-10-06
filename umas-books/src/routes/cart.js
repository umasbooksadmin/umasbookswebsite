const express = require("express");
const { localCover } = require("../lib/coverStore");
const { pool, withTransaction } = require("../db");
const helloasso = require("../lib/helloasso");
const { releaseCartHold, reconcileOrder, isRecentlyClosed, persistCheckoutIntentId, CART_HOLD_TTL_MINUTES } = require("../lib/cart");
const { expireStaleReservations } = require("../lib/reservations");
const { seatsTakenExpr } = require("../lib/classCapacity");
const { baseUrl } = require("../lib/baseUrl");
const { isPreviewMode } = require("../lib/preview");
const { TERMS_OF_SALE_VERSION } = require("../lib/legal");
const { loadOrderItems, orderItemLabel } = require("../lib/orderItems");
const { helloassoPaymentOrigins } = require("../lib/helloassoHosts");
const { saveSession } = require("../lib/session");
const { clean, parseId } = require("../lib/validation");
const { CART_RETURN } = require("../lib/returnTo");
const { checkoutLimiter, cartEditLimiter } = require("../middleware/rateLimits");

const router = express.Router();

// A same-origin, path-only redirect target: "/foo" is fine, but "//evil"
// or "/\evil" is a protocol-relative URL — browsers treat a Location
// starting with // as "same scheme, different host" and follow it
// off-site, so startsWith("/") alone isn't enough to keep backTo local.
function isSafeLocalPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

// A copy without a real price (NULL, 0, negative) is never purchasable here:
// every query below that reads or locks a copy also requires
// `price IS NOT NULL AND price > 0`, so such a copy can never reach an order or
// a total (it would otherwise be charged as 0). It is "ask in the shop" only.
//
// Browsing, adding to and viewing the cart need no login (matches /books and
// /sessions); CHECKING OUT does: buying books or class seats requires an
// account (see accountForCheckout and POST /cart/checkout). The cart itself is
// just a list of lines in the session (it is carried across the login's
// session regeneration, see loginAs in routes/auth.js); nothing is locked in
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

// Who is checking out. Re-read from the database (not the session snapshot)
// so the order always carries the account's CURRENT confirmed email.
//   { state: "guest" }                     not logged in (or account gone/disabled)
//   { state: "unconfirmed", user }         logged in, email never confirmed
//   { state: "ok", user }                  may check out
async function accountForCheckout(req) {
  const sessionUser = req.session && req.session.user;
  if (!sessionUser) return { state: "guest" };
  const { rows } = await pool.query(
    "SELECT id, email, display_name, email_verified_at, is_disabled FROM users WHERE id = $1",
    [sessionUser.id]
  );
  const user = rows[0];
  if (!user || user.is_disabled) return { state: "guest" };
  // Nothing is ever sent to, or ordered under, an unconfirmed address.
  if (!user.email_verified_at) return { state: "unconfirmed", user };
  return { state: "ok", user };
}

// What views/cart.ejs needs to choose between the checkout form and the
// "log in or create an account" block.
function accountView(account) {
  return {
    checkoutState: account.state,
    accountEmail: account.user ? account.user.email : null,
    accountName: account.user ? account.user.display_name || "" : "",
  };
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
         AND c.price IS NOT NULL AND c.price > 0
       ORDER BY c.id ASC`,
      [bookLines.map((l) => l.copyId)]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const line of bookLines) {
      const r = byId.get(line.copyId);
      if (!r) continue; // no longer in stock — dropped, same as before
      items.push({
        kind: "book", lineId: line.lineId, copyId: r.id,
        title: r.title, authors: r.authors, coverUrl: localCover(r.cover_url), price: Number(r.price), condition: r.condition,
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
      if (!cls || cls.dropin_price == null || Number(cls.dropin_price) <= 0) continue; // no longer sold as drop-in — dropped
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
  // Read without getCart() so a person with no cart doesn't get a session created.
  res.json({ count: Array.isArray(req.session.cart) ? req.session.cart.length : 0 });
});

// HelloAsso's own payment link stops working after about 15 minutes; resuming
// is offered for a little less than that.
const RESUME_WINDOW_MINUTES = 14;

// The logged-in buyer's OWN unpaid orders still holding books or seats, for the
// "finish or cancel" block on the cart page. Never anyone else's.
async function loadOwnPendingOrders(req) {
  const sessionUser = req.session && req.session.user;
  if (!sessionUser) return [];
  const { rows } = await pool.query(
    `SELECT id, total_amount, created_at, checkout_redirect_url,
            (checkout_redirect_url IS NOT NULL
             AND created_at > now() - make_interval(mins => $2)) AS can_resume
     FROM orders
     WHERE user_id = $1 AND status = 'pending' AND created_at > now() - make_interval(mins => $3)
     ORDER BY id DESC`,
    [sessionUser.id, RESUME_WINDOW_MINUTES, CART_HOLD_TTL_MINUTES]
  );
  for (const o of rows) {
    o.items = (await loadOrderItems(pool, o.id)).map((i) => ({ label: orderItemLabel(i, req.lang), price: Number(i.price) }));
  }
  return rows;
}

function cartNotice(req) {
  switch (String(req.query.notice || "")) {
    case "order-cancelled":
      return req.tr("Your unpaid order was cancelled and its items are available again.", "Votre commande non payée a été annulée et ses articles sont de nouveau disponibles.");
    case "order-paid":
      return req.tr("Good news: that order was in fact paid, so it was not cancelled. You will find it in your account.", "Bonne nouvelle : cette commande a bien été payée, elle n’a donc pas été annulée. Vous la retrouverez dans votre compte.");
    case "resume-expired":
      return req.tr("The payment page for that order has expired. Cancel the order, then add the items to your cart again.", "La page de paiement de cette commande a expiré. Annulez la commande, puis ajoutez de nouveau les articles à votre panier.");
    default:
      return null;
  }
}

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
  const account = await accountForCheckout(req);
  res.render("cart", {
    items, total, error: null, notice: cartNotice(req), pendingOrders: await loadOwnPendingOrders(req),
    helloassoReady: helloasso.isConfigured(), ...accountView(account),
  });
});

const orderIdParam = (req) => parseId(req.params.id);

// Back to HelloAsso's payment page for the buyer's own unpaid order, while its
// link is still valid. A redirect, not a page: nothing is changed.
router.get("/cart/orders/:id/resume", async (req, res) => {
  const id = orderIdParam(req);
  const sessionUser = req.session && req.session.user;
  if (!sessionUser) return res.redirect(LOGIN_REQUIRED_URL);
  if (!id) return res.status(404).render("404");
  const { rows } = await pool.query(
    `SELECT checkout_redirect_url, created_at > now() - make_interval(mins => $3) AS fresh
     FROM orders WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [id, sessionUser.id, RESUME_WINDOW_MINUTES]
  );
  const order = rows[0];
  if (!order) return res.status(404).render("404"); // not theirs, not pending, or not found: the same answer
  let target = null;
  try {
    const url = new URL(order.checkout_redirect_url || "");
    if (order.fresh && helloassoPaymentOrigins().includes(url.origin)) target = url.toString();
  } catch { /* no usable link */ }
  if (!target) return res.redirect("/cart?notice=resume-expired");
  res.redirect(target);
});

// Cancels the buyer's own unpaid order and frees its items. HelloAsso is asked
// first (reconcileOrder): an order that was in fact paid is never cancelled.
router.post("/cart/orders/:id/cancel", cartEditLimiter, async (req, res) => {
  const id = orderIdParam(req);
  const sessionUser = req.session && req.session.user;
  if (!sessionUser) return res.redirect(LOGIN_REQUIRED_URL);
  if (!id) return res.status(404).render("404");
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1 AND user_id = $2", [id, sessionUser.id]);
  const order = rows[0];
  if (!order) return res.status(404).render("404");
  if (order.status === "paid") return res.redirect("/cart?notice=order-paid");
  if (order.status === "pending") {
    const status = await reconcileOrder(pool, order);
    if (status === "paid") return res.redirect("/cart?notice=order-paid");
    if (status === "pending") await releaseCartHold(pool, id, "cancelled");
    const { rows: after } = await pool.query("SELECT status FROM orders WHERE id = $1", [id]);
    if (after[0] && after[0].status === "paid") return res.redirect("/cart?notice=order-paid");
  }
  res.redirect("/cart?notice=order-cancelled");
});

const LOGIN_REQUIRED_URL = `/login?returnTo=${encodeURIComponent(CART_RETURN)}`;

// Nothing is checked out by GET: this only exists so a bookmarked or
// back-button URL lands somewhere useful. Preview mode first (the cart page
// carries the "ordering opens at launch" notice), then the login requirement.
router.get("/cart/checkout", async (req, res) => {
  if (isPreviewMode()) return res.redirect(CART_RETURN);
  const account = await accountForCheckout(req);
  if (account.state === "guest") return res.redirect(LOGIN_REQUIRED_URL);
  res.redirect(CART_RETURN);
});

// Upper bound on lines per cart — checkout locks every copy in the cart
// for an hour, so an unbounded cart is an inventory-lock lever.
const MAX_CART_LINES = 20;

router.post("/cart/add", cartEditLimiter, async (req, res) => {
  const copyId = parseId(req.body.copyId);
  const backTo = isSafeLocalPath(req.body.backTo) ? req.body.backTo : "/cart";
  if (copyId !== null) {
    const { rows } = await pool.query("SELECT id FROM book_copies WHERE id = $1 AND status = 'in_stock' AND price IS NOT NULL AND price > 0", [copyId]);
    if (rows.length) {
      const cart = getCart(req);
      if (cart.length < MAX_CART_LINES && !cart.some((l) => l.kind === "book" && l.copyId === copyId)) {
        cart.push({ kind: "book", lineId: nextLineId(req), copyId });
      }
    }
  }
  await saveSession(req);
  res.redirect(backTo);
});

router.post("/cart/add-dropin", cartEditLimiter, async (req, res) => {
  const classId = parseId(req.body.classId);
  const backTo = isSafeLocalPath(req.body.backTo) ? req.body.backTo : "/sessions";
  if (classId !== null) {
    const { rows } = await pool.query(
      `SELECT capacity, dropin_price, ${seatsTakenExpr("classes")}::int AS seats_taken
       FROM classes WHERE id = $1`,
      [classId]
    );
    const cls = rows[0];
    if (cls && cls.dropin_price != null && Number(cls.dropin_price) > 0) {
      const cart = getCart(req);
      const alreadyInCart = cart.filter((l) => l.kind === "dropin" && l.classId === classId).length;
      const spotsLeft = cls.capacity != null ? cls.capacity - cls.seats_taken - alreadyInCart : Infinity;
      // A soft, early check for a friendly redirect — checkout below is
      // the real, race-condition-safe enforcement.
      if (spotsLeft > 0 && cart.length < MAX_CART_LINES) cart.push({ kind: "dropin", lineId: nextLineId(req), classId });
    }
  }
  await saveSession(req);
  res.redirect(backTo);
});

router.post("/cart/remove", async (req, res) => {
  // Only compared against the session's own lines, never sent to SQL.
  const lineId = Number(req.body.lineId);
  const cart = getCart(req);
  req.session.cart = cart.filter((l) => l.lineId !== lineId);
  await saveSession(req);
  res.redirect("/cart");
});

// Most unpaid orders one email address, or one IP address, can have open
// at once. Each one locks its copies for CART_HOLD_TTL_MINUTES, so without
// this a script could lock the whole shelf without ever paying.
// Per account (the order email is always the logged-in account's) the cap is
// tight; per IP it is looser, because a household, a school or the shop's own
// wifi legitimately shares one public IP, and a tight cap would lock real
// customers out of checkout while the hold is open.
const MAX_PENDING_ORDERS = 2;
const MAX_PENDING_ORDERS_PER_IP = 10;

// Run the checkout transaction, trying once more if Postgres picks it as
// the loser of a deadlock (40P01): two overlapping carts that touch the
// same rows. Everything inside rolled back, so a retry is safe.
async function runCheckoutTransaction(fn) {
  try {
    return await withTransaction(pool, fn);
  } catch (err) {
    if (err.code !== "40P01") throw err;
    console.warn("Checkout deadlock detected, retrying once");
    try {
      return await withTransaction(pool, fn);
    } catch (retryErr) {
      if (retryErr.code === "40P01") throw new Error("BUSY", { cause: retryErr });
      throw retryErr;
    }
  }
}

router.post("/cart/checkout", checkoutLimiter, async (req, res) => {
  const cart = getCart(req);
  // Name and phone come from the form; the EMAIL never does: an order is
  // placed under the logged-in account's confirmed address (any posted
  // "email" field is ignored, so nobody can order under someone else's).
  let name = clean(req.body.name, 100);
  const phone = clean(req.body.phone, 30) || null;

  const items = await loadCartItems(cart);
  req.session.cart = items.map((i) => ({
    kind: i.kind, lineId: i.lineId,
    ...(i.kind === "book" ? { copyId: i.copyId } : { classId: i.classId }),
  }));

  const account = await accountForCheckout(req);

  const renderCart = async (extra) =>
    res.render("cart", {
      items, total: items.reduce((sum, i) => sum + i.price, 0), helloassoReady: helloasso.isConfigured(), error: null, notice: null,
      pendingOrders: await loadOwnPendingOrders(req), ...accountView(account), ...extra,
    });

  // Preview mode (src/lib/preview.js): nothing can be ordered. Refuse before
  // any validation, lock, order row or HelloAsso call; the cart page itself
  // carries the "ordering opens at launch" notice (views/cart.ejs).
  if (isPreviewMode()) {
    res.status(403);
    return renderCart({});
  }

  // Buying requires an account, enforced here on the server (the cart page
  // merely hides the form). Checked AFTER preview mode, so the preview notice
  // is never masked, and BEFORE anything else: a guest creates no order, no
  // lock, no HelloAsso call. The cart stays in the session.
  if (account.state === "guest") {
    await saveSession(req); // the pruned cart must be there when the login page loads
    return res.redirect(LOGIN_REQUIRED_URL);
  }
  if (account.state === "unconfirmed") {
    res.status(403);
    return renderCart({ error: req.tr("Please confirm your email address before ordering: open the link we sent you when you signed up.", "Veuillez confirmer votre adresse e-mail avant de commander : ouvrez le lien que nous vous avons envoyé lors de votre inscription.") });
  }
  const email = account.user.email.toLowerCase();
  if (!name) name = clean(account.user.display_name, 100);

  if (!items.length) return renderCart({ items: [], total: 0, error: req.tr("Your cart is empty.", "Votre panier est vide.") });
  if (!name) return renderCart({ error: req.tr("Please enter your name.", "Veuillez indiquer votre nom.") });
  if (req.body.acceptCgv !== "on") return renderCart({ error: req.tr("Please accept the terms of sale to continue.", "Veuillez accepter les conditions de vente pour continuer.") });
  // Drop-in seats are dated leisure bookings: the buyer must expressly ask for
  // the session to take place on the booked date. The box is kept (the buyer
  // confirms the date); the right of withdrawal does not exist for these
  // sessions anyway (Consumer Code art. L.221-28, 12°).
  const hasDropin = items.some((i) => i.kind === "dropin");
  if (hasDropin && req.body.waiveWithdrawal !== "on") {
    return renderCart({ error: req.tr("Please tick the box confirming you want the drop-in session(s) to take place on the date booked.", "Veuillez cocher la case confirmant que vous souhaitez que la ou les séances drop-in aient lieu à la date réservée.") });
  }
  if (!helloasso.isConfigured()) {
    return renderCart({ helloassoReady: false, error: req.tr("Online payment isn't set up yet — please check back soon, or come by the shop in person.", "Le paiement en ligne n’est pas encore en place : revenez bientôt, ou passez à la boutique.") });
  }

  const bookItems = items.filter((i) => i.kind === "book");
  const dropinItems = items.filter((i) => i.kind === "dropin");
  const total = items.reduce((sum, i) => sum + i.price, 0);

  const clientIp = req.ip || null;

  let order;
  try {
    order = await runCheckoutTransaction(async (client) => {
      // Serialize concurrent checkouts from the same email / IP so two
      // simultaneous requests can't both pass the cap below. Keys are
      // taken in sorted order so these locks can't deadlock each other.
      const lockKeys = [`checkout-email:${email}`, `checkout-ip:${clientIp || ""}`].sort();
      for (const key of lockKeys) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);

      const { rows: pendingRows } = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE lower(buyer_email) = $1 OR user_id = $4)::int AS by_email,
           COUNT(*) FILTER (WHERE client_ip = $2)::int AS by_ip
         FROM orders
         WHERE status = 'pending' AND created_at > now() - make_interval(mins => $3)
           AND (lower(buyer_email) = $1 OR user_id = $4 OR client_ip = $2)`,
        [email, clientIp, CART_HOLD_TTL_MINUTES, account.user.id]
      );
      if (pendingRows[0].by_email >= MAX_PENDING_ORDERS || pendingRows[0].by_ip >= MAX_PENDING_ORDERS_PER_IP) {
        throw new Error("TOO_MANY_PENDING");
      }

      const { rows: orderRows } = await client.query(
        `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, total_amount, client_ip, withdrawal_waiver_at, lang,
                             cgv_accepted_at, cgv_version, user_id)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END, $7, now(), $8, $9) RETURNING *`,
        [name, email, phone, total, clientIp, hasDropin, req.lang, TERMS_OF_SALE_VERSION, account.user.id]
      );
      const newOrder = orderRows[0];

      if (bookItems.length) {
        // Take the row locks in id order. Two carts sharing copies would
        // otherwise each lock them in their own order and deadlock.
        const copyIds = bookItems.map((i) => i.copyId).sort((a, b) => a - b);
        await client.query("SELECT id FROM book_copies WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [copyIds]);
        const { rows: locked } = await client.query(
          `UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now(), updated_at = now()
           WHERE id = ANY($2::int[]) AND status = 'in_stock' AND price IS NOT NULL AND price > 0 RETURNING id`,
          [newOrder.id, copyIds]
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

        // Class rows are locked in id order too (see the copies above).
        for (const [classId, count] of [...wanted].sort((a, b) => a[0] - b[0])) {
          // Lock the class row so two simultaneous checkouts for the same
          // session can't both read the same "spots left" and oversell it.
          const { rows: clsRows } = await client.query(
            `SELECT capacity, dropin_price, ${seatsTakenExpr("classes")}::int AS seats_taken
             FROM classes WHERE id = $1 FOR UPDATE`,
            [classId]
          );
          const cls = clsRows[0];
          const spotsLeft = cls && cls.dropin_price != null && Number(cls.dropin_price) > 0
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
    if (err.message === "TOO_MANY_PENDING") {
      return renderCart({ error: req.tr("You already have unpaid orders waiting for payment. Please finish or cancel them (see \"Your unpaid orders\" just below), or wait for them to expire (about an hour), before starting another.", "Vous avez déjà des commandes en attente de paiement. Veuillez les régler ou les annuler (voir « Vos commandes non payées » ci-dessous), ou attendre qu’elles expirent (environ une heure), avant d’en commencer une autre.") });
    }
    if (err.message === "BUSY") {
      return renderCart({ error: req.tr("The shop is busy right now. Please try again in a moment.", "La boutique est très sollicitée en ce moment. Veuillez réessayer dans un instant.") });
    }
    if (err.message !== "SOLD_OUT") {
      console.error("Checkout failed to create order:", err.message);
      return renderCart({ error: req.tr("Something went wrong starting checkout. Please try again.", "Une erreur est survenue au démarrage du paiement. Veuillez réessayer.") });
    }
    const fresh = await loadCartItems(cart);
    req.session.cart = fresh.map((i) => ({
      kind: i.kind, lineId: i.lineId,
      ...(i.kind === "book" ? { copyId: i.copyId } : { classId: i.classId }),
    }));
    return renderCart({
      items: fresh, total: fresh.reduce((sum, i) => sum + i.price, 0),
      error: req.tr("Sorry, something in your cart was just taken by someone else. Please review your cart and try again.", "Désolé, un article de votre panier vient d’être pris par quelqu’un d’autre. Veuillez vérifier votre panier et réessayer."),
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
    return renderCart({ error: req.tr("Couldn't reach the payment provider right now. Please try again in a moment.", "Impossible de joindre le prestataire de paiement pour le moment. Veuillez réessayer dans un instant.") });
  }

  // Retries once and alerts the admin if it still fails (never throws):
  // the buyer is sent on to pay either way, since the payment link is
  // already live — see persistCheckoutIntentId in lib/cart.js.
  await persistCheckoutIntentId(pool, order.id, intent.id);
  // So a buyer who backs out of HelloAsso can resume from the cart page while
  // the link is valid (GET /cart/orders/:id/resume). Best effort.
  await pool.query("UPDATE orders SET checkout_redirect_url = $1 WHERE id = $2", [String(intent.redirectUrl || ""), order.id]).catch((err) =>
    console.error(`Could not store the payment link for order ${order.id}:`, err.message)
  );
  // The session cart is emptied before the redirect (the items are now held
  // by the order, so a second checkout from the same cart must not happen).
  // Backing out of HelloAsso lands on /cart, which lists this unpaid order
  // with Resume payment / Cancel.
  req.session.cart = [];
  await saveSession(req);
  res.redirect(intent.redirectUrl);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/cart/return", async (req, res) => {
  const token = String(req.query.order || "");
  if (!UUID_RE.test(token)) return res.status(404).render("404");

  const { rows } = await pool.query("SELECT * FROM orders WHERE access_token = $1", [token]);
  let order = rows[0];
  if (!order) return res.status(404).render("404");

  // A recently expired/cancelled order may have been paid after all (the
  // buyer retried the same HelloAsso checkout), so reconcile those too,
  // then re-read: reconcileOrder may have recovered or flagged the order.
  if (order.status === "pending" || isRecentlyClosed(order)) {
    await reconcileOrder(pool, order);
    const { rows: fresh } = await pool.query("SELECT * FROM orders WHERE id = $1", [order.id]);
    if (fresh[0]) order = fresh[0];
  }
  const status = order.status;
  // helloasso_order_id on a closed order is only ever set by a late payment
  // that could not be fulfilled (see recoverLatePayment): money was taken.
  const paymentReceivedUnfulfilled = status !== "paid" && status !== "pending" && !!order.helloasso_order_id;

  const orderItems = (await loadOrderItems(pool, order.id)).map((i) => ({ label: orderItemLabel(i, req.lang), price: i.price }));
  res.render("cart_return", { order, items: orderItems, status, paymentReceivedUnfulfilled });
});

module.exports = router;
