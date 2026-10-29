// Admin > Genres (/admin/genres): manage the genre names of the catalogue. English only, admin only.
//
//   managed genres   the list of genres the shop wants (English names, listed A to Z, and how each one shows on the public Browse page)
//   found genres     every distinct raw genre in books.categories with its book count and the managed genre it is slotted into
//   rules            "this genre / any genre containing this word becomes ..." (lib/genreRules.js: first match wins)
//   AI help          proposes slots for unmapped genres; nothing is saved until the admin ticks and saves
//   Update all books preview -> confirm -> audit -> Undo (lib/genreRun.js), like the Reprice tool
//
// Only the "Update all books" confirm (and Undo) change books. Every other action here edits the lists and rules.
// All writes are POSTs with CSRF that redirect (Post/Redirect/Get); the one JSON answer is the "Slot into..." select's fetch().

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { limit, aiAdminLimiter, AI_LIMIT_MESSAGE } = require("../../middleware/rateLimits");
const { setFlash, takeFlash } = require("../../lib/flash");
const { audit } = require("../../lib/audit");
const { validateIdParams } = require("../../middleware/idParams");
const { parseIntParam } = require("../../lib/parseParams");
const { loadRules, genreKey } = require("../../lib/genreRules");
const admin = require("../../lib/genreAdmin");
const run = require("../../lib/genreRun");
const { suggestSlots } = require("../../lib/genreSuggest");
const { PALETTE, ICONS } = require("../../lib/browseGenres");

const router = express.Router();
validateIdParams(router, "id");

const FLASH = "genres";
const FLASH_APPLY = "genres_apply";
const PAGE_SIZE = 100;
const FILTERS = ["all", "unmapped", "mapped"];
const SORT_KEYS = ["books", "books-asc", "name", "name-desc", "target"];

const flash = (req, data) => setFlash(req, FLASH, data);
const str = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
const userOf = (req) => (req.session && req.session.user) || {};

// 30 a minute per admin for the write buttons that are cheap but bulk-capable (the slot select fires once per change).
const userKey = (prefix) => (req) => `${prefix}-${req.session && req.session.user ? req.session.user.id : "anon"}`;
const writeLimit = limit({
  windowMs: 60 * 1000, max: 120, keyGenerator: userKey("genres-write"), validate: { keyGeneratorIpFallback: false },
  handler: async (req, res) => { await flash(req, { error: "Too many changes in a minute: wait a moment and try again." }); res.redirect(303, "/admin/genres"); },
});
// The preview reads every book, the apply and undo rewrite them: a few a minute is plenty.
const bulkLimit = limit({
  windowMs: 60 * 1000, max: 6, keyGenerator: userKey("genres-bulk"), validate: { keyGeneratorIpFallback: false },
  handler: async (req, res) => { await setFlash(req, FLASH_APPLY, { error: "Too many requests in a minute: wait a moment and try again." }); res.redirect(303, "/admin/genres/apply"); },
});
const aiLimit = aiAdminLimiter({
  handler: async (req, res) => { await flash(req, { error: AI_LIMIT_MESSAGE }); res.redirect(303, "/admin/genres"); },
});

// The table's filter / sort / page, as a clean query string (whatever the request carried is reduced to known values).
function tableQuery(src) {
  const p = new URLSearchParams();
  const q = str(src.q, 80).replace(/[\u0000-\u001f]/g, "").trim(); // eslint-disable-line no-control-regex
  if (q) p.set("q", q);
  if (FILTERS.includes(src.filter) && src.filter !== "all") p.set("filter", src.filter);
  if (SORT_KEYS.includes(src.sort) && src.sort !== admin.DEFAULT_SORT) p.set("sort", src.sort);
  const page = parseIntParam(src.page, { min: 1, max: 100000, default: 1 });
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `?${s}` : "";
}
const backTo = (body, anchor = "found") => `/admin/genres${tableQuery(body || {})}#${anchor}`;

// ---------- the page ----------

router.get("/admin/genres", requireAdmin, async (req, res) => {
  const f = takeFlash(req, FLASH) || {};
  const filter = FILTERS.includes(req.query.filter) ? req.query.filter : "all";
  const sort = SORT_KEYS.includes(req.query.sort) ? req.query.sort : admin.DEFAULT_SORT;
  const page = parseIntParam(req.query.page, { min: 1, max: 100000, default: 1 });
  const q = str(req.query.q, 80).trim();
  const [found, managed, { rules }] = await Promise.all([admin.foundGenres(pool), admin.listManaged(pool), loadRules(pool)]);
  const table = admin.queryFound(found, rules, { filter, q, sort, page, pageSize: PAGE_SIZE });
  const storedRules = await admin.listRules(pool, found);
  const exactByKey = new Map(storedRules.filter((r) => r.kind === "exact").map((r) => [genreKey(r.pattern), r]));
  await run.reapStaleRuns(pool).catch(() => {}); // a run a crash left 'running' becomes 'failed (interrupted)'
  const lastRun = await run.getRun(pool, await run.undoableRunId(pool));
  res.set("Cache-Control", "private, no-store");
  res.render("admin/genres", {
    active: "genres", flash: f, managed, storedRules, table, exactByKey, filter, sort, q, PALETTE, ICONS, lastRun,
    genreKey,
    tableQuery: (over) => tableQuery({ q, filter, sort, page, ...over }),
    suggestions: f.suggestions || null,
  });
});

// "Show matches" for a rule before it is saved: the found genres it would take. Reads only.
router.get("/admin/genres/rules/preview", requireAdmin, async (req, res) => {
  const kind = req.query.kind === "exact" ? "exact" : "contains-word";
  const pattern = str(req.query.pattern, admin.PATTERN_MAX).trim();
  const [found, { rules }] = await Promise.all([admin.foundGenres(pool), loadRules(pool)]);
  const out = admin.previewRule(found, rules, { kind, pattern });
  res.set("Cache-Control", "private, no-store");
  res.json({ kind, pattern, genres: out.takes.length, books: out.books, takes: out.takes.slice(0, 200), handled: out.handled.slice(0, 50), more: Math.max(0, out.takes.length - 200) });
});

// ---------- managed genres ----------

router.post("/admin/genres/managed", requireAdmin, writeLimit, async (req, res) => {
  const r = await admin.addManaged(pool, { nameEn: req.body.nameEn });
  if (!r.ok) {
    await flash(req, { error: r.error });
    return res.redirect(303, "/admin/genres#managed");
  }
  await audit(req, { action: "genre.managed_add", targetType: "managed_genre", targetId: r.id, detail: admin.cleanName(req.body.nameEn) });
  await flash(req, { notice: `Added "${admin.cleanName(req.body.nameEn)}". It shows on the Browse page (a minute from now at most); no book carries it until you slot genres into it.` });
  res.redirect(303, "/admin/genres#managed");
});

router.post("/admin/genres/managed/:id", requireAdmin, writeLimit, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const r = await admin.updateManaged(pool, id, {
    nameEn: b.nameEn, colour: b.colour, icon: b.icon, showOnBrowse: b.showOnBrowse === "1",
    labelEn: b.labelEn, topic: b.topic, browseOrder: /^\d{1,4}$/.test(String(b.browseOrder || "")) ? Number(b.browseOrder) : undefined,
  });
  if (!r.ok) {
    await flash(req, { error: r.error });
    return res.redirect(303, "/admin/genres#managed");
  }
  await audit(req, { action: "genre.managed_update", targetType: "managed_genre", targetId: id, detail: admin.cleanName(b.nameEn) });
  if (r.renamedFrom && b.everywhere === "1") {
    // "Rename everywhere": the rule old name -> new name now exists; show what Update all books would do.
    const plan = await run.planRun(pool);
    await setFlash(req, FLASH_APPLY, { preview: run.planSummary(plan), notice: `Renamed "${r.renamedFrom}" to "${admin.cleanName(b.nameEn)}". Check what changes in the books below, then confirm.` });
    return res.redirect(303, "/admin/genres/apply");
  }
  await flash(req, { notice: r.renamedFrom
    ? `Renamed "${r.renamedFrom}" to "${admin.cleanName(b.nameEn)}". Books still carry the old name until you press Update all books (a rule "${r.renamedFrom}" -> new name was added for that).`
    : "Saved." });
  res.redirect(303, "/admin/genres#managed");
});

// Deleting a genre asks first: its rules go with it (their genres become Unmapped).
router.get("/admin/genres/managed/:id/delete", requireAdmin, async (req, res) => {
  const impact = await admin.deleteImpact(pool, Number(req.params.id));
  if (!impact) return res.status(404).render("404");
  res.render("admin/genres_delete", { active: "genres", impact });
});

router.post("/admin/genres/managed/:id/delete", requireAdmin, writeLimit, async (req, res) => {
  const id = Number(req.params.id);
  const impact = await admin.deleteImpact(pool, id);
  if (impact && (await admin.deleteManaged(pool, id))) {
    await audit(req, { action: "genre.managed_delete", targetType: "managed_genre", targetId: id, detail: `${impact.genre.name_en}; ${impact.rules.length} rules unmapped` });
    await flash(req, { notice: `Deleted "${impact.genre.name_en}". ${impact.rules.length} rule${impact.rules.length === 1 ? "" : "s"} went with it: those genres are Unmapped again. Books keep their genres until you press Update all books.` });
  }
  res.redirect(303, "/admin/genres#managed");
});

// ---------- rules ----------

// Adds a rule (any genre containing the word X becomes Y).
router.post("/admin/genres/rules", requireAdmin, writeLimit, async (req, res) => {
  const kind = req.body.kind === "exact" ? "exact" : "contains-word";
  const r = await admin.saveRule(pool, { kind, pattern: req.body.pattern, target: req.body.target });
  if (!r.ok) {
    await flash(req, { error: r.error, ruleForm: { kind, pattern: str(req.body.pattern, 80), target: str(req.body.target, 20) } });
    return res.redirect(303, "/admin/genres#rules");
  }
  await audit(req, { action: "genre.rule_add", targetType: "genre_rule", targetId: r.id, detail: `${kind}: ${admin.cleanName(req.body.pattern, 80)} -> ${str(req.body.target, 20)}` });
  await flash(req, { notice: `Rule saved: ${kind === "exact" ? "the genre" : "any genre containing the word"} "${admin.cleanName(req.body.pattern, 80)}" is slotted. Books change only when you press Update all books.` });
  res.redirect(303, "/admin/genres#rules");
});

// "Slot into..." on a found genre: an EXACT rule, saved at once. JSON for the page's script, a redirect without it.
router.post("/admin/genres/slot", requireAdmin, writeLimit, async (req, res) => {
  const name = str(req.body.genre, admin.PATTERN_MAX);
  const r = await admin.saveRule(pool, { kind: "exact", pattern: name, target: req.body.target });
  const wantsJson = String(req.get("accept") || "").includes("application/json");
  if (r.ok) await audit(req, { action: r.removed ? "genre.rule_delete" : "genre.rule_add", targetType: "genre_rule", targetId: r.id, detail: `exact: ${admin.cleanName(name, 80)} -> ${str(req.body.target, 20)}` });
  if (wantsJson) {
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    const { rules } = await loadRules(pool);
    return res.json({ ok: true, label: admin.describeMatch(rules, name).targetLabel });
  }
  await flash(req, r.ok ? { notice: r.removed ? `"${name}" is unmapped again.` : `Saved: "${name}" is slotted.` } : { error: r.error });
  res.redirect(303, backTo(req.body));
});

router.post("/admin/genres/rules/:id", requireAdmin, writeLimit, async (req, res) => {
  const r = await admin.updateRule(pool, Number(req.params.id), { pattern: req.body.pattern, target: req.body.target });
  if (r.ok) await audit(req, { action: "genre.rule_update", targetType: "genre_rule", targetId: Number(req.params.id), detail: `${admin.cleanName(req.body.pattern, 80)} -> ${str(req.body.target, 20)}` });
  await flash(req, r.ok ? { notice: "Rule saved." } : { error: r.error });
  res.redirect(303, "/admin/genres#rules");
});

router.post("/admin/genres/rules/:id/move", requireAdmin, writeLimit, async (req, res) => {
  await admin.moveRule(pool, Number(req.params.id), req.body.dir === "up" ? "up" : "down");
  res.redirect(303, "/admin/genres#rules");
});

router.post("/admin/genres/rules/:id/delete", requireAdmin, writeLimit, async (req, res) => {
  const gone = await admin.deleteRule(pool, Number(req.params.id));
  if (gone) {
    await audit(req, { action: "genre.rule_delete", targetType: "genre_rule", targetId: Number(req.params.id), detail: `${gone.kind}: ${gone.pattern}` });
    await flash(req, { notice: `Rule deleted: "${gone.pattern}" is no longer slotted by it.` });
  }
  res.redirect(303, "/admin/genres#rules");
});

// ---------- AI help ----------

router.post("/admin/genres/suggest", requireAdmin, aiLimit, async (req, res) => {
  const [found, managed, { rules }] = await Promise.all([admin.foundGenres(pool), admin.listManaged(pool), loadRules(pool)]);
  const unmapped = admin.queryFound(found, rules, { filter: "unmapped", sort: "books", page: 1, pageSize: 100000 }).rows.map((r) => ({ name: r.name, books: r.books }));
  const out = await suggestSlots(unmapped, managed);
  if (!out.ok) {
    await flash(req, { error: out.error });
    return res.redirect(303, "/admin/genres#ai");
  }
  const proposals = out.proposals.slice().sort((a, b) => admin.compareNames(a.name, b.name));
  await flash(req, { suggestions: { proposals, rejected: out.rejected, asked: out.asked, notice: out.notice || null } });
  res.redirect(303, "/admin/genres#ai");
});

// Saves the proposals the admin ticked (repeated field "accept", value "<managed genre id>|<raw genre>") as exact rules.
router.post("/admin/genres/suggest/save", requireAdmin, writeLimit, async (req, res) => {
  const picked = [].concat(req.body.accept || []).slice(0, 300);
  let saved = 0;
  for (const item of picked) {
    const s = String(item);
    const i = s.indexOf("|");
    if (i < 1) continue;
    const r = await admin.saveRule(pool, { kind: "exact", pattern: s.slice(i + 1), target: `m:${s.slice(0, i)}` });
    if (r.ok) saved += 1;
  }
  if (saved) await audit(req, { action: "genre.rule_add", detail: `${saved} rules from AI suggestions` });
  await flash(req, { notice: saved ? `Saved ${saved} rule${saved === 1 ? "" : "s"} from the AI suggestions. Books change only when you press Update all books.` : "Nothing was ticked, so nothing was saved." });
  res.redirect(303, "/admin/genres#rules");
});

// ---------- Update all books ----------

// The preview: computed here (nothing is written), shown on the GET below.
router.post("/admin/genres/apply/preview", requireAdmin, bulkLimit, async (req, res) => {
  const plan = await run.planRun(pool);
  await setFlash(req, FLASH_APPLY, { preview: run.planSummary(plan) });
  res.redirect(303, "/admin/genres/apply");
});

router.get("/admin/genres/apply", requireAdmin, async (req, res) => {
  const f = takeFlash(req, FLASH_APPLY) || {};
  res.set("Cache-Control", "private, no-store");
  await run.reapStaleRuns(pool).catch(() => {});
  res.render("admin/genres_apply", { active: "genres", preview: f.preview || null, notice: f.notice || null, error: f.error || null, runs: await run.recentRuns(pool, 5) });
});

// Applies the plan only when it is EXACTLY the previewed one (count and fingerprint).
router.post("/admin/genres/apply", requireAdmin, bulkLimit, async (req, res) => {
  const expectedCount = String(req.body.expectedCount || "");
  const expectedHash = String(req.body.expectedHash || "");
  if (!/^\d{1,9}$/.test(expectedCount) || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    await setFlash(req, FLASH_APPLY, { error: "Nothing was changed: preview the update first, then confirm it." });
    return res.redirect(303, "/admin/genres/apply");
  }
  const user = userOf(req);
  const result = await run.applyRun(pool, { id: user.id || null }, { count: Number(expectedCount), hash: expectedHash });
  if (result.busy) {
    await setFlash(req, FLASH_APPLY, { error: "Another genre update is running right now. Wait for it to finish, then preview again." });
    return res.redirect(303, "/admin/genres/apply");
  }
  if (result.mismatch) {
    await audit(req, { action: "genre.apply_refused", detail: `previewed ${result.expectedCount}, live ${result.liveCount}` });
    const fresh = await run.planRun(pool);
    await setFlash(req, FLASH_APPLY, { preview: run.planSummary(fresh), error: `Nothing was changed: the books or the rules are no longer what you previewed (you confirmed ${result.expectedCount} books, there are now ${result.liveCount}, or the changes differ). This is the new preview: check it and confirm again.` });
    return res.redirect(303, "/admin/genres/apply");
  }
  if (!result.runId) {
    await flash(req, { notice: "Nothing to change: every book already follows the rules (a second run finds nothing)." });
    return res.redirect(303, "/admin/genres");
  }
  await audit(req, {
    action: "genre.apply", targetType: "genre_run", targetId: result.runId,
    detail: `${result.changed} books changed, ${result.skipped} skipped, ${result.stats.genresRemoved} genres removed`,
  });
  res.redirect(303, `/admin/genres/runs/${result.runId}`);
});

router.get("/admin/genres/runs/:id", requireAdmin, async (req, res) => {
  await run.reapStaleRuns(pool).catch(() => {});
  const r = await run.getRun(pool, Number(req.params.id));
  if (!r) return res.status(404).render("404");
  const f = takeFlash(req, FLASH) || {};
  const undoable = (await run.undoableRunId(pool)) === r.id;
  res.set("Cache-Control", "private, no-store");
  res.render("admin/genres_run", {
    active: "genres", run: r, examples: await run.runExamples(pool, r.id), undoable,
    undo: undoable ? await run.previewUndo(pool, r.id) : null, notice: f.notice || null, error: f.error || null,
  });
});

router.post("/admin/genres/runs/:id/undo", requireAdmin, bulkLimit, async (req, res) => {
  const id = Number(req.params.id);
  const expectedCount = String(req.body.expectedCount || "");
  const expectedHash = String(req.body.expectedHash || "");
  const back = `/admin/genres/runs/${id}`;
  if (!/^\d{1,9}$/.test(expectedCount) || !/^[0-9a-f]{64}$/.test(expectedHash)) return res.redirect(303, back);
  const result = await run.undoRun(pool, id, { count: Number(expectedCount), hash: expectedHash });
  if (result.notFound) return res.status(404).render("404");
  if (result.busy || result.notLast || result.mismatch) {
    await flash(req, { error: result.busy ? "Another genre update is running right now: try again in a minute."
      : result.notLast ? "Only the newest run that has not been undone can be undone."
        : "Nothing was undone: the books that can be restored are no longer the ones you saw. Look at the numbers below and confirm again." });
    return res.redirect(303, back);
  }
  await audit(req, { action: "genre.undo", targetType: "genre_run", targetId: id, detail: `${result.restored} books restored, ${result.skipped} left alone` });
  await flash(req, { notice: `Undone: ${result.restored} book${result.restored === 1 ? "" : "s"} back as they were, ${result.skipped} left alone (edited since, or deleted).` });
  res.redirect(303, back);
});

module.exports = router;
