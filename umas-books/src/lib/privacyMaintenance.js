// Two small privacy jobs that need no personal data to run:
//
//  1. cleanOrderPhones: the buyer's phone number on an order exists only so the
//     shop can call about a pickup. It is NOT an accounting need, so it is
//     removed as soon as the order is closed, and at the latest 30 days after
//     the order was made (name and email stay on paid orders for the 10-year
//     accounting retention, see docs/runbook.md "Retention rules"). Same for the
//     phone copied onto a reserved book copy. Idempotent; at most BATCH rows per
//     table per run (the next run continues); logged in job_runs by guardJob.
//  2. sendMailboxCleanupReminder: the privacy policy promises that emails received
//     through the contact, volunteer and pre-registration forms are deleted from
//     the mailbox after 12 months. That is a manual task in Gmail; once a month
//     this emails ALERT_TO a reminder (at most once per 30 days, remembered in
//     alert_flags, so restarts and several instances do not repeat it).
const { claimAlertSlot, releaseAlertSlot } = require("./alertFlags");
const { sendAdminAlert } = require("./errorAlert");

const PHONE_MAX_DAYS = 30;
const BATCH = 500;
const MAILBOX_REMINDER_KEY = "contact_mailbox_cleanup_reminder";
const MAILBOX_REMINDER_MINUTES = 30 * 24 * 60;

async function cleanOrderPhones(pool, { batch = BATCH } = {}) {
  // Closed (cancelled/expired), collected-and-paid, or simply 30 days old.
  const orders = await pool.query(
    `UPDATE orders SET buyer_phone = NULL
     WHERE id IN (
       SELECT id FROM orders
       WHERE buyer_phone IS NOT NULL
         AND (status IN ('cancelled', 'expired')
              OR (status = 'paid' AND collected_at IS NOT NULL)
              OR created_at < now() - interval '${PHONE_MAX_DAYS} days')
       ORDER BY id LIMIT $1)`,
    [batch]
  );
  // The phone copied onto a held book: only a live reservation needs it.
  const copies = await pool.query(
    `UPDATE book_copies SET reserved_by_phone = NULL
     WHERE id IN (
       SELECT id FROM book_copies
       WHERE reserved_by_phone IS NOT NULL
         AND (status <> 'reserved' OR reserved_at < now() - interval '${PHONE_MAX_DAYS} days')
       ORDER BY id LIMIT $1)`,
    [batch]
  );
  return { orders: orders.rowCount, copies: copies.rowCount };
}

async function sendMailboxCleanupReminder(pool) {
  if (!(await claimAlertSlot(pool, MAILBOX_REMINDER_KEY, MAILBOX_REMINDER_MINUTES))) return false;
  const ok = await sendAdminAlert({
    subject: "[umas-books] Monthly reminder: delete contact-form emails older than 12 months",
    text:
      "Our privacy policy promises that emails received through the contact, volunteer sign-up and pre-registration forms " +
      "are deleted from the shop mailbox after 12 months (unless a conversation is still ongoing).\n\n" +
      "To do now (a few minutes):\n" +
      "1. Open the shop mailbox in Gmail (the one that receives the website forms).\n" +
      "2. Search for:  older_than:1y   (add  label:<your form label>  or the form subjects if you filed them).\n" +
      "3. Skim for any conversation that is still ongoing, then select the rest and delete them, and empty Trash (Gmail keeps deleted mail 30 days).\n\n" +
      "Details: docs/runbook.md, \"Retention rules\". This reminder is sent once a month. No personal data is in this message.",
  });
  if (!ok) await releaseAlertSlot(pool, MAILBOX_REMINDER_KEY);
  return ok;
}

module.exports = { cleanOrderPhones, sendMailboxCleanupReminder, PHONE_MAX_DAYS, MAILBOX_REMINDER_KEY };
