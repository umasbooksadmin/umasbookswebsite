// The cart icon on a book card's price line (every list of books a customer sees: Browse New In, genre and search
// results, collection pages, Favorites, "More by" on a book page). What the icon does is decided per book from the copies
// that can be bought online right now (status 'in_stock' with a real price, the same rule as POST /cart/add):
//
//   no such copy                         -> no icon at all (reserved, sold, unpriced: never a dead icon)
//   one such copy, or several that are   -> the icon adds THAT copy (the oldest one, lowest id) straight to the cart
//   identical in everything the book
//   page shows for a copy (price,
//   condition, clearance)
//   several that differ                  -> the icon opens the book page, where the customer picks a copy
//
// (public lists add `from`, the lowest of those prices, to a "several that differ" answer when the prices differ)
// and, per person, a book that already has a copy in the session's cart shows "in your cart" (a link to the cart).
// The markup is views/partials/card_cart.ejs on the server and UmasUI.cartControlHtml in public/ui.js in the browser
// (test/unit/uiHelpers.test.js keeps them the same); public/cart-add.js does the adding without a page reload.

const { safeReturnTo } = require("./returnTo");

// One number per book, read by the list queries: NULL = nothing to buy online, 0 = several different copies (choose on the
// book page), otherwise the id of the copy the icon adds.
const BUY_COPY_SQL = (bookId = "b.id") => `(SELECT CASE WHEN COUNT(*) = 0 THEN NULL
            WHEN COUNT(DISTINCT (bc.price, bc.condition, bc.is_clearance)) = 1 THEN MIN(bc.id)
            ELSE 0 END
     FROM book_copies bc WHERE bc.book_id = ${bookId} AND bc.status = 'in_stock' AND bc.price IS NOT NULL AND bc.price > 0)`;

// The lowest price of those same copies, but only when they do not all cost the same (NULL otherwise): the card then says
// "from €X" next to the choose button (2026-10-27 review H11). Copies at one price with different grades just say the price.
const BUY_FROM_SQL = (bookId = "b.id") => `(SELECT CASE WHEN COUNT(DISTINCT bc.price) > 1 THEN MIN(bc.price) END
     FROM book_copies bc WHERE bc.book_id = ${bookId} AND bc.status = 'in_stock' AND bc.price IS NOT NULL AND bc.price > 0)`;

// The public JSON's `buy` field: null | { copyId } | { choose: true } | { choose: true, from } (from = the lowest price,
// when the copies' prices differ).
function cardBuy(buyCopyId, fromPrice) {
  if (buyCopyId == null) return null;
  const id = Number(buyCopyId);
  if (id === 0) {
    const from = fromPrice == null ? NaN : Number(fromPrice);
    return from > 0 ? { choose: true, from } : { choose: true };
  }
  return Number.isSafeInteger(id) && id > 0 ? { copyId: id } : null;
}

// The book ids that have a copy in this session's cart (at most 20 lines, src/routes/cart.js MAX_CART_LINES).
async function cartBookIds(pool, session) {
  const lines = session && Array.isArray(session.cart) ? session.cart : [];
  const copyIds = lines
    .map((l) => (typeof l === "number" ? l : l && l.kind === "book" ? l.copyId : null))
    .filter((id) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647);
  if (!copyIds.length) return [];
  const { rows } = await pool.query("SELECT DISTINCT book_id FROM book_copies WHERE id = ANY($1::int[]) ORDER BY book_id", [copyIds]);
  return rows.map((r) => r.book_id);
}

// res.locals.cardCart for a page that draws cards on the server.
//   personal: the page is already drawn for this one session (a signed-in person's page, or a page that prints a CSRF
//   token anyway, like the book page). Only then does the HTML carry the session's own things: a real POST form with the
//   CSRF token, and the "in your cart" state. A signed-out visitor's marketing page (a collection, Browse) stays the same
//   HTML for everyone and creates no session: its icon is a plain GET form to the book's page (no JavaScript), and
//   public/cart-add.js adds the book to the session's cart directly when JavaScript runs.
async function setCardCartLocals(pool, req, res, { personal = false } = {}) {
  const isPersonal = Boolean(req.session && req.session.user) || personal;
  let inCart = [];
  if (isPersonal) inCart = await cartBookIds(pool, req.session).catch(() => []);
  res.locals.cardCart = {
    post: isPersonal,
    inCart: new Set(inCart),
    backTo: safeReturnTo(req.originalUrl) || safeReturnTo(req.path) || "/books.html",
  };
}

module.exports = { BUY_COPY_SQL, BUY_FROM_SQL, cardBuy, cartBookIds, setCardCartLocals };
