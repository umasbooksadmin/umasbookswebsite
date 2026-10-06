// Copy barcode labels: /admin/inventory/labels. Every copy has a label with a
// Code 128 barcode of "UB-<copyId>", the price color chip, the price, a short
// title, the author and the ISBN (or "No ISBN"). Mounted BEFORE the inventory
// router ("labels" is not a book id).
//
//   GET /admin/inventory/labels                       pick copies (filters like the stickers page)
//   GET /admin/inventory/labels?id=12&id=13           the label sheet for those copies
//   GET /admin/inventory/labels?all=1&since=...       the sheet for every copy the filters show
//   &w=50&h=25 (mm, default 50x25)   &layout=roll|sheet (roll: one label per page, sheet: a grid)

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { SITE_TIME_ZONE } = require("../../lib/tz");
const { validDay, todayParis, addDays } = require("../../lib/reports");
const { normalizeLocation, conditionLabel } = require("../../lib/inventory");
const colors = require("../../lib/priceColors");
const code128 = require("../../lib/code128");
const { copyCode } = require("../../lib/tillScan");

const router = express.Router();
router.use("/admin/inventory", colors.exposeToViews);

const LIST_LIMIT = 500;
const SHEET_LIMIT = 300;
const DEFAULT_DAYS = 7;
const SIZE = { w: { min: 20, max: 210, def: 50 }, h: { min: 10, max: 150, def: 25 } };

function parseSize(query) {
  const one = (v, r) => {
    const n = Number(typeof v === "string" ? v.replace(",", ".") : NaN);
    return Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, Math.round(n * 10) / 10)) : r.def;
  };
  return { w: one(query.w, SIZE.w), h: one(query.h, SIZE.h), layout: query.layout === "sheet" ? "sheet" : "roll" };
}

function parseIds(query) {
  const raw = [].concat(query.id === undefined ? [] : query.id, query.copy === undefined ? [] : query.copy);
  const ids = raw.filter((v) => typeof v === "string" && /^\d{1,9}$/.test(v)).map(Number);
  return [...new Set(ids)].slice(0, SHEET_LIMIT);
}

function parseFilters(query, now = new Date()) {
  const since = validDay(typeof query.since === "string" ? query.since : "") || addDays(todayParis(now), -DEFAULT_DAYS);
  const location = normalizeLocation(typeof query.location === "string" ? query.location : "");
  const color = typeof query.color === "string" && colors.COLOR_KEYS.includes(query.color) ? query.color : null;
  return { since, location, color };
}

const COLUMNS = `c.id, c.book_id, c.price, c.publisher_price, c.condition, c.is_clearance, c.location, c.status, b.title, b.authors, b.isbn`;

async function loadByIds(ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = ANY($1) ORDER BY c.id`, [ids]
  );
  return rows;
}

async function loadFiltered({ since, location, color }) {
  const params = [since];
  let where = `c.status = 'in_stock' AND c.created_at >= ($1::date)::timestamp AT TIME ZONE '${SITE_TIME_ZONE}'`;
  if (location) {
    params.push(location);
    where += ` AND c.location = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM book_copies c JOIN books b ON b.id = c.book_id WHERE ${where}
     ORDER BY c.location NULLS LAST, b.title, c.id LIMIT ${LIST_LIMIT + 1}`, params
  );
  const withColor = rows.slice(0, LIST_LIMIT).map((r) => ({ ...r, level: colors.colorFor(r) }));
  return { rows: color ? withColor.filter((r) => r.level.key === color) : withColor, truncated: rows.length > LIST_LIMIT };
}

const clip = (s, n) => { const t = String(s || "").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// What one label shows. The price: the asking price, or for a new book with no
// price the publisher's.
function labelFor(r) {
  const level = colors.colorFor(r);
  const price = r.price != null ? Number(r.price) : (r.condition === "new" && r.publisher_price != null ? Number(r.publisher_price) : null);
  const code = copyCode(r.id);
  return {
    id: r.id, code, svg: code128.svg(code, { height: 40 }), level,
    price: price == null ? "" : `€${price.toFixed(2)}`,
    title: clip(r.title, 42), author: clip(r.authors, 30), isbn: r.isbn || "", conditionLabel: conditionLabel(r.condition),
  };
}

router.get("/admin/inventory/labels", requireAdmin, async (req, res) => {
  const size = parseSize(req.query);
  const filters = parseFilters(req.query);
  const ids = parseIds(req.query);
  const wantsAll = req.query.all === "1";

  if (ids.length || wantsAll) {
    let rows;
    let truncated = false;
    if (ids.length) rows = await loadByIds(ids);
    else {
      const f = await loadFiltered(filters);
      rows = f.rows.slice(0, SHEET_LIMIT);
      truncated = f.rows.length > SHEET_LIMIT;
    }
    await audit(req, { action: "labels.print", targetType: "labels", detail: `${rows.length} label(s) ${size.w}x${size.h}mm ${size.layout}` });
    return res.render("admin/inventory/label_sheet", {
      active: "inventory", mainWide: true, title: "Copy labels", pageTitle: "Copy labels",
      labels: rows.map(labelFor), size, truncated, sheetLimit: SHEET_LIMIT, filters, ids,
    });
  }

  const { rows, truncated } = await loadFiltered(filters);
  const { rows: locs } = await pool.query("SELECT DISTINCT location FROM book_copies WHERE location IS NOT NULL ORDER BY 1");
  res.render("admin/inventory/labels", {
    active: "inventory", mainWide: true, title: "Copy labels", pageTitle: "Copy labels",
    rows, truncated, rowLimit: LIST_LIMIT, filters, size, locations: locs.map((r) => r.location), conditionLabel, copyCode,
  });
});

module.exports = router;
module.exports.parseSize = parseSize;
