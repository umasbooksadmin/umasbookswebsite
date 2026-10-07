// Removes TEST data from the database before launch (npm run clear-test-data,
// scripts/clear-test-data.js). This is the most dangerous code in the repo:
// run against a live database it destroys real orders and members. Every
// design choice below is about making a mistake hard.
//
// Safety layers
//  1. Dry run by default. It does the whole job inside a transaction and rolls
//     it back, so the counts it prints are exactly what a real run deletes.
//  2. A real run needs --execute AND --confirm "DELETE TEST DATA FROM <db>"
//     (the database's own name) AND --i-have-a-backup.
//  3. Refuses unless PREVIEW_MODE is on, unless --allow-live is given.
//  4. Every table must be classified in TABLES below (shop / people / logs /
//     content / kept). The script refuses to run when the database has a table
//     it does not know, and test/integration/clearTestData.test.js fails when a
//     migration adds a table nobody classified. New tables must be classified
//     here, deliberately.
//  5. Admins are never deleted (every delete says NOT is_admin) and the script
//     refuses to run when there is no admin at all.
//  6. One transaction, plain DELETEs in foreign-key order (no TRUNCATE ...
//     CASCADE), then sanity checks (admins, 2FA, recovery codes, pricing
//     settings, migrations, kept content unchanged) that roll everything back
//     on the slightest difference.
//  7. Sequences are restarted (ALTER SEQUENCE ... RESTART, which rolls back
//     with the transaction) only for tables that ended up completely empty.

const crypto = require("node:crypto");
const { isPreviewMode } = require("./preview");
const { IMAGE_REFERENCES, notReferencedSql } = require("./imageCleanup");

// Group of every table in the public schema.
//   shop    - books, stock, orders and everything hanging off them. Always cleared.
//   people  - accounts and what they did, plus guest sign-ups keyed by email.
//             Admin accounts (and what only they own) stay.
//   logs    - admin_audit_log. Always cleared.
//   content - events, classes, blog, announcements, charity rounds, meetings,
//             volunteer shifts. KEPT unless --include-content.
//   kept    - never touched.
const GROUPS = ["shop", "people", "logs", "content", "kept"];
const TABLES = {
  // shop
  books: "shop",
  book_copies: "shop",
  orders: "shop",
  order_items: "shop",
  class_dropin_seats: "shop",
  shop_sales: "shop",
  till_sales: "shop",
  till_sale_items: "shop",
  till_quick_items: "shop",
  till_days: "shop",
  till_receipt_counters: "shop", // per-year receipt numbers: restart with the sales
  accounting_map: "kept", // the treasurer's account mapping is settings
  book_awards: "shop",
  book_requests: "shop",
  book_request_list_tokens: "shop",
  price_lookups: "shop",
  images: "shop", // only the ones no remaining row refers to
  favorites: "shop",
  // people
  users: "people", // non-admins only
  event_signups: "people",
  class_signups: "people",
  event_rsvps: "people",
  forum_threads: "people",
  forum_replies: "people",
  charity_votes: "people",
  charity_ideas: "people",
  membership_payments: "people",
  email_outbox: "people", // stored copies of sent/queued emails (recipient, subject, body)
  password_reset_tokens: "people",
  email_verification_tokens: "people",
  totp_recovery_codes: "people", // non-admins only: admins keep their codes
  volunteer_signups: "people",
  meeting_rsvps: "people",
  session: "people", // created by connect-pg-simple; admins' sessions stay
  // logs
  admin_audit_log: "logs",
  // content
  events: "content",
  classes: "content",
  blog_posts: "content",
  announcements: "content",
  charity_rounds: "content",
  charity_options: "content",
  charities: "content",
  meetings: "content",
  volunteer_shifts: "content",
  // kept
  schema_migrations: "kept",
  pricing_settings: "kept",
  job_runs: "kept", // background-job bookkeeping (no personal data); clearing it would only hide a failing job
  alert_flags: "kept", // "alert X was sent at T" markers (no personal data)
};

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
for (const t of Object.keys(TABLES)) {
  if (!IDENT_RE.test(t)) throw new Error(`Bad table name ${t}`);
}

const NON_ADMIN = "(SELECT id FROM users WHERE NOT is_admin)";
const GROUP_TITLES = {
  shop: "Shop data (always cleared)",
  people: "People",
  logs: "Logs (always cleared)",
  content: "Content",
  kept: "Always kept",
};

// ---------------------------------------------------------------------------
// Command line

const VALUE_FLAGS = new Set(["--confirm"]);
const BOOL_FLAGS = new Set([
  "--execute",
  "--i-have-a-backup",
  "--include-content",
  "--keep-members",
  "--allow-live",
  "--list-admins",
  "--help",
]);

// -> { flags: {execute, confirm, backup, includeContent, keepMembers, allowLive, listAdmins, help}, errors: [] }
function parseArgs(argv) {
  const flags = {
    execute: false,
    confirm: null,
    backup: false,
    includeContent: false,
    keepMembers: false,
    allowLive: false,
    listAdmins: false,
    help: false,
  };
  const errors = [];
  const camel = (f) => f.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inline = null;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = inline !== null ? inline : argv[i + 1];
      if (value === undefined || (inline === null && value.startsWith("--"))) {
        errors.push(`${arg} needs a value`);
      } else {
        flags.confirm = value;
        if (inline === null) i += 1;
      }
    } else if (BOOL_FLAGS.has(arg) && inline === null) {
      if (arg === "--i-have-a-backup") flags.backup = true;
      else flags[camel(arg)] = true;
    } else {
      errors.push(`Unknown option: ${argv[i]}`);
    }
  }
  if (flags.listAdmins && (flags.execute || flags.includeContent || flags.keepMembers)) {
    errors.push("--list-admins cannot be combined with other options");
  }
  return { flags, errors };
}

// "postgres://user:pw@host:5432/dbname?x=y" -> { host, name }; never the password.
function describeDatabaseUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname || "(unknown host)", name: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  } catch {
    return { host: "(unreadable DATABASE_URL)", name: "" };
  }
}

const confirmPhrase = (dbName) => `DELETE TEST DATA FROM ${dbName}`;

// The reasons a REAL run must be refused ([] = allowed).
function executeRefusals(flags, { dbName, env }) {
  const problems = [];
  if (!flags.execute) return problems;
  if (flags.confirm !== confirmPhrase(dbName)) {
    problems.push(`--confirm "${confirmPhrase(dbName)}" is missing or does not match this database exactly.`);
  }
  if (!flags.backup) {
    problems.push("--i-have-a-backup is missing. Run the 'Nightly database backup' workflow first (GitHub > Actions) and wait for it to go green.");
  }
  if (!isPreviewMode(env) && !flags.allowLive) {
    problems.push("PREVIEW_MODE is not on. This looks like a LIVE site: refusing. (--allow-live overrides this; read the warning before you do.)");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Database helpers

const countRows = async (db, table, where = "TRUE") => {
  if (!TABLES[table]) throw new Error(`Unclassified table ${table}`);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return rows[0].n;
};

async function existingTables(db) {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

// Tables in the database that TABLES does not classify.
async function unclassifiedTables(db) {
  return (await existingTables(db)).filter((t) => !TABLES[t]);
}

async function listAdmins(db) {
  const { rows } = await db.query("SELECT email FROM users WHERE is_admin ORDER BY id");
  return rows.map((r) => r.email);
}

const digest = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");

// Fingerprints of everything that must come out the other side unchanged.
async function snapshot(db, have) {
  const fp = async (sql) => {
    const { rows } = await db.query(sql);
    return digest(rows.map((r) => r.j).join("\n"));
  };
  const snap = {
    admins: await fp("SELECT row_to_json(u)::text AS j FROM users u WHERE is_admin ORDER BY id"),
    adminCount: await countRows(db, "users", "is_admin"),
    nonAdminCount: await countRows(db, "users", "NOT is_admin"),
    recovery: await fp(
      "SELECT row_to_json(c)::text AS j FROM totp_recovery_codes c WHERE user_id IN (SELECT id FROM users WHERE is_admin) ORDER BY id"
    ),
    pricing: await fp("SELECT row_to_json(p)::text AS j FROM pricing_settings p ORDER BY id"),
    migrations: await fp("SELECT row_to_json(m)::text AS j FROM schema_migrations m ORDER BY filename"),
    adminSessions: have.session ? await countRows(db, "session", ADMIN_SESSION) : 0,
    content: {},
  };
  for (const [t, g] of Object.entries(TABLES)) {
    if (g === "content") snap.content[t] = await countRows(db, t);
  }
  return snap;
}

// A login session belongs to an admin when its user id is an admin's.
const ADMIN_SESSION = "(sess -> 'user' ->> 'id') IN (SELECT id::text FROM users WHERE is_admin)";

// ---------------------------------------------------------------------------
// The plan: ordered deletes. Children always come before parents so plain
// DELETEs never hit a foreign key. Each step: { table, where }.

function buildPlan({ includeContent = false, keepMembers = false } = {}, have = { session: true }) {
  const steps = [];
  const del = (table, where = "TRUE") => steps.push({ table, where });

  // Shop data: always.
  del("order_items");
  del("till_sale_items");
  del("shop_sales");
  del("till_sales");
  del("till_receipt_counters");
  del("till_days");
  del("till_quick_items");
  del("book_requests");
  del("book_request_list_tokens");
  del("class_dropin_seats");
  del("orders");
  del("favorites");
  del("book_awards");
  del("book_copies");
  del("books");
  del("price_lookups");

  // Guest data keyed only by email: always.
  del("event_signups");
  del("class_signups");

  // Rows hanging off events, meetings, shifts, rounds. All of them when the
  // content goes too; otherwise only non-admin accounts' rows.
  const childWhere = includeContent ? "TRUE" : keepMembers ? null : `user_id IN ${NON_ADMIN}`;
  if (childWhere) {
    del("event_rsvps", childWhere);
    del("meeting_rsvps", childWhere);
    del("volunteer_signups", childWhere);
    del("charity_votes", childWhere);
  }

  // People who have accounts.
  if (!keepMembers) {
    const authorGone = `author_id IS NULL OR author_id IN ${NON_ADMIN}`;
    del("charity_ideas", `submitted_by IS NULL OR submitted_by IN ${NON_ADMIN}`);
    del("forum_replies", `${authorGone} OR thread_id IN (SELECT id FROM forum_threads WHERE ${authorGone})`);
    del("forum_threads", authorGone);
    del("membership_payments", `user_id IS NULL OR user_id IN ${NON_ADMIN}`);
    del("email_outbox");
    del("password_reset_tokens", `user_id IN ${NON_ADMIN}`);
    del("email_verification_tokens", `user_id IN ${NON_ADMIN}`);
    del("totp_recovery_codes", `user_id IN ${NON_ADMIN}`);
  }
  if (have.session) {
    // Guests without an account (carts of deleted books) always go; with an
    // account, only the ones of accounts that are going.
    const keepSession = keepMembers ? "(sess -> 'user' ->> 'id') IN (SELECT id::text FROM users)" : ADMIN_SESSION;
    del("session", `NOT COALESCE(${keepSession}, false)`);
  }
  if (!keepMembers) del("users", "NOT is_admin");

  // Logs.
  del("admin_audit_log");

  // Content: only on request.
  if (includeContent) {
    del("announcements");
    del("blog_posts");
    del("events");
    del("classes");
    del("charity_options");
    del("charities");
    del("charity_rounds");
    del("meetings");
    del("volunteer_shifts");
  }

  // Pictures nothing refers to any more (covers of the deleted books, ...).
  // Also whatever was already unused: the daily cleanup would remove it too.
  steps.push({ table: "images", where: notReferencedSql("images") });
  return steps;
}

// ---------------------------------------------------------------------------
// The run

class SanityError extends Error {}
class RefusedError extends Error {}

// Runs the whole job on `db` (a connected pg Client/PoolClient, not shared
// with anything else) inside one transaction. execute=false: dry run, always
// rolled back. Returns a report; throws RefusedError / SanityError (after
// rolling back) when it must not go ahead.
//   hooks.afterDeletes(db): TEST ONLY, runs after the deletes so a test can
//   simulate something going wrong and prove the sanity checks catch it.
async function runClearTestData(db, { execute = false, includeContent = false, keepMembers = false, hooks = {} } = {}) {
  const { rows: dbRow } = await db.query("SELECT current_database() AS name");
  const dbName = dbRow[0].name;

  const unknown = await unclassifiedTables(db);
  if (unknown.length) {
    throw new RefusedError(
      `The database has tables this script does not know: ${unknown.join(", ")}. ` +
        "Classify them in src/lib/clearTestData.js (TABLES) first, so nothing is forgotten or broken."
    );
  }
  const admins = await listAdmins(db);
  if (!admins.length) {
    throw new RefusedError("There is no admin account in this database. Refusing: after the clean-up nobody could log in.");
  }

  const have = { session: (await db.query("SELECT to_regclass('public.session') AS t")).rows[0].t !== null };
  const plan = buildPlan({ includeContent, keepMembers }, have);

  const report = {
    database: dbName,
    executed: false,
    committed: false,
    includeContent,
    keepMembers,
    admins,
    tables: [], // { group, table, deleted, remaining }
    sequences: [], // { table, sequence, restarted }
    warnings: [],
  };

  await db.query("BEGIN");
  try {
    // Never wait forever on a lock held by the live site, never run away.
    await db.query("SET LOCAL lock_timeout = '15s'");
    await db.query("SET LOCAL statement_timeout = '10min'");

    // Warnings for the report, before anything is deleted.
    const paidOrders = await countRows(db, "orders", "status = 'paid'");
    const payments = await countRows(db, "membership_payments");
    if (paidOrders || payments) {
      report.warnings.push(
        `${paidOrders} paid reservation(s) and ${payments} membership payment(s) will be deleted. ` +
          "If any are REAL, French accounting law makes you keep them for 10 years: stop."
      );
    }
    if (!keepMembers) {
      const real = await countRows(db, "users", "NOT is_admin AND (is_member OR is_volunteer OR member_expires_at > now())");
      if (real) {
        report.warnings.push(`${real} non-admin account(s) are marked member or volunteer and will be deleted. Re-run with --keep-members if they are real.`);
      }
    }

    const before = await snapshot(db, have);
    const deleted = {};
    for (const step of plan) {
      const r = await db.query(`DELETE FROM ${step.table}${step.where === "TRUE" ? "" : ` WHERE ${step.where}`}`);
      deleted[step.table] = (deleted[step.table] || 0) + r.rowCount;
    }
    if (hooks.afterDeletes) await hooks.afterDeletes(db);

    // Remaining rows per table, and which tables ended up empty.
    const remaining = {};
    for (const t of Object.keys(TABLES)) {
      if (t === "session" && !have.session) continue;
      remaining[t] = await countRows(db, t);
    }

    // Sequences of emptied tables restart at 1 (a real run only; ALTER SEQUENCE
    // RESTART is part of the transaction and rolls back with it).
    for (const t of Object.keys(deleted)) {
      if (remaining[t] !== 0) continue;
      // (pg_get_serial_sequence errors on a table without an "id" column.)
      const { rows: idCol } = await db.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'",
        [t]
      );
      if (!idCol.length) continue;
      const { rows } = await db.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [`public.${t}`]);
      if (!rows[0].s) continue;
      if (execute) await db.query(`ALTER SEQUENCE ${rows[0].s} RESTART WITH 1`);
      report.sequences.push({ table: t, sequence: rows[0].s, restarted: execute });
    }

    // Sanity checks.
    const after = await snapshot(db, have);
    const problems = [];
    if (after.adminCount < 1) problems.push("no admin account would remain");
    if (after.adminCount !== before.adminCount || after.admins !== before.admins) problems.push("admin accounts changed");
    if (after.recovery !== before.recovery) problems.push("admins' two-step recovery codes changed");
    if (after.pricing !== before.pricing) problems.push("pricing_settings changed");
    if (after.migrations !== before.migrations) problems.push("schema_migrations changed");
    if (after.adminSessions !== before.adminSessions) problems.push("admins' login sessions changed");
    if (keepMembers && after.nonAdminCount !== before.nonAdminCount) problems.push("members changed although --keep-members");
    if (!keepMembers && after.nonAdminCount !== 0) problems.push("non-admin accounts remain");
    for (const [t, n] of Object.entries(before.content)) {
      const expected = includeContent ? 0 : n;
      if (after.content[t] !== expected) problems.push(`content table ${t} has ${after.content[t]} rows, expected ${expected}`);
    }
    for (const t of Object.keys(TABLES)) {
      // images: only the unreferenced ones go (the rest are used by kept content).
      if (TABLES[t] === "shop" && t !== "images" && remaining[t] !== 0) problems.push(`shop table ${t} still has ${remaining[t]} rows`);
    }
    const strayImages = await countRows(db, "images", notReferencedSql("images"));
    if (strayImages) problems.push(`${strayImages} unused image(s) remain`);
    for (const t of ["event_signups", "class_signups", "admin_audit_log"]) {
      if (remaining[t] !== 0) problems.push(`${t} still has ${remaining[t]} rows`);
    }
    if (problems.length) throw new SanityError(`Sanity check failed, nothing was changed: ${problems.join("; ")}.`);

    for (const t of Object.keys(TABLES)) {
      if (t === "session" && !have.session) continue;
      report.tables.push({ group: TABLES[t], table: t, deleted: deleted[t] || 0, remaining: remaining[t] });
    }

    if (execute) {
      // One line of accountability, written last (the table was just emptied).
      await db.query(
        "INSERT INTO admin_audit_log (actor_label, action, detail) VALUES ('clear-test-data script', 'clear_test_data', $1)",
        [`content=${includeContent ? "cleared" : "kept"}, members=${keepMembers ? "kept" : "cleared"}`]
      );
      await db.query("COMMIT");
      report.executed = true;
      report.committed = true;
    } else {
      await db.query("ROLLBACK");
    }
    return report;
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {
      /* connection already gone: nothing was committed */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Output + entry point (scripts/clear-test-data.js)

const USAGE = `Usage: npm run clear-test-data -- [options]

  (no options)         Dry run: shows what WOULD be deleted. Deletes nothing.
  --list-admins        Print the admin e-mail addresses that are kept, then stop.
  --execute            Really delete. Also needs both of the following:
  --confirm "DELETE TEST DATA FROM <database name>"
  --i-have-a-backup    You ran the 'Nightly database backup' workflow first.
  --include-content    Also delete events, classes, blog, announcements,
                       charity rounds, meetings, volunteer shifts.
  --keep-members       Keep non-admin accounts and what they own.
  --allow-live         Allow a real run when PREVIEW_MODE is not on (DANGEROUS).

Note the "--" after the script name: without it npm swallows the options.`;

function formatReport(report, { dbHost, execute }) {
  const lines = [];
  lines.push(`Database: ${report.database} on ${dbHost}`);
  lines.push(`Mode: ${execute ? "REAL RUN (committed)" : "DRY RUN (nothing was changed)"}`);
  lines.push(`Admins kept: ${report.admins.length}`);
  const order = ["shop", "people", "logs", "content", "kept"];
  for (const g of order) {
    const rows = report.tables.filter((t) => t.group === g);
    if (!rows.length) continue;
    let title = GROUP_TITLES[g];
    if (g === "content") title += report.includeContent ? " (cleared: --include-content)" : " (KEPT: add --include-content to clear)";
    if (g === "people" && report.keepMembers) title += " (accounts KEPT: --keep-members)";
    lines.push("", `${title}`);
    const verb = execute ? "deleted" : "would delete";
    const width = Math.max(...rows.map((r) => r.table.length));
    for (const r of rows) {
      lines.push(`  ${r.table.padEnd(width)}  ${verb} ${String(r.deleted).padStart(6)}   remaining ${String(r.remaining).padStart(6)}`);
    }
  }
  if (report.sequences.length) {
    lines.push("", `${execute ? "Counters restarted at 1" : "Counters that would restart at 1"} (emptied tables only): ${report.sequences.map((s) => s.table).join(", ")}`);
  }
  for (const w of report.warnings) lines.push("", `WARNING: ${w}`);
  return lines.join("\n");
}

// connect(): returns a connected pg client for DATABASE_URL (injected so tests
// can reuse their own). Returns the process exit code; never calls process.exit.
async function main(argv, { env = process.env, out = console.log, err = console.error, connect } = {}) {
  const { flags, errors } = parseArgs(argv);
  if (flags.help) {
    out(USAGE);
    return 0;
  }
  if (errors.length) {
    for (const e of errors) err(e);
    err("");
    err(USAGE);
    return 2;
  }
  if (!env.DATABASE_URL) {
    err("DATABASE_URL is not set.");
    return 1;
  }
  const { host } = describeDatabaseUrl(env.DATABASE_URL);

  let db;
  try {
    db = await connect(env.DATABASE_URL);
  } catch (e) {
    err(`Could not connect to the database on ${host}: ${e.message}`);
    return 1;
  }
  try {
    const { rows } = await db.query("SELECT current_database() AS name");
    const dbName = rows[0].name;
    out(`Database host: ${host}`);
    out(`Database name: ${dbName}`);
    out(`PREVIEW_MODE: ${isPreviewMode(env) ? "on" : "OFF (this looks like a live site)"}`);
    out("");

    if (flags.listAdmins) {
      const admins = await listAdmins(db);
      out(admins.length ? `Admins that are kept (${admins.length}):` : "NO ADMIN ACCOUNTS FOUND.");
      for (const a of admins) out(`  ${a}`);
      return admins.length ? 0 : 1;
    }

    const problems = executeRefusals(flags, { dbName, env });
    if (problems.length) {
      err("REFUSED. Nothing was changed.");
      for (const p of problems) err(`  - ${p}`);
      return 1;
    }
    if (flags.execute) {
      out("Reminder: you need a fresh backup before this (GitHub > Actions > 'Nightly database backup' > Run workflow).");
      out("To get the data back afterwards, see 'Restoring from a backup' in umas-books/README.md and the 'Launching' section of docs/runbook.md.");
      if (!isPreviewMode(env)) {
        out("");
        out("!!! PREVIEW_MODE IS OFF AND --allow-live WAS GIVEN. THIS DELETES REAL ORDERS, REAL MEMBERS AND REAL PAYMENT RECORDS. !!!");
      }
      out("");
    }

    const report = await runClearTestData(db, {
      execute: flags.execute,
      includeContent: flags.includeContent,
      keepMembers: flags.keepMembers,
    });
    out(formatReport(report, { dbHost: host, execute: flags.execute }));
    if (!flags.execute) {
      out("");
      out("This was a dry run: nothing was deleted. To delete for real, run:");
      out(`  npm run clear-test-data -- --execute --confirm "${confirmPhrase(dbName)}" --i-have-a-backup${flags.includeContent ? " --include-content" : ""}${flags.keepMembers ? " --keep-members" : ""}`);
    } else {
      out("");
      out("Done. The test data is gone.");
    }
    return 0;
  } catch (e) {
    if (e instanceof RefusedError || e instanceof SanityError) {
      err(`REFUSED: ${e.message}`);
      err("Nothing was changed.");
    } else {
      err(`Failed, nothing was changed: ${e.message}`);
    }
    return 1;
  } finally {
    await db.end().catch(() => {});
  }
}

module.exports = {
  GROUPS,
  TABLES,
  IMAGE_REFERENCES,
  parseArgs,
  describeDatabaseUrl,
  confirmPhrase,
  executeRefusals,
  unclassifiedTables,
  listAdmins,
  buildPlan,
  runClearTestData,
  formatReport,
  main,
  RefusedError,
  SanityError,
};
