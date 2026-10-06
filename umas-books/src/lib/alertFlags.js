// "Send this alert at most once per period", remembered in the database
// (table alert_flags, migration 072) so it holds across restarts and across
// app instances. Used by:
//   - the launch-guard alerts (lib/env.js sendLaunchAlerts): once per 24 h, not
//     once per deploy/restart (a persistent banner on the admin pages shows
//     them the rest of the time);
//   - the "an email has been stuck for over an hour" alert (lib/outbox.js).
//
// claimAlertSlot is ONE atomic statement: of two callers racing, exactly one
// gets true. If the alert mail then cannot be sent, call releaseAlertSlot so
// the next tick tries again instead of staying quiet for the whole period.

async function claimAlertSlot(db, key, minutes) {
  const { rowCount } = await db.query(
    `INSERT INTO alert_flags (key, last_sent_at) VALUES ($1, now())
     ON CONFLICT (key) DO UPDATE SET last_sent_at = now()
       WHERE alert_flags.last_sent_at < now() - ($2 * interval '1 minute')`,
    [key, minutes]
  );
  return rowCount === 1;
}

async function releaseAlertSlot(db, key) {
  await db.query("DELETE FROM alert_flags WHERE key = $1", [key]);
}

module.exports = { claimAlertSlot, releaseAlertSlot };
