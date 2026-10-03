// Right of access / portability (GDPR art. 15 and 20): everything we hold
// about one member, as one object. Used by the admin download
// (routes/admin/members.js) and by the member's own download
// (routes/accountPrivacy.js). Most of it is keyed by EMAIL, not user id (see
// lib/privacy.js), so each section matches on lower(email) like eraseMember
// does. Secrets are never exported: any users column whose name suggests a
// hash, token or secret is dropped, which also covers columns added later
// (e.g. 2FA secrets).
const SECRET_COLUMN = /hash|token|secret|totp/i;

// Returns null when there is no such account.
async function buildMemberExport(pool, userId) {
  const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  if (!userRows.length) return null;
  const user = {};
  for (const [key, value] of Object.entries(userRows[0])) {
    if (!SECRET_COLUMN.test(key)) user[key] = value;
  }
  const email = userRows[0].email.toLowerCase();
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  return {
    exported_at: new Date().toISOString(),
    note: "Personal data held by Uma's Books about this account. Passwords and security secrets are never included.",
    user,
    event_signups: await q(
      `SELECT s.id, e.title AS event_title, e.starts_at, s.name, s.email, s.created_at
       FROM event_signups s JOIN events e ON e.id = s.event_id
       WHERE lower(s.email) = $1 ORDER BY s.created_at`,
      [email]
    ),
    class_signups: await q(
      `SELECT s.id, c.title AS class_title, c.starts_at, s.name, s.email, s.created_at
       FROM class_signups s JOIN classes c ON c.id = s.class_id
       WHERE lower(s.email) = $1 ORDER BY s.created_at`,
      [email]
    ),
    orders: await q(
      `SELECT o.id, o.buyer_name, o.buyer_email, o.buyer_phone, o.status, o.total_amount,
              o.created_at, o.paid_at,
              COALESCE((SELECT json_agg(json_build_object('title', i.item_title, 'price', i.price) ORDER BY i.id)
                        FROM order_items i WHERE i.order_id = o.id), '[]'::json) AS items
       FROM orders o WHERE lower(o.buyer_email) = $1 ORDER BY o.created_at`,
      [email]
    ),
    membership_payments: await q(
      `SELECT id, helloasso_order_id, payer_email, amount_cents, paid_at, created_at
       FROM membership_payments WHERE user_id = $1 OR lower(payer_email) = $2 ORDER BY paid_at`,
      [userId, email]
    ),
    favorites: await q(
      `SELECT f.created_at, b.title, b.authors FROM favorites f JOIN books b ON b.id = f.book_id
       WHERE f.user_id = $1 ORDER BY f.created_at`,
      [userId]
    ),
    volunteer_signups: await q(
      `SELECT v.created_at, s.role, s.starts_at, s.ends_at
       FROM volunteer_signups v JOIN volunteer_shifts s ON s.id = v.shift_id
       WHERE v.user_id = $1 ORDER BY s.starts_at`,
      [userId]
    ),
    meeting_rsvps: await q(
      `SELECT r.created_at, m.title, m.scheduled_at
       FROM meeting_rsvps r JOIN meetings m ON m.id = r.meeting_id
       WHERE r.user_id = $1 ORDER BY m.scheduled_at`,
      [userId]
    ),
    forum_threads: await q(
      "SELECT id, title, body, created_at FROM forum_threads WHERE author_id = $1 ORDER BY created_at",
      [userId]
    ),
    forum_replies: await q(
      "SELECT id, thread_id, body, created_at FROM forum_replies WHERE author_id = $1 ORDER BY created_at",
      [userId]
    ),
    charity_votes: await q(
      `SELECT v.created_at, r.title AS round_title, COALESCE(ch.name, o.name) AS option_name
       FROM charity_votes v
       JOIN charity_rounds r ON r.id = v.round_id
       JOIN charity_options o ON o.id = v.option_id
       LEFT JOIN charities ch ON ch.id = o.charity_id
       WHERE v.user_id = $1 ORDER BY v.created_at`,
      [userId]
    ),
    charity_ideas: await q(
      `SELECT id, name, description, category, website_url, status, created_at
       FROM charity_ideas WHERE submitted_by = $1 ORDER BY created_at`,
      [userId]
    ),
    book_reservations: await q(
      `SELECT c.id AS copy_id, b.title, c.status, c.reserved_by_name, c.reserved_by_email,
              c.reserved_by_phone, c.reserved_at
       FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE lower(c.reserved_by_email) = $1 ORDER BY c.reserved_at`,
      [email]
    ),
  };
}

module.exports = { buildMemberExport, SECRET_COLUMN };
