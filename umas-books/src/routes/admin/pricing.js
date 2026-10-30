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
const { colorChartRows } = require("../../lib/pricing/colorChart");
const { levelText } = require("../../lib/pricing/intake");
const reprice = require("../../lib/pricing/reprice");
const { csvCell, CSV_SEP } = require("../../lib/reports");
const { parseIntParam } = require("../../lib/parseParams");

const router = express.Router();
validateIdParams(router, "copyId", "runId");

const REVIEW_PAGE = 200;
const SAMPLE_VALUES = [2, 4, 5.5, 6, 12, 19.99, 20, 35, 49.99, 50, 80];
const BINDING_COLUMNS = [
  { value: "", label: "Binding unknown" }, { value: "mass_market", label: "Mass Market" },
  { value: "trade", label: "Trade" }, { value: "hardcover", label: "Hardback" }, { value: "other", label: "Other" },
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
  const copies = parseIntParam(query.calcCopies, { max: 1000 });
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
    bindingColumns: BINDING_COLUMNS, money, colorChart: colorChartRows(settings),
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
  if (!levels.includes(Number(settings.tradePrice))) levels.push(Number(settings.tradePrice));
  if (!levels.includes(Number(settings.massMarketPrice))) levels.push(Number(settings.massMarketPrice));
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
  const offset = parseIntParam(req.query.offset, { min: 0, max: 1000000, default: 0 });
  const skipped = req.query.skipped != null ? parseIntParam(req.query.skipped, { max: 1000000 }) : 0;
  const notice = req.query.cleared != null
    ? `Clearance applied to ${parseIntParam(req.query.cleared, { max: 1000000 })} copies.` +
      (skipped ? ` ${skipped} ${skipped === 1 ? "copy was" : "copies were"} skipped because ${skipped === 1 ? "it was" : "they were"} no longer in stock (sold, reserved or withdrawn) and keep${skipped === 1 ? "s" : ""} the price ${skipped === 1 ? "it" : "they"} had.` : "")
    : req.query.notice === "gone" ? "That copy is no longer in stock (sold, reserved or withdrawn), so its price was not changed." : null;
  await reviewPage(res, { offset, notice });
});

router.post("/admin/pricing/review/:copyId", requireAdmin, async (req, res) => {
  const copyId = Number(req.params.copyId);
  const offset = parseIntParam(req.body.offset, { min: 0, max: 1000000, default: 0 });
  const settings = await getSettings(pool);
  const { rows } = await pool.query(
    `SELECT c.id, c.price, c.condition, c.status, c.publisher_price, b.isbn, b.binding
     FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1`, [copyId]
  );
  const copy = rows[0];
  if (copy && copy.status !== "in_stock") {
    // Sold / reserved / withdrawn copies are never repriced: the price on a sold copy is part of the sale record.
    return res.redirect(`/admin/pricing/review?offset=${offset}&notice=gone`);
  }
  if (copy && copy.status === "in_stock" && copy.condition !== "new") {
    const s = rulesSuggestionFor(copy, await cachedComparables(pool, [copy.isbn]), settings);
    if (s && s.price != null) {
      // status re-checked in the UPDATE itself: a sale between the SELECT above and here must not be repriced.
      const upd = await pool.query(
        `UPDATE book_copies SET price=$1, suggested_price=$1, suggested_level=$2, price_basis='suggested', is_clearance=false, updated_at=now()
         WHERE id=$3 AND status='in_stock'`,
        [s.price, levelText(s), copyId]
      );
      if (!upd.rowCount) return res.redirect(`/admin/pricing/review?offset=${offset}&notice=gone`);
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
  // Only copies still in stock are repriced (status re-checked in the UPDATE itself: a copy sold or reserved
  // since the list was computed keeps its price). Skipped ones are counted and shown to the admin.
  const applied = [];
  await withTransaction(pool, async (client) => {
    for (const c of candidates) {
      const r = await client.query(
        "UPDATE book_copies SET price = $1, is_clearance = true, updated_at = now() WHERE id = $2 AND status = 'in_stock'",
        [settings.clearance.price, c.id]
      );
      if (r.rowCount) applied.push(c);
    }
  });
  for (const c of applied) {
    await audit(req, {
      action: "copy.reprice", targetType: "book_copy", targetId: c.id,
      detail: `price ${c.price != null ? c.price.toFixed(2) : "none"} -> ${Number(settings.clearance.price).toFixed(2)} (clearance)`,
    });
  }
  const skipped = candidates.length - applied.length;
  res.redirect(`/admin/pricing/review?cleared=${applied.length}${skipped ? `&skipped=${skipped}` : ""}`);
});

// ---------- Reprice (one-off: Trade and Mass Market at a flat price, no EUR 8) ----------

function repriceRunLabel(run) {
  const g = reprice.groupByKey(run.group_key);
  return `${g ? g.letter : "?"}: ${g ? g.title : run.group_key}`;
}

router.get("/admin/pricing/reprice", requireAdmin, async (req, res) => {
  const settings = await getSettings(pool);
  const groups = await reprice.previewGroups(pool, settings);
  const none = reprice.groupByKey(String(req.query.none || ""));
  const stale = reprice.groupByKey(String(req.query.stale || ""));
  const was = parseIntParam(req.query.was, { max: 1000000 });
  const now = parseIntParam(req.query.now, { max: 1000000 });
  res.render("admin/pricing/reprice", {
    active: "pricing", money, groups, runs: await reprice.recentRuns(pool), repriceRunLabel,
    notice: none ? `Group ${none.letter}: nothing left to change (a second run finds nothing).` : null,
    error: stale ? `Group ${stale.letter} was NOT changed: the copies in it are no longer the ones you previewed (you confirmed ${was}, there are now ${now}, or they are different copies). Nothing was applied. Review the new preview below and confirm again.` : null,
  });
});

// Applies ONE group, but only if the live set is EXACTLY the one previewed: the confirm form posts
// the previewed count and a hash of the previewed copy ids (src/lib/pricing/reprice.js).
router.post("/admin/pricing/reprice/:group", requireAdmin, async (req, res) => {
  const group = reprice.groupByKey(req.params.group);
  if (!group) return res.status(404).render("404");
  const settings = await getSettings(pool);
  const user = req.session && req.session.user;
  const expectedCount = String(req.body.expectedCount || "");
  const expectedHash = String(req.body.expectedHash || "");
  if (!/^\d+$/.test(expectedCount) || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    // A form without the previewed count and hash is never applied: re-preview.
    return res.redirect(303, `/admin/pricing/reprice?stale=${group.key}&was=0&now=0`);
  }
  const result = await reprice.applyGroup(pool, group.key, settings, { id: user ? user.id : null, role: "admin" }, { count: Number(expectedCount), hash: expectedHash });
  if (result.mismatch) {
    await audit(req, { action: "pricing.reprice.refused", detail: `Group ${group.letter} (${group.key}): previewed ${result.expectedCount}, live ${result.liveCount}` });
    return res.redirect(303, `/admin/pricing/reprice?stale=${group.key}&was=${result.expectedCount}&now=${result.liveCount}`);
  }
  if (!result.runId) return res.redirect(303, `/admin/pricing/reprice?none=${group.key}`);
  await audit(req, {
    action: "pricing.reprice", targetType: "price_reprice_run", targetId: result.runId,
    detail: `Group ${group.letter} (${group.key}): ${result.changed} copies -> ${Number(result.target).toFixed(2)}`,
  });
  res.redirect(303, `/admin/pricing/reprice/runs/${result.runId}`);
});

router.get("/admin/pricing/reprice/runs/:runId", requireAdmin, async (req, res) => {
  const run = await reprice.getRun(pool, Number(req.params.runId));
  if (!run) return res.status(404).render("404");
  const items = await reprice.runItems(pool, run.id);
  const isLast = (await reprice.lastRunId(pool)) === run.id;
  res.render("admin/pricing/reprice_result", {
    active: "pricing", run, items: items.slice(0, 200), total: items.length, money, label: repriceRunLabel(run), isLast,
    notice: req.query.undone != null ? `Undone: ${parseIntParam(req.query.undone, { max: 1000000 })} copies back at their previous price, ${parseIntParam(req.query.skipped, { max: 1000000 })} left alone (sold, reserved or changed since).` : null,
    error: req.query.undostale ? "Nothing was undone: the copies that can be restored are no longer the ones you previewed. Review the preview and confirm again." : null,
  });
});

// "Undo this run": preview first (how many copies go back, how many are left alone), then confirm.
// Only the LAST run can be undone, and only copies still at the price the run set and still in stock.
router.get("/admin/pricing/reprice/runs/:runId/undo", requireAdmin, async (req, res) => {
  const run = await reprice.getRun(pool, Number(req.params.runId));
  if (!run) return res.status(404).render("404");
  const isLast = (await reprice.lastRunId(pool)) === run.id;
  const undo = isLast ? await reprice.previewUndo(pool, run.id) : null;
  res.render("admin/pricing/reprice_undo", { active: "pricing", run, label: repriceRunLabel(run), isLast, undo, money });
});

router.post("/admin/pricing/reprice/runs/:runId/undo", requireAdmin, async (req, res) => {
  const run = await reprice.getRun(pool, Number(req.params.runId));
  if (!run) return res.status(404).render("404");
  const expectedCount = String(req.body.expectedCount || "");
  const expectedHash = String(req.body.expectedHash || "");
  if (!/^\d+$/.test(expectedCount) || !/^[0-9a-f]{64}$/.test(expectedHash)) return res.redirect(303, `/admin/pricing/reprice/runs/${run.id}/undo`);
  const result = await reprice.undoRun(pool, run.id, { count: Number(expectedCount), hash: expectedHash });
  if (result.notLast) return res.redirect(303, `/admin/pricing/reprice/runs/${run.id}/undo`);
  if (result.mismatch) return res.redirect(303, `/admin/pricing/reprice/runs/${run.id}?undostale=1`);
  await audit(req, {
    action: "pricing.reprice.undo", targetType: "price_reprice_run", targetId: run.id,
    detail: `Group ${run.group_key}: ${result.restored} copies restored, ${result.skipped} left alone`,
  });
  res.redirect(303, `/admin/pricing/reprice/runs/${run.id}?undone=${result.restored}&skipped=${result.skipped}`);
});

// Before/after of every copy a run changed, so a revert is possible.
router.get("/admin/pricing/reprice/runs/:runId/export.csv", requireAdmin, async (req, res) => {
  const run = await reprice.getRun(pool, Number(req.params.runId));
  if (!run) return res.status(404).render("404");
  const items = await reprice.runItems(pool, run.id);
  const header = ["run", "group", "copy_id", "book_id", "title", "binding", "old_price", "new_price", "old_suggested_price", "old_suggested_level", "old_price_basis"];
  const num = (v) => ({ bare: v == null ? "" : Number(v).toFixed(2) }); // prices are written as plain numbers
  const lines = [header.map(csvCell).join(CSV_SEP)];
  for (const i of items) {
    lines.push([run.id, run.group_key, i.copy_id, i.book_id, i.title, i.binding, num(i.old_price), num(i.new_price), num(i.old_suggested_price), i.old_suggested_level, i.old_price_basis]
      .map((v) => (v && typeof v === "object" ? v.bare : typeof v === "number" ? v : csvCell(v))).join(CSV_SEP));
  }
  await audit(req, { action: "pricing.reprice.csv", targetType: "price_reprice_run", targetId: run.id, detail: `${items.length} copies` });
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="umas-books-reprice-run-${run.id}-${run.group_key}.csv"`,
    "Cache-Control": "no-store",
  });
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
});

module.exports = router;
