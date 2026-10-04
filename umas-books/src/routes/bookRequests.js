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
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { limit } = require("../middleware/rateLimits");
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

function renderForm(req, res, { status = 200, error = null, values = null } = {}) {
  const u = req.session && req.session.user;
  res.set("Cache-Control", "no-store");
  res.status(status).render("request_book", {
    error,
    values: values || { title: "", author: "", isbn: "", email: u ? u.email : "", name: u ? u.displayName || "" : "", note: "" },
  });
}

function sentPage(res) {
  res.set("Cache-Control", "no-store");
  res.render("request_book_sent");
}

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
    renderForm(req, res, {
      status: 429,
      values: req.body || {},
      error: req.tr(
        "You have sent several requests today. Please try again tomorrow, or email admin@umasbooks.org.",
        "Vous avez envoyé plusieurs demandes aujourd'hui. Veuillez réessayer demain, ou écrire à admin@umasbooks.org."
      ),
    }),
});

router.get("/request-a-book", (req, res) => renderForm(req, res));

// A text field: trimmed; `tooLong` is set when it exceeds `max` (rejected, never silently cut).
function field(body, name, max, problems) {
  const v = typeof body[name] === "string" ? body[name].trim() : "";
  if (v.length > max) problems.push(name);
  return v;
}

router.post("/request-a-book", requestLimiter, async (req, res) => {
  const body = req.body || {};
  // Honeypot: people never see or fill this field; bots get the normal answer.
  if (body.website) return sentPage(res);

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
  if (!values.title) {
    error = req.tr("Please tell us the title of the book.", "Veuillez indiquer le titre du livre.");
  } else if (!isEmail(values.email)) {
    error = req.tr("Please enter one valid email address, so we can write to you.", "Veuillez saisir une seule adresse e-mail valide, pour que nous puissions vous écrire.");
  } else if (isbn === null) {
    error = req.tr("The ISBN should have 10 or 13 digits (or leave it empty).", "L'ISBN doit comporter 10 ou 13 chiffres (ou laissez le champ vide).");
  } else if (tooLong.length) {
    error = req.tr(
      "Something you typed is too long. Titles can have up to 200 characters and notes up to 500.",
      "Un champ est trop long. Les titres peuvent comporter jusqu'à 200 caractères et les notes jusqu'à 500."
    );
  }
  if (error) return renderForm(req, res, { status: 400, error, values });

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
  sentPage(res);
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
  res.status(ok ? 200 : 400).render("request_book_confirm", { state: ok ? "done" : "invalid", request: null, token: "" });
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
  if (!email) return res.status(400).render("my_requests", { state: "invalid", requests: [], token: "", notice: null });
  for (const r of await br.activeRequestsByEmail(pool, email)) {
    await br.cancelRequest(pool, r.id, { ownerSql: "AND lower(email) = $3", ownerParams: [email] });
  }
  res.redirect(`/my-requests/list/${req.params.token}?cancelled=1`);
});

router.post("/my-requests/list/:token/cancel/:id", async (req, res) => {
  privatePage(res);
  const email = TOKEN_RE.test(req.params.token) ? await br.emailForListToken(pool, req.params.token) : null;
  if (!email) return res.status(400).render("my_requests", { state: "invalid", requests: [], token: "", notice: null });
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
  if (!request) return res.status(404).render("my_request", { request: null, token: "" });
  await br.cancelRequest(pool, request.id);
  res.redirect(`/my-requests/${req.params.token}`);
});

// ---------- "find my requests" ----------

const findIpLimiter = limit({
  windowMs: HOUR,
  max: 5,
  handler: (req, res) =>
    res.status(429).render("my_requests", { state: "limited", requests: [], token: "", notice: null }),
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
  res.render("my_requests", { state: "form", requests: [], token: "", notice: null, email: u ? u.email : "" });
});

router.post("/my-requests", findIpLimiter, async (req, res) => {
  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  res.set("Cache-Control", "no-store");
  if (!isEmail(email)) {
    return res.status(400).render("my_requests", { state: "form", requests: [], token: "", notice: "bad-email", email: "" });
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
  res.render("my_requests", { state: "sent", requests: [], token: "", notice: null });
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
