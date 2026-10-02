require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool } = require("./db");
const { validateNewPassword } = require("./lib/passwordPolicy");

// Creates a starter admin account (only if no admin exists yet) plus a
// couple of sample announcements/events/charity round so the area isn't
// empty on first login. Safe to re-run.

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@umasbooks.org";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  const { rows: existingAdmins } = await pool.query("SELECT id FROM users WHERE is_admin = TRUE LIMIT 1");
  let adminId;
  if (existingAdmins.length) {
    adminId = existingAdmins[0].id;
    console.log("Admin already exists, skipping admin creation.");
  } else {
    if (!adminPassword) {
      throw new Error("Set SEED_ADMIN_PASSWORD to create the first admin account.");
    }
    // This is the single most privileged account in the app, and this
    // script is the only place the *first* one is created — afterwards an
    // admin can promote others (/admin/members/:id/toggle-admin), but with
    // none yet there's no in-app way in. It shouldn't
    // be held to a *lower* bar than an ordinary signup, which already
    // runs through this same check.
    const passwordError = await validateNewPassword(adminPassword);
    if (passwordError) {
      throw new Error(`SEED_ADMIN_PASSWORD is not strong enough: ${passwordError}`);
    }
    const hash = await bcrypt.hash(adminPassword, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, is_admin)
       VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [adminEmail, hash, "Uma's Books Admin"]
    );
    adminId = rows[0].id;
    console.log("Created admin account:", adminEmail);
  }

  const { rows: announcementCount } = await pool.query("SELECT COUNT(*)::int AS n FROM announcements");
  if (announcementCount[0].n === 0) {
    await pool.query(
      `INSERT INTO announcements (title, body, created_by) VALUES ($1, $2, $3)`,
      ["Welcome to the Members Area", "This is where we'll share announcements, host the community forum, run our quarterly charity vote, and schedule volunteer shifts and meetings.", adminId]
    );
    console.log("Seeded a welcome announcement.");
  }

  const { rows: roundCount } = await pool.query("SELECT COUNT(*)::int AS n FROM charity_rounds WHERE is_active = TRUE");
  if (roundCount[0].n === 0) {
    const { rows: roundRows } = await pool.query(
      `INSERT INTO charity_rounds (title, is_active) VALUES ($1, TRUE) RETURNING id`,
      ["Which charity should we support next?"]
    );
    const roundId = roundRows[0].id;
    await pool.query(
      `INSERT INTO charity_options (round_id, name, description) VALUES
        ($1, 'Restos du Coeur Albi', 'Local food aid association'),
        ($1, 'Bibliotheques Sans Frontieres', 'Books and literacy access worldwide'),
        ($1, 'SPA Albi', 'Local animal shelter')`,
      [roundId]
    );
    console.log("Seeded an active charity vote round.");
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
