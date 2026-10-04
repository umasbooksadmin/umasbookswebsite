// Shared in-process harness for the admin content screen tests
// (adminCalendars / adminAnnouncementsBlog / adminCharity). Mounts the REAL
// src/routes/admin/* routers with the real views, a memory session and no
// CSRF (see inProcessApp.js), and gives tests logged-in admin / member
// users backed by real `users` rows (created_by is a foreign key).
//
// In CI every file shares ONE database, so tests must use unique values
// (uniq()) and never rely on global row counts. A file that has to do
// something global (the charity screen deactivates every active round)
// passes { isolated: true } to get its own throwaway database instead.

const path = require("node:path");
const { prepareDatabase, buildApp, listen } = require("./inProcessApp");

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// routerNames: file names under src/routes/admin (without .js).
function adminHarness(label, routerNames, { isolated = false } = {}) {
  const sharedUrl = process.env.DATABASE_URL;
  const db = prepareDatabase(label);
  let isolatedName = null;
  if (isolated && sharedUrl) {
    // Same server, own database: prepareDatabase() above left DATABASE_URL
    // pointing at the shared one, so re-point it before src/db loads.
    isolatedName = `umasbooks_${label}_test_${Date.now()}`;
    const u = new URL(sharedUrl);
    u.pathname = `/${isolatedName}`;
    process.env.DATABASE_URL = u.toString();
  }
  const { pool } = require("../../src/db");

  const h = { pool, uniq, base: null, admin: null, member: null };
  let server;

  async function adminClient(url) {
    const { Client } = require("pg");
    const c = new Client({ connectionString: url });
    await c.connect();
    return c;
  }

  async function makeUser(flags) {
    const email = `admin-content-${uniq()}@example.test`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, email_verified_at)
       VALUES ($1, 'x', $2, $3, $4, now()) RETURNING id`,
      [email, flags.admin ? "Admin Tester" : "Member Tester", !!flags.admin, !!flags.member]
    );
    return {
      id: rows[0].id, email, displayName: flags.admin ? "Admin Tester" : "Member Tester",
      isAdmin: !!flags.admin, isMember: !!flags.member, isVolunteer: false,
    };
  }

  h.makeUser = makeUser;

  h.start = async () => {
    if (isolatedName) {
      const c = await adminClient(sharedUrl);
      await c.query(`CREATE DATABASE "${isolatedName}"`);
      await c.end();
      const { execFileSync } = require("node:child_process");
      execFileSync("node", ["src/migrate.js"], {
        cwd: path.join(__dirname, "..", ".."), env: process.env, stdio: "inherit",
      });
    } else {
      db.create();
    }
    h.admin = await makeUser({ admin: true });
    h.member = await makeUser({ member: true });

    // Stands in for the multer middleware src/index.js puts in front of
    // the image-upload admin routes: an `x-test-image` header makes
    // req.files.image[0] a real PNG so the sharp resize branches run.
    const sharp = require("sharp");
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#c33" } }).png().toBuffer();
    const files = require("express").Router();
    files.use((req, res, next) => {
      if (req.get("x-test-image")) req.files = { image: [{ buffer: png }] };
      next();
    });

    const routers = routerNames.map((n) => require(path.join("..", "..", "src", "routes", "admin", n)));
    server = await listen(buildApp([files, ...routers]));
    h.base = server.base;
  };

  h.stop = async () => {
    if (server) await server.close();
    await pool.end();
    if (isolatedName) {
      const c = await adminClient(sharedUrl);
      await c.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`);
      await c.end();
    } else {
      db.drop();
    }
  };

  const headersFor = (user, extra) => ({ ...(user ? { "x-test-user": JSON.stringify(user) } : {}), ...extra });

  // GET as `user` (default admin); resolves { res, text }. Pass null for anonymous.
  h.get = async (p, user = h.admin) => {
    const res = await fetch(`${h.base}${p}`, { redirect: "manual", headers: headersFor(user) });
    return { res, text: await res.text() };
  };
  // POST urlencoded fields as `user` (default admin). Array values repeat the key.
  h.post = async (p, fields = {}, { user = h.admin, image = false } = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      for (const item of [].concat(v)) body.append(k, String(item));
    }
    const res = await fetch(`${h.base}${p}`, {
      method: "POST", redirect: "manual",
      headers: headersFor(user, { ...FORM, ...(image ? { "x-test-image": "1" } : {}) }),
      body: body.toString(),
    });
    return { res, text: await res.text() };
  };
  h.q = async (sql, params) => (await pool.query(sql, params)).rows;
  return h;
}

module.exports = { adminHarness, uniq };
