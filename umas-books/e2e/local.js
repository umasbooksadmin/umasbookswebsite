#!/usr/bin/env node
// `npm run e2e:local`: runs the whole end-to-end suite against a throwaway
// copy of the app on this computer, with sample data and test logins created
// for the run, so the suite itself can be checked without touching any real
// site. Uses the same helpers as the integration tests (test/helpers/testApp).
//
//   npm run e2e:local                      reservations on (a fake HelloAsso for the membership lookups), writes on
//   npm run e2e:local -- --preview         the app in preview mode (reserving off)
//   npm run e2e:local -- --persona admin   only some personas
//   npm run e2e:local -- --readonly        no E2E_ALLOW_WRITES
//   npm run e2e:local -- --serve           leave the seeded app running to poke at
//
// Needs a local PostgreSQL (createdb/dropdb on the PATH, like `npm test`).
// Nothing here is used by `npm test` or CI.

const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Same secret startTestApp gives the server, so the stored two-step secret
// of the test admin decrypts there.
process.env.SESSION_SECRET = "test-session-secret-not-for-production";

const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const totp = require("../src/lib/totp");
const { startTestApp } = require("../test/helpers/testApp");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const passthrough = args.filter((a) => !["--preview", "--readonly", "--serve"].includes(a));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// A stand-in for HelloAsso's API. Only the membership uses HelloAsso now
// (books and seats are reserved and paid in the shop), so this answers a token
// and nothing else (the membership lookups find no payments).
function startFakeHelloAsso() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url.includes("/oauth2/token")) return res.end(JSON.stringify({ access_token: "fake", expires_in: 1800 }));
        res.statusCode = 404;
        res.end("{}");
      });
    }).listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

const secretPassword = () => `Aa1!${crypto.randomBytes(9).toString("hex")}`;
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function seed(databaseUrl, creds) {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const user = async (email, password, name, flags, totpSecret) => {
    const hash = await bcrypt.hash(password, 10);
    const enc = totpSecret ? totp.encryptSecret(totpSecret) : null;
    await db.query(
      `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_volunteer, email_verified_at, totp_secret_enc, totp_enabled_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)`,
      [email, hash, name, !!flags.admin, !!flags.member, !!flags.volunteer, enc]
    );
  };
  await user(creds.account.email, creds.account.password, "E2E Local Account Holder", {});
  await user(creds.member.email, creds.member.password, "E2E Local Member", { member: true });
  await user(creds.volunteer.email, creds.volunteer.password, "E2E Local Volunteer", { volunteer: true });
  await user(creds.admin.email, creds.admin.password, "E2E Local Admin", { admin: true, member: true }, creds.admin.totpSecret);

  const book = async (b, copies, awards = []) => {
    const { rows } = await db.query(
      `INSERT INTO books (isbn, title, authors, categories, categories_fr, binding, description, description_fr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.isbn || null, b.title, b.author, b.categories || "Fiction", b.categoriesFr || "Fiction", b.binding || "trade", b.description || "A sample book.", b.descriptionFr || "Un livre d’exemple."]
    );
    for (const c of copies) {
      await db.query(
        "INSERT INTO book_copies (book_id, condition, price, status, is_clearance, publisher_price, location, source) VALUES ($1,$2,$3,$4,$5,$6,'Shelf A','donation')",
        [rows[0].id, c.condition || "very_good", c.price, c.status || "in_stock", !!c.clearance, c.publisherPrice || null]
      );
    }
    for (const a of awards) {
      await db.query("INSERT INTO book_awards (book_id, label, year, kind, source, status) VALUES ($1,$2,$3,'award','manual','verified')", [rows[0].id, a.label, a.year]);
    }
    return rows[0].id;
  };
  const gatsbyId = await book({ isbn: "9780141036144", title: "E2E Sample Gatsby", author: "Sample Author", categories: "Fiction, Classics", binding: "trade" },
    [{ condition: "very_good", price: 5 }, { condition: "good", price: 8 }, { condition: "acceptable", price: 1, clearance: true }]);
  await book({ title: "E2E Sample Without A Price", author: "Other Author", binding: "hardcover" }, [{ condition: "very_good", price: null }]);
  await book({ title: "E2E Sample Sold Out", author: "Other Author" }, [{ price: 4, status: "sold" }]);
  const awardId = await book({ title: "E2E Sample Award Winner", author: "Sample Author", categories: "Fiction" }, [{ price: 6 }], [{ label: "Booker Prize", year: 2019 }]);
  await book({ isbn: "9780747532743", title: "E2E Sample New Book", author: "Third Author", binding: "hardcover" }, [{ condition: "new", price: 12, publisherPrice: 12 }]);

  // Curated collections (G96 to G100): four published with two approved books (the migration seeds all 19 unpublished);
  // "The Art of Getting Lost" stays unpublished, so its address is a 404.
  const { rows: cols } = await db.query("SELECT id, slug FROM curated_collections WHERE slug <> 'the-art-of-getting-lost' ORDER BY sort_order LIMIT 4");
  for (const c of cols) {
    await db.query("INSERT INTO curated_collection_books (collection_id, book_id, status, reason, position) VALUES ($1,$2,'approved','Sample',1), ($1,$3,'approved','Sample',2)", [c.id, gatsbyId, awardId]);
    await db.query("UPDATE curated_collections SET published = TRUE WHERE id = $1", [c.id]);
  }

  // Phone layout (G82, A102): an unbroken 90-letter title, and a 41-letter word with a web address in the description.
  const longTitle = `E2Ephone${"x".repeat(82)}`;
  await book({ title: longTitle, author: `${longTitle.slice(0, 40)} Author`, description: `${longTitle} https://example.org/${"a".repeat(60)}` }, [{ price: 5 }]);
  await book({ title: "E2Ephone Pneumonoultramicroscopicsilicovolcanoconi", author: "Pneumonoultramicroscopicsilicovolcanoconi", categories: "Fiction" }, [{ price: 6 }]);
  // New In (G91, G92): enough books to fill several carousel pages and a second page of "See All New In", with long titles and authors.
  const newInIds = [];
  for (let i = 1; i <= 30; i++) {
    const long = i % 3 === 0 ? " and a much longer subtitle that needs several lines on a narrow card, with an Élégante Évocation" : "";
    newInIds.push(await book({ title: `E2E Sample New In ${i}${long}`, author: i % 4 === 0 ? "A. Very Long-Named Author, Co-Author Jane Smith, Translator Jean Dupont" : "New In Author" }, [{ price: 3 + (i % 9) }]));
  }
  // G97a: the fourth published collection also holds these 30 books (32 in all), more than the 24 a collection page shows at first.
  for (const [k, id] of newInIds.entries()) await db.query("INSERT INTO curated_collection_books (collection_id, book_id, status, reason, position) VALUES ($1,$2,'approved','Sample',$3)", [cols[3].id, id, k + 3]);
  // More than 200 New In books, all added today a few minutes apart (Bulk 1 is the newest): the carousel must hold every one of them,
  // newest first by the time of day, and the arrows must still land on whole cards.
  await db.query(
    `WITH b AS (
       INSERT INTO books (title, authors, categories, categories_fr, binding, description, description_fr)
       SELECT 'E2E Sample New In Bulk ' || g || CASE WHEN g % 5 = 0 THEN ' with a much longer subtitle on a narrow card' ELSE '' END,
              'Bulk Author ' || g, 'Fiction', 'Fiction', 'trade', 'A sample book.', 'Un livre d’exemple.'
       FROM generate_series(1, 230) g RETURNING id, title)
     INSERT INTO book_copies (book_id, condition, price, status, is_clearance, location, source, created_at)
     SELECT id, 'very_good', 4, 'in_stock', FALSE, 'Shelf A', 'donation',
            now() - (substring(title from 'Bulk ([0-9]+)')::int * interval '7 minutes') FROM b`
  );
  await db.query("INSERT INTO events (title, description, location, starts_at, ends_at, capacity) VALUES ('E2E Sample Event','Sample','Albi',$1,$2,10)", [days(2), days(2.1)]);
  await db.query("INSERT INTO events (title, description, location, starts_at, ends_at, capacity) VALUES ('E2E Sample Full Event','Sample','Albi',$1,$2,1)", [days(3), days(3.1)]);
  await db.query("INSERT INTO classes (title, description, location, starts_at, ends_at, capacity, dropin_price, program_type) VALUES ('E2E Sample Drop-in','Sample','Albi',$1,$2,6,8,'dropin')", [days(2), days(2.1)]);
  await db.query("INSERT INTO blog_posts (title, body, slug, excerpt, status) VALUES ('E2E Sample Post','<p>Hello</p>','e2e-sample-post','Hello','published')");
  await db.query("INSERT INTO meetings (title, scheduled_at, location, agenda) VALUES ('E2E Sample Meeting',$1,'Albi','Agenda')", [days(4)]);
  await db.query("INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity) VALUES ('E2E Sample Shift',$1,$2,1)", [days(2), days(2.1)]);
  const { rows: round } = await db.query("INSERT INTO charity_rounds (title, is_active) VALUES ('E2E Sample Vote', TRUE) RETURNING id");
  for (const n of ["Sample Charity A", "Sample Charity B"]) await db.query("INSERT INTO charity_options (round_id, name, description) VALUES ($1,$2,'Sample')", [round[0].id, n]);
  await db.end();
}

async function main() {
  const preview = has("--preview");
  const port = await freePort();
  const fake = await startFakeHelloAsso();
  const creds = {
    account: { email: "e2e-account@example.test", password: secretPassword() },
    member: { email: "e2e-member@example.test", password: secretPassword() },
    volunteer: { email: "e2e-volunteer@example.test", password: secretPassword() },
    admin: { email: "e2e-admin@example.test", password: secretPassword(), totpSecret: totp.generateSecret() },
  };
  console.log(`# starting a throwaway app on port ${port} (${preview ? "preview mode" : "normal mode, fake HelloAsso"})`);
  const app = await startTestApp({
    port,
    env: {
      ADMIN_2FA_REQUIRED: "true",
      // The personas open hundreds of fresh browser sessions from this one address; the live site caps that at 60 per 10 minutes.
      ANON_SESSION_LIMIT: "100000",
      PREVIEW_MODE: preview ? "true" : "",
      HELLOASSO_CLIENT_ID: "fake", HELLOASSO_CLIENT_SECRET: "fake", HELLOASSO_ORG_SLUG: "fake-org",
      HELLOASSO_API_BASE: `http://127.0.0.1:${fake.port}/v5`,
      // The local copy must never send an email or call a paid API.
      GMAIL_USER: "", GMAIL_APP_PASSWORD: "", ANTHROPIC_API_KEY: "",
    },
  });
  let code;
  try {
    await seed(app.databaseUrl, creds);
    const env = {
      ...process.env,
      E2E_BASE_URL: app.base,
      E2E_ACCOUNT_EMAIL: creds.account.email, E2E_ACCOUNT_PASSWORD: creds.account.password,
      E2E_MEMBER_EMAIL: creds.member.email, E2E_MEMBER_PASSWORD: creds.member.password,
      E2E_VOLUNTEER_EMAIL: creds.volunteer.email, E2E_VOLUNTEER_PASSWORD: creds.volunteer.password,
      E2E_ADMIN_EMAIL: creds.admin.email, E2E_ADMIN_PASSWORD: creds.admin.password, E2E_ADMIN_TOTP_SECRET: creds.admin.totpSecret,
      E2E_ALLOW_WRITES: has("--readonly") ? "" : "1",
    };
    if (has("--serve")) {
      // Leave the app running for poking around by hand (Ctrl-C to stop).
      const fs = require("node:fs");
      const out = path.join(__dirname, "artifacts", "local-env.json");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(env, null, 2));
      console.log(`# serving ${app.base}; the test logins are in e2e/artifacts/local-env.json (throwaway, local only)`);
      await new Promise((resolve) => process.on("SIGINT", resolve).on("SIGTERM", resolve));
      code = 0;
    } else {
      code = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, "run.js"), ...passthrough], { stdio: "inherit", env });
        child.on("exit", (c) => resolve(c === null ? 1 : c));
      });
    }
  } finally {
    fake.close();
    await app.stop();
  }
  process.exit(code);
}

main().catch((err) => { console.error(err); process.exit(1); });
