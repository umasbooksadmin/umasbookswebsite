// Is a month that the monthly accounting export has ALREADY produced out of date?
//
// The export runs from a GitHub workflow on the 1st (07:00 Paris; retries on the 2nd and 3rd), so the app
// does not know when it ran. Instead of a new table, this assumes it ran by EXPORT_DONE_HOUR on the 1st of
// the following month and looks for changes TYPED IN after that moment that touch the month:
//   - a till sale of the month entered after it (a late or backdated entry, till_sales.entered_at)
//   - a till sale of the month voided after it (voided_at)
//   - a day of the month closed after it with a cash difference (an "over/short" row appears)
//   - a membership payment of the month that reached the database after it (created_at)
// A later refund is NOT listed: it is a negative row in the month of the refund, by design.
// The check is a warning, not proof: it only knows what the dates say, cannot see a deleted row or an edited accounts
// mapping, and (the app having no record of the export) cannot tell that someone has since re-made the files, so the warning
// stays for those months; it is a prompt to check, not a to-do that clears itself.
const { SITE_TIME_ZONE } = require("./tz");
const TZ = SITE_TIME_ZONE;

// The Paris hour on the 1st by which the monthly export has normally been made (cron 05:00 / 06:00 UTC).
const EXPORT_DONE_HOUR = 9;

// SQL: the instant after which a change to the month of the Paris date expression `d` counts as "after the export".
const cutoff = (d) => `((date_trunc('month', ${d}::timestamp) + interval '1 month' + interval '${EXPORT_DONE_HOUR} hours') AT TIME ZONE '${TZ}')`;
const parisMonth = (col) => `to_char(${col} AT TIME ZONE '${TZ}', 'YYYY-MM')`;
const inRange = (col, a, b) =>
  `${col} >= ($${a}::date)::timestamp AT TIME ZONE '${TZ}' AND ${col} < (($${b}::date) + 1)::timestamp AT TIME ZONE '${TZ}'`;

const KINDS = {
  late_sale: (n) => `${n} till sale${n === 1 ? "" : "s"} entered late or backdated`,
  voided_sale: (n) => `${n} till sale${n === 1 ? "" : "s"} voided`,
  late_close: (n) => `${n} day${n === 1 ? "" : "s"} closed with a cash difference`,
  late_membership: (n) => `${n} membership payment${n === 1 ? "" : "s"} recorded`,
};

// -> [{ month: "2026-09", kinds: { late_sale: 2, ... } }] for the months of [from, to] that changed after their export.
async function staleMonths(db, from, to) {
  const { rows } = await db.query(
    `WITH d AS (
       SELECT ${parisMonth("created_at")} AS m, 'late_sale' AS kind FROM till_sales
         WHERE status = 'completed' AND entered_at > ${cutoff(`(created_at AT TIME ZONE '${TZ}')`)} AND ${inRange("created_at", 1, 2)}
       UNION ALL
       SELECT ${parisMonth("created_at")}, 'voided_sale' FROM till_sales
         WHERE status = 'voided' AND voided_at > ${cutoff(`(created_at AT TIME ZONE '${TZ}')`)} AND ${inRange("created_at", 1, 2)}
       UNION ALL
       SELECT to_char(day, 'YYYY-MM'), 'late_close' FROM till_days
         WHERE closed_at > ${cutoff("day")} AND difference_cents IS NOT NULL AND difference_cents <> 0 AND day >= $1::date AND day <= $2::date
       UNION ALL
       SELECT ${parisMonth("paid_at")}, 'late_membership' FROM membership_payments
         WHERE amount_cents IS NOT NULL AND created_at > ${cutoff(`(paid_at AT TIME ZONE '${TZ}')`)} AND ${inRange("paid_at", 1, 2)}
     ) SELECT m, kind, COUNT(*)::int AS n FROM d GROUP BY m, kind ORDER BY m, kind`,
    [from, to]
  );
  const byMonth = new Map();
  for (const r of rows) {
    if (!byMonth.has(r.m)) byMonth.set(r.m, {});
    byMonth.get(r.m)[r.kind] = r.n;
  }
  return [...byMonth].map(([month, kinds]) => ({ month, kinds }));
}

// -> a report banner { level, text } or null.
async function stalenessBanner(db, from, to) {
  const months = await staleMonths(db, from, to);
  if (!months.length) return null;
  const parts = months.map(({ month, kinds }) => `${month}: ${Object.entries(kinds).map(([k, n]) => KINDS[k](n)).join(", ")}`);
  return {
    level: "danger",
    text: `These figures are newer than the monthly export already made for the month(s) listed. Since that export was made (assumed the morning of the 1st), ${parts.join("; ")}. The emailed and stored files for those months do not have these changes: ask for them to be re-made (GitHub > Actions > "Monthly accounting export" > Run workflow, type the month), or tell the treasurer (this warning stays for those months, the app cannot see that files were re-made). This page and its CSV are always up to date.`,
  };
}

// True when the range reaches a month that is not over yet.
const reachesOpenMonth = (to, today) => to.slice(0, 7) >= today.slice(0, 7);

module.exports = { staleMonths, stalenessBanner, reachesOpenMonth, EXPORT_DONE_HOUR };
