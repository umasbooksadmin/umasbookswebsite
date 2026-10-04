require("dotenv").config({ quiet: true });
const bcrypt = require("bcryptjs");
const { validateNewPassword } = require("./lib/passwordPolicy");

// First-boot bootstrap. Runs before every start (render.yaml startCommand),
// so it must be safe to re-run and must NEVER stop the site from starting:
//
//   - Creates the first admin account, but only when no admin exists yet
//     AND the account does not already exist. It never promotes, enables or
//     changes the password of an existing account (a demoted or disabled
//     admin stays that way; a warning says what to do instead).
//   - Creates the sample announcement / charity round only on a genuinely
//     fresh database: in the same run that created the first admin, or when
//     SEED_SAMPLE_CONTENT=true is set on purpose. Otherwise a closed round
//     or a deleted announcement would reappear on every boot.
//   - Any failure is logged loudly and emailed through the normal error
//     alert, then the process exits 0 so `npm start` still runs. Set
//     SEED_STRICT=true (CI does) to exit 1 on failure instead.

const SAMPLE_CHARITIES = [
  ["Restos du Coeur Albi", "Local food aid association"],
  ["Bibliotheques Sans Frontieres", "Books and literacy access worldwide"],
  ["SPA Albi", "Local animal shelter"],
];

// pool and log are injectable for tests; defaults are the app's own.
async function runSeed({ env = process.env, pool = require("./db").pool, log = console } = {}) {
  const adminEmail = (env.SEED_ADMIN_EMAIL || "admin@umasbooks.org").trim();
  const adminPassword = env.SEED_ADMIN_PASSWORD;

  const { rows: existingAdmins } = await pool.query("SELECT id FROM users WHERE is_admin = TRUE ORDER BY id LIMIT 1");
  let adminId = existingAdmins.length ? existingAdmins[0].id : null;
  let createdAdmin = false;

  if (adminId !== null) {
    log.log("Admin already exists, skipping admin creation.");
  } else {
    const { rows: sameEmail } = await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [adminEmail]);
    if (sameEmail.length) {
      log.warn(
        `[seed] WARNING: there is no admin account, but ${adminEmail} already exists as an ordinary account, so the seed did NOT touch it ` +
        "(it never promotes or re-enables an existing account, and never resets a password). Nobody can reach /admin until an admin exists. " +
        "Fix: see docs/runbook.md, \"Add or restore an admin\" (set is_admin = TRUE for the right person in the database)."
      );
    } else if (!adminPassword) {
      log.warn(
        "[seed] WARNING: no admin account exists and SEED_ADMIN_PASSWORD is not set, so none was created. " +
        "Set SEED_ADMIN_PASSWORD (and SEED_ADMIN_EMAIL) in Render > Environment and redeploy, then remove the password again."
      );
    } else {
      // This is the single most privileged account in the app, so it is
      // held to the same bar as an ordinary signup.
      const passwordError = await validateNewPassword(adminPassword);
      if (passwordError) {
        log.warn(`[seed] WARNING: SEED_ADMIN_PASSWORD is not strong enough (${passwordError}); no admin was created.`);
      } else {
        const hash = await bcrypt.hash(adminPassword, 12);
        // ON CONFLICT: a signup racing this insert must not crash the seed.
        const { rows } = await pool.query(
          `INSERT INTO users (email, password_hash, display_name, is_admin)
           VALUES ($1, $2, $3, TRUE) ON CONFLICT DO NOTHING RETURNING id`,
          [adminEmail, hash, "Uma's Books Admin"]
        );
        if (rows.length) {
          adminId = rows[0].id;
          createdAdmin = true;
          log.log("Created admin account:", adminEmail);
        } else {
          log.warn(`[seed] WARNING: ${adminEmail} appeared while the seed ran; no admin was created.`);
        }
      }
    }
  }

  const wantSamples = createdAdmin || env.SEED_SAMPLE_CONTENT === "true";
  if (!wantSamples) {
    log.log("Not a fresh database: sample content skipped (set SEED_SAMPLE_CONTENT=true to force it).");
    return { createdAdmin, seededSamples: false };
  }

  let seededSamples = false;
  const { rows: announcementCount } = await pool.query("SELECT COUNT(*)::int AS n FROM announcements");
  if (announcementCount[0].n === 0) {
    await pool.query(
      `INSERT INTO announcements (title, body, created_by) VALUES ($1, $2, $3)`,
      ["Welcome to the Members Area", "This is where we'll share announcements, host the community forum, run our quarterly charity vote, and schedule volunteer shifts and meetings.", adminId]
    );
    log.log("Seeded a welcome announcement.");
    seededSamples = true;
  }

  const { rows: roundCount } = await pool.query("SELECT COUNT(*)::int AS n FROM charity_rounds WHERE is_active = TRUE");
  if (roundCount[0].n === 0) {
    const { rows: roundRows } = await pool.query(
      `INSERT INTO charity_rounds (title, is_active) VALUES ($1, TRUE) RETURNING id`,
      ["Which charity should we support next?"]
    );
    const roundId = roundRows[0].id;
    for (const [name, description] of SAMPLE_CHARITIES) {
      await pool.query("INSERT INTO charity_options (round_id, name, description) VALUES ($1, $2, $3)", [roundId, name, description]);
    }
    log.log("Seeded an active charity vote round.");
    seededSamples = true;
  }
  return { createdAdmin, seededSamples };
}

async function main() {
  let failure = null;
  try {
    await runSeed();
  } catch (err) {
    failure = err;
    console.error("[seed] FAILED (the site will still start):", err);
    try {
      const { alertOnError } = require("./lib/errorAlert");
      await Promise.race([
        alertOnError("Startup seed failed (site still started)", err),
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ]);
    } catch (alertErr) {
      console.error("[seed] could not send the alert:", alertErr.message);
    }
  }
  try {
    await require("./db").pool.end();
  } catch {
    // nothing useful to do
  }
  // Never block startup: render.yaml runs `npm run seed; npm start`, and
  // this exit code is 0 on purpose. CI sets SEED_STRICT to see failures.
  process.exit(failure && process.env.SEED_STRICT === "true" ? 1 : 0);
}

if (require.main === module) main();

module.exports = { runSeed };
