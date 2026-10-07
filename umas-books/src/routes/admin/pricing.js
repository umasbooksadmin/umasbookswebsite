// Pricing rules (/admin/pricing), the price check (/admin/pricing/review) and
// clearance candidates. Admin only; English only. See lib/pricing for the rules.

const express = require("express");
const { pool, withTransaction } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { setFlash, takeFlash } = require("../../lib/flash");
const { audit } = require("../../lib/audit");
const { validateIdParams } = require("../../middleware/idParams");
const { getSettings, getSettingsAndRow, validateSettingsInput, saveSettings, NUMBER_FIELDS } = require("../../lib/pricing/settings");
const { suggestFromRules } = require("../../lib/pricing/rules");
const { ruleName } = require("../../lib/pricing");
const { clearanceCandidates, cachedComparables, rulesSuggestionFor } = require("../../lib/pricing/clearance");
const { levelText } = require("../../lib/pricing/intake");

const router = express.Router();
validateIdParams(router, "copyId");

const REVIEW_PAGE = 200;
const SAMPLE_VALUES = [2, 4, 5.5, 6, 12, 19.99, 20, 35, 49.99, 50, 80];
const BINDING_COLUMNS = [
  { value: "", label: "Binding unknown" }, { value: "hardcover", label: "Hardcover" },
  { value: "trade", label: "Trade" }, { value: "mass_market", label: "Mass Market" }, { value: "other", label: "Other" },
];
const SAMPLE_ISBN = "9780000000002"; // any valid-looking ISBN: samples are about the rules, not a real book

const money = (n) => (n == null ? "" : Number(n).toFixed(2));

// What the settings form shows: the stored values, or what was just typed.
function formValues(row) {
  const out = {};
  for (const f of NUMBER_FIELDS) out[f.col] = row[f.col] == null ? "" : String(Number(row[f.col]));
  out.clearance_scope = row.clearance_scope;
  out.clearance_applies_to = row.clearance_applies_to;
  out.hardcover_min_applies_to_clearance = row.hardcover_min_applies_to_clearance === true;
  out.levels = (Array.isArray(row.levels) ? row.levels : []).join(", ");
  return out;
}

function typedValues(body) {
  const out = {};
  for (const f of NUMBER_FIELDS) out[f.col] = String(body[f.col] == null ? "" : body[f.col]);
  out.clearance_scope = body.clearance_scope;
  out.clearance_applies_to = body.clearance_applies_to;
  out.hardcover_min_applies_to_clearance = ["1", "on", "true"].includes(body.hardcover_min_applies_to_clearance);
  out.levels = String(body.levels == null ? "" : body.levels);
  return out;
}

function calculator(settings, query) {
  const market = Number(String(query.calcMarket == null ? "" : query.calcMarket).replace(",", "."));
  const copies = Math.max(0, Math.min(1000, parseInt(query.calcCopies, 10) || 0));
  const calc = {
    market: query.calcMarket == null || query.calcMarket === "" ? "" : String(query.calcMarket),
    binding: BINDING_COLUMNS.some((b) => b.value === query.calcBinding) ? query.calcBinding : "",
    copies,
    isbn: query.calcIsbn !== "no",
    result: null,
  };
  if (calc.market !== "" && Number.isFinite(market) && market >= 0) {
    const r = suggestFromRules({
      condition: "very_good", binding: calc.binding || null, isbn: calc.isbn ? SAMPLE_ISBN : "", marketEur: market, existingCopies: copies, settings,
    });
    calc.result = { price: r.price, rule: ruleName(r), message: r.reviewMessage };
  }
  const sample = (value, isbn, binding) => suggestFromRules({ condition: "very_good", binding: binding || null, isbn, marketEur: value, existingCopies: 0, settings });
  const cell = (r) => (r.price == null ? "Manual review" : `EUR ${money(r.price)}`);
  calc.table = SAMPLE_VALUES.map((v) => ({ value: v, cells: BINDING_COLUMNS.map((b) => cell(sample(v, SAMPLE_ISBN, b.value))) }));
  calc.noIsbn = cell(sample(10, "", ""));
  return calc;
}

async function renderSettings(res, { error = null, form = null, saved = false, query = {} } = {}) {
  const { settings, row } = await getSettingsAndRow(pool, Date.now(), { fresh: true });
  res.render("admin/pricing/settings", {
    active: "pricing", error, saved, form: form || formValues(row), calc: calculator(settings, query),
    bindingColumns: BINDING_COLUMNS, money,
  });
}

router.get("/admin/pricing", requireAdmin, async (req, res) => {
  // A refused save redirects here (Post/Redirect/Get) with the message and what was typed.
  const f = takeFlash(req, "pricing");
  if (f && f.error) return renderSettings(res, { error: String(f.error), form: f.form || null, query: req.query });
  await renderSettings(res, { saved: req.query.saved === "1", query: req.query });
});

router.post("/admin/pricing", requireAdmin, async (req, res) => {
  const parsed = validateSettingsInput(req.body);
  if (parsed.error) {
    await setFlash(req, "pricing", { error: parsed.error, form: typedValues(req.body) });
    return res.redirect(303, "/admin/pricing");
  }
  const changed = await saveSettings(pool, parsed.values);
  if (changed.length) await audit(req, { action: "pricing.settings", detail: changed.join(", ") });
  res.redirect("/admin/pricing?saved=1");
});

// ---------- Price check ----------

// In-stock priced copies (not new) with what the rules alone suggest, using
// market data that is already cached (never an AI call).
async function reviewRows(settings) {
  const { rows } = await pool.query(
    `SELECT c.id, c.book_id, c.price, c.condition, c.publisher_price, c.is_clearance, b.title, b.isbn, b.binding
     FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.status = 'in_stock' AND c.condition <> 'new' AND c.price IS NOT NULL
     ORDER BY c.id`
  );
  const cache = await cachedComparables(pool, rows.map((r) => r.isbn));
  const levels = settings.levels.map(Number);
  if (!levels.includes(Number(settings.aPrice))) levels.push(Number(settings.aPrice));
  if (!levels.includes(Number(settings.bPrice))) levels.push(Number(settings.bPrice));
  const out = [];
  for (const r of rows) {
    const price = Number(r.price);
    if (r.is_clearance && Math.abs(price - settings.clearance.price) < 0.005) continue;
    const s = rulesSuggestionFor(r, cache, settings);
    if (!s || s.price == null) continue; // nothing to suggest: it is for a person (see "Needs review")
    if (Math.abs(price - s.price) < 0.005) continue; // already what the rules suggest
    out.push({
      id: r.id, bookId: r.book_id, title: r.title, price, suggested: s.price, rule: ruleName(s),
      reason: levels.includes(price) ? "Differs from the suggested price" : "Not one of the standard prices",
    });
  }
  return out;
}

async function reviewPage(res, { offset = 0, notice = null } = {}) {
  const settings = await getSettings(pool);
  const all = await reviewRows(settings);
  const { rows: needs } = await pool.query(
    `SELECT c.id, c.book_id, c.price, c.condition, b.title FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.suggested_level = 'review' AND c.status = 'in_stock' AND (c.price IS NULL OR c.price = 5)
     ORDER BY c.id LIMIT 200`
  );
  const candidates = await clearanceCandidates(pool, settings);
  res.render("admin/pricing/review", {
    active: "pricing", notice, money, offset, total: all.length, pageSize: REVIEW_PAGE,
    rows: all.slice(offset, offset + REVIEW_PAGE), needs, candidates, clearance: settings.clearance,
  });
}

router.get("/admin/pricing/review", requireAdmin, async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const notice = req.query.cleared != null ? `Clearance applied to ${Math.max(0, parseInt(req.query.cleared, 10) || 0)} copies.` : null;
  await reviewPage(res, { offset, notice });
});

router.post("/admin/pricing/review/:copyId", requireAdmin, async (req, res) => {
  const copyId = Number(req.params.copyId);
  const offset = Math.max(0, parseInt(req.body.offset, 10) || 0);
  const settings = await getSettings(pool);
  const { rows } = await pool.query(
    `SELECT c.id, c.price, c.condition, c.status, c.publisher_price, b.isbn, b.binding
     FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1`, [copyId]
  );
  const copy = rows[0];
  if (copy && copy.status === "in_stock" && copy.condition !== "new") {
    const s = rulesSuggestionFor(copy, await cachedComparables(pool, [copy.isbn]), settings);
    if (s && s.price != null) {
      await pool.query(
        `UPDATE book_copies SET price=$1, suggested_price=$1, suggested_level=$2, price_basis='suggested', is_clearance=false, updated_at=now() WHERE id=$3`,
        [s.price, levelText(s), copyId]
      );
      await audit(req, {
        action: "copy.reprice", targetType: "book_copy", targetId: copyId,
        detail: `price ${copy.price != null ? Number(copy.price).toFixed(2) : "none"} -> ${s.price.toFixed(2)}`,
      });
    }
  }
  res.redirect(`/admin/pricing/review?offset=${offset}`);
});

// Applies clearance to the candidates (recomputed here: the page's list is only a preview).
router.post("/admin/pricing/clearance", requireAdmin, async (req, res) => {
  const settings = await getSettings(pool);
  const candidates = await clearanceCandidates(pool, settings);
  await withTransaction(pool, async (client) => {
    for (const c of candidates) {
      await client.query("UPDATE book_copies SET price = $1, is_clearance = true, updated_at = now() WHERE id = $2", [settings.clearance.price, c.id]);
    }
  });
  for (const c of candidates) {
    await audit(req, {
      action: "copy.reprice", targetType: "book_copy", targetId: c.id,
      detail: `price ${c.price != null ? c.price.toFixed(2) : "none"} -> ${Number(settings.clearance.price).toFixed(2)} (clearance)`,
    });
  }
  res.redirect(`/admin/pricing/review?cleared=${candidates.length}`);
});

module.exports = router;
