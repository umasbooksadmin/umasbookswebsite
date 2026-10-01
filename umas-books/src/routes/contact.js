const express = require("express");
const rateLimit = require("express-rate-limit");
const { sendMail } = require("../mailer");
const { isEmail } = require("../lib/validation");

const router = express.Router();

// Where contact-form messages are delivered.
const CONTACT_TO = process.env.CONTACT_TO || "admin@umasbooks.org";

const TOPICS = ["General question", "Books & orders", "English programs", "Events", "Donating books", "Membership", "Other"];

// Public form, so keep it from being used to spam the inbox.
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).render("contact", {
      topics: TOPICS, sent: false, values: req.body || {},
      error: "Too many messages from this connection — please try again in a little while, or email admin@umasbooks.org.",
    }),
});

router.get("/contact", (req, res) => {
  res.render("contact", { topics: TOPICS, sent: req.query.sent === "1", error: null, values: {} });
});

router.post("/contact", contactLimiter, async (req, res) => {
  const values = {
    name: String(req.body.name || "").trim().slice(0, 120),
    email: String(req.body.email || "").trim().slice(0, 200),
    topic: TOPICS.includes(req.body.topic) ? req.body.topic : "General question",
    message: String(req.body.message || "").trim().slice(0, 5000),
  };

  // Honeypot: real visitors never see or fill this field.
  if (req.body.website) return res.redirect("/contact?sent=1");

  if (!values.name || !values.message || !isEmail(values.email)) {
    return res.status(400).render("contact", {
      topics: TOPICS, sent: false, values,
      error: "Please fill in your name, a valid email address and your message.",
    });
  }

  try {
    await sendMail({
      to: CONTACT_TO,
      // {name, address} form, not a hand-built "Name <addr>" string: a name
      // containing "<boss@x.org>, y" would otherwise add extra Reply-To entries.
      replyTo: { name: values.name.replace(/[<>",;\r\n]/g, " "), address: values.email },
      subject: `Website contact: ${values.topic} — ${values.name}`,
      text:
        `New message from the website contact form\n\n` +
        `Name: ${values.name}\nEmail: ${values.email}\nTopic: ${values.topic}\n\n` +
        `${values.message}\n`,
    });
  } catch (err) {
    console.error("Contact form email failed:", err);
    return res.status(500).render("contact", {
      topics: TOPICS, sent: false, values,
      error: "Sorry, your message couldn't be sent just now. Please try again, or email admin@umasbooks.org.",
    });
  }
  res.redirect("/contact?sent=1");
});

module.exports = router;
