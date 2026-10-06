// The two marketing-site forms that used to open the visitor's email app
// ("mailto:"): the English Immersion pre-registration and the volunteer
// sign-up. They now POST here, like /contact (routes/contact.js): CSRF token
// (checked by the app-wide middleware), honeypot, per-IP rate limit, server-side
// validation, then ONE email to the contact inbox. Nothing is stored in the
// database; the email is kept 12 months in the mailbox and then deleted (privacy
// policy, docs/privacy/record-of-processing.md).
//
// The pages themselves are GET /pre-registration.html and /volunteer.html
// (src/index.js). res.locals.form tells the view what to show:
//   { sent }                       the thank-you state (/<page>?sent=1)
//   { values, errors, error }      a refused submission: what was typed, per-field
//                                  errors { field: { key, label } }, and a page-level
//                                  error ("ratelimit" | "send")
// Nothing typed is ever written to a log: failures log the error message only.

const express = require("express");
const { limit } = require("../middleware/rateLimits");
const { sendMail } = require("../mailer");
const { renderMarketing, commonDictionary } = require("../lib/pageDictionary");
const { marketingCsp } = require("../lib/marketingCsp");
const { setMarketingSeoLocals } = require("./seo");
const forms = require("../lib/marketingForms");

const router = express.Router();

const CONTACT_TO = process.env.CONTACT_TO || "admin@umasbooks.org";

// ONE place that sends these emails: swap this body (e.g. for the outbox) without touching the routes.
async function deliver(mail) {
  await sendMail({ to: CONTACT_TO, ...mail });
}

const FORMS = [
  {
    name: "Pre-registration", post: "/pre-registration", page: "pre-registration.html", view: "marketing/pre-registration",
    validate: forms.validatePreRegistration, buildEmail: forms.preRegistrationEmail,
  },
  {
    name: "Volunteer sign-up", post: "/volunteer-signup", page: "volunteer.html", view: "marketing/volunteer",
    validate: forms.validateVolunteer, buildEmail: forms.volunteerEmail,
  },
];
const FORM_PAGES = FORMS.map((f) => "/" + f.page);

// English text of a form.err.* message (the views print it; the French server
// render and the language toggle swap it through data-i18n).
function formMsg(key) {
  return commonDictionary("en")[key] || key;
}

// For the form pages (GET here and in src/index.js, and the POST re-render):
// the local every form view needs, and a header that keeps a page carrying a
// personal CSRF token out of shared caches.
function prepareFormPage(res) {
  res.locals.formMsg = formMsg;
  res.set("Cache-Control", "private, no-store");
}

function showForm(cfg, req, res, next, status, form) {
  res.status(status);
  res.set("Content-Security-Policy", marketingCsp());
  setMarketingSeoLocals(req, res, "/" + cfg.page);
  prepareFormPage(res);
  res.locals.form = form;
  renderMarketing(req, res, next, cfg.view);
}

for (const cfg of FORMS) {
  // Public form: keep it from being used to spam the inbox. Refused attempts count too.
  const limiter = limit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    handler: (req, res, next) => {
      const { values } = cfg.validate(req.body || {});
      showForm(cfg, req, res, next, 429, { values, errors: {}, error: "ratelimit" });
    },
  });

  router.post(cfg.post, limiter, async (req, res, next) => {
    // Honeypot: real people never see or fill this field. Looks like success to a bot.
    if (req.body.website) return res.redirect(`/${cfg.page}?sent=1`);

    const { values, errors, ok } = cfg.validate(req.body);
    if (!ok) return showForm(cfg, req, res, next, 400, { values, errors, error: null });

    try {
      await deliver(cfg.buildEmail(values, req.lang));
    } catch (err) {
      console.error(`${cfg.name} email failed:`, err && err.message);
      return showForm(cfg, req, res, next, 500, { values, errors: {}, error: "send" });
    }
    res.redirect(`/${cfg.page}?sent=1`);
  });
}

module.exports = router;
module.exports.FORM_PAGES = FORM_PAGES;
module.exports.prepareFormPage = prepareFormPage;
