#!/usr/bin/env node
// `npm run e2e:ci`: the small browser-test subset CI runs (e2e/specs/ci-subset.e2e.js: the Browse Books carousel and the genre
// list's Show more) against a throwaway copy of the app on this computer, seeded with 130 New In books that are all Fiction,
// so the carousel crosses its batch boundary of 60 twice. Same pieces as e2e:local (test/helpers/testApp, headless Chrome through
// puppeteer), a fraction of the time (about two minutes; the full G91 alone takes ten). Nothing is sent anywhere.
//
// Needs a PostgreSQL: DATABASE_URL pointing at a server (CI: the job's service container; a copy database is made on it), or none
// set and createdb/dropdb on the PATH (locally, like `npm test`).

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Client } = require("pg");
const { startTestApp } = require("../test/helpers/testApp");

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

const BOOKS = 130; // more than two batches of 60

async function seed(databaseUrl) {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  // All added today a few minutes apart (Bulk 1 is the newest): all New In, all Fiction, some with a long subtitle so cards differ in height.
  await db.query(
    `WITH b AS (
       INSERT INTO books (title, authors, categories, categories_fr, binding, description, description_fr)
       SELECT 'E2E Sample New In Bulk ' || g || CASE WHEN g % 5 = 0 THEN ' with a much longer subtitle on a narrow card' ELSE '' END,
              CASE WHEN g % 4 = 0 THEN 'A. Very Long-Named Author, Co-Author Jane Smith, Translator Jean Dupont' ELSE 'Bulk Author ' || g END,
              'Fiction', 'Fiction', 'trade', 'A sample book.', 'Un livre d’exemple.'
       FROM generate_series(1, $1::int) g RETURNING id, title)
     INSERT INTO book_copies (book_id, condition, price, status, is_clearance, location, source, created_at)
     SELECT id, 'very_good', 4, 'in_stock', FALSE, 'Shelf A', 'donation',
            now() - (substring(title from 'Bulk ([0-9]+)')::int * interval '7 minutes') FROM b`,
    [BOOKS]
  );
  await db.end();
}

async function main() {
  const port = await freePort();
  console.log(`# starting a throwaway app on port ${port} with ${BOOKS} New In books`);
  const app = await startTestApp({
    port,
    isolated: true, // its own database, even when DATABASE_URL points at a shared one (CI)
    env: { ANON_SESSION_LIMIT: "100000", GMAIL_USER: "", GMAIL_APP_PASSWORD: "", ANTHROPIC_API_KEY: "" },
  });
  let code;
  try {
    await seed(app.databaseUrl);
    const started = Date.now();
    code = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", path.join(__dirname, "specs", "ci-subset.e2e.js")], {
        stdio: "inherit",
        env: {
          ...process.env,
          E2E_BASE_URL: app.base,
          E2E_ONLY: "guest",
          E2E_NO_SANDBOX: process.env.CI ? "1" : process.env.E2E_NO_SANDBOX || "", // GitHub's Ubuntu runners need Chrome without its sandbox
        },
      });
      child.on("exit", (c) => resolve(c === null ? 1 : c));
    });
    console.log(`# browser subset ${code === 0 ? "passed" : "FAILED"} in ${Math.round((Date.now() - started) / 1000)} s`);
  } finally {
    await app.stop();
  }
  process.exit(code);
}

main().catch((err) => { console.error(err); process.exit(1); });
