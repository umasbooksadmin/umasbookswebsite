// Setting an account flag (member, volunteer, till, admin, disabled) to an
// explicit value. The admin screens used to flip it (SET x = NOT x), so a
// double click or a stale page undid the change. Here the form posts the state
// it wants and the update is idempotent: asking twice gives the same result.
//
// The last-admin rule is enforced in the same transaction as the update, under
// a lock on every admin row, so two admins demoting (or deactivating) each
// other at the same moment cannot leave the site with no active admin.

const { withTransaction } = require("../db");

const ROLES = {
  member: { column: "is_member", label: "Member status", on: "Member status given", off: "Member status removed",
    // A hand-granted membership must not be expired by the HelloAsso backstop sweep
    // (expireStaleMemberships in lib/membership.js), and a re-grant after a lapse starts open-ended.
    extraSet: ", member_expires_at = NULL" },
  volunteer: { column: "is_volunteer", label: "Volunteer status", on: "Volunteer status given", off: "Volunteer status removed" },
  till: { column: "is_till", label: "Till access", on: "Till access given", off: "Till access removed" },
  admin: { column: "is_admin", label: "Admin rights", on: "Admin rights given", off: "Admin rights removed", guardsLastAdmin: "demote" },
  disabled: { column: "is_disabled", label: "Account", on: "Account deactivated", off: "Account reactivated", guardsLastAdmin: "disable" },
};

// "on" / "off" from a form field; anything else is null (the caller refuses).
function parseDesired(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  if (v === "on") return true;
  if (v === "off") return false;
  return null;
}

// -> { status: "changed" | "unchanged" | "missing" | "last_admin", was }
async function setAccountFlag(pool, userId, role, desired) {
  const cfg = ROLES[role];
  if (!cfg) throw new Error(`unknown role ${role}`);
  const column = cfg.column; // from the fixed table above, never from input
  return withTransaction(pool, async (db) => {
    // Serialise every change that could remove an admin: lock all admin rows in id order.
    if (cfg.guardsLastAdmin) await db.query("SELECT id FROM users WHERE is_admin ORDER BY id FOR UPDATE");
    const { rows } = await db.query(`SELECT ${column} AS cur, is_admin, is_disabled FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (!rows.length) return { status: "missing" };
    const cur = rows[0].cur;
    if (cur === desired) return { status: "unchanged", was: cur };
    const removesAdmin = (cfg.guardsLastAdmin === "demote" && desired === false && rows[0].is_admin && !rows[0].is_disabled)
      || (cfg.guardsLastAdmin === "disable" && desired === true && rows[0].is_admin && !rows[0].is_disabled);
    if (removesAdmin) {
      const { rows: others } = await db.query("SELECT count(*)::int AS n FROM users WHERE is_admin AND NOT is_disabled AND id <> $1", [userId]);
      if (others[0].n < 1) return { status: "last_admin", was: cur };
    }
    await db.query(`UPDATE users SET ${column} = $2${cfg.extraSet || ""} WHERE id = $1`, [userId, desired]);
    return { status: "changed", was: cur };
  });
}

module.exports = { ROLES, parseDesired, setAccountFlag };
