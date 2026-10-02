// Reservations expire after 2 weeks and revert to "in_stock" — called at
// the top of any route that displays copy status (public book search/
// detail, admin inventory) so the shown status is always accurate
// regardless of whether the periodic backstop in index.js has run
// recently (Render's free tier can sleep, so a timer alone isn't
// reliable). A reminder email goes out 3 days before that deadline
// (i.e. once a reservation is 11+ days old), tracked via
// reminder_sent_at so it's only ever sent once per reservation.

const { sendMail } = require("../mailer");
const { emailSafeName } = require("./validation");

const RESERVATION_TTL_DAYS = 14;
const REMINDER_AT_DAYS = RESERVATION_TTL_DAYS - 3;

async function expireStaleReservations(pool) {
  await pool.query(
    `UPDATE book_copies
     SET status = 'in_stock', reserved_by_name = NULL, reserved_by_email = NULL,
         reserved_by_phone = NULL, reserved_at = NULL, reminder_sent_at = NULL, updated_at = now()
     WHERE status = 'reserved' AND reserved_at < now() - interval '${RESERVATION_TTL_DAYS} days'`
  );
}

// Only meant to be called from the periodic backstop (not on every page
// read) — sending mail is a side effect that doesn't need to happen with
// page-load precision, and shouldn't add latency to a GET request.
async function sendPickupReminders(pool) {
  const { rows } = await pool.query(
    `SELECT c.id, c.reserved_by_name, c.reserved_by_email, c.reserved_at, b.title
     FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.status = 'reserved' AND c.reminder_sent_at IS NULL
       AND c.reserved_at <= now() - interval '${REMINDER_AT_DAYS} days'`
  );

  for (const copy of rows) {
    try {
      // "Wishlist match" is a legacy reserved_by_name from the retired
      // wishlist feature — those reservations have no real person's name
      // to greet by, so fall back to a plain "Hi,".
      const greeting = copy.reserved_by_name === "Wishlist match" ? "Hi," : `Hi ${emailSafeName(copy.reserved_by_name)},`;
      await sendMail({
        to: copy.reserved_by_email,
        subject: `Reminder: your copy of "${copy.title}" is waiting for pickup`,
        text: `${greeting}\n\nJust a reminder that we're holding your reserved copy of "${copy.title}" at Uma's Books. Reservations are held for 2 weeks from when you reserved — please come by within the next 3 days to pick it up and pay in the shop, or it will go back on the shelf.\n\nUma's Books\nRue Peyrolière, 81000 Albi`,
      });
      await pool.query("UPDATE book_copies SET reminder_sent_at = now() WHERE id = $1", [copy.id]);
    } catch (err) {
      console.error(`Pickup reminder failed for copy ${copy.id}:`, err.message);
    }
  }
}


module.exports = { expireStaleReservations, sendPickupReminders };
