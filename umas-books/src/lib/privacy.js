// Right-to-erasure and retention purges. The periods here are the ones the
// privacy policy (views/marketing/privacy-policy.ejs, section "How long we
// keep it") promises — change both together.
//
// Most personal data in this app is keyed by EMAIL, not user_id (orders,
// event/class sign-ups, book reservations, HelloAsso payments), so deleting
// the users row alone leaves it all behind. eraseMember() handles both.

const { withTransaction } = require("../db");
const { sendMail } = require("../mailer");
const { emailSafeName } = require("./validation");

const RETENTION = {
  inactiveAccountYears: 3,
  signupMonths: 12,
  accountingYears: 10,
  tokenGraceDays: 7,
  inactivityWarningDays: 30,
};

// Stands in for a name/email once someone is erased. The ".invalid" TLD
// can never receive mail or match a real address (RFC 2606).
const ERASED_NAME = "Erased";
const erasedEmail = (id) => `erased-${id}@erased.invalid`;

// Removes everything we hold about the account's email except what French
// accounting law makes us keep (paid orders and payment records: amounts,
// dates, items), which stays but is anonymised. Returns false if there is
// no such account.
async function eraseMember(pool, userId, { client } = {}) {
  const run = async (db) => {
    const { rows } = await db.query("SELECT id, email FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!rows.length) return false;
    const email = rows[0].email.toLowerCase();

    await db.query("DELETE FROM event_signups WHERE lower(email) = $1", [email]);
    await db.query("DELETE FROM class_signups WHERE lower(email) = $1", [email]);

    // An active reservation is released rather than kept without contact
    // details nobody could pick it up with.
    await db.query(
      `UPDATE book_copies
       SET status = CASE WHEN status = 'reserved' THEN 'in_stock' ELSE status END,
           reserved_by_name = NULL, reserved_by_email = NULL, reserved_by_phone = NULL,
           reserved_at = NULL, reminder_sent_at = NULL, updated_at = now()
       WHERE lower(reserved_by_email) = $1`,
      [email]
    );

    // Orders: anonymise rather than delete (accounting). Unpaid ones have
    // no accounting value, but deleting would fight the cart/expiry code,
    // so they are anonymised the same way. The access token is rotated so
    // an old emailed link stops working.
    await db.query(
      `UPDATE orders
       SET buyer_name = $2, buyer_email = $3, buyer_phone = NULL,
           access_token = gen_random_uuid()
       WHERE lower(buyer_email) = $1`,
      [email, ERASED_NAME, erasedEmail(userId)]
    );
    await db.query(
      `UPDATE membership_payments SET payer_email = $2, user_id = NULL
       WHERE user_id = $3 OR lower(payer_email) = $1`,
      [email, erasedEmail(userId), userId]
    );

    // Logged-in sessions of this account.
    // (The table is created by connect-pg-simple on first use, so it may
    // not exist yet on a brand-new database.)
    const { rows: sessionTable } = await db.query("SELECT to_regclass('session') AS t");
    if (sessionTable[0].t) {
      await db.query("DELETE FROM session WHERE (sess -> 'user' ->> 'id')::int = $1", [userId]);
    }

    // Cascades: reset/verification tokens, favorites, RSVPs, volunteer
    // sign-ups. Forum posts and other authored rows keep their text with
    // the author set to NULL (shown without a name).
    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    return true;
  };
  return client ? run(client) : withTransaction(pool, run);
}

const appUrl = () => (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

// Daily retention sweep. Each step is independent so one failure does not
// stop the others; returns counts for logging (never any personal data).
async function purgeExpiredPersonalData(pool) {
  const counts = {};
  const step = async (name, fn) => {
    try {
      counts[name] = await fn();
    } catch (err) {
      counts[name] = "error";
      console.error(`Retention purge step "${name}" failed:`, err.message);
    }
  };

  await step("signups", async () => {
    const a = await pool.query(
      `DELETE FROM event_signups s USING events e
       WHERE e.id = s.event_id AND e.starts_at < now() - interval '${RETENTION.signupMonths} months'`
    );
    const b = await pool.query(
      `DELETE FROM class_signups s USING classes c
       WHERE c.id = s.class_id AND c.starts_at < now() - interval '${RETENTION.signupMonths} months'`
    );
    return a.rowCount + b.rowCount;
  });

  await step("tokens", async () => {
    const a = await pool.query(
      `DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '${RETENTION.tokenGraceDays} days'`
    );
    const b = await pool.query(
      `DELETE FROM email_verification_tokens WHERE expires_at < now() - interval '${RETENTION.tokenGraceDays} days'`
    );
    return a.rowCount + b.rowCount;
  });

  await step("accounting", async () => {
    // Orders older than the legal retention period; order_items cascade.
    const a = await pool.query(
      `DELETE FROM orders
       WHERE status <> 'pending' AND created_at < now() - interval '${RETENTION.accountingYears} years'`
    );
    const b = await pool.query(
      `DELETE FROM membership_payments WHERE paid_at < now() - interval '${RETENTION.accountingYears} years'`
    );
    return a.rowCount + b.rowCount;
  });

  // Inactive accounts: warn by email first, delete 30 days later unless
  // they log in (a login clears the warning). Never admins, never anyone
  // with a current membership.
  const INACTIVE = `NOT is_admin
    AND (member_expires_at IS NULL OR member_expires_at < now())
    AND COALESCE(last_login_at, created_at) < now() - interval '${RETENTION.inactiveAccountYears} years' + interval '${RETENTION.inactivityWarningDays} days'`;

  await step("inactivityWarnings", async () => {
    const { rows } = await pool.query(
      `SELECT id, email, display_name FROM users WHERE ${INACTIVE} AND inactivity_warned_at IS NULL LIMIT 200`
    );
    let n = 0;
    for (const u of rows) {
      try {
        await sendMail({
          to: u.email,
          subject: "Your Uma's Books account will be deleted in 30 days",
          text:
            `Hi ${emailSafeName(u.display_name)},\n\n` +
            `You haven't logged in to your Uma's Books account for almost ${RETENTION.inactiveAccountYears} years. ` +
            `To protect your privacy we delete inactive accounts, so yours will be deleted in ${RETENTION.inactivityWarningDays} days.\n\n` +
            `To keep it, just log in once${appUrl() ? `: ${appUrl()}/login` : " on our website"}.\n\n` +
            `If you no longer want an account, you don't need to do anything.`,
        });
        // Only marked after the mail went out: a failed send is retried
        // tomorrow rather than deleting someone who was never warned.
        await pool.query("UPDATE users SET inactivity_warned_at = now() WHERE id = $1", [u.id]);
        n += 1;
      } catch (err) {
        console.error(`Inactivity warning failed for account ${u.id}:`, err.message);
      }
    }
    return n;
  });

  await step("inactiveAccounts", async () => {
    const { rows } = await pool.query(
      `SELECT id FROM users
       WHERE NOT is_admin
         AND (member_expires_at IS NULL OR member_expires_at < now())
         AND COALESCE(last_login_at, created_at) < now() - interval '${RETENTION.inactiveAccountYears} years'
         AND inactivity_warned_at < now() - interval '${RETENTION.inactivityWarningDays} days'
       LIMIT 200`
    );
    let n = 0;
    for (const { id } of rows) {
      if (await eraseMember(pool, id)) n += 1;
    }
    return n;
  });

  return counts;
}

module.exports = { eraseMember, purgeExpiredPersonalData, RETENTION, ERASED_NAME, erasedEmail };
