// The app's own safety net for "GitHub Actions stopped running our scheduled jobs".
//
// The nightly database backup, the nightly inventory export and the hourly uptime check all run on GitHub
// Actions. Each emails when it FAILS, and a daily freshness check looks at Backblaze, but that check is a
// GitHub scheduled workflow too: if GitHub stops running schedules (the monthly minutes run out, the
// workflows get disabled, an outage), every one of those alerts goes quiet together and nothing says so.
//
// This module is the part that does not depend on GitHub. It needs NO new credentials:
//   1. At the end of a SUCCESSFUL run, each of the three workflows asks the site for /healthz with a header
//      "X-Umas-Probe: uptime | backup | inventory" (a few lines of curl, no secret). probeMiddleware() sees the
//      header and stamps alert_flags (key "gha-seen:<name>", no migration) at most once per 10 minutes.
//   2. The app's own scheduler (src/jobs.js, job "Scheduled-job watchdog", hourly) reads those stamps. When one is
//      older than its limit it emails ALERT_TO through the usual admin-alert mechanism, at most once per 24 h
//      per problem (alert_flags key "gha-silent:<name>"); a fresh stamp clears the flag so the next outage alerts at once.
//
// Armed by the first stamp: a job that has never reported (the workflow change is not live yet, or a staging site)
// raises nothing. The header is not a secret and anyone can send it; the only thing a forged stamp can do is delay
// this safety-net email, never hide a failure the workflows themselves report. The page answer is unchanged.
const { claimAlertSlot, releaseAlertSlot } = require("./alertFlags");
const { looseBaseUrl } = require("./baseUrl");

const HOUR = 60;
const SEEN_EVERY_MINUTES = 10;
const ALERT_EVERY_MINUTES = 24 * HOUR;
const seenKey = (name) => `gha-seen:${name}`;
const silentKey = (name) => `gha-silent:${name}`;

// maxAgeHours: how old the last report may be. uptime runs hourly (GitHub often starts runs late or skips one):
// 6 h. backup and inventory run nightly: 50 h = a night may be missed (a blip, a failed ping) but not two.
const WATCHED = [
  {
    name: "uptime", job: "Site uptime check", maxAgeHours: 6,
    what: "the hourly site uptime check", also: "So the site-down alert, which this check sends, is not working either.",
    fix: "Actions tab > \"Site uptime check\" > the latest runs. If nothing ran, see the steps below.",
  },
  {
    name: "backup", job: "Nightly database backup", maxAgeHours: 50,
    what: "the nightly database backup", also: "No new backup has been confirmed. Older backups in Backblaze are safe.",
    fix: "Actions tab > \"Nightly database backup\" > Run workflow (it makes a backup right away).",
  },
  {
    name: "inventory", job: "Nightly inventory export", maxAgeHours: 50,
    what: "the nightly inventory export", also: "The end-of-day inventory file and email have not arrived.",
    fix: "Actions tab > \"Nightly inventory export\" > Run workflow (it exports the inventory as of now). You can also download the inventory from the admin Inventory page.",
  },
];
const NAMES = WATCHED.map((w) => w.name);

// Express middleware, mounted in front of /healthz. Never changes or delays the answer; never throws.
function probeMiddleware(pool) {
  return (req, res, next) => {
    const name = String(req.get("x-umas-probe") || "").trim().toLowerCase();
    if (NAMES.includes(name)) {
      Promise.resolve()
        .then(() => claimAlertSlot(pool, seenKey(name), SEEN_EVERY_MINUTES))
        .catch((err) => console.warn(`Scheduled-job probe "${name}" not recorded: ${String(err && err.message).slice(0, 120)}`));
    }
    next();
  };
}

function alertText(w, ageHours, base) {
  return (
    `The site has not heard from ${w.what} for ${ageHours} hours (it should report in at least every ${w.maxAgeHours} hours).\n\n` +
    `This usually means GitHub Actions has stopped running the scheduled jobs, not that the site is broken. ${w.also}\n\n` +
    "Possible causes: the GitHub Actions minutes for the month have run out (Settings > Billing and plans), the workflows were disabled, or a GitHub outage (githubstatus.com). " +
    "It can also mean the site could not be reached when the job tried to report, or that the job ran and failed (you would then also have its own failure email).\n\n" +
    "What to do:\n" +
    "  1. Open the repository on github.com > Actions tab. Look at \"" + w.job + "\": when did it last run, and is it enabled?\n" +
    "  2. If Actions are blocked or workflows are disabled, fix that first (billing, or the Enable workflow button).\n" +
    `  3. ${w.fix}\n` +
    "  4. The other scheduled jobs (backup freshness check, restore test, monthly accounting export) are on the same schedule, so check that they run too.\n\n" +
    `This safety net lives in the site itself (admin page: ${base}/admin/diagnostics/jobs, job "Scheduled-job watchdog"). You get at most one of these emails per job per 24 hours while it stays silent; a new one follows only after the job has reported again and then gone quiet.\n` +
    "Runbook: docs/runbook.md, \"When GitHub Actions stops running our scheduled jobs\".\n"
  );
}

// Called by the hourly job. Returns { silent: [names alerted now], quiet: [names late but already alerted],
// ok: [...], unarmed: [names never seen] }. Throws on a database error (the job guard records it).
async function checkScheduledJobs(pool, { send = (m) => require("./errorAlert").sendAdminAlert(m), base = looseBaseUrl() } = {}) {
  const { rows } = await pool.query(
    "SELECT key, floor(extract(epoch FROM now() - last_sent_at) / 3600)::int AS age_hours FROM alert_flags WHERE key = ANY($1)",
    [NAMES.map(seenKey)]
  );
  const age = new Map(rows.map((r) => [r.key, r.age_hours]));
  const out = { silent: [], quiet: [], ok: [], unarmed: [] };
  for (const w of WATCHED) {
    const hours = age.get(seenKey(w.name));
    if (hours === undefined) { out.unarmed.push(w.name); continue; }
    if (hours < w.maxAgeHours) {
      out.ok.push(w.name);
      await releaseAlertSlot(pool, silentKey(w.name));
      continue;
    }
    if (!(await claimAlertSlot(pool, silentKey(w.name), ALERT_EVERY_MINUTES))) { out.quiet.push(w.name); continue; }
    const sent = await send({ subject: `[umas-books] No report from ${w.what} for ${hours} hours`, text: alertText(w, hours, base) });
    if (sent) out.silent.push(w.name);
    else await releaseAlertSlot(pool, silentKey(w.name)); // try again at the next hourly run
  }
  return out;
}

module.exports = { probeMiddleware, checkScheduledJobs, WATCHED, seenKey, silentKey, SEEN_EVERY_MINUTES, ALERT_EVERY_MINUTES };
