// Data subject requests for an email ADDRESS (access and erasure), for people
// who have no account or write from an address that is not the account's: the
// privacy policy tells them to write to the shop mailbox (CONTACT_EMAIL in lib/legal.js), and an admin uses
// the Privacy requests page (routes/admin/privacyRequests.js), which calls this.
//
// It extends, rather than copies, the member tools: the export reuses
// memberExport.js (buildMemberExport per account + buildEmailSections for the
// address) and the erasure reuses privacy.js (eraseMember per account +
// eraseEmailKeyedData for what is held under the bare address).
//
// The address is never written to the audit log or any log: auditToken() gives
// a keyed hash (HMAC with SESSION_SECRET), so the same request can be
// recognised later without the log naming anyone.
const crypto = require("node:crypto");
const config = require("./config");
const { withTransaction } = require("../db");
const { eraseMember, eraseEmailKeyedData } = require("./privacy");
const { eraseOutboxFor, listOutboxFor } = require("./outbox");
const { buildMemberExport, buildEmailSections } = require("./memberExport");
const { isEmail } = require("./validation");

function normaliseAddress(raw) {
  const e = String(raw || "").trim().toLowerCase();
  return e.length <= 200 && isEmail(e) ? e : null;
}

function auditToken(email) {
  const key = config.get("SESSION_SECRET") || "umasbooks-privacy-requests";
  return "hmac:" + crypto.createHmac("sha256", key).update(String(email).toLowerCase()).digest("hex").slice(0, 16);
}

// What is held under this address, with counts (no message bodies).
async function findRecords(pool, email) {
  const q = async (sql, params = [email]) => (await pool.query(sql, params)).rows;
  const accounts = await q("SELECT id, email, display_name, is_admin, is_member, is_volunteer, email_verified_at, created_at FROM users WHERE lower(email) = $1");
  const ids = accounts.map((a) => a.id);
  const orders = await q(
    `SELECT id, status, total_amount, created_at, (buyer_email LIKE '%@erased.invalid') AS erased FROM orders
     WHERE lower(buyer_email) = $1 OR user_id = ANY($2::int[]) ORDER BY id`,
    [email, ids]
  );
  const reservations = await q(
    "SELECT c.id, b.title, c.status, c.reserved_at FROM book_copies c JOIN books b ON b.id = c.book_id WHERE lower(c.reserved_by_email) = $1 ORDER BY c.id"
  );
  const eventSignups = await q(
    "SELECT s.id, e.title, e.starts_at FROM event_signups s JOIN events e ON e.id = s.event_id WHERE lower(s.email) = $1 ORDER BY s.id"
  );
  const classSignups = await q(
    "SELECT s.id, c.title, c.starts_at FROM class_signups s JOIN classes c ON c.id = s.class_id WHERE lower(s.email) = $1 ORDER BY s.id"
  );
  const bookRequests = await q(
    "SELECT id, title, status, created_at FROM book_requests WHERE lower(email) = $1 OR user_id = ANY($2::int[]) ORDER BY id",
    [email, ids]
  );
  const requestLinks = await q("SELECT count(*)::int AS n FROM book_request_list_tokens WHERE lower(email) = $1");
  const payments = await q(
    "SELECT id, amount_cents, paid_at, user_id, unmatched_at FROM membership_payments WHERE lower(payer_email) = $1 OR user_id = ANY($2::int[]) ORDER BY id",
    [email, ids]
  );
  const outbox = await listOutboxFor(pool, email);
  const records = {
    accounts, orders, reservations, eventSignups, classSignups, bookRequests, payments, outbox,
    unmatchedPayments: payments.filter((p) => !p.user_id && p.unmatched_at),
    contactForms: outbox.filter((m) => m.kind === "contact" && m.role === "sender"),
    bookRequestLinks: requestLinks[0].n,
  };
  records.counts = {
    accounts: accounts.length, orders: orders.length, reservations: reservations.length,
    eventSignups: eventSignups.length, classSignups: classSignups.length, bookRequests: bookRequests.length,
    membershipPayments: payments.length, unmatchedPayments: records.unmatchedPayments.length,
    emails: outbox.length, contactForms: records.contactForms.length, bookRequestLinks: records.bookRequestLinks,
  };
  records.total = Object.entries(records.counts).reduce((n, [k, v]) => n + (k === "unmatchedPayments" || k === "contactForms" ? 0 : v), 0);
  return records;
}

// Everything, as one JSON-able object: each account's full member export, plus
// the sections held under the bare address.
async function buildAddressExport(pool, email) {
  const { rows } = await pool.query("SELECT id FROM users WHERE lower(email) = $1 ORDER BY id", [email]);
  const accounts = [];
  for (const { id } of rows) accounts.push(await buildMemberExport(pool, id));
  return {
    exported_at: new Date().toISOString(),
    note: "Personal data held by Uma's Books under this email address. Passwords and security secrets are never included. Message texts are not included (they may hold one-time links).",
    address: email,
    accounts,
    held_under_address: await buildEmailSections(pool, email, null),
  };
}

// One transaction. Accounts go through eraseMember (so exactly what a member
// deleting their account gets); then whatever remains under the bare address.
// Paid orders and payment records are anonymised, not deleted (10-year
// accounting retention). Returns { ok: false, reason } without touching
// anything when an account with the address is an administrator.
async function eraseEverythingFor(pool, email) {
  const { rows: admins } = await pool.query("SELECT 1 FROM users WHERE lower(email) = $1 AND is_admin LIMIT 1", [email]);
  if (admins.length) return { ok: false, reason: "admin" };
  return withTransaction(pool, async (db) => {
    const { rows: users } = await db.query("SELECT id FROM users WHERE lower(email) = $1 ORDER BY id FOR UPDATE", [email]);
    for (const { id } of users) await eraseMember(pool, id, { client: db });
    await eraseEmailKeyedData(db, email, { userId: null });
    const outbox = await eraseOutboxFor(db, email);
    return { ok: true, accounts: users.length, outbox };
  });
}

module.exports = { normaliseAddress, auditToken, findRecords, buildAddressExport, eraseEverythingFor };
