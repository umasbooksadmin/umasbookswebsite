// Small fetch wrapper for the in-process harness (test/helpers/inProcessApp.js):
// `as` is the session user sent via the x-test-user header (null = anonymous).
// Each call is a fresh request with no cookie jar; tests that need a session
// to persist (e.g. a cart) use test/helpers/httpClient.js's makeCookieJar.

function makeClient(base) {
  async function send(path, { method = "GET", as = null, form, headers = {} } = {}) {
    let res = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(as ? { "x-test-user": JSON.stringify(as) } : {}),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    // 303 = an admin form answered Post/Redirect/Get: follow it like the browser does, with the
    // session the POST started (any other answer is returned as is).
    let seeOther;
    if (res.status === 303) {
      seeOther = res.headers.get("location");
      const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      res = await fetch(`${base}${res.headers.get("location")}`, { redirect: "manual", headers: { ...(as ? { "x-test-user": JSON.stringify(as) } : {}), ...headers, cookie } });
    }
    return { res, status: res.status, location: res.headers.get("location"), text: await res.text(), seeOther };
  }
  return {
    get: (path, opts) => send(path, opts),
    post: (path, form, opts) => send(path, { ...opts, method: "POST", form }),
  };
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Inserts a real users row (FKs from rsvps/signups/favorites need one) and
// returns the matching session-user object for x-test-user.
async function makeUser(pool, { member = false, volunteer = false, admin = false, name } = {}) {
  const email = `rc-${uniq()}@example.test`;
  const displayName = name || `RC User ${uniq()}`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_member, is_volunteer, is_admin, email_verified_at)
     VALUES ($1, 'x', $2, $3, $4, $5, now()) RETURNING id`,
    [email, displayName, member, volunteer, admin]
  );
  return { id: rows[0].id, email, displayName, isAdmin: admin, isMember: member, isVolunteer: volunteer };
}

module.exports = { makeClient, makeUser, uniq };
