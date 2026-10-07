// Printable sticker sheet: in-stock copies with the color of their price
// sticker (see lib/priceColors), so volunteers can print the list and stick
// the right colors. Mounted BEFORE the inventory router ("stickers" is not a
// book id).
//
//   GET /admin/inventory/stickers               the sheet
//   GET /admin/inventory/stickers?format=csv    the same rows as a CSV download (audited; the smoke
//                                               crawler skips ?format=csv, see scripts/sitemap/crawler.js)
//
// Filters: ?since=YYYY-MM-DD (copies added on or after, default the last 7
// days, Paris time), ?location=, ?color=<level key>.

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { SITE_TIME_ZONE } = require("../../lib/tz");
const { validDay, todayParis, addDays, csvCell } = require("../../lib/reports");
const { normalizeLocation, conditionLabel, bindingLabel } = require("../../lib/inventory");
const colors = require("../../lib/priceColors");

const router = express.Router();
router.use("/admin/inventory", require("../../lib/priceColors").exposeToViews); // chips in the views
const ROW_LIMIT = 5000;
const DEFAULT_DAYS = 7;

// since: a valid day or the default; location: normalized or null; color: a known key or null.
function parseFilters(query, now = new Date()) {
  const today = todayParis(now);
  const since = validDay(typeof query.since === "string" ? query.since : "") || addDays(today, -DEFAULT_DAYS);
  const location = normalizeLocation(typeof query.location === "string" ? query.location : "");
  const color = typeof query.color === "string" && colors.COLOR_KEYS.includes(query.color) ? query.color : null;
  return { since, location, color };
}

async function loadRows({ since, location, color }) {
  const params = [since];
  let where = `c.status = 'in_stock' AND c.created_at >= ($1::date)::timestamp AT TIME ZONE '${SITE_TIME_ZONE}'`;
  if (location) {
    params.push(location);
    where += ` AND c.location = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.book_id, c.price, c.condition, c.is_clearance, c.location, c.created_at,
            b.title, b.authors, b.isbn, b.binding
     FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE ${where}
     ORDER BY c.location NULLS LAST, b.title, c.id
     LIMIT ${ROW_LIMIT + 1}`,
    params
  );
  const truncated = rows.length > ROW_LIMIT;
  const out = rows.slice(0, ROW_LIMIT).map((r) => ({ ...r, level: colors.colorFor(r) }));
  const filtered = color ? out.filter((r) => r.level.key === color) : out;
  const rank = (r) => colors.SORT_ORDER.indexOf(r.level.key);
  filtered.sort((a, b) => {
    const la = a.location || "￿";
    const lb = b.location || "￿";
    if (la !== lb) return la < lb ? -1 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return String(a.title).localeCompare(String(b.title)) || a.id - b.id;
  });
  return { rows: filtered, truncated };
}

const priceText = (p) => (p == null ? "" : Number(p).toFixed(2));

function toCsv(rows) {
  const head = ["Color", "Price (EUR)", "Title", "Author", "ISBN", "Condition", "Binding", "Location"].map(csvCell).join(",");
  const lines = rows.map((r) => [
    csvCell(r.level.label), priceText(r.price), csvCell(r.title), csvCell(r.authors), csvCell(r.isbn),
    csvCell(conditionLabel(r.condition)), csvCell(bindingLabel(r.binding)), csvCell(r.location),
  ].join(","));
  return "\uFEFF" + [head, ...lines].join("\r\n") + "\r\n";
}

router.get("/admin/inventory/stickers", requireAdmin, async (req, res) => {
  const filters = parseFilters(req.query);
  const { rows, truncated } = await loadRows(filters);

  if (req.query.format === "csv") {
    await audit(req, { action: "stickers.csv", targetType: "stickers", detail: `since=${filters.since}${filters.location ? ` location=${filters.location}` : ""}${filters.color ? ` color=${filters.color}` : ""}` });
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="umas-books-stickers-since-${filters.since}.csv"`,
      "Cache-Control": "no-store",
    });
    return res.send(toCsv(rows));
  }

  const { rows: locs } = await pool.query("SELECT DISTINCT location FROM book_copies WHERE location IS NOT NULL ORDER BY 1");
  res.render("admin/inventory/stickers", {
    active: "stickers", rows, truncated, rowLimit: ROW_LIMIT, filters, locations: locs.map((r) => r.location),
    conditionLabel, bindingLabel, priceText,
  });
});

module.exports = router;
module.exports.parseFilters = parseFilters;
