// Fake people and reservations for the TEST SYSTEM (staging) only:
//   npm run demo:load -- --yes      (creates them; safe to run again)
//   npm run demo:remove -- --yes    (removes exactly what demo:load made)
// See docs/runbook.md, section aa, "Demo people and reservations".
//
// What it makes (everything is marked "demo", nothing else is touched):
//   - 5 accounts at the reserved example.com domain (nobody can receive mail
//     there): demo.account, demo.member, demo.expired, demo.volunteer,
//     demo.account2. Confirmed email, so they can log in. Random strong
//     passwords per run, only their hashes are stored, printed once.
//   - 3 reservations through the real library functions (lib/cart.js
//     createReservation, lib/till.js completeSale): one open, one expiring
//     within the reminder window, one collected and paid at the till (with a
//     receipt number).
//   - the book copies those need: real in-stock copies when the inventory has
//     at least 4, otherwise clearly fake "DEMO ..." books (at most 6 copies).
//     The collected reservation always uses a DEMO copy, so removal never has
//     to "un-sell" a real book.
//
// Safety (checked before anything is written, load AND remove):
//   - only on the test system (APP_ENV=staging), or locally with
//     DEMO_ALLOW_LOCAL=1 AND a localhost DATABASE_URL;
//   - never when DATABASE_URL is the production database host
//     (PRODUCTION_DATABASE_HOST);
//   - never when the users table has more than 50 rows and any of them is not
//     a demo account (that looks like real data);
//   - prints what it will do, and needs --yes (or DEMO_CONFIRM=yes).
// It sends no email (the mailer is muted for the run and the confirmation
// rows the reservations queue are deleted again) and contacts no external
// service (no password-breach lookup, no HelloAsso, no cover lookups).
//
// How the marks work (no schema change): accounts are the fixed addresses in
// ACCOUNTS; reservations are orders of those accounts; demo books have
// authors "DEMO Author", no ISBN and a title starting "DEMO "; demo copies have
// notes starting "DEMO (".

const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { isStaging, hostOf, productionHostProblem } = require("./staging");

const MANY_USERS = 50;
const MAX_DEMO_COPIES = 6;
const MIN_REAL_COPIES = 4;
const EXPIRING_IN_DAYS = 2; // inside the reminder window (legal.RESERVATION_REMINDER_DAYS_BEFORE)
const DEMO_AUTHOR = "DEMO Author";
const DEMO_NOTE = "DEMO (fake test copy: npm run demo:remove deletes it)";
const DEMO_BOOKS = [
  { title: "DEMO Book One (fake)", price: "5.00" },
  { title: "DEMO Book Two (fake)", price: "6.50" },
  { title: "DEMO Book Three (fake)", price: "8.00" },
];

const ACCOUNTS = [
  { key: "account", email: "demo.account@example.com", name: "DEMO Account Holder", role: "account holder (not a member)" },
  { key: "member", email: "demo.member@example.com", name: "DEMO Member", role: "member (membership valid for a year)", member: "active" },
  { key: "expired", email: "demo.expired@example.com", name: "DEMO Expired Member", role: "member whose membership expired", member: "expired" },
  { key: "volunteer", email: "demo.volunteer@example.com", name: "DEMO Volunteer", role: "volunteer", volunteer: true },
  { key: "account2", email: "demo.account2@example.com", name: "DEMO Second Account Holder", role: "account holder (not a member)" },
];
const DEMO_EMAILS = ACCOUNTS.map((a) => a.email);

const RESERVATIONS = [
  { key: "open", name: "DEMO Open reservation", account: "account", status: "reserved", what: "fresh open reservation" },
  { key: "expiring", name: "DEMO Expiring reservation", account: "member", status: "reserved", expiring: true, what: `reservation expiring in ${EXPIRING_IN_DAYS} days (inside the reminder window)` },
  { key: "collected", name: "DEMO Collected and paid", account: "account2", status: "paid", pay: true, what: "reservation collected and paid in cash at the till (with a receipt number)" },
];

const accountByKey = (k) => ACCOUNTS.find((a) => a.key === k);

// ---------- safety ----------

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Pure part: what the ENVIRONMENT forbids. Empty list = allowed.
function envProblems(env = process.env) {
  const problems = [];
  const local = String(env.DEMO_ALLOW_LOCAL || "").trim() === "1";
  if (isStaging(env)) {
    // fine: the test system
  } else if (local) {
    if (!LOCAL_HOSTS.has(hostOf(env.DATABASE_URL))) {
      problems.push("DEMO_ALLOW_LOCAL=1 only works with a DATABASE_URL on localhost (127.0.0.1 or ::1); this DATABASE_URL is not.");
    }
  } else {
    problems.push("Not the test system: APP_ENV is not 'staging'. This script only runs on the staging service (or locally with DEMO_ALLOW_LOCAL=1 and a localhost DATABASE_URL). Nothing was changed.");
  }
  const prod = productionHostProblem(env);
  if (prod) problems.push(prod);
  if (!String(env.DATABASE_URL || "").trim()) problems.push("DATABASE_URL is not set.");
  return problems;
}

// Database part: users that are not demo accounts, when there are many.
async function dataProblems(pool) {
  const { rows: [r] } = await pool.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE lower(email) <> ALL($1::text[]))::int AS other FROM users",
    [DEMO_EMAILS]
  );
  if (r.total > MANY_USERS && r.other > 0) {
    return [`The users table has ${r.total} rows and ${r.other} of them are not demo accounts: this looks like real data, so the script refuses to touch it.`];
  }
  return [];
}

function confirmed(argv, env) {
  return argv.includes("--yes") || String(env.DEMO_CONFIRM || "").trim().toLowerCase() === "yes";
}

// ---------- mail is muted for the whole run ----------

function muteMail() {
  const mailer = require("../mailer");
  const original = mailer.sendMail;
  let blocked = 0;
  mailer.sendMail = async () => { blocked++; };
  return { blocked: () => blocked, restore: () => { mailer.sendMail = original; } };
}

// ---------- passwords ----------

function randomPassword() {
  const sets = ["abcdefghjkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "-_.!#"];
  const all = sets.join("");
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (chars.length < 20) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ---------- load ----------

async function ensureAccounts(pool, { fixedPassword, resetPasswords }) {
  const out = { created: [], existing: [], passwords: {} };
  for (const a of ACCOUNTS) {
    const memberSql = a.member === "active" ? "now() + interval '365 days'" : a.member === "expired" ? "now() - interval '30 days'" : "NULL";
    const { rows: found } = await pool.query("SELECT id FROM users WHERE lower(email) = $1", [a.email]);
    let password = null;
    if (!found.length || resetPasswords) password = fixedPassword || randomPassword();
    if (!found.length) {
      const hash = await bcrypt.hash(password, 10);
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, display_name, is_member, member_expires_at, is_volunteer, email_verified_at)
         VALUES ($1, $2, $3, $4, ${memberSql}, $5, now()) RETURNING id`,
        [a.email, hash, a.name, Boolean(a.member), Boolean(a.volunteer)]
      );
      a.id = rows[0].id;
      out.created.push(a.email);
    } else {
      // Re-run: put the flags back to what the account is meant to be (never
      // is_admin, never is_till). The password changes only with --reset-passwords.
      const sets = [`is_member = $2`, `member_expires_at = ${memberSql}`, `is_volunteer = $3`, "is_disabled = FALSE", "locked_until = NULL", "failed_login_attempts = 0", "email_verified_at = COALESCE(email_verified_at, now())"];
      const params = [found[0].id, Boolean(a.member), Boolean(a.volunteer)];
      if (password) {
        params.push(await bcrypt.hash(password, 10));
        sets.push(`password_hash = $${params.length}`, "password_changed_at = now()");
      }
      await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1 AND NOT is_admin`, params);
      a.id = found[0].id;
      out.existing.push(a.email);
    }
    if (password) out.passwords[a.email] = password;
  }
  return out;
}

async function realStockCount(pool) {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.status = 'in_stock' AND c.price IS NOT NULL AND c.price > 0
       AND c.cart_order_id IS NULL AND COALESCE(c.notes, '') NOT LIKE 'DEMO (%'`
  );
  return r.n;
}

async function inStockCopy(pool, { demo, exclude }) {
  const { rows } = await pool.query(
    `SELECT c.id, c.price, b.title FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.status = 'in_stock' AND c.price IS NOT NULL AND c.price > 0 AND c.cart_order_id IS NULL
       AND (COALESCE(c.notes, '') LIKE 'DEMO (%') = $1 AND c.id <> ALL($2::int[])
     ORDER BY c.id LIMIT 1`,
    [demo, exclude]
  );
  return rows[0] || null;
}

// Makes sure the fake books exist with enough copies. `books` = how many of
// the three, `copies` = copies of each; copies already made are counted
// whatever their status (sold ones too), so the cap of MAX_DEMO_COPIES holds.
async function ensureDemoStock(pool, { books, copies }) {
  for (const def of DEMO_BOOKS.slice(0, books)) {
    let { rows: [book] } = await pool.query("SELECT id FROM books WHERE title = $1 AND authors = $2 AND isbn IS NULL ORDER BY id LIMIT 1", [def.title, DEMO_AUTHOR]);
    if (!book) {
      ({ rows: [book] } = await pool.query(
        "INSERT INTO books (isbn, title, authors, description) VALUES (NULL, $1, $2, 'Fake book made by npm run demo:load. Safe to delete.') RETURNING id",
        [def.title, DEMO_AUTHOR]
      ));
    }
    const { rows: [{ n: have }] } = await pool.query("SELECT count(*)::int AS n FROM book_copies WHERE book_id = $1", [book.id]);
    const { rows: [{ n: total }] } = await pool.query("SELECT count(*)::int AS n FROM book_copies WHERE COALESCE(notes, '') LIKE 'DEMO (%'");
    let made = 0;
    for (let i = have; i < copies && total + made < MAX_DEMO_COPIES; i++, made++) {
      await pool.query(
        "INSERT INTO book_copies (book_id, condition, price, status, notes) VALUES ($1, 'very_good', $2, 'in_stock', $3)",
        [book.id, def.price, DEMO_NOTE]
      );
    }
  }
}

async function findOrder(pool, userId, spec) {
  const { rows } = await pool.query("SELECT id FROM orders WHERE user_id = $1 AND buyer_name = $2 AND status = $3 ORDER BY id LIMIT 1", [userId, spec.name, spec.status]);
  return rows[0] ? rows[0].id : null;
}

async function ensureReservations(pool, log) {
  const { createReservation } = require("./cart");
  const { completeSale } = require("./till");
  const { TERMS_OF_SALE_VERSION } = require("./legal");
  const results = [];
  const missing = [];
  for (const spec of RESERVATIONS) {
    const user = accountByKey(spec.account);
    const id = await findOrder(pool, user.id, spec);
    if (id) results.push({ key: spec.key, orderId: id, existed: true, what: spec.what });
    else missing.push(spec);
  }
  if (!missing.length) return results;

  // Copies: real in-stock ones when there are at least 4, else fake ones. Only
  // looked at when a reservation has to be made (a re-run changes nothing).
  const useReal = (await realStockCount(pool)) >= MIN_REAL_COPIES;
  if (useReal) {
    if (missing.some((s) => s.pay)) await ensureDemoStock(pool, { books: 1, copies: 1 });
  } else {
    await ensureDemoStock(pool, { books: 3, copies: 2 });
  }

  const taken = [];
  const { rows: admins } = await pool.query("SELECT id FROM users WHERE is_admin ORDER BY id LIMIT 1");
  for (const spec of missing) {
    const user = accountByKey(spec.account);
    const copy = await inStockCopy(pool, { demo: !useReal || Boolean(spec.pay), exclude: taken });
    if (!copy) {
      results.push({ key: spec.key, skipped: `no in-stock copy was available for it`, what: spec.what });
      continue;
    }
    taken.push(copy.id);
    const order = await createReservation(pool, {
      user: { id: user.id, email: user.email }, name: spec.name, phone: null, lang: "en", hasDropin: false,
      acceptedVersion: TERMS_OF_SALE_VERSION,
      items: [{ kind: "book", copyId: copy.id, title: copy.title, price: Number(copy.price) }],
    });
    const r = { key: spec.key, orderId: order.id, what: spec.what, book: copy.title };
    if (spec.expiring) {
      await pool.query("UPDATE orders SET reserved_until = now() + make_interval(days => $2) WHERE id = $1 AND status = 'reserved'", [order.id, EXPIRING_IN_DAYS]);
    }
    if (spec.pay) {
      try {
        const { rows: lines } = await pool.query("SELECT id, price FROM order_items WHERE order_id = $1 ORDER BY id", [order.id]);
        const totalCents = lines.reduce((s, l) => s + Math.round(Number(l.price) * 100), 0);
        const sale = await completeSale(pool, {
          token: `demo-${crypto.randomBytes(12).toString("hex")}`, method: "cash",
          items: lines.map((l) => ({ kind: "reserved", orderId: order.id, itemId: l.id })),
          received: String(Math.ceil(totalCents / 100)), expectedTotalCents: totalCents, userId: admins[0] ? admins[0].id : null, isAdmin: true,
        });
        const { rows: [s] } = await pool.query("SELECT receipt_year, receipt_no FROM till_sales WHERE id = $1", [sale.saleId]);
        r.receipt = s && s.receipt_no ? `${s.receipt_year}-${String(s.receipt_no).padStart(4, "0")}` : String(sale.saleId);
      } catch (err) {
        // The reservation stays open (fine to look at); say why it was not paid.
        r.paidSkipped = err.message;
        log(`  (could not pay reservation ${order.id} at the till: ${err.message})`);
      }
    }
    results.push(r);
  }
  return results;
}

async function loadDemo(pool, { fixedPassword = null, resetPasswords = false, log = () => {} } = {}) {
  const mail = muteMail();
  try {
    const accounts = await ensureAccounts(pool, { fixedPassword, resetPasswords });
    const reservations = await ensureReservations(pool, log);
    // The confirmations the reservations queued: not wanted (and never sent).
    const { rowCount } = await pool.query(
      "DELETE FROM email_outbox WHERE lower(to_email) = ANY($1::text[]) OR related_order_id IN (SELECT id FROM orders WHERE lower(buyer_email) = ANY($1::text[]))",
      [DEMO_EMAILS]
    );
    return { accounts, reservations, outboxRowsDeleted: rowCount, mailBlocked: mail.blocked() };
  } finally {
    mail.restore();
  }
}

// ---------- remove ----------

async function removeDemo(pool) {
  const { releaseReservation } = require("./reservations");
  const { withTransaction } = require("../db");
  const summary = { released: 0, orders: 0, sales: 0, copies: 0, books: 0, users: 0, keptCopies: 0 };

  const { rows: open } = await pool.query("SELECT id FROM orders WHERE lower(buyer_email) = ANY($1::text[]) AND status = 'reserved'", [DEMO_EMAILS]);
  for (const { id } of open) {
    // Gives real copies back to the shelf (and frees demo ones).
    const r = await releaseReservation(pool, id, { status: "cancelled", reason: "admin" });
    if (r.outcome === "released") summary.released++;
  }

  await withTransaction(pool, async (client) => {
    const demoOrders = "SELECT id FROM orders WHERE lower(buyer_email) = ANY($1::text[]) OR user_id IN (SELECT id FROM users WHERE lower(email) = ANY($1::text[]))";
    const sales = `SELECT DISTINCT sale_id FROM till_sale_items WHERE reservation_order_id IN (${demoOrders})`;
    await client.query(`DELETE FROM shop_sales WHERE till_sale_id IN (${sales})`, [DEMO_EMAILS]);
    summary.sales = (await client.query(`DELETE FROM till_sales WHERE id IN (${sales})`, [DEMO_EMAILS])).rowCount;
    await client.query(`DELETE FROM email_outbox WHERE lower(to_email) = ANY($1::text[]) OR related_order_id IN (${demoOrders})`, [DEMO_EMAILS]);
    summary.orders = (await client.query(`DELETE FROM orders WHERE id IN (${demoOrders})`, [DEMO_EMAILS])).rowCount;
    // Fake copies and books, unless something else (an order the tester made
    // herself) still refers to them.
    summary.copies = (await client.query(
      `DELETE FROM book_copies c WHERE COALESCE(c.notes, '') LIKE 'DEMO (%'
         AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.book_copy_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM shop_sales s WHERE s.copy_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM till_sale_items t WHERE t.copy_id = c.id)`
    )).rowCount;
    summary.keptCopies = (await client.query("SELECT count(*)::int AS n FROM book_copies WHERE COALESCE(notes, '') LIKE 'DEMO (%'")).rows[0].n;
    summary.books = (await client.query(
      `DELETE FROM books b WHERE b.authors = $1 AND b.isbn IS NULL AND b.title LIKE 'DEMO %'
         AND NOT EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id)`, [DEMO_AUTHOR]
    )).rowCount;
    summary.users = (await client.query("DELETE FROM users WHERE lower(email) = ANY($1::text[]) AND NOT is_admin", [DEMO_EMAILS])).rowCount;
  });
  return summary;
}

// ---------- command line ----------

function planText(command, { fixedPassword, resetPasswords }) {
  if (command === "remove") {
    return [
      "demo:remove will DELETE:",
      `  - the demo accounts (${DEMO_EMAILS.join(", ")})`,
      "  - their reservations (open ones are released first, real books go back on the shelf), the till receipt of the paid one",
      "  - the fake \"DEMO ...\" books and copies (a copy that another order still refers to is kept)",
      "  Real books, other accounts and the admin are not touched.",
    ];
  }
  return [
    "demo:load will CREATE (anything that already exists is left as it is):",
    ...ACCOUNTS.map((a) => `  - account ${a.email}: ${a.role}`),
    ...RESERVATIONS.map((r) => `  - ${r.what}`),
    `  - fake "DEMO ..." books/copies (at most ${MAX_DEMO_COPIES} copies) when reservations need them; real in-stock copies are used for the open and expiring ones when the inventory has at least ${MIN_REAL_COPIES}`,
    `  Passwords: ${fixedPassword ? "the one from DEMO_PASSWORD" : "random, printed once at the end"}${resetPasswords ? " (existing demo accounts get a new password too)" : "; existing demo accounts keep theirs (add --reset-passwords for new ones)"}.`,
    "  No email is sent or queued. No external service is contacted.",
  ];
}

// argv: the arguments after the script name. Resolves the exit code.
async function main({ argv, env = process.env, pool = null, out = console.log, err = console.error } = {}) {
  const command = argv[0];
  if (command !== "load" && command !== "remove") {
    err("Usage: npm run demo:load -- --yes   |   npm run demo:remove -- --yes   (options: --reset-passwords, --password-from-env)");
    return 2;
  }
  const flags = argv.slice(1);
  const problems = envProblems(env);
  let fixedPassword = null;
  if (flags.includes("--password-from-env")) {
    fixedPassword = String(env.DEMO_PASSWORD || "");
    if (fixedPassword.length < 12) problems.push("--password-from-env needs DEMO_PASSWORD set to at least 12 characters.");
  }
  const refuse = (list) => { for (const p of list) err(`REFUSED: ${p}`); return 1; };
  if (problems.length) return refuse(problems);

  const p = pool || require("../db").pool;
  const ownPool = !pool;
  try {
    const more = await dataProblems(p);
    if (more.length) return refuse(more);
    const resetPasswords = flags.includes("--reset-passwords");
    for (const line of planText(command, { fixedPassword, resetPasswords })) out(line);
    if (!confirmed(argv, env)) {
      return refuse(["Nothing was changed. Run it again with --yes (or DEMO_CONFIRM=yes) to go ahead."]);
    }
    if (command === "remove") {
      const s = await removeDemo(p);
      out(`Removed: ${s.users} accounts, ${s.orders} reservations (${s.released} were still open), ${s.sales} till receipts, ${s.copies} fake copies, ${s.books} fake books.`);
      if (s.keptCopies) out(`Kept ${s.keptCopies} fake copies because another order still refers to them.`);
      return 0;
    }
    const r = await loadDemo(p, { fixedPassword, resetPasswords, log: out });
    out("");
    out(`Accounts: ${r.accounts.created.length} created, ${r.accounts.existing.length} already there.`);
    for (const x of r.reservations) {
      if (x.skipped) out(`Reservation (${x.what}): SKIPPED, ${x.skipped}.`);
      else out(`Reservation #${x.orderId} (${x.what}): ${x.existed ? "already there" : "created"}${x.receipt ? `, receipt ${x.receipt}` : ""}${x.paidSkipped ? `, NOT paid (${x.paidSkipped})` : ""}.`);
    }
    out(`Email: none sent (${r.mailBlocked} blocked), ${r.outboxRowsDeleted} queued confirmation rows deleted.`);
    const pw = Object.entries(r.accounts.passwords);
    if (pw.length) {
      out("");
      out("LOGINS (shown ONCE: copy them now; only hashes are stored):");
      for (const [email, password] of pw) out(`  ${email}   ${password}`);
    } else {
      out("No new passwords (the accounts already existed). Use --reset-passwords to set new ones.");
    }
    return 0;
  } finally {
    if (ownPool) await p.end().catch(() => {});
  }
}

module.exports = {
  main, loadDemo, removeDemo, envProblems, dataProblems, randomPassword,
  ACCOUNTS, RESERVATIONS, DEMO_EMAILS, MAX_DEMO_COPIES, MANY_USERS, DEMO_NOTE,
};
