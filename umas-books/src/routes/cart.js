const express = require("express");
const { localCover } = require("../lib/coverStore");
const { pool } = require("../db");
const { createReservation } = require("../lib/cart");
const { expireStaleReservations, cancelReservationAsCustomer, MAX_RESERVED_COPIES, MAX_ACTIVE_RESERVATIONS, SEAT_CANCEL_HOURS } = require("../lib/reservations");
const { seatsTakenExpr } = require("../lib/classCapacity");
const { isPreviewMode } = require("../lib/preview");
const { TERMS_OF_SALE_VERSION } = require("../lib/legal");
const { loadOrderItems, orderItemLabel, orderItemParts, reservationLastDay } = require("../lib/orderItems");
const { saveSession } = require("../lib/session");
const { clean, parseId } = require("../lib/validation");
const { CART_RETURN } = require("../lib/returnTo");
const { checkoutLimiter, cartEditLimiter } = require("../middleware/rateLimits");
const { redirectWithFlash, takePageFlash } = require("../lib/postRedirect");

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
// /sessions); RESERVING does: reserving books or class seats requires an
// account (see accountForCheckout and POST /cart/reserve). Nothing is paid
// online: the customer pays in person at the shop or at the class session. The cart itself is
// just a list of lines in the session (it is carried across the login's
// session regeneration, see loginAs in routes/auth.js); nothing is held in
// the database until the reservation is made (see src/lib/cart.js). A line is either a book copy ({ kind: "book", copyId }) or a
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
      `SELECT c.id, c.title, c.title_fr, c.starts_at, c.capacity, c.dropin_price, ${seatsTakenExpr("c")}::int AS seats_taken
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
        title: cls.title, titleFr: cls.title_fr, startsAt: cls.starts_at, price: Number(cls.dropin_price),
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

function cartNotice(req) {
  switch (String(req.query.notice || "")) {
    case "reservation-cancelled":
      return req.tr("Your reservation was cancelled and its items are available again.", "Votre réservation a été annulée et ses articles sont de nouveau disponibles.");
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
  // A refused reservation (POST /cart/reserve) left its message, and the name and phone typed, here once.
  const flash = takePageFlash(req, res, "cart") || {};
  const view = accountView(account);
  if (flash.name) view.accountName = flash.name;
  res.render("cart", {
    items, total, error: flash.error || null, notice: cartNotice(req), ...view, typedPhone: flash.phone || "", limits: LIMITS,
  });
});

const orderIdParam = (req) => parseId(req.params.id);

const LOGIN_REQUIRED_URL = `/login?returnTo=${encodeURIComponent(CART_RETURN)}`;

// Nothing is reserved by GET: this only exists so a bookmarked or
// back-button URL lands somewhere useful. Preview mode first (the cart page
// carries the "ordering opens at launch" notice), then the login requirement.
router.get("/cart/checkout", async (req, res) => {
  if (isPreviewMode()) return res.redirect(CART_RETURN);
  const account = await accountForCheckout(req);
  if (account.state === "guest") return res.redirect(LOGIN_REQUIRED_URL);
  res.redirect(CART_RETURN);
});

// Upper bound on lines per cart — a reservation holds every copy in the cart
// for two weeks, so an unbounded cart is an inventory-lock lever (the per-account
// limits in lib/legal.js cap what can be held at once).
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

// The policy numbers shown to customers (lib/legal.js is the single source).
const LIMITS = { copies: MAX_RESERVED_COPIES, reservations: MAX_ACTIVE_RESERVATIONS, seatHours: SEAT_CANCEL_HOURS };

// POST /cart/reserve: "Reserve these books". NOTHING IS PAID ONLINE: the copies
// and seats are held for the customer (RESERVATION_DAYS for books), who pays in
// person at the shop or at the class session. See lib/cart.js createReservation.
router.post("/cart/reserve", checkoutLimiter, async (req, res) => {
  const cart = getCart(req);
  // Name and phone come from the form; the EMAIL never does: a reservation is
  // placed under the logged-in account's confirmed address (any posted "email"
  // field is ignored, so nobody can reserve under someone else's).
  let name = clean(req.body.name, 100);
  const phone = clean(req.body.phone, 30) || null;

  const items = await loadCartItems(cart);
  req.session.cart = items.map((i) => ({
    kind: i.kind, lineId: i.lineId,
    ...(i.kind === "book" ? { copyId: i.copyId } : { classId: i.classId }),
  }));

  const account = await accountForCheckout(req);

  // A refusal goes back to the cart page by redirect (lib/postRedirect.js), so Back never offers
  // to resubmit the form; the message and the typed name and phone travel once in the session,
  // saved together with the cart pruned above.
  const refuse = (error) => redirectWithFlash(req, res, "/cart", "cart", { error, name, phone: phone || "" });

  // Preview mode (src/lib/preview.js): nothing can be reserved. Refuse before
  // any validation, lock or order row; the cart page itself carries the
  // "ordering opens at launch" notice (views/cart.ejs).
  if (isPreviewMode()) return refuse(null);

  // Reserving requires an account, enforced here on the server (the cart page
  // merely hides the form). Checked AFTER preview mode, so the preview notice
  // is never masked, and BEFORE anything else: a guest creates no order and no
  // hold. The cart stays in the session.
  if (account.state === "guest") {
    await saveSession(req); // the pruned cart must be there when the login page loads
    return res.redirect(LOGIN_REQUIRED_URL);
  }
  if (account.state === "unconfirmed") {
    return refuse(req.tr("Please confirm your email address before reserving: open the link we sent you when you signed up.", "Veuillez confirmer votre adresse e-mail avant de réserver : ouvrez le lien que nous vous avons envoyé lors de votre inscription."));
  }
  if (!name) name = clean(account.user.display_name, 100);

  if (!items.length) return refuse(req.tr("Your cart is empty.", "Votre panier est vide."));
  if (!name) return refuse(req.tr("Please enter your name.", "Veuillez indiquer votre nom."));
  if (req.body.acceptCgv !== "on") return refuse(req.tr("Please accept the terms of sale to continue.", "Veuillez accepter les conditions générales de vente (CGV) pour continuer."));

  // The price the customer SAW for each book (a hidden field of the cart form): the
  // reservation is refused, not silently re-priced, when the copy's price under the row
  // lock differs (lib/cart.js). A missing field falls back to the price just loaded.
  const priced = items.map((i) => {
    if (i.kind !== "book") return i;
    const raw = String(req.body[`seenPrice_${i.copyId}`] ?? "").trim().replace(",", ".");
    const seen = Number(raw);
    return raw !== "" && Number.isFinite(seen) && seen > 0 ? { ...i, price: Math.round(seen * 100) / 100 } : i;
  });

  let order;
  try {
    order = await createReservation(pool, {
      user: account.user, name, phone, items: priced, lang: req.lang, hasDropin: false, acceptedVersion: TERMS_OF_SALE_VERSION,
    });
  } catch (err) {
    if (err.message === "TOO_MANY_RESERVATIONS") {
      return refuse(req.tr(`You already have ${MAX_ACTIVE_RESERVATIONS} open reservations, which is the most we can hold for one account. Please collect or cancel one first (see your account page).`, `Vous avez déjà ${MAX_ACTIVE_RESERVATIONS} réservations en cours, ce qui est le maximum pour un compte. Veuillez en retirer ou en annuler une avant d’en faire une autre (voir votre page de compte).`));
    }
    if (err.message === "TOO_MANY_COPIES") {
      return refuse(req.tr(`We can hold at most ${MAX_RESERVED_COPIES} books at a time for one account, counting your other open reservations. Please remove some books from your cart, or collect or cancel a reservation first.`, `Nous pouvons garder au plus ${MAX_RESERVED_COPIES} livres à la fois pour un compte, vos autres réservations en cours comprises. Veuillez retirer des livres de votre panier, ou retirer ou annuler une réservation avant d’en faire une autre.`));
    }
    if (err.message === "PRICE_CHANGED") {
      // Nothing was reserved. The cart page now shows the new price; pressing Reserve again confirms it.
      const msgs = (err.changes || []).map((c) => req.tr(
        `The price of "${c.title}" changed to EUR ${c.newPrice.toFixed(2)}, please review your reservation.`,
        `Le prix de « ${c.title} » est passé à ${c.newPrice.toFixed(2).replace(".", ",")} €, veuillez vérifier votre réservation.`));
      return refuse(msgs.join(" "));
    }
    if (err.message === "NOT_FOR_SALE") {
      // A copy's price was cleared (or set to 0) after the customer saw the cart: it is not "taken by someone else".
      const fresh = await loadCartItems(cart);
      req.session.cart = fresh.map((i) => ({
        kind: i.kind, lineId: i.lineId,
        ...(i.kind === "book" ? { copyId: i.copyId } : { classId: i.classId }),
      }));
      const names = (err.titles || []).map((t) => `"${t}"`).join(", ");
      const namesFr = (err.titles || []).map((t) => `« ${t} »`).join(", ");
      return refuse(req.tr(
        `${names} is no longer for sale at the moment (it has no price), so nothing was reserved. Please review your cart and try again.`,
        `${namesFr} n’est plus en vente pour le moment (il n’a plus de prix), donc rien n’a été réservé. Veuillez vérifier votre panier et réessayer.`));
    }
    if (err.message === "BUSY") {
      return refuse(req.tr("The shop is busy right now. Please try again in a moment.", "La boutique est très sollicitée en ce moment. Veuillez réessayer dans un instant."));
    }
    if (err.message !== "SOLD_OUT") {
      console.error("Reservation failed:", err.message);
      return refuse(req.tr("Something went wrong making your reservation. Please try again.", "Une erreur est survenue lors de votre réservation. Veuillez réessayer."));
    }
    const fresh = await loadCartItems(cart);
    req.session.cart = fresh.map((i) => ({
      kind: i.kind, lineId: i.lineId,
      ...(i.kind === "book" ? { copyId: i.copyId } : { classId: i.classId }),
    }));
    return refuse(req.tr("Sorry, something in your cart was just taken by someone else. Please review your cart and try again.", "Désolé, un article de votre panier vient d’être pris par quelqu’un d’autre. Veuillez vérifier votre panier et réessayer."));
  }

  // The items are now held by the reservation, so the cart is emptied (a second
  // press of the button must not reserve them again). access_token (an
  // unguessable UUID, see migrations/019) rather than order.id in the URL: the
  // id is sequential.
  req.session.cart = [];
  await saveSession(req);
  res.redirect(`/cart/return?order=${order.access_token}`);
});

// The customer cancels their OWN reservation (owner-only; a copy is released at
// once, a drop-in seat until SEAT_CANCEL_HOURS before its session). Asked from the
// account page and from the reservation page.
router.post("/cart/reservations/:id/cancel", cartEditLimiter, async (req, res) => {
  const id = orderIdParam(req);
  const sessionUser = req.session && req.session.user;
  if (!sessionUser) return res.redirect(LOGIN_REQUIRED_URL);
  if (!id) return res.status(404).render("404");
  const result = await cancelReservationAsCustomer(pool, id, sessionUser.id);
  if (result.outcome === "not_found") return res.status(404).render("404");
  const notice = result.outcome === "released" ? "reservation-cancelled" : result.outcome === "too_late" ? "reservation-too-late" : "reservation-not-open";
  res.redirect(`/account?notice=${notice}`);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The reservation page, found by its unguessable token (it is also the link in
// the confirmation email). Shows the status: reserved (what to do, the deadline),
// paid (collected), cancelled / expired.
router.get("/cart/return", async (req, res) => {
  const token = String(req.query.order || "");
  if (!UUID_RE.test(token)) return res.status(404).render("404");

  await expireStaleReservations(pool);
  const { rows } = await pool.query("SELECT * FROM orders WHERE access_token = $1", [token]);
  const order = rows[0];
  if (!order) return res.status(404).render("404");

  const orderItems = (await loadOrderItems(pool, order.id)).map((i) => ({ label: orderItemLabel(i, req.lang), ...orderItemParts(i, req.lang), price: i.price, isSeat: i.class_dropin_seat_id != null }));
  const sessionUser = req.session && req.session.user;
  const isOwner = !!(sessionUser && order.user_id && sessionUser.id === order.user_id);
  res.render("cart_return", { order, items: orderItems, status: order.status, isOwner, lastDay: reservationLastDay(order), limits: LIMITS });
});

module.exports = router;
