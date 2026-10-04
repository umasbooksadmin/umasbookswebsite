// Customer book requests ("Can't find a book? Ask us"): no login or membership
// needed, the requester is identified by an email address confirmed with a link.
//
// Lifecycle (book_requests.status):
//   unconfirmed -> open        the requester clicked the emailed link and pressed Confirm
//   open -> matched            a copy that fits arrived (or an admin matched it by hand)
//   matched -> notified        an admin pressed Notify (optionally also holding the copy)
//   notified -> fulfilled      an admin marked it done
//   any active status -> cancelled   the requester or an admin cancelled it
//   open/matched/notified -> expired   12 months after the request was made
// "Active" means unconfirmed, open, matched or notified.
//
// Personal columns (email, name, note, admin_note, user_id) are cleared when a
// request ends (see clearPersonalSql and lib/privacy.js); title/author/ISBN stay
// for anonymous demand counts. Tokens are random, stored hashed
// (lib/resetTokens.js) and appear in clear only inside emails.

const { withTransaction } = require("../db");
const mailer = require("../mailer");
const { generateToken, hashToken } = require("./resetTokens");
const { emailTr, normLang } = require("./lang");
const { emailSafeName } = require("./validation");
const { normalizeIsbn } = require("./bookLookup");
const { isbnVariants } = require("./inventory");
const { RESERVATION_TTL_DAYS } = require("./reservations");

const ACTIVE_STATUSES = ["unconfirmed", "open", "matched", "notified"];
// What counts toward the per-email cap on pending requests.
const PENDING_STATUSES = ["unconfirmed", "open", "matched"];

const LIMITS = {
  title: 200,
  author: 150,
  name: 100,
  note: 500,
  maxPendingPerEmail: 3,
  unconfirmedDays: 7,
  openMonths: 12,
  listTokenDays: 30,
  holdDays: 7,
  resendMinutes: 10,
};

// Everything personal on a request, cleared together (cancel, expiry, purge, erasure).
const CLEAR_PERSONAL_SQL =
  "email = NULL, name = NULL, note = NULL, admin_note = NULL, user_id = NULL";

// ---------- normalisation ----------

// "Harry Potter & the Philosopher's Stone!" -> "harry potter the philosopher s stone"
function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Words of a name, single letters (initials) dropped: "J. R. R. Tolkien" -> ["tolkien"].
function authorTokens(value) {
  return normalizeText(value).split(" ").filter((t) => t.length > 1);
}

// True when every word of one author string appears in the other ("Austen" vs
// "Jane Austen", "Tolkien, J.R.R." vs "J. R. R. Tolkien"). An empty side matches anything.
function authorsOverlap(a, b) {
  const ta = authorTokens(a);
  const tb = authorTokens(b);
  if (!ta.length || !tb.length) return true;
  const sa = new Set(ta);
  const sb = new Set(tb);
  return ta.every((t) => sb.has(t)) || tb.every((t) => sa.has(t));
}

// Digits and X only; "" when empty; null when it is not a plausible ISBN (10 or 13 characters).
function parseRequestIsbn(raw) {
  const cleaned = normalizeIsbn(typeof raw === "string" ? raw : "");
  if (!cleaned) return "";
  return /^\d{13}$/.test(cleaned) || /^\d{9}[\dX]$/.test(cleaned) ? cleaned : null;
}

// ---------- matching ----------

// Open requests that ask for this book: same ISBN (10 and 13 forms are the same
// book) or same normalised title with an empty/overlapping author.
function requestFitsBook(request, book) {
  if (request.isbn && book.isbn) {
    if (isbnVariants(normalizeIsbn(book.isbn)).includes(request.isbn)) return true;
  }
  const bookTitle = normalizeText(book.title);
  if (bookTitle && normalizeText(request.title) === bookTitle) {
    return authorsOverlap(request.author, book.authors);
  }
  return false;
}

// Marks the open requests that fit this book as 'matched' to copyId (which must
// be an in-stock copy of the book). Returns how many requests were matched.
async function matchRequestsForCopy(db, bookId, copyId) {
  const { rows: copyRows } = await db.query(
    "SELECT 1 FROM book_copies WHERE id = $1 AND book_id = $2 AND status = 'in_stock'",
    [copyId, bookId]
  );
  if (!copyRows.length) return 0;
  const { rows: bookRows } = await db.query("SELECT isbn, title, authors FROM books WHERE id = $1", [bookId]);
  if (!bookRows.length) return 0;
  const book = bookRows[0];
  const { rows: open } = await db.query(
    "SELECT id, title, author, isbn FROM book_requests WHERE status = 'open'"
  );
  const ids = open.filter((r) => requestFitsBook(r, book)).map((r) => r.id);
  if (!ids.length) return 0;
  const result = await db.query(
    `UPDATE book_requests SET status = 'matched', matched_copy_id = $1, updated_at = now()
     WHERE id = ANY($2::int[]) AND status = 'open'`,
    [copyId, ids]
  );
  return result.rowCount;
}

// Re-check after an admin edits a book's title/ISBN: match against its newest in-stock copy.
async function matchRequestsForBook(db, bookId) {
  const { rows } = await db.query(
    "SELECT id FROM book_copies WHERE book_id = $1 AND status = 'in_stock' ORDER BY created_at DESC, id DESC LIMIT 1",
    [bookId]
  );
  return rows.length ? matchRequestsForCopy(db, bookId, rows[0].id) : 0;
}

// ---------- creating and confirming ----------

// Adds a request (status 'unconfirmed') unless it is a duplicate or the address
// already has too many pending requests. Returns { confirmToken, manageToken,
// request } for a new row, a fresh { confirmToken, request } when a long-unconfirmed duplicate
// is re-sent, or null when nothing should be emailed. The caller shows the same
// page in every case.
async function createRequest(pool, { title, author, isbn, note, email, name, lang, userId }) {
  return withTransaction(pool, async (db) => {
    // Serialise concurrent submissions for one address so the cap can't be raced.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`book_request:${email}`]);

    const { rows: dup } = await db.query(
      `SELECT id, status, lang, (updated_at < now() - make_interval(mins => $3)) AS stale
       FROM book_requests
       WHERE lower(email) = $1 AND lower(title) = lower($2) AND status = ANY($4::text[])
       ORDER BY id LIMIT 1`,
      [email, title, LIMITS.resendMinutes, ACTIVE_STATUSES]
    );
    if (dup.length) {
      // A lost confirmation mail can be re-requested, at most every few minutes.
      if (dup[0].status !== "unconfirmed" || !dup[0].stale) return null;
      const confirmToken = generateToken();
      await db.query(
        `UPDATE book_requests SET confirm_token_hash = $1, updated_at = now(),
                expires_at = now() + make_interval(days => $3)
         WHERE id = $2`,
        [hashToken(confirmToken), dup[0].id, LIMITS.unconfirmedDays]
      );
      const manageToken = await rotateManageToken(db, dup[0].id);
      return { confirmToken, manageToken, request: { id: dup[0].id, title, author, lang: dup[0].lang, name } };
    }

    const { rows: pending } = await db.query(
      "SELECT count(*)::int AS n FROM book_requests WHERE lower(email) = $1 AND status = ANY($2::text[])",
      [email, PENDING_STATUSES]
    );
    if (pending[0].n >= LIMITS.maxPendingPerEmail) return null;

    const confirmToken = generateToken();
    const manageToken = generateToken();
    const { rows } = await db.query(
      `INSERT INTO book_requests
         (title, author, isbn, note, email, name, lang, user_id, status, confirm_token_hash, manage_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unconfirmed', $9, $10, now() + make_interval(days => $11))
       RETURNING id`,
      [
        title, author || null, isbn || null, note || null, email, name || null, normLang(lang) || "en",
        userId || null, hashToken(confirmToken), hashToken(manageToken), LIMITS.unconfirmedDays,
      ]
    );
    return { confirmToken, manageToken, request: { id: rows[0].id, title, author, lang, name } };
  });
}

// A new private link replaces the old one; only the latest email's link works.
async function rotateManageToken(db, requestId) {
  const token = generateToken();
  await db.query("UPDATE book_requests SET manage_token_hash = $1 WHERE id = $2", [hashToken(token), requestId]);
  return token;
}

// The request behind a confirmation link, if the link is valid and unused.
async function findByConfirmToken(db, token) {
  const { rows } = await db.query(
    `SELECT id, title, author FROM book_requests
     WHERE confirm_token_hash = $1 AND status = 'unconfirmed' AND expires_at > now()`,
    [hashToken(String(token))]
  );
  return rows[0] || null;
}

// Double opt-in: only called from the POST behind the Confirm button, never a GET.
// The request then lives for 12 months from when it was made.
async function confirmRequest(db, token) {
  const { rows } = await db.query(
    `UPDATE book_requests
     SET status = 'open', confirmed_at = now(), confirm_token_hash = NULL, updated_at = now(),
         expires_at = created_at + make_interval(months => $2)
     WHERE confirm_token_hash = $1 AND status = 'unconfirmed' AND expires_at > now()
     RETURNING id`,
    [hashToken(String(token)), LIMITS.openMonths]
  );
  return rows.length > 0;
}

// ---------- cancelling ----------

// Cancels an active request, clearing the requester's personal data (title,
// author and ISBN stay for demand counts). If the copy is being held for this
// requester, the hold is released. Returns true when something was cancelled.
// `ownerSql`/`ownerParams` optionally restrict whose request it may be.
async function cancelRequest(pool, id, { ownerSql = "", ownerParams = [] } = {}) {
  return withTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT id, email, matched_copy_id FROM book_requests
       WHERE id = $1 AND status = ANY($2::text[]) ${ownerSql} FOR UPDATE`,
      [id, ACTIVE_STATUSES, ...ownerParams]
    );
    if (!rows.length) return false;
    await releaseHold(db, rows[0]);
    await db.query(
      `UPDATE book_requests SET status = 'cancelled', ${CLEAR_PERSONAL_SQL},
              confirm_token_hash = NULL, updated_at = now()
       WHERE id = $1`,
      [id]
    );
    return true;
  });
}

// Puts the matched copy back on the shelf when it is reserved for this very requester.
async function releaseHold(db, request) {
  if (!request.matched_copy_id || !request.email) return;
  await db.query(
    `UPDATE book_copies
     SET status = 'in_stock', reserved_by_name = NULL, reserved_by_email = NULL,
         reserved_by_phone = NULL, reserved_at = NULL, reminder_sent_at = NULL, updated_at = now()
     WHERE id = $1 AND status = 'reserved' AND lower(reserved_by_email) = lower($2)`,
    [request.matched_copy_id, request.email]
  );
}

// ---------- the requester's own lists ----------

// Active requests of one address (lower-cased), newest first.
async function activeRequestsByEmail(db, email) {
  const { rows } = await db.query(
    `SELECT id, title, author, status, created_at FROM book_requests
     WHERE lower(email) = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC, id DESC`,
    [email, ACTIVE_STATUSES]
  );
  return rows;
}

// A signed-in customer's active requests: made while logged in (user_id) or under
// their VERIFIED email address (an unverified account can't claim someone else's).
async function activeRequestsForUser(db, userId) {
  const { rows } = await db.query(
    `SELECT r.id, r.title, r.author, r.status, r.created_at
     FROM book_requests r, users u
     WHERE u.id = $1 AND r.status = ANY($2::text[])
       AND (r.user_id = u.id OR (u.email_verified_at IS NOT NULL AND lower(r.email) = lower(u.email)))
     ORDER BY r.created_at DESC, r.id DESC`,
    [userId, ACTIVE_STATUSES]
  );
  return rows;
}

// SQL fragment + params restricting a cancel to a signed-in customer's own requests.
function userOwnerFilter(userId, nextParam) {
  return {
    ownerSql: `AND (user_id = $${nextParam} OR (lower(email) = (SELECT lower(email) FROM users WHERE id = $${nextParam} AND email_verified_at IS NOT NULL)))`,
    ownerParams: [userId],
  };
}

async function createListToken(db, email) {
  const token = generateToken();
  await db.query(
    "INSERT INTO book_request_list_tokens (email, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [email, hashToken(token), LIMITS.listTokenDays]
  );
  return token;
}

// The address behind a valid 30-day list link, or null.
async function emailForListToken(db, token) {
  const { rows } = await db.query(
    "SELECT email FROM book_request_list_tokens WHERE token_hash = $1 AND expires_at > now()",
    [hashToken(String(token))]
  );
  return rows.length ? rows[0].email : null;
}

// ---------- emails ----------

const SHOP_ADDRESS = "Uma's Books\nRue Peyrolière, 81000 Albi";

function greeting(tr, name) {
  const n = emailSafeName(name);
  return n ? tr(`Hi ${n},`, `Bonjour ${n},`) : tr("Hi,", "Bonjour,");
}

function describeTr(tr, title, author) {
  const t = emailSafeName(title);
  const a = emailSafeName(author);
  return a ? tr(`"${t}" by ${a}`, `« ${t} » de ${a}`) : tr(`"${t}"`, `« ${t} »`);
}

async function sendConfirmationEmail({ to, request, confirmToken, manageToken, base }) {
  const tr = emailTr(request.lang);
  const what = describeTr(tr, request.title, request.author);
  const confirmLink = `${base}/request-a-book/confirm/${confirmToken}`;
  const manageLink = `${base}/my-requests/${manageToken}`;
  await mailer.sendMail({
    to,
    subject: tr("Please confirm your book request at Uma's Books", "Merci de confirmer votre demande de livre chez Uma's Books"),
    text: tr(
      `${greeting(tr, request.name)}\n\nYou asked us to look out for ${what}. Please confirm your request (the link works for ${LIMITS.unconfirmedDays} days):\n${confirmLink}\n\nOnce confirmed, we'll email you if a copy arrives. We use your email only for this request.\n\nChanged your mind? You can cancel any time:\n${manageLink}\n\nIf you didn't make this request, just ignore this email and nothing will happen.\n\n${SHOP_ADDRESS}`,
      `${greeting(tr, request.name)}\n\nVous nous avez demandé de chercher ${what}. Merci de confirmer votre demande (le lien est valable ${LIMITS.unconfirmedDays} jours) :\n${confirmLink}\n\nUne fois confirmée, nous vous écrirons si un exemplaire arrive. Votre adresse e-mail ne sert qu'à cette demande.\n\nVous avez changé d'avis ? Vous pouvez annuler à tout moment :\n${manageLink}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez simplement ce message : il ne se passera rien.\n\n${SHOP_ADDRESS}`
    ),
  });
}

async function sendListEmail({ to, lang, token, base }) {
  const tr = emailTr(lang);
  const link = `${base}/my-requests/list/${token}`;
  await mailer.sendMail({
    to,
    subject: tr("Your book requests at Uma's Books", "Vos demandes de livres chez Uma's Books"),
    text: tr(
      `Hi,\n\nHere is your private link to see and cancel your book requests (it works for ${LIMITS.listTokenDays} days):\n${link}\n\nIf you didn't ask for this, you can safely ignore this email.\n\n${SHOP_ADDRESS}`,
      `Bonjour,\n\nVoici votre lien privé pour voir et annuler vos demandes de livres (il est valable ${LIMITS.listTokenDays} jours) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer ce message.\n\n${SHOP_ADDRESS}`
    ),
  });
}

function formatPrice(price, lang) {
  if (price === null || price === undefined) return null;
  const n = Number(price).toFixed(2);
  return lang === "fr" ? `${n.replace(".", ",")} €` : `€${n}`;
}

function formatDay(date, lang) {
  return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
    timeZone: "Europe/Paris", day: "numeric", month: "long", year: "numeric",
  }).format(date);
}

// "A copy has arrived" mail. `copy` = { bookId, title, price }.
async function sendNotifyEmail({ request, copy, manageToken, base, hold }) {
  const lang = normLang(request.lang) || "en";
  const tr = emailTr(lang);
  const title = emailSafeName(copy.title);
  const price = formatPrice(copy.price, lang);
  const link = `${base}/books/${copy.bookId}`;
  const manageLink = `${base}/my-requests/${manageToken}`;
  const until = formatDay(new Date(Date.now() + LIMITS.holdDays * 24 * 60 * 60 * 1000), lang);
  const priceEn = price ? ` Price: ${price}.` : "";
  const priceFr = price ? ` Prix : ${price}.` : "";
  const holdEn = hold
    ? `We've set this copy aside for you for ${LIMITS.holdDays} days (until ${until}). Come by the shop to pick it up and pay in person.`
    : "Copies are sold first come, first served, so come by soon or reserve it online.";
  const holdFr = hold
    ? `Nous avons mis cet exemplaire de côté pour vous pendant ${LIMITS.holdDays} jours (jusqu'au ${until}). Passez à la boutique pour le récupérer et le régler sur place.`
    : "Les exemplaires partent au fur et à mesure : passez vite à la boutique ou réservez-le en ligne.";
  await mailer.sendMail({
    to: request.email,
    subject: tr(`Good news: "${title}" is now at Uma's Books`, `Bonne nouvelle : « ${title} » est arrivé chez Uma's Books`),
    text: tr(
      `${greeting(tr, request.name)}\n\nYou asked us to look out for "${title}", and we now have a copy.${priceEn}\n${link}\n\n${holdEn}\n\nIf you have any questions, just reply to this email.\n\nNo longer interested? Cancel your request here:\n${manageLink}\n\n${SHOP_ADDRESS}`,
      `${greeting(tr, request.name)}\n\nVous nous aviez demandé de chercher « ${title} » et nous en avons maintenant un exemplaire.${priceFr}\n${link}\n\n${holdFr}\n\nPour toute question, répondez simplement à ce message.\n\nCela ne vous intéresse plus ? Annulez votre demande ici :\n${manageLink}\n\n${SHOP_ADDRESS}`
    ),
  });
}

// ---------- admin: notify (and optionally hold) ----------

// Reasons shown to the admin; the admin page only ever prints these exact strings.
const NOTIFY_ERRORS = {
  gone: "That request no longer exists.",
  notMatched: "Only a matched request can be notified. Match it to a book first.",
  noEmail: "This request has no email address any more.",
  noCopy: "The matched copy no longer exists. Match the request to a book again.",
  holdGone: "That copy is no longer in stock, so it can't be held. Nothing was sent.",
  stockGone: "That copy is no longer in stock. Nothing was sent.",
  changed: "That request changed while you were working. Please reload.",
  mailFailed: "The email could not be sent, so nothing was changed. Please try again.",
};


// Emails the requester that the matched copy is here and sets the request to
// 'notified'. With hold, the copy is also reserved for them for holdDays: the
// standard reservation lasts RESERVATION_TTL_DAYS from reserved_at, so reserved_at is
// back-dated to leave exactly holdDays, and reminder_sent_at is set so the
// pickup reminder (sent at day 11) does not fire at once.
// Returns { ok: true } or { error: "reason shown to the admin" }.
async function notifyRequest(pool, id, { hold = false, base }) {
  const { rows } = await pool.query(
    `SELECT r.*, c.status AS copy_status, c.price AS copy_price, c.book_id, b.title AS book_title
     FROM book_requests r
     LEFT JOIN book_copies c ON c.id = r.matched_copy_id
     LEFT JOIN books b ON b.id = c.book_id
     WHERE r.id = $1`,
    [id]
  );
  const r = rows[0];
  if (!r) return { error: NOTIFY_ERRORS.gone };
  if (r.status !== "matched" && r.status !== "notified") return { error: NOTIFY_ERRORS.notMatched };
  if (!r.email) return { error: NOTIFY_ERRORS.noEmail };
  if (!r.matched_copy_id || !r.book_id) return { error: NOTIFY_ERRORS.noCopy };

  let heldNow = false;
  if (hold) {
    const claim = await pool.query(
      `UPDATE book_copies
       SET status = 'reserved', reserved_by_name = $1, reserved_by_email = $2, reserved_by_phone = NULL,
           reserved_at = now() - make_interval(days => $4), reminder_sent_at = now(), updated_at = now()
       WHERE id = $3 AND status = 'in_stock'
       RETURNING id`,
      [r.name || "Book request", r.email, r.matched_copy_id, RESERVATION_TTL_DAYS - LIMITS.holdDays]
    );
    if (!claim.rowCount) return { error: NOTIFY_ERRORS.holdGone };
    heldNow = true;
  } else if (r.copy_status !== "in_stock") {
    return { error: NOTIFY_ERRORS.stockGone };
  }

  const manageToken = generateToken();
  const updated = await pool.query(
    `UPDATE book_requests SET status = 'notified', notified_at = now(), manage_token_hash = $2, updated_at = now()
     WHERE id = $1 AND status IN ('matched', 'notified')`,
    [id, hashToken(manageToken)]
  );
  const undo = async () => {
    if (heldNow) {
      await pool.query(
        `UPDATE book_copies
         SET status = 'in_stock', reserved_by_name = NULL, reserved_by_email = NULL, reserved_by_phone = NULL,
             reserved_at = NULL, reminder_sent_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'reserved' AND lower(reserved_by_email) = lower($2)`,
        [r.matched_copy_id, r.email]
      );
    }
  };
  if (!updated.rowCount) {
    await undo();
    return { error: NOTIFY_ERRORS.changed };
  }

  try {
    await sendNotifyEmail({
      request: r,
      copy: { bookId: r.book_id, title: r.book_title, price: r.copy_price },
      manageToken, base, hold: heldNow,
    });
  } catch (err) {
    console.error(`Book request notification failed for request ${id}:`, err.message);
    await undo();
    await pool.query(
      "UPDATE book_requests SET status = $2, notified_at = $3, manage_token_hash = $4, updated_at = now() WHERE id = $1",
      [id, r.status, r.notified_at, r.manage_token_hash]
    );
    return { error: NOTIFY_ERRORS.mailFailed };
  }
  return { ok: true, held: heldNow, copyId: r.matched_copy_id };
}

module.exports = {
  ACTIVE_STATUSES,
  PENDING_STATUSES,
  LIMITS,
  NOTIFY_ERRORS,
  CLEAR_PERSONAL_SQL,
  normalizeText,
  authorsOverlap,
  parseRequestIsbn,
  requestFitsBook,
  matchRequestsForCopy,
  matchRequestsForBook,
  createRequest,
  rotateManageToken,
  findByConfirmToken,
  confirmRequest,
  cancelRequest,
  activeRequestsByEmail,
  activeRequestsForUser,
  userOwnerFilter,
  createListToken,
  emailForListToken,
  sendConfirmationEmail,
  sendListEmail,
  notifyRequest,
};
