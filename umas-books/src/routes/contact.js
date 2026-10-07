const express = require("express");
const { limit } = require("../middleware/rateLimits");
const { redirectWithFlash, takePageFlash } = require("../lib/postRedirect");
const { sendEmail } = require("../lib/outbox");
const { isPreviewMode } = require("../lib/preview");
const { isEmail, emailSafeName } = require("../lib/validation");

const router = express.Router();

// Where contact-form messages are delivered.
const CONTACT_TO = process.env.CONTACT_TO || "admin@umasbooks.org";

const TOPICS = ["General question", "Books & orders", "English programs", "Events", "Donating books", "Membership", "Other"];
// Only offered while the site is in preview mode (lib/preview.js), but always
// accepted when posted. The stored value stays English like the others.
const FEEDBACK_TOPIC = "Feedback on the preview";
const ALL_TOPICS = [...TOPICS, FEEDBACK_TOPIC];
const topicsFor = () => (isPreviewMode() ? [FEEDBACK_TOPIC, ...TOPICS] : TOPICS);

// Public form, so keep it from being used to spam the inbox.
const contactLimiter = limit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  handler: (req, res) =>
    redirectWithFlash(req, res, "/contact", "contact", {
      values: typedValues(req.body || {}),
      error: req.tr(
        "Too many messages from this connection — please try again in a little while, or email admin@umasbooks.org.",
        "Trop de messages depuis cette connexion — veuillez réessayer dans un moment, ou écrire à admin@umasbooks.org."
      ),
    }),
});

// What the form had typed, to put back on the page after a refusal: strings only, same caps as the POST.
function typedValues(body) {
  const str = (v, max) => String(typeof v === "string" ? v : "").trim().slice(0, max);
  return {
    name: str(body.name, 120),
    email: str(body.email, 200),
    topic: ALL_TOPICS.includes(body.topic) ? body.topic : "General question",
    message: str(body.message, 5000),
  };
}

router.get("/contact", (req, res) => {
  // /contact?topic=feedback pre-selects the preview-feedback topic.
  // A refused form (POST /contact) left its message and what was typed here, once.
  const flash = takePageFlash(req, res, "contact");
  if (flash) return res.render("contact", { topics: topicsFor(), sent: false, error: flash.error, values: flash.values || {} });
  const values = isPreviewMode() && req.query.topic === "feedback" ? { topic: FEEDBACK_TOPIC } : {};
  res.render("contact", { topics: topicsFor(), sent: req.query.sent === "1", error: null, values });
});

router.post("/contact", contactLimiter, async (req, res) => {
  const values = {
    name: String(req.body.name || "").trim().slice(0, 120),
    email: String(req.body.email || "").trim().slice(0, 200),
    topic: ALL_TOPICS.includes(req.body.topic) ? req.body.topic : "General question",
    message: String(req.body.message || "").trim().slice(0, 5000),
  };

  // Honeypot: real people never see or fill this field.
  if (req.body.website) return res.redirect("/contact?sent=1");

  if (!values.name || !values.message || !isEmail(values.email)) {
    return redirectWithFlash(req, res, "/contact", "contact", {
      values,
      error: req.tr(
        "Please fill in your name, a valid email address and your message.",
        "Veuillez indiquer votre nom, une adresse email valide et votre message."
      ),
    });
  }

  try {
    await sendEmail({
      kind: "contact",
      to: CONTACT_TO,
      // {name, address} form, not a hand-built "Name <addr>" string: a name
      // containing "<boss@x.org>, y" would otherwise add extra Reply-To entries.
      replyTo: { name: emailSafeName(values.name).replace(/[<>",;\r\n]/g, " "), address: values.email },
      subject: `Website contact: ${values.topic} — ${emailSafeName(values.name)}`,
      text:
        `New message from the website contact form\n\n` +
        `Name: ${emailSafeName(values.name)}\nEmail: ${values.email}\nTopic: ${values.topic}\n\n` +
        `${values.message}\n`,
    });
  } catch (err) {
    console.error("Contact form email failed:", err);
    return redirectWithFlash(req, res, "/contact", "contact", {
      values,
      error: req.tr(
        "Sorry, your message couldn't be sent just now. Please try again, or email admin@umasbooks.org.",
        "Désolé, votre message n’a pas pu être envoyé pour le moment. Veuillez réessayer, ou écrire à admin@umasbooks.org."
      ),
    });
  }
  res.redirect("/contact?sent=1");
});

module.exports = router;
