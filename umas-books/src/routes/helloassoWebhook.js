const express = require("express");
const { limit } = require("../middleware/rateLimits");
const { pool } = require("../db");
const { syncMembershipForEmail } = require("../lib/membership");
const { scrubPersonalData } = require("../lib/scrub");
const { getSyncGuard } = require("../lib/webhookGuard");

const router = express.Router();

// This route has no signature to verify a call actually came from
// HelloAsso (see below), so its membership branch amounts to "anyone can
// ask us to re-check any email against HelloAsso's real API, as often as
// they like." findMembershipOrdersByEmail's exact-match check and
// syncMembershipForEmail's verified-email check (lib/helloasso.js,
// lib/membership.js) are what stop that from being able to misattribute
// anything — this is just a cap on how much of that re-checking one
// caller can force, since it costs a real outbound API call each time.
// Comfortably above anything a small shop's real transaction volume
// would ever hit — each payment sends several events and HelloAsso can
// deliver a burst at once, and a 429 here loses the notification, so this
// is generous (300 per 5 minutes per IP) but still bounded.
const webhookLimiter = limit({ windowMs: 5 * 60 * 1000, max: 300 });

// Looks up a dotted path across a couple of possible shapes: an "Order"
// event has formType directly under data, while a "Payment" event nests
// it under data.order instead — payer.email, though, sits at data.payer
// in both (see dev.helloasso.com's Order/Payment notification examples).
function pick(obj, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (value != null) return value;
  }
  return undefined;
}

// HelloAsso calls this after Order/Payment events (configured from the
// organization's HelloAsso dashboard under Mon Compte > Intégrations et
// API, pointed at <this app's URL>/webhooks/helloasso). It's an external
// POST with no CSRF token, so this router is mounted before
// app.use(csrfProtection) in index.js rather than after with the rest of
// the app's routes.
//
// ONLY MEMBERSHIP is paid through HelloAsso (books and drop-in seats are
// reserved on the site and paid in the shop), so this handles the Membership
// form's payments and nothing about orders: an old notification that names one
// of the old online-checkout orders is just logged.
//
// HelloAsso's docs don't publish the exact payload shape or a signature
// to verify it with, so this handler never trusts the body's content: the
// payer.email pulled from the body is only used to pick which email to
// re-check, and syncMembershipForEmail re-asks HelloAsso's API (with our own
// credentials) for that email's real Authorized orders (filtered to an exact
// payer-email match, not HelloAsso's own fuzzy userSearchKey — see
// lib/helloasso.js) and only ever applies them to a local account whose email
// is itself verified (lib/membership.js). A forged call here can, at worst,
// force an early re-check of one email against HelloAsso's real records —
// never attribute a payment to an account that hasn't proven it owns that email.
router.post("/webhooks/helloasso", webhookLimiter, express.json(), async (req, res) => {
  res.status(200).end(); // ack immediately — HelloAsso retries on non-200/timeout

  const body = req.body || {};
  try {
    const formType = pick(body, ["data.formType", "data.order.formType"]);
    const payerEmail = pick(body, ["data.payer.email"]);
    if (formType === "Membership" && payerEmail) {
      // Per-address cooldown + global cap (lib/webhookGuard.js): a forged flood cannot use up HelloAsso's API limits.
      const email = String(payerEmail).slice(0, 254);
      await getSyncGuard().request(email, () => syncMembershipForEmail(pool, email));
    } else {
      console.warn("HelloAsso webhook: not a membership payment, ignored:", scrubPersonalData(JSON.stringify(body)).slice(0, 500));
    }
  } catch (err) {
    console.error("HelloAsso webhook handling failed:", err.message);
  }
});

// A body that express.json rejects (malformed JSON, a bare scalar like
// `null`, an oversized or unsupported-encoding payload) never reaches the
// handler above, so it used to fall through to the app's 500 handler — and
// HelloAsso, seeing a non-200, retries the identical body again and again.
// There is nothing to act on in such a body (the handler never trusts the
// body's content anyway), so acknowledge it and log it. Anything that is not
// a body-parser rejection still goes to the normal error handler.
router.use("/webhooks/helloasso", (err, req, res, next) => {
  const rejectedBody = err && (String(err.type || "").startsWith("entity.") || [400, 413, 415].includes(err.status));
  if (!rejectedBody || res.headersSent) return next(err);
  console.warn(
    `HelloAsso webhook: ignored an unreadable body (${err.type || err.status}):`,
    String(err.body || "").slice(0, 200)
  );
  res.status(200).end();
});

module.exports = router;
