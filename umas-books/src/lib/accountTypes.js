// What kind of account is this? ONE definition, shared by the admin accounts
// list (/admin/members) and the Accounts report (/admin/reports/accounts) so
// the two can never disagree.
//
//   guest         = not logged in (not an account at all, never listed)
//   account holder = a confirmed account (it can buy)
//   member        = account holder who is a member RIGHT NOW (is_member and no
//                   end date or an end date in the future: see memberStatus.js)
//   volunteer     = is_volunteer
//   admin         = is_admin
//   unconfirmed   = signed up but never confirmed the email (email_verified_at NULL)
//   till          = is_till: "Till access" (may use /admin/till without being an admin). It is a
//                   FLAG on top of the types above, not a primary type: an account shows its
//                   primary type and, as well, the "Till" pill; the "Till access" filter lists them.
//
// An account has one PRIMARY type for display (highest of admin, volunteer,
// member, then account; "unconfirmed" when it has none of those and has not
// confirmed its email) and can match several FILTERS: the Volunteer filter
// lists every volunteer even if she is also a member, the Account holder
// filter only lists confirmed accounts with no other role.
const { isActiveMember, activeMemberSql } = require("./memberStatus");

// "till" is a filter and a pill, never a primary type (see accountType).
const TYPES = ["admin", "volunteer", "member", "account", "unconfirmed", "till"];
const TYPE_LABELS = { admin: "Admin", volunteer: "Volunteer", member: "Member", account: "Account", unconfirmed: "Unconfirmed", till: "Till" };

// Filter dropdown labels (value "" = no filter).
const FILTER_LABELS = {
  "": "All accounts",
  admin: "Admin",
  volunteer: "Volunteer",
  member: "Member (paying or granted)",
  account: "Account holder (not a member)",
  unconfirmed: "Unconfirmed",
  till: "Till access",
};

function parseTypeFilter(value) {
  return TYPES.includes(value) ? value : "";
}

function accountType(row, now = new Date()) {
  if (row.is_admin) return "admin";
  if (row.is_volunteer) return "volunteer";
  if (isActiveMember(row, now)) return "member";
  return row.email_verified_at ? "account" : "unconfirmed";
}

// Pills for the list: the primary type first, then every other thing that is
// true of the account (Admin + Member, Not confirmed, Membership expired).
function accountBadges(row, now = new Date()) {
  const primary = accountType(row, now);
  const out = [primary];
  const add = (t) => { if (!out.includes(t)) out.push(t); };
  if (row.is_admin) add("admin");
  if (row.is_volunteer) add("volunteer");
  if (isActiveMember(row, now)) add("member");
  if (row.is_till) add("till");
  const labels = out.map((t) => TYPE_LABELS[t]);
  if (!row.email_verified_at && primary !== "unconfirmed") labels.push("Not confirmed");
  if (row.is_member && !isActiveMember(row, now) && primary !== "member") labels.push("Membership expired");
  return { primary, labels };
}

// SQL twin of the filters, for a users alias. Returns null for "no filter".
function typeFilterSql(type, alias = "u") {
  switch (type) {
    case "admin": return `${alias}.is_admin`;
    case "volunteer": return `${alias}.is_volunteer`;
    case "member": return activeMemberSql(alias);
    case "account": return `(${alias}.email_verified_at IS NOT NULL AND NOT ${alias}.is_admin AND NOT ${alias}.is_volunteer AND NOT ${activeMemberSql(alias)})`;
    case "unconfirmed": return `${alias}.email_verified_at IS NULL`;
    case "till": return `${alias}.is_till`;
    default: return null;
  }
}

// SQL expression giving the primary type as text (same order as accountType).
const typeCaseSql = (alias = "u") =>
  `(CASE WHEN ${alias}.is_admin THEN 'admin' WHEN ${alias}.is_volunteer THEN 'volunteer' WHEN ${activeMemberSql(alias)} THEN 'member' WHEN ${alias}.email_verified_at IS NOT NULL THEN 'account' ELSE 'unconfirmed' END)`;

// How many accounts match each filter, in one query. Keyed by filter value,
// "" being all accounts. db is anything with .query().
async function accountTypeCounts(db) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS all_n,
            ${TYPES.map((t) => `COUNT(*) FILTER (WHERE ${typeFilterSql(t, "u")})::int AS ${t}_n`).join(",\n            ")}
     FROM users u`
  );
  const r = rows[0];
  const counts = { "": r.all_n };
  for (const t of TYPES) counts[t] = r[`${t}_n`];
  return counts;
}

module.exports = { TYPES, TYPE_LABELS, FILTER_LABELS, parseTypeFilter, accountType, accountBadges, typeFilterSql, typeCaseSql, accountTypeCounts };
