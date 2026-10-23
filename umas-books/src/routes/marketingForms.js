// The two marketing-site forms that used to open the visitor's email app
// ("mailto:"): the English Immersion pre-registration and the volunteer
// sign-up. They now POST here, like /contact (routes/contact.js): CSRF token
// (checked by the app-wide middleware), honeypot, per-IP rate limit, server-side
// validation, then ONE email to the contact inbox. The email is kept 12 months in
// the mailbox and then deleted; a copy stays in the email outbox (30 days, 90 if
// sending failed) and in the backups (up to 2 years), then it is erased (privacy
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
const config = require("../lib/config");
const { limit } = require("../middleware/rateLimits");
const { sendEmail } = require("../lib/outbox");
const { commonDictionary } = require("../lib/pageDictionary");
const forms = require("../lib/marketingForms");
const { redirectWithFlash, takePageFlash } = require("../lib/postRedirect");

const router = express.Router();

const CONTACT_TO = config.get("CONTACT_TO");

// ONE place that sends these emails. They go through the email outbox (lib/outbox.js)
// like the contact form, so a failed send is retried; the copy in the database is
// erased after 30 days (90 if it could not be sent).
async function deliver(mail) {
  await sendEmail({ kind: "contact", to: CONTACT_TO, ...mail });
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

// A refused submission goes back to the page by redirect (lib/postRedirect.js), so Back never offers
// to resubmit the form: what was typed and the errors travel once in the session, and the page's GET
// route (src/index.js, flashKey) shows them. The thank-you state is /<page>?sent=1, which a reload keeps.
const flashKey = (page) => `marketingForm:${page}`;
function refuseForm(cfg, req, res, form) {
  return redirectWithFlash(req, res, `/${cfg.page}`, flashKey(cfg.page), form);
}

for (const cfg of FORMS) {
  // Public form: keep it from being used to spam the inbox. Refused attempts count too.
  const limiter = limit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    handler: (req, res) => {
      const { values } = cfg.validate(req.body || {});
      return refuseForm(cfg, req, res, { values, errors: {}, error: "ratelimit" });
    },
  });

  router.post(cfg.post, limiter, async (req, res) => {
    // Honeypot: real people never see or fill this field. Looks like success to a bot.
    if (req.body.website) return res.redirect(`/${cfg.page}?sent=1`);

    const { values, errors, ok } = cfg.validate(req.body);
    if (!ok) return refuseForm(cfg, req, res, { values, errors, error: null });

    try {
      await deliver(cfg.buildEmail(values, req.lang));
    } catch (err) {
      console.error(`${cfg.name} email failed:`, err && err.message);
      return refuseForm(cfg, req, res, { values, errors: {}, error: "send" });
    }
    res.redirect(`/${cfg.page}?sent=1`);
  });
}

module.exports = router;
module.exports.FORM_PAGES = FORM_PAGES;
module.exports.prepareFormPage = prepareFormPage;
// res.locals.form for a form page's GET: what a refused submission left (typed values, errors), or the thank-you state.
module.exports.setFormState = (req, res, file) => {
  res.locals.form = takePageFlash(req, res, flashKey(file)) || { sent: req.query.sent === "1" };
};
