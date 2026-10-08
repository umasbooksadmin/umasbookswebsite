// npm run demo:load -- --yes   /   npm run demo:remove -- --yes
// Fake people and reservations for the test system (staging) only.
// All the logic and the safety checks are in src/lib/demoData.js.
require("dotenv").config({ quiet: true });
// No email may leave from this process, whatever the environment says.
delete process.env.GMAIL_USER;
delete process.env.GMAIL_APP_PASSWORD;

const { main } = require("../src/lib/demoData");

main({ argv: process.argv.slice(2) }).then(
  (code) => process.exit(code),
  (err) => {
    console.error("demo-data failed:", err && err.message ? err.message : err);
    process.exit(1);
  }
);
