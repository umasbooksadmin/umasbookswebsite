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

const crypto = require("node:crypto");
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

// A fingerprint of the exact set of copies: sha256 of the sorted ids. The confirm form posts it
// (with the count) and Apply refuses when the live set is not exactly the previewed one.
function idsHash(ids) {
  return crypto.createHash("sha256").update([...ids].map(Number).sort((a, b) => a - b).join(",")).digest("hex");
}

// "raise" | "lower" | "same" for a copy going from `price` to `target`.
function direction(price, target) {
  const a = Math.round(Number(price) * 100);
  const b = Math.round(Number(target) * 100);
  return a < b ? "raise" : a > b ? "lower" : "same";
}

// Preview of every group: the full set (count, hash), how many copies would RAISE / LOWER /
// stay the same, and the first SAMPLE_SIZE of each direction. Nothing is changed.
async function previewGroups(pool, settings) {
  const out = [];
  for (const g of GROUPS) {
    const target = targetPrice(g, settings);
    const { sql, params } = eligibleSql(g, target);
    const { rows } = await pool.query(
      `SELECT c.id, c.book_id, c.price, b.title, b.binding FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE ${sql} ORDER BY c.id`, params
    );
    const all = rows.map((r) => ({ ...r, price: Number(r.price), direction: direction(r.price, target) }));
    const byDirection = (d) => all.filter((r) => r.direction === d);
    const raise = byDirection("raise");
    const lower = byDirection("lower");
    const same = byDirection("same");
    out.push({
      ...g, target, count: all.length, hash: idsHash(all.map((r) => r.id)),
      raiseCount: raise.length, lowerCount: lower.length, sameCount: same.length,
      raiseSample: raise.slice(0, SAMPLE_SIZE), lowerSample: lower.slice(0, SAMPLE_SIZE), sameSample: same.slice(0, SAMPLE_SIZE),
      // The first 25 overall (kept for older callers).
      sample: all.slice(0, SAMPLE_SIZE),
    });
  }
  return out;
}

// Applies one group. Returns { runId, changed, target } (changed may be 0:
// then no run is recorded and runId is null).
// `expected` ({ count, hash } from the preview the admin confirmed) makes Apply exact: when the
// live set differs in count or in ids, NOTHING is changed and { mismatch: true, expectedCount,
// liveCount } comes back, so the admin re-previews.
async function applyGroup(pool, key, settings, actor = {}, expected = null) {
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
    if (expected) {
      const liveHash = idsHash(locked.map((r) => r.id));
      if (locked.length !== Number(expected.count) || liveHash !== String(expected.hash)) {
        return { runId: null, changed: 0, target, mismatch: true, expectedCount: Number(expected.count), liveCount: locked.length };
      }
    }
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
      `INSERT INTO price_reprice_runs (group_key, new_price, copies_changed, actor_user_id, actor_role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [key, target, changedRows.length, actor.id ?? null, actor.role || "admin"]
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

// ---------- Undo the last run ----------

// The only run that can be undone is the most recent one (ids are serial).
async function lastRunId(db) {
  const { rows } = await db.query("SELECT max(id)::int AS id FROM price_reprice_runs");
  return rows[0].id;
}

// What an undo of `runId` would do: restore a copy's previous price ONLY while its price still
// equals the price the run set AND it is still in stock. Anything else (sold, reserved, edited by
// hand since) is left alone and counted as skipped.
const UNDO_ELIGIBLE = `c.price = i.new_price AND c.status = 'in_stock'`;

async function previewUndo(pool, runId) {
  const { rows } = await pool.query(
    `SELECT i.copy_id, i.title, i.old_price, i.new_price, (c.id IS NOT NULL AND ${UNDO_ELIGIBLE}) AS restorable
     FROM price_reprice_items i LEFT JOIN book_copies c ON c.id = i.copy_id
     WHERE i.run_id = $1 ORDER BY i.copy_id`, [runId]
  );
  const ok = rows.filter((r) => r.restorable);
  return {
    total: rows.length, count: ok.length, skipped: rows.length - ok.length,
    hash: idsHash(ok.map((r) => r.copy_id)),
    sample: ok.slice(0, SAMPLE_SIZE).map((r) => ({ ...r, old_price: r.old_price == null ? null : Number(r.old_price), new_price: Number(r.new_price) })),
  };
}

// Restores the previous prices of the LAST run. Same exactness as Apply: `expected`
// ({ count, hash }) from the confirmed preview must match the live restorable set.
// Resolves { restored, skipped } | { notLast: true } | { notFound: true } | { mismatch: true, ... }.
async function undoRun(pool, runId, expected = null) {
  return withTransaction(pool, async (client) => {
    const { rows: runRows } = await client.query("SELECT * FROM price_reprice_runs WHERE id = $1", [runId]);
    if (!runRows[0]) return { notFound: true };
    if ((await lastRunId(client)) !== runId) return { notLast: true };
    const { rows: locked } = await client.query(
      `SELECT i.copy_id, i.old_price, i.old_suggested_price, i.old_suggested_level, i.old_price_basis
       FROM price_reprice_items i JOIN book_copies c ON c.id = i.copy_id
       WHERE i.run_id = $1 AND ${UNDO_ELIGIBLE}
       ORDER BY i.copy_id FOR UPDATE OF c`, [runId]
    );
    if (expected) {
      if (locked.length !== Number(expected.count) || idsHash(locked.map((r) => r.copy_id)) !== String(expected.hash)) {
        return { mismatch: true, expectedCount: Number(expected.count), liveCount: locked.length };
      }
    }
    const { rows: total } = await client.query("SELECT count(*)::int AS n FROM price_reprice_items WHERE run_id = $1", [runId]);
    if (!locked.length) return { restored: 0, skipped: total[0].n, run: runRows[0] };
    // Conditions again in the UPDATE (defence in depth).
    const { rows: updated } = await client.query(
      `UPDATE book_copies c
       SET price = t.old_price, suggested_price = t.old_suggested_price, suggested_level = t.old_suggested_level,
           price_basis = t.old_price_basis, updated_at = now()
       FROM price_reprice_items t
       WHERE t.run_id = $1 AND t.copy_id = c.id AND t.copy_id = ANY($2::int[])
         AND c.price = t.new_price AND c.status = 'in_stock'
       RETURNING c.id`,
      [runId, locked.map((r) => r.copy_id)]
    );
    return { restored: updated.length, skipped: total[0].n - updated.length, run: runRows[0] };
  });
}

module.exports = {
  idsHash, direction, lastRunId, previewUndo, undoRun, GROUPS, groupByKey, targetPrice, previewGroups, applyGroup, getRun, runItems, recentRuns, PLAIN_IN_STOCK };
