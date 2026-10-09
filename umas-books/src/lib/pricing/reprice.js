// One-off "Reprice" tool (/admin/pricing/reprice) for the pricing change
// "Trade and Mass Market at a flat EUR 5, no EUR 8": three groups of copies
// already in stock, each previewed first and applied only when an admin
// confirms THAT group.
//
//   trade         A: Trade copies not at the Trade price (5.00)        -> Trade price
//   mass_market   B: Mass Market copies not at the Mass market price  -> Mass market price
//   eight_to_ten  C: copies of any other binding priced exactly 8.00  -> 10.00
//
// Only plain, priced, in-stock copies are touched: never clearance copies,
// never new books (their price is fixed by the publisher: loi Lang), and
// never a copy that is reserved, sold, in a cart or in an open order or
// book-request hold. Reserved copies keep their price, and an order stores its
// own line price (order_items.price), so existing orders are never affected.
//
// Applying a group is ONE transaction: the eligible rows are locked
// (FOR UPDATE SKIP LOCKED, conditions re-checked once the lock is held) and
// updated with the same conditions in the UPDATE, so a copy sold, reserved or
// edited between the preview and the confirmation is simply not changed. A
// second run finds nothing left to change. Every changed copy is recorded
// (before/after) in price_reprice_items, which feeds the CSV export.

const { withTransaction } = require("../../db");

const SAMPLE_SIZE = 25;
const EIGHT = 8;
const TEN = 10;

const GROUPS = [
  { key: "trade", letter: "A", title: "Trade copies", binding: "trade" },
  { key: "mass_market", letter: "B", title: "Mass Market copies", binding: "mass_market" },
  { key: "eight_to_ten", letter: "C", title: "Other bindings (Hardback, Other, unknown) priced EUR 8.00", binding: null },
];

const groupByKey = (key) => GROUPS.find((g) => g.key === key) || null;

// The price a group moves copies to, from the saved settings (C is fixed).
function targetPrice(group, settings) {
  if (group.key === "trade") return Number(settings.tradePrice);
  if (group.key === "mass_market") return Number(settings.massMarketPrice);
  return TEN;
}

// "The copy is plain and on the shelf". `c` is book_copies, `b` is books.
const PLAIN_IN_STOCK = `
  c.status = 'in_stock' AND c.is_clearance = false AND c.condition <> 'new'
  AND c.price IS NOT NULL
  AND c.cart_order_id IS NULL AND c.cart_added_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE oi.book_copy_id = c.id AND o.status IN ('reserved', 'pending'))
  AND NOT EXISTS (SELECT 1 FROM book_requests r WHERE r.matched_copy_id = c.id AND r.status IN ('matched', 'notified'))`;

// SQL condition (alias c, b) and its parameters, starting at $start.
function eligibleSql(group, target, start = 1) {
  if (group.key === "eight_to_ten") {
    return { sql: `${PLAIN_IN_STOCK} AND c.price = $${start} AND b.binding IS DISTINCT FROM 'trade' AND b.binding IS DISTINCT FROM 'mass_market'`, params: [EIGHT] };
  }
  return { sql: `${PLAIN_IN_STOCK} AND b.binding = $${start} AND c.price <> $${start + 1}`, params: [group.binding, target] };
}

// Preview of every group: count and a sample, nothing is changed.
async function previewGroups(pool, settings) {
  const out = [];
  for (const g of GROUPS) {
    const target = targetPrice(g, settings);
    const { sql, params } = eligibleSql(g, target);
    const { rows: count } = await pool.query(`SELECT COUNT(*)::int AS n FROM book_copies c JOIN books b ON b.id = c.book_id WHERE ${sql}`, params);
    const { rows: sample } = await pool.query(
      `SELECT c.id, c.book_id, c.price, b.title, b.binding FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE ${sql} ORDER BY c.id LIMIT ${SAMPLE_SIZE}`, params
    );
    out.push({ ...g, target, count: count[0].n, sample: sample.map((r) => ({ ...r, price: Number(r.price) })) });
  }
  return out;
}

// Applies one group. Returns { runId, changed, target } (changed may be 0:
// then no run is recorded and runId is null).
async function applyGroup(pool, key, settings, actor = {}) {
  const group = groupByKey(key);
  if (!group) throw new Error(`Unknown reprice group ${key}`);
  const target = targetPrice(group, settings);
  const { sql, params } = eligibleSql(group, target);
  return withTransaction(pool, async (client) => {
    // Lock the candidates; rows another transaction holds are skipped, and
    // the conditions are checked again on the locked version of each row.
    const { rows: locked } = await client.query(
      `SELECT c.id, c.book_id, c.price, c.suggested_price, c.suggested_level, c.price_basis, b.title, b.binding
       FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE ${sql} ORDER BY c.id FOR UPDATE OF c SKIP LOCKED`, params
    );
    if (!locked.length) return { runId: null, changed: 0, target };
    const ids = locked.map((r) => r.id);
    const level = String(Number(target));
    // Same conditions again in the UPDATE (defence in depth), keyed by the locked ids.
    const { sql: again, params: againParams } = eligibleSql(group, target, 4);
    const { rows: updated } = await client.query(
      `UPDATE book_copies c
       SET price = $1, suggested_price = $1, suggested_level = $2, price_basis = 'repriced', is_clearance = false, updated_at = now()
       FROM books b
       WHERE b.id = c.book_id AND c.id = ANY($3::int[]) AND ${again}
       RETURNING c.id`,
      [target, level, ids, ...againParams]
    );
    const done = new Set(updated.map((r) => r.id));
    const changedRows = locked.filter((r) => done.has(r.id));
    if (!changedRows.length) return { runId: null, changed: 0, target };
    const { rows: run } = await client.query(
      `INSERT INTO price_reprice_runs (group_key, new_price, copies_changed, actor_user_id, actor_label)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [key, target, changedRows.length, actor.id ?? null, actor.label ?? null]
    );
    const runId = run[0].id;
    await client.query(
      `INSERT INTO price_reprice_items (run_id, copy_id, book_id, title, binding, old_price, new_price, old_suggested_price, old_suggested_level, old_price_basis)
       SELECT $1, t.id, t.book_id, t.title, t.binding, t.price, $2, t.suggested_price, t.suggested_level, t.price_basis
       FROM jsonb_to_recordset($3::jsonb) AS t(id int, book_id int, title text, binding text, price numeric, suggested_price numeric, suggested_level text, price_basis text)`,
      [runId, target, JSON.stringify(changedRows)]
    );
    return { runId, changed: changedRows.length, target };
  });
}

async function getRun(pool, runId) {
  const { rows } = await pool.query("SELECT * FROM price_reprice_runs WHERE id = $1", [runId]);
  return rows[0] || null;
}

async function runItems(pool, runId) {
  const { rows } = await pool.query("SELECT * FROM price_reprice_items WHERE run_id = $1 ORDER BY copy_id", [runId]);
  return rows;
}

async function recentRuns(pool, limit = 20) {
  const { rows } = await pool.query("SELECT * FROM price_reprice_runs ORDER BY id DESC LIMIT $1", [limit]);
  return rows;
}

module.exports = { GROUPS, groupByKey, targetPrice, previewGroups, applyGroup, getRun, runItems, recentRuns, PLAIN_IN_STOCK };
