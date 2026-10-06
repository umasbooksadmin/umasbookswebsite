// "Is this account a member RIGHT NOW?" One definition, used everywhere a
// session or a page decides access: is_member AND (no end date, or the end
// date is still in the future). is_member alone is only corrected by the
// 6-hourly sweep (lib/membership.js expireStaleMemberships), so trusting it
// let an expired member keep access for hours. A hand-granted membership has
// no end date (member_expires_at NULL) and never lapses.
const { SITE_TIME_ZONE } = require("./tz");

function isActiveMember(row, now = new Date()) {
  if (!row || !row.is_member) return false;
  if (!row.member_expires_at) return true;
  return new Date(row.member_expires_at).getTime() > now.getTime();
}

// SQL twin of isActiveMember for queries; `alias` is the users table alias.
const activeMemberSql = (alias = "users") =>
  `(${alias}.is_member AND (${alias}.member_expires_at IS NULL OR ${alias}.member_expires_at > now()))`;

// YYYY-MM-DD of an instant as a calendar date in Paris. toISOString() would
// give the UTC date, one day early for an end date at (Paris) midnight.
function isoDateParis(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}

module.exports = { isActiveMember, activeMemberSql, isoDateParis };
