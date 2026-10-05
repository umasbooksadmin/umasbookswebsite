// Shared test helpers for "buying requires an account".
//
//   createAccount(pool, { email, displayName, password, confirmed, isMember })
//       inserts a user row (confirmed by default: only confirmed accounts can
//       buy) and returns it, with the clear-text password it was given.
//   sessionHeaders(account)
//       for the IN-PROCESS harness (test/helpers/inProcessApp.js), whose
//       session is injected from an `x-test-user` header: stands in for "this
//       person has logged in as that account".
//   loginOverHttp(base, jar, account)
//       for tests that boot the REAL app (startTestApp): performs the real
//       POST /login (CSRF token and all) and leaves the session cookie in
//       the jar. Returns the login response.
const bcrypt = require("bcryptjs");
const { fetchCsrfToken } = require("./httpClient");

const DEFAULT_PASSWORD = "Test-Password-1!";

async function createAccount(pool, { email, displayName = "Test Buyer", password = DEFAULT_PASSWORD, confirmed = true, isMember = false, memberExpiresAt = null } = {}) {
  const lowered = String(email).toLowerCase();
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at, is_member, member_expires_at)
     VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() END, $5, $6)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING *`,
    [lowered, hash, displayName, confirmed, isMember, memberExpiresAt]
  );
  return { ...rows[0], password };
}

function sessionHeaders(account) {
  return {
    "x-test-user": JSON.stringify({
      id: account.id, email: account.email, displayName: account.display_name,
      isAdmin: Boolean(account.is_admin), isMember: Boolean(account.is_member), isVolunteer: false,
    }),
  };
}

async function loginOverHttp(base, jar, account, extraHeaders = {}) {
  const token = await fetchCsrfToken(base, jar, extraHeaders);
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: new URLSearchParams({ email: account.email, password: account.password, _csrf: token }).toString(),
  });
  jar.capture(res);
  return res;
}

module.exports = { createAccount, sessionHeaders, loginOverHttp, DEFAULT_PASSWORD };

// In-process harness only: makes the person whose cookie jar this is a
// logged-in session for `account` (one request carrying the x-test-user
// header; the session then remembers it, like a real login would).
async function logInInProcess(base, jar, account) {
  const res = await fetch(`${base}/api/cart/count`, { headers: { cookie: jar.header(), ...sessionHeaders(account) } });
  jar.capture(res);
  await res.text();
}

module.exports.logInInProcess = logInInProcess;
