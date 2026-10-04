#!/usr/bin/env node
// Creates the four named accounts crawler.js logs in as (anonymous needs
// none). Replaces the hand-copied SQL block in README.md with something
// that can't drift from crawler.js's own PASSWORD constant. Idempotent
// (ON CONFLICT DO NOTHING) — safe to run against a database that already
// has these accounts from a previous run.
//
// Usage: node seed-crawl-accounts.js

require("dotenv").config({ quiet: true });
const bcrypt = require("bcryptjs");
const { pool } = require("../../src/db");

const PASSWORD = "TestAdmin123!secure"; // must match crawler.js's PASSWORD constant

const ACCOUNTS = [
  { email: "crawl-account@example.test", displayName: "Crawl Account", isAdmin: false, isMember: false, isVolunteer: false },
  { email: "crawl-member@example.test", displayName: "Crawl Member", isAdmin: false, isMember: true, isVolunteer: false },
  { email: "crawl-volunteer@example.test", displayName: "Crawl Volunteer", isAdmin: false, isMember: false, isVolunteer: true },
  { email: "crawl-admin@example.test", displayName: "Crawl Admin", isAdmin: true, isMember: true, isVolunteer: false },
];

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 12);
  for (const a of ACCOUNTS) {
    await pool.query(
      `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_volunteer)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO NOTHING`,
      [a.email, hash, a.displayName, a.isAdmin, a.isMember, a.isVolunteer]
    );
    console.log("Seeded (or already present):", a.email);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
