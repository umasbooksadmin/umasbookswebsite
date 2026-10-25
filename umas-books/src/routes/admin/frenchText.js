const express = require("express");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { sanitizeHtml } = require("../../lib/sanitizeHtml");
const { SPECS } = require("../../lib/frenchText");
const { translateFields } = require("../../lib/frenchTranslate");
const { aiAdminLimiter } = require("../../middleware/rateLimits");

const router = express.Router();

// "Translate to French" in the admin editors of events, sessions, announcements and charities (the blog has its own
// route, routes/admin/blog.js). The editor's script (public/french-translate.js) sends what is typed in the form;
// nothing is saved here, and the French text comes back to be read and edited. It calls the paid AI service, so: 10
// a minute per admin, plus the shared daily cap (one call per press).
const translateLimit = aiAdminLimiter();
router.post("/admin/translate-french/:kind", requireAdmin, translateLimit, async (req, res) => {
  const kind = String(req.params.kind);
  const spec = Object.prototype.hasOwnProperty.call(SPECS, kind) ? SPECS[kind] : null;
  if (!spec) return res.status(404).json({ error: "Unknown kind of text." });
  const pick = (k) => String(Array.isArray(req.body[k]) ? req.body[k][0] : req.body[k] == null ? "" : req.body[k]);
  const typed = {};
  for (const f of spec.fields) {
    typed[f] = spec.html.includes(f) ? sanitizeHtml(pick(f).trim()) : pick(f);
    typed[`${f}_fr`] = pick(`${f}_fr`);
  }
  const result = await translateFields(kind, typed, { overwrite: pick("overwrite") === "1" });
  await audit(req, { action: "french.translate", targetType: kind, detail: result.ok ? `${result.filled.length} filled` : "failed" });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({
    values: result.values,
    filled: result.filled,
    notice: "French filled in below. Read it, change what you like, then press Save: nothing is saved until you do." +
      (result.partial ? " Part of it could not be translated this time: translate again, or write the rest by hand." : ""),
  });
});

module.exports = router;
