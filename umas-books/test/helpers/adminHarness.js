// Shared in-process harness for the admin content screen tests
// (adminCalendars / adminAnnouncementsBlog / adminCharity). Mounts the REAL
// src/routes/admin/* routers with the real views, a memory session and no
// CSRF (see inProcessApp.js), and gives tests logged-in admin / member
// users backed by real `users` rows (created_by is a foreign key).
//
// Pass { isolated: true } to get a throwaway database of the file's own even
// when CI points every file at one shared database (see testDatabase.js).

const path = require("node:path");
const { prepareDatabase, buildApp, listen } = require("./inProcessApp");

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// routerNames: file names under src/routes/admin (without .js).
function adminHarness(label, routerNames, { isolated = false } = {}) {
  const db = prepareDatabase(label, { isolated });
  const { pool } = require("../../src/db");

  const h = { pool, uniq, base: null, admin: null, member: null };
  let server;

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
    db.create();
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
    db.drop();
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
    let res = await fetch(`${h.base}${p}`, {
      method: "POST", redirect: "manual",
      headers: headersFor(user, { ...FORM, ...(image ? { "x-test-image": "1" } : {}) }),
      body: body.toString(),
    });
    // 303 = a form answered Post/Redirect/Get: follow it like the browser does, with the session
    // the POST started (any other answer is returned as is).
    if (res.status === 303) {
      const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      res = await fetch(`${h.base}${res.headers.get("location")}`, { redirect: "manual", headers: headersFor(user, { cookie }) });
    }
    return { res, text: await res.text() };
  };
  h.q = async (sql, params) => (await pool.query(sql, params)).rows;
  return h;
}

module.exports = { adminHarness, uniq };
