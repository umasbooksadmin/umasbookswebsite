// What the membership page (views/marketing/membership.ejs) shows. Becoming a
// member needs an account, created in ONE step on this page:
//   guest   - not logged in, no join started: a short name + email form (POST
//             /membership/join, same account creation as /signup). The HelloAsso
//             widget is not in the page at all.
//   joined  - a guest who just filled that form: the payment widget, the email to
//             use on it, and the "we emailed you a link" message. The typed email
//             lives only in the session (never in a URL).
//   form    - logged in, not (or no longer) a current member: ONLY the payment
//             widget, plus the account's email and a "Check my membership" button.
//             Never a signup form: they join on their existing account.
//   member  - current member with more than RENEWAL_WINDOW_DAYS left (or no end
//             date): their status instead of the widget. Inside the window, or
//             once expired, they get the widget again to renew.
// Payments made on HelloAsso itself need nothing enforced here: the webhook and
// the backstop sync (src/lib/membership.js) are unchanged, and a payment made
// before the account's email is confirmed attaches when it is confirmed.
const { isEmail } = require("./validation");

const RENEWAL_WINDOW_DAYS = 30;
// How long a started join keeps showing the payment step (a refresh while
// paying must not lose it).
const JOIN_TTL_MS = 2 * 60 * 60 * 1000;

async function membershipPageState(pool, session, now = new Date()) {
  const out = {};
  // One-shot message left by a POST (join error, "Check my membership" result).
  if (session.membershipFlash) {
    out.memFlash = session.membershipFlash;
    delete session.membershipFlash;
  }

  const sessionUser = session.user;
  if (!sessionUser) {
    const join = session.membershipJoin;
    if (join && join.at && now.getTime() - join.at < JOIN_TTL_MS && isEmail(join.email)) {
      return { ...out, memState: "joined", memEmail: join.email };
    }
    return { ...out, memState: "guest" };
  }

  const { rows } = await pool.query(
    "SELECT email, is_member, member_expires_at, is_disabled FROM users WHERE id = $1",
    [sessionUser.id]
  );
  const u = rows[0];
  if (!u || u.is_disabled) return { ...out, memState: "guest" };
  const expires = u.member_expires_at ? new Date(u.member_expires_at) : null;
  const renewalFrom = new Date(now.getTime() + RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const currentMember = u.is_member && (!expires || expires > renewalFrom);
  return {
    ...out,
    memState: currentMember ? "member" : "form",
    memEmail: u.email,
    // ISO date (YYYY-MM-DD): reads the same in both languages, so it never
    // goes stale when the person flips the language toggle.
    memExpires: u.is_member && expires ? expires.toISOString().slice(0, 10) : null,
  };
}

module.exports = { membershipPageState, RENEWAL_WINDOW_DAYS, JOIN_TTL_MS };
