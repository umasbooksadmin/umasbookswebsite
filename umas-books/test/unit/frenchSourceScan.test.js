// A second net under the French work: customer-facing server code (routes, middleware and
// the libraries that build customer messages) must not gain a new English sentence outside
// tr("English", "Français"). The scan (test/helpers/i18nSourceScan.js) is deliberately simple;
// what it finds today was read once and is listed in test/i18n-source-baseline.json: SQL
// fragments, log lines, messages for the admins, the English half of an {en, fr} pair, data
// sent to the admins. A NEW hit fails this test: translate it with tr(), or, if it really is
// not for customers, add it to the baseline (with the text exactly as shown below).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { scan } = require("../helpers/i18nSourceScan");
const baseline = require("../i18n-source-baseline.json");

test("no new untranslated English sentence in the customer-facing server code", () => {
  const known = new Set(baseline.map((b) => `${b.file}|${b.text}`));
  const fresh = scan()
    .filter((x) => !known.has(`${x.file}|${x.text.slice(0, 160)}`))
    .map((x) => `${x.file}:${x.line}: ${x.text.slice(0, 120)}`);
  assert.deepEqual(fresh, [], "English text outside tr(): use req.tr('English', 'Français') (or emailTr in emails), or add it to test/i18n-source-baseline.json if customers never see it");
});

test("the scan flags an English message outside tr() and ignores a translated pair, a pair in an array and SQL", () => {
  const { scanText } = require("../helpers/i18nSourceScan");
  const flagged = (src) => scanText(src, "x.js").map((x) => x.text);
  assert.deepEqual(flagged('res.send("Something is not available right now, please try again.");'), ["Something is not available right now, please try again."]);
  assert.deepEqual(flagged('res.send(req.tr("Something is not available right now, please try again.", "Ce service est indisponible pour le moment, veuillez réessayer."));'), []);
  assert.deepEqual(flagged('const M = ["Your reservation was cancelled and its items are back.", "Votre réservation a été annulée et ses articles sont de retour."];'), []);
  assert.deepEqual(flagged('pool.query("SELECT * FROM books WHERE title = the");'), []);
});
