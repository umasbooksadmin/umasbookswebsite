// The account emails (verification, "someone tried to sign up", password
// reset) are written in the account's stored language (users.lang) and fall
// back to English. No database or SMTP: pool.query and mailer.sendMail are
// stubbed.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/never_connected";
process.env.PGSSLMODE = "disable";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const sent = [];
// Must be replaced before the libs below destructure it. (The outbox itself,
// store-then-send, is covered in outbox.test.js.)
require("../../src/lib/outbox").sendEmail = async (opts) => { sent.push(opts); return { id: 1, sent: true }; };

const { pool } = require("../../src/db");
let langLookup = null;
pool.query = async (sql) => {
  if (/SELECT lang FROM users/.test(sql)) return { rows: langLookup === undefined ? [] : [{ lang: langLookup }] };
  return { rows: [] };
};

const { sendVerificationEmail, sendSignupAttemptEmail } = require("../../src/lib/emailVerification");
const { sendResetLink } = require("../../src/lib/passwordReset");

const user = (lang) => ({ id: 1, email: "ana@example.test", display_name: "Ana", lang });
beforeEach(() => { sent.length = 0; });

test("verification email: French for a 'fr' account", async () => {
  await sendVerificationEmail(user("fr"), "https://shop.test");
  const m = sent[0];
  assert.equal(m.subject, "Confirmez votre adresse e-mail pour Uma's Books");
  assert.match(m.text, /^Bonjour Ana,/);
  assert.match(m.text, /ce lien expire dans 24 heures/);
  assert.match(m.text, /https:\/\/shop\.test\/verify-email\//);
  assert.doesNotMatch(m.text, /Confirm this is your email/);
});

test("verification email: English for 'en' and for no stored language", async () => {
  for (const lang of ["en", null]) {
    sent.length = 0;
    await sendVerificationEmail(user(lang), "https://shop.test");
    assert.equal(sent[0].subject, "Confirm your email for Uma's Books");
    assert.match(sent[0].text, /^Hi Ana,/);
  }
});

test("verification email: a caller without lang gets it looked up (admin email change)", async () => {
  langLookup = "fr";
  await sendVerificationEmail({ id: 1, email: "ana@example.test", display_name: "Ana" }, "https://shop.test");
  assert.match(sent[0].subject, /^Confirmez/);
  langLookup = undefined;
  sent.length = 0;
  await sendVerificationEmail({ id: 1, email: "ana@example.test", display_name: "Ana" }, "https://shop.test");
  assert.match(sent[0].subject, /^Confirm your email/);
});

test("signup-attempt email in both languages", async () => {
  await sendSignupAttemptEmail(user("fr"), "https://shop.test");
  assert.match(sent[0].subject, /^Quelqu'un a tenté de s'inscrire/);
  assert.match(sent[0].text, /connectez-vous sur https:\/\/shop\.test\/login/);
  sent.length = 0;
  await sendSignupAttemptEmail(user(null), "https://shop.test");
  assert.match(sent[0].subject, /^Someone tried to sign up/);
  assert.match(sent[0].text, /log in at https:\/\/shop\.test\/login/);
});

test("password reset email in both languages", async () => {
  await sendResetLink(user("fr"), "https://shop.test");
  assert.equal(sent[0].subject, "Réinitialisez le mot de passe de votre compte Uma's Books");
  assert.match(sent[0].text, /ce lien expire dans 1 heure/);
  assert.match(sent[0].text, /https:\/\/shop\.test\/reset-password\//);
  sent.length = 0;
  await sendResetLink(user("en"), "https://shop.test");
  assert.equal(sent[0].subject, "Reset your Uma's Books account password");
  assert.match(sent[0].text, /this link expires in 1 hour/);
});

test("password policy messages: French through a translator, English by default", async () => {
  const { validateNewPassword } = require("../../src/lib/passwordPolicy");
  const { translator } = require("../../src/lib/lang");
  const fr = translator("fr");
  assert.equal(await validateNewPassword("Ab1!", fr), "Le mot de passe doit contenir au moins 8 caractères.");
  assert.equal(await validateNewPassword("abcdefghij", fr), "Le mot de passe doit contenir une lettre majuscule, un chiffre, un symbole.");
  assert.equal(await validateNewPassword("abcdefghij"), "Password must include an uppercase letter, a number, a symbol.");
});
