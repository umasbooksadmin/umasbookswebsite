// What an admin does to a copy that already exists: edit it, cancel its reservation, delete it
// (and its book when it was the last copy). The routes in routes/admin/inventory.js read the form
// and answer; the SQL and the rules live here (see ARCHITECTURE.md, "Where SQL lives").
//
// Adding a copy is in lib/inventoryIntake.js. Both share learningFields() below.
//
// Functions that write an audit entry take `ctx.audit(entry)` (the route passes
// `(entry) => audit(req, entry)`), so the entries are the same whoever calls them.

const { withTransaction } = require("../db");
const { STATUSES, normalizeCondition, normalizeLocation, normalizeSource, resolveCopyPricing } = require("./inventory");
const { getSettings } = require("./pricing/settings");
const { parseSuggestedPrice, normalizeSuggestedLevel, priceBasisFor, priceFromLevelChoice } = require("./pricing/intake");
const { parseMoney, parseDay } = require("./validation");

const parseAcquisitionCost = (raw) => parseMoney(raw, { allowBlank: true, label: "Acquisition cost" });
// What to show back in a form after a refused value: the text as typed.
const asTyped = (raw) => (typeof raw === "string" ? raw.slice(0, 40) : "");

// A suggestion is only ever shown: the volunteer accepts it or picks their own price. The suggestion
// that was on screen travels in hidden fields (suggestedPrice, suggestedLevel) so the save can record
// whether it was kept. `body` is the posted form (or the same four fields, see inventoryIntake.js).
function learningFields(price, body, stored = {}) {
  const posted = body.suggestedPrice !== undefined || body.suggestedLevel !== undefined;
  const suggestedPrice = posted ? parseSuggestedPrice(body.suggestedPrice) : (stored.suggested_price != null ? Number(stored.suggested_price) : null);
  const suggestedLevel = posted ? normalizeSuggestedLevel(body.suggestedLevel) : (stored.suggested_level || null);
  return { suggestedPrice, suggestedLevel, priceBasis: priceBasisFor(price, suggestedPrice, suggestedLevel) };
}

// A copy's status can change under an open edit form (sold in the shop, put in a cart at checkout,
// reserved by a customer). The form posts the status it was rendered with (renderedStatus); the status
// is only changed when the person picked a different one AND the copy still has the rendered status.
// A sold copy or one in somebody's checkout is never changed from this form. The other fields are saved
// either way. (in_cart is a status of its own, set by checkout, that the form does not offer.)
const statusLabelOf = (value) => (value === "in_cart" ? "In a cart" : (STATUSES.find((x) => x.value === value) || {}).label || value);
const isStatusValue = (value) => typeof value === "string" && STATUSES.some((x) => x.value === value);

// ---------- Edit a copy ----------

// The edit form, read. Pure. `price` is the raw field set (priceLevel, price, suggested*) that
// priceFromLevelChoice() and learningFields() read.
function parseCopyEdit(body) {
  return {
    condition: normalizeCondition(body.condition),
    priceForm: { priceLevel: body.priceLevel, price: body.price, suggestedPrice: body.suggestedPrice, suggestedLevel: body.suggestedLevel },
    rawPublisherPrice: body.publisherPrice,
    rawAcquisitionCost: body.acquisitionCost,
    costCheck: parseAcquisitionCost(body.acquisitionCost),
    acquiredCheck: parseDay(body.acquiredAt, { label: "Date acquired" }),
    notes: (body.notes || "").trim() || null,
    location: normalizeLocation(body.location),
    source: normalizeSource(body.source),
    status: isStatusValue(body.status) ? body.status : null,
    renderedStatus: isStatusValue(body.renderedStatus) ? body.renderedStatus : null,
  };
}

// Prices the edit: the shop's pricing settings, the price level chosen, the book's published year
// (the 2-year rule for New books). -> { choice, pricing, error } (error: the first refusal, or null)
async function priceCopyEdit(db, bookId, input) {
  const settings = await getSettings(db);
  const choice = priceFromLevelChoice(input.condition, input.priceForm, settings);
  const yearRow = await db.query("SELECT published_year FROM books WHERE id = $1", [bookId]);
  const pricing = resolveCopyPricing(input.condition, choice.rawPrice, input.rawPublisherPrice, { publishedYear: yearRow.rows[0] && yearRow.rows[0].published_year });
  const error = pricing.error || input.costCheck.error || input.acquiredCheck.error || null;
  return { choice, pricing, error };
}

// What was typed, laid over the copy's form when something is refused (display only).
function copyEditOverlay(copyId, input, choice) {
  return {
    copy: {
      id: copyId, condition: input.condition, notes: input.notes, location: input.location, source: input.source,
      price: asTyped(choice.rawPrice), publisher_price: asTyped(input.rawPublisherPrice), acquisition_cost: asTyped(input.rawAcquisitionCost),
      ...(input.status ? { status: input.status } : {}),
      ...(input.renderedStatus ? { rendered_status: input.renderedStatus } : {}),
    },
  };
}

// Saves the edit under a row lock. -> { missing: true } | { error, status: 409 } | { before, keptStatus }
function updateCopy(pool, bookId, copyId, input, priced) {
  const { price, publisherPrice } = priced.pricing;
  const { choice } = priced;
  const { condition, notes, location, source } = input;
  const acquisitionCost = input.costCheck.value;
  const acquiredAt = input.acquiredCheck.value;
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      "SELECT status, cart_order_id, location, price, suggested_price, suggested_level, is_clearance FROM book_copies WHERE id = $1 AND book_id = $2 FOR UPDATE",
      [copyId, bookId]
    );
    const stored = rows[0];
    if (!stored) return { missing: true };
    const wanted = input.status || stored.status;
    const rendered = input.renderedStatus || stored.status;
    let newStatus = stored.status;
    let keptStatus = false;
    if (wanted !== rendered) {
      if (stored.status !== rendered) {
        return { error: `This copy changed since you opened the form (now: ${statusLabelOf(stored.status)}). Reload.`, status: 409 };
      }
      // A sold copy or one in somebody's checkout keeps its status; the other
      // fields are still saved (and the page says so).
      // A copy reserved online by a customer also keeps its status: it is released
      // from its order page (Cancel reservation), never from here.
      if (stored.status === "sold" || stored.status === "in_cart" || (stored.status === "reserved" && stored.cart_order_id)) keptStatus = true;
      else newStatus = wanted;
    }
    const startsReservation = newStatus === "reserved" && stored.status !== "reserved";
    const endsReservation = stored.status === "reserved" && newStatus !== "reserved";
    // The suggestion shown with the form (if any) is kept; otherwise what was
    // stored stays. A price chosen as "Clearance" marks the copy as clearance;
    // any other price change clears the mark.
    const learning = learningFields(price, input.priceForm, stored);
    const unchangedPrice = stored.price != null && price != null && Math.round(Number(stored.price) * 100) === Math.round(price * 100);
    const isClearance = condition !== "new" && (choice.isClearance != null ? choice.isClearance : Boolean(stored.is_clearance) && unchangedPrice);
    // A reservation made from this form gets reserved_at like any other, so it
    // expires after the usual two weeks (lib/reservations.js); leaving
    // "reserved" clears who it was held for.
    await client.query(
      `UPDATE book_copies SET condition=$1, status=$2, price=$3, publisher_price=$4, acquisition_cost=$5, acquired_at=$6, notes=$7, location=$10, source=$11,
              suggested_price=$12, suggested_level=$13, price_basis=$14, is_clearance=$15,
              reserved_by_name = CASE WHEN $16::boolean THEN NULL ELSE reserved_by_name END,
              reserved_by_email = CASE WHEN $16::boolean THEN NULL ELSE reserved_by_email END,
              reserved_by_phone = CASE WHEN $16::boolean THEN NULL ELSE reserved_by_phone END,
              reminder_sent_at = CASE WHEN $16::boolean OR $17::boolean THEN NULL ELSE reminder_sent_at END,
              reserved_at = CASE WHEN $16::boolean THEN NULL WHEN $17::boolean THEN now() ELSE reserved_at END,
              updated_at=now()
       WHERE id = $8 AND book_id = $9`,
      [condition, newStatus, price, publisherPrice, acquisitionCost, acquiredAt, notes, copyId, bookId, location, source,
        learning.suggestedPrice, learning.suggestedLevel, learning.priceBasis, isClearance, endsReservation, startsReservation]
    );
    return { before: stored, keptStatus };
  });
}

// ---------- Cancel a reservation ----------

// Only a copy that is still reserved goes back to stock: one that was sold since the page was opened must
// not be put back on sale. A copy reserved online (it has an order) is released from that order's page instead.
// -> { orderId } (held by an order: nothing changed) | { gone: status } (no longer reserved) | { done: true }
async function cancelReservation(pool, bookId, copyId) {
  const { rows: held } = await pool.query("SELECT cart_order_id FROM book_copies WHERE id = $1 AND book_id = $2 AND status = 'reserved'", [copyId, bookId]);
  if (held[0] && held[0].cart_order_id) return { orderId: held[0].cart_order_id };
  const { rowCount } = await pool.query(
    `UPDATE book_copies SET status='in_stock', reserved_by_name=NULL, reserved_by_email=NULL,
            reserved_by_phone=NULL, reserved_at=NULL, reminder_sent_at=NULL, updated_at=now()
     WHERE id = $1 AND book_id = $2 AND status = 'reserved' AND cart_order_id IS NULL`,
    [copyId, bookId]
  );
  if (!rowCount) {
    const { rows } = await pool.query("SELECT status FROM book_copies WHERE id = $1 AND book_id = $2", [copyId, bookId]);
    if (rows.length) return { gone: rows[0].status };
  }
  return { done: true };
}

// ---------- Delete ----------

// order_items point at copies with no ON DELETE action, so anything that has ever been ordered can't be
// deleted (Postgres 23503): { hasOrders: true } instead of a 500.
async function deleteBook(pool, bookId, ctx) {
  try {
    await pool.query("DELETE FROM books WHERE id = $1", [bookId]);
  } catch (err) {
    if (err.code !== "23503") throw err;
    return { hasOrders: true };
  }
  await ctx.audit({ action: "book.delete", targetType: "book", targetId: bookId });
  return { deleted: true };
}

// Deletes the copy; the book goes with its last copy. -> { hasOrders: true } | { bookRemoved: boolean }
async function deleteCopy(pool, bookId, copyId, ctx) {
  try {
    await pool.query("DELETE FROM book_copies WHERE id = $1 AND book_id = $2", [copyId, bookId]);
  } catch (err) {
    if (err.code !== "23503") throw err;
    return { hasOrders: true };
  }
  await ctx.audit({ action: "book_copy.delete", targetType: "book_copy", targetId: copyId });
  const { rows } = await pool.query("SELECT 1 FROM book_copies WHERE book_id = $1", [bookId]);
  if (!rows.length) {
    await pool.query("DELETE FROM books WHERE id = $1", [bookId]);
    await ctx.audit({ action: "book.delete", targetType: "book", targetId: bookId, detail: "last copy removed" });
    return { bookRemoved: true };
  }
  return { bookRemoved: false };
}

module.exports = {
  parseAcquisitionCost, asTyped, learningFields, statusLabelOf, isStatusValue,
  parseCopyEdit, priceCopyEdit, copyEditOverlay, updateCopy, cancelReservation, deleteBook, deleteCopy,
};
