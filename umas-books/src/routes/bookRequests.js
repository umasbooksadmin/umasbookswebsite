// Customer book requests, no login or membership needed (lib/bookRequests.js):
//   GET/POST /request-a-book                     the form; the answer is always the same "check your inbox" page
//   GET/POST /request-a-book/confirm/:token      GET only shows a Confirm button (mail scanners that open links
//                                                must not confirm); the POST confirms
//   GET /my-requests/:manageToken (+ POST /cancel)   one request, from the private link in its emails
//   GET/POST /my-requests                        "find my requests": always the same answer, emails a 30-day link
//   GET /my-requests/list/:token (+ cancel, cancel-all)   everything under one address
//   POST /account/book-requests/:id/cancel       cancel from My Account (login, not membership)
//
// Pages reached through a token link are no-store and send no Referer.

const express = require("express");
const { CONTACT_EMAIL } = require("../lib/legal");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { limit } = require("../middleware/rateLimits");
const { redirectWithFlash, takePageFlash } = require("../lib/postRedirect");
const { baseUrl } = require("../lib/baseUrl");
const { isEmail } = require("../lib/validation");
const { normLang } = require("../lib/lang");
const { hashToken } = require("../lib/resetTokens");
const br = require("../lib/bookRequests");

const router = express.Router();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TOKEN_RE = /^[a-f0-9]{64}$/;

function privatePage(res) {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
}

function renderForm(req, res, { status = 200, error = null, values = null, errorFields = [] } = {}) {
  const u = req.session && req.session.user;
  res.set("Cache-Control", "no-store");
  res.status(status).render("request_book", {
    error,
    errorFields,
    values: values || { title: "", author: "", isbn: "", email: u ? u.email : "", name: u ? u.displayName || "" : "", note: "" },
  });
}

function sentPage(res) {
  res.set("Cache-Control", "no-store");
  res.render("request_book_sent");
}

// Every answer to a POST here is a redirect to a GET page (lib/postRedirect.js), so Back
// never shows "Confirm form resubmission": the thank-you pages have addresses of their own.
const SENT_URL = "/request-a-book/sent";
const CONFIRMED_URL = "/request-a-book/confirmed";

// Fire-and-forget, so the response time does not depend on whether a mail was sent.
function sendInBackground(label, promise) {
  promise.catch((err) => console.error(`${label} failed:`, err.message));
}

// ---------- the form ----------

// 5 requests a day per connection (every POST counts, valid or not).
const requestLimiter = limit({
  windowMs: DAY,
  max: 5,
  handler: (req, res) =>
    redirectWithFlash(req, res, "/request-a-book", "requestBook", {
      values: formValues(req.body || {}),
      error: req.tr(
        "You have sent several requests today. Please try again tomorrow, or email " + CONTACT_EMAIL + ".",
        "Vous avez envoyé plusieurs demandes aujourd'hui. Veuillez réessayer demain, ou écrire à " + CONTACT_EMAIL + "."
      ),
    }),
});

// Only the form's own text fields (and only strings) go back into the session.
function formValues(body) {
  const out = {};
  for (const k of ["title", "author", "isbn", "email", "name", "note"]) out[k] = typeof body[k] === "string" ? body[k].slice(0, 600) : "";
  return out;
}

router.get("/request-a-book", (req, res) => {
  const flash = takePageFlash(req, res, "requestBook");
  renderForm(req, res, flash ? { error: flash.error, values: flash.values, errorFields: flash.errorFields || [] } : {});
});
router.get(SENT_URL, (req, res) => sentPage(res));
router.get(CONFIRMED_URL, (req, res) => {
  privatePage(res);
  res.render("request_book_confirm", { state: "done", request: null, token: "" });
});

// A text field: trimmed; `tooLong` is set when it exceeds `max` (rejected, never silently cut).
function field(body, name, max, problems) {
  const v = typeof body[name] === "string" ? body[name].trim() : "";
  if (v.length > max) problems.push(name);
  return v;
}

router.post("/request-a-book", requestLimiter, async (req, res) => {
  const body = req.body || {};
  // Honeypot: people never see or fill this field; bots get the normal answer.
  if (body.website) return res.redirect(303, SENT_URL);

  const tooLong = [];
  const values = {
    title: field(body, "title", br.LIMITS.title, tooLong),
    author: field(body, "author", br.LIMITS.author, tooLong),
    isbn: field(body, "isbn", 40, tooLong),
    email: field(body, "email", 200, tooLong).toLowerCase(),
    name: field(body, "name", br.LIMITS.name, tooLong),
    note: field(body, "note", br.LIMITS.note, tooLong),
  };
  const isbn = br.parseRequestIsbn(values.isbn);

  let error = null;
  let errorFields = [];   // the inputs the message is about (views/request_book.ejs links to them)
  if (!values.title) {
    errorFields = ["title"];
    error = req.tr("Please tell us the title of the book.", "Veuillez indiquer le titre du livre.");
  } else if (!isEmail(values.email)) {
    errorFields = ["email"];
    error = req.tr("Please enter one valid email address, so we can write to you.", "Veuillez saisir une seule adresse e-mail valide, pour que nous puissions vous écrire.");
  } else if (isbn === null) {
    errorFields = ["isbn"];
    error = req.tr("The ISBN should have 10 or 13 digits (or leave it empty).", "L'ISBN doit comporter 10 ou 13 chiffres (ou laissez le champ vide).");
  } else if (tooLong.length) {
    errorFields = tooLong;
    error = req.tr(
      "Something you typed is too long. Titles can have up to 200 characters and notes up to 500.",
      "Un champ est trop long. Les titres peuvent comporter jusqu'à 200 caractères et les notes jusqu'à 500."
    );
  }
  if (error) return redirectWithFlash(req, res, "/request-a-book", "requestBook", { error, errorFields, values });

  const user = req.session && req.session.user;
  const lang = normLang(req.lang) || "en";
  const created = await br.createRequest(pool, {
    title: values.title,
    author: values.author,
    isbn,
    note: values.note,
    email: values.email,
    name: values.name,
    lang,
    userId: user ? user.id : null,
  });
  if (created) {
    sendInBackground(
      "Book request confirmation email",
      br.sendConfirmationEmail({
        to: values.email,
        request: created.request,
        confirmToken: created.confirmToken,
        manageToken: created.manageToken,
        base: baseUrl(req),
      })
    );
  }
  res.redirect(303, SENT_URL);
});

// ---------- double opt-in ----------

router.get("/request-a-book/confirm/:token", async (req, res) => {
  privatePage(res);
  const request = TOKEN_RE.test(req.params.token) ? await br.findByConfirmToken(pool, req.params.token) : null;
  // Nothing changes on GET: the request is confirmed by the button (a POST).
  res.status(request ? 200 : 400).render("request_book_confirm", { state: request ? "ask" : "invalid", request, token: req.params.token });
});

router.post("/request-a-book/confirm/:token", async (req, res) => {
  privatePage(res);
  const ok = TOKEN_RE.test(req.params.token) && (await br.confirmRequest(pool, req.params.token));
  // A dead link goes back to the link's own page, which says so.
  res.redirect(303, ok ? CONFIRMED_URL : `/request-a-book/confirm/${encodeURIComponent(req.params.token)}`);
});

// ---------- one request, from its private link ----------

async function findByManageToken(token) {
  if (!TOKEN_RE.test(token)) return null;
  const { rows } = await pool.query(
    "SELECT id, title, author, status, created_at FROM book_requests WHERE manage_token_hash = $1",
    [hashToken(token)]
  );
  return rows[0] || null;
}

router.get("/my-requests/list/:token", async (req, res) => {
  privatePage(res);
  const email = TOKEN_RE.test(req.params.token) ? await br.emailForListToken(pool, req.params.token) : null;
  if (!email) return res.status(400).render("my_requests", { state: "invalid", requests: [], token: "", notice: null });
  const requests = await br.activeRequestsByEmail(pool, email);
  res.render("my_requests", { state: "list", requests, token: req.params.token, notice: req.query.cancelled ? "cancelled" : null });
});

router.post("/my-requests/list/:token/cancel-all", async (req, res) => {
  privatePage(res);
  const email = TOKEN_RE.test(req.params.token) ? await br.emailForListToken(pool, req.params.token) : null;
  if (!email) return res.redirect(303, `/my-requests/list/${encodeURIComponent(req.params.token)}`);
  for (const r of await br.activeRequestsByEmail(pool, email)) {
    await br.cancelRequest(pool, r.id, { ownerSql: "AND lower(email) = $3", ownerParams: [email] });
  }
  res.redirect(`/my-requests/list/${req.params.token}?cancelled=1`);
});

router.post("/my-requests/list/:token/cancel/:id", async (req, res) => {
  privatePage(res);
  const email = TOKEN_RE.test(req.params.token) ? await br.emailForListToken(pool, req.params.token) : null;
  if (!email) return res.redirect(303, `/my-requests/list/${encodeURIComponent(req.params.token)}`);
  const id = Number(req.params.id);
  if (Number.isInteger(id) && id > 0 && id <= 2147483647) {
    await br.cancelRequest(pool, id, { ownerSql: "AND lower(email) = $3", ownerParams: [email] });
  }
  res.redirect(`/my-requests/list/${req.params.token}?cancelled=1`);
});

router.get("/my-requests/:token", async (req, res) => {
  privatePage(res);
  const request = await findByManageToken(req.params.token);
  if (!request) return res.status(404).render("my_request", { request: null, token: "" });
  res.render("my_request", { request, token: req.params.token });
});

router.post("/my-requests/:token/cancel", async (req, res) => {
  privatePage(res);
  const request = await findByManageToken(req.params.token);
  if (!request) return res.redirect(303, `/my-requests/${encodeURIComponent(req.params.token)}`);
  await br.cancelRequest(pool, request.id);
  res.redirect(`/my-requests/${req.params.token}`);
});

// ---------- "find my requests" ----------

const findIpLimiter = limit({
  windowMs: HOUR,
  max: 5,
  handler: (req, res) => redirectWithFlash(req, res, "/my-requests", "findRequests", { state: "limited" }),
});

// 3 a day per address. Answered exactly like a normal request, so the limit
// itself reveals nothing; the mail is simply not sent.
const findEmailCounts = new Map();
function takeEmailAllowance(email) {
  const now = Date.now();
  for (const [k, v] of findEmailCounts) if (v.resetAt < now) findEmailCounts.delete(k);
  const entry = findEmailCounts.get(email) || { n: 0, resetAt: now + DAY };
  entry.n += 1;
  findEmailCounts.set(email, entry);
  return entry.n <= 3;
}

router.get("/my-requests", (req, res) => {
  const u = req.session && req.session.user;
  res.set("Cache-Control", "no-store");
  // POST /my-requests answers every valid address the same way: ?sent=1 shows "check your inbox"
  // (nothing about the address is in the URL, and a reload shows it again). A bad address or
  // the per-connection limit leave a one-time message instead.
  if (req.query.sent === "1") return res.render("my_requests", { state: "sent", requests: [], token: "", notice: null });
  const flash = takePageFlash(req, res, "findRequests");
  if (flash && flash.state === "limited") {
    return res.render("my_requests", { state: "limited", requests: [], token: "", notice: null });
  }
  res.render("my_requests", { state: "form", requests: [], token: "", notice: flash ? flash.notice : null, email: flash ? flash.email : u ? u.email : "" });
});

router.post("/my-requests", findIpLimiter, async (req, res) => {
  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  res.set("Cache-Control", "no-store");
  if (!isEmail(email)) {
    return redirectWithFlash(req, res, "/my-requests", "findRequests", { state: "form", notice: "bad-email", email: "" });
  }
  if (takeEmailAllowance(email)) {
    const requests = await br.activeRequestsByEmail(pool, email);
    if (requests.length) {
      const { rows } = await pool.query(
        "SELECT lang FROM book_requests WHERE lower(email) = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
        [email]
      );
      const token = await br.createListToken(pool, email);
      sendInBackground(
        "Book request list email",
        br.sendListEmail({ to: email, lang: (rows[0] && rows[0].lang) || normLang(req.lang), token, base: baseUrl(req) })
      );
    }
  }
  res.redirect(303, "/my-requests?sent=1");
});

// ---------- My Account ----------

router.post("/account/book-requests/:id/cancel", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isInteger(id) && id > 0 && id <= 2147483647) {
    await br.cancelRequest(pool, id, br.userOwnerFilter(req.session.user.id, 3));
  }
  res.redirect("/account");
});

module.exports = router;
