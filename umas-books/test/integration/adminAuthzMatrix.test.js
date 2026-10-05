// Authorization matrix for the whole admin panel. Every route registered
// under src/routes/admin/*.js is enumerated from the router stack (so a
// route added later is covered automatically, and one registered WITHOUT
// requireAdmin is caught), then exercised over HTTP against the real app as:
//   - a guest           -> must be bounced to /login (or 401/403)
//   - a logged-in non-member user    -> must be refused
//   - a logged-in member + volunteer -> must be refused (membership is not admin)
// POSTs carry a valid CSRF token so a refusal is the authz check, not CSRF.
// A real admin hitting GET /admin is the control proving the harness reaches
// the routes at all.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3480;
const PASSWORD = "AuthzMatrix1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;
let routes; // [{ method, path, requestPath, hasRequireAdmin }]

function collectRoutes(stack, out = []) {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push({
          method: method.toUpperCase(),
          path: layer.route.path,
          hasRequireAdmin: layer.route.stack.some((l) => l.handle === requireAdmin),
        });
      }
    } else if (layer.handle && layer.handle.stack) {
      collectRoutes(layer.handle.stack, out);
    }
  }
  return out;
}

let requireAdmin;

before(async () => {
  app = await startTestApp({ port: PORT });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  ({ requireAdmin } = require("../../src/middleware/auth"));
  routes = collectRoutes(require("../../src/routes/admin").stack).map((r) => ({
    ...r,
    requestPath: r.path.replace(/:\w+/g, "1"),
  }));
});

after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser(flags) {
  const email = `authz-${uniq()}@example.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_volunteer, email_verified_at)
     VALUES ($1, $2, 'Authz Test', $3, $4, $5, now())`,
    [email, await bcrypt.hash(PASSWORD, 10), !!flags.admin, !!flags.member, !!flags.volunteer]
  );
  return email;
}

async function loginJar(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302, "test login should succeed");
  return jar;
}

async function request(jar, { method, requestPath }) {
  const headers = { cookie: jar.header() };
  let body;
  if (method !== "GET") {
    const token = await fetchCsrfToken(app.base, jar);
    headers["content-type"] = FORM["content-type"];
    body = new URLSearchParams({ _csrf: token }).toString();
  }
  const res = await fetch(`${app.base}${requestPath}`, { method, redirect: "manual", headers, body });
  await res.text();
  return res;
}

test("the enumeration really found the admin routes", () => {
  assert.ok(routes.length >= 50, `expected the full admin surface, found only ${routes.length} routes`);
  for (const r of routes) assert.ok(r.path.startsWith("/admin"), `${r.method} ${r.path} is outside /admin`);
  assert.ok(routes.some((r) => r.method === "GET") && routes.some((r) => r.method === "POST"));
});

test("every admin route has requireAdmin in its own handler chain", () => {
  const missing = routes.filter((r) => !r.hasRequireAdmin).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(missing, []);
});

test("control: a real admin gets through to the admin dashboard", async () => {
  const jar = await loginJar(await createUser({ admin: true }));
  const res = await request(jar, { method: "GET", requestPath: "/admin" });
  assert.equal(res.status, 200);
});

const IDENTITIES = [
  {
    name: "anonymous",
    jar: async () => makeCookieJar(),
    ok: (res) => [401, 403].includes(res.status) || (res.status === 302 && res.headers.get("location") === "/login"),
    expected: "302 -> /login (or 401/403)",
  },
  {
    name: "logged-in non-member",
    jar: async () => loginJar(await createUser({})),
    ok: (res) => res.status === 403,
    expected: "403",
  },
  {
    name: "logged-in member + volunteer (not admin)",
    jar: async () => loginJar(await createUser({ member: true, volunteer: true })),
    ok: (res) => res.status === 403,
    expected: "403",
  },
];

for (const identity of IDENTITIES) {
  test(`authz matrix: every /admin route refuses ${identity.name}`, async () => {
    const jar = await identity.jar();
    const failures = [];
    for (const route of routes) {
      const res = await request(jar, route);
      if (!identity.ok(res)) {
        failures.push(`${route.method} ${route.path} -> ${res.status} ${res.headers.get("location") || ""} (wanted ${identity.expected})`);
      }
    }
    assert.deepEqual(failures, []);
  });
}
