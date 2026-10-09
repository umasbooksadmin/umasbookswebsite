// Preloaded into the test app (node --require) by the French crawler: every mail the
// app hands to the mailer (src/mailer.js sendMail) is appended, as one JSON line, to
// the file named by MAIL_CAPTURE_FILE, and is not sent. This sees the full text of the
// one-time-link mails too (the outbox blanks those after sending) and the mails sent
// straight through the mailer. Test use only: nothing in the app depends on it.
const Module = require("node:module");
const fs = require("node:fs");

const file = process.env.MAIL_CAPTURE_FILE;
const original = Module.prototype.require;
if (file) {
  Module.prototype.require = function (id) {
    const loaded = original.apply(this, arguments);
    if (/(^|[\\/])mailer(\.js)?$/.test(String(id)) && loaded && typeof loaded.sendMail === "function" && !loaded.__captured) {
      loaded.__captured = true;
      loaded.sendMail = async (mail) => {
        fs.appendFileSync(file, JSON.stringify({ to: mail.to, subject: mail.subject, text: mail.text, html: mail.html || null }) + "\n");
      };
    }
    return loaded;
  };
}
