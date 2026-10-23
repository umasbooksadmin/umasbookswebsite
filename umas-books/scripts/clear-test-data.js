#!/usr/bin/env node
// Removes test data from the database before launch. Dry run by default.
// Read src/lib/clearTestData.js (safety layers) and docs/runbook.md (steps).
//   npm run clear-test-data                      -> dry run
//   npm run clear-test-data -- --list-admins
//   npm run clear-test-data -- --execute --confirm "DELETE TEST DATA FROM <db>" --i-have-a-backup
require("dotenv").config({ quiet: true });
const { Client } = require("pg");
const { main } = require("../src/lib/clearTestData");
const config = require("../src/lib/config");

// Same TLS stance as src/db.js: encrypted, certificate not verified (Render's
// internal database uses a self-signed certificate). PGSSLMODE=disable for a
// local database without TLS.
async function connect(url) {
  const client = new Client({
    connectionString: url,
    ssl: config.get("PGSSLMODE") ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  return client;
}

main(process.argv.slice(2), { connect }).then(
  (code) => process.exit(code),
  (e) => {
    console.error("Unexpected failure, nothing was changed:", e.message);
    process.exit(1);
  }
);
