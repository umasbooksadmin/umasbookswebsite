// Abuse limits and input hardening, over HTTP against the real app:
//   - /api/csrf-token can't be used to mint unlimited session rows
//   - the reserve route carries a daily per-IP ceiling
//   - garbage / out-of-range ids in request bodies get a 4xx or redirect,
//     never a Postgres 22003/22P02 -> 500 (which would also use up the
//     throttled admin error alert)
//   - deleting a book/copy/class that has orders explains itself instead of 500
//   - the same ISBN can't become two books, even when added simultaneously

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3610; // distinct from the other test files' ports (3610-3619 are this PR's)
const PASSWORD = "AbuseLimits1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const HUGE = "99999999999"; // past int4
const NOTICE = /has orders, so it can&#39;t be deleted|has orders, so it can't be deleted/;

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});

after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function post(jar, path, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  await res.text();
  return res;
}

async function loginAs(flags) {
  const email = `abuse-${uniq()}@example.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, email_verified_at)
     VALUES ($1, $2, 'Abuse Test', $3, $3, now())`,
    [email, await bcrypt.hash(PASSWORD, 10), !!flags.admin]
  );
  const jar = makeCookieJar();
  const res = await post(jar, "/login", { email, password: PASSWORD });
  assert.equal(res.status, 302, "test login should succeed");
  return jar;
}

async function newBook(isbn = null) {
  const { rows } = await pool.query("INSERT INTO books (title, authors, isbn) VALUES ($1, 'A', $2) RETURNING id", [`Abuse ${uniq()}`, isbn]);
  return rows[0].id;
}

async function newCopy(bookId, status = "in_stock") {
  const { rows } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, $2, 5.00) RETURNING id", [bookId, status]);
  return rows[0].id;
}

async function ordered(copyId) {
  const { rows } = await pool.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', $1, 5, 'paid') RETURNING id", [`o-${uniq()}@example.test`]);
  await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 't', 5)", [rows[0].id, copyId]);
}

test("reserve route carries the daily per-IP limiter", () => {
  const { reserveDailyLimiter } = require("../../src/middleware/rateLimits");
  const router = require("../../src/routes/books");
  const layer = router.stack.find((l) => l.route && l.route.path === "/books/:id/reserve");
  assert.ok(layer.route.stack.some((l) => l.handle === reserveDailyLimiter));
});

test("garbage / oversized ids in bodies never cause a 500", async () => {
  const jar = makeCookieJar();
  const bookId = await newBook();
  for (const bad of [HUGE, "abc", "-1", "1e3", "0"]) {
    const add = await post(jar, "/cart/add", { copyId: bad });
    assert.equal(add.status, 302, `cart/add copyId=${bad}`);
    const dropin = await post(jar, "/cart/add-dropin", { classId: bad });
    assert.equal(dropin.status, 302, `cart/add-dropin classId=${bad}`);
    const reserve = await post(jar, `/books/${bookId}/reserve`, { copyId: bad, name: "X", email: `r-${uniq()}@example.test` });
    assert.equal(reserve.status, 302, `reserve copyId=${bad}`);
  }

  const member = await loginAs({});
  for (const bad of [HUGE, "abc"]) {
    const fav = await post(member, "/api/favorites/toggle", { bookId: bad, isFavorite: "1" });
    assert.equal(fav.status, 400, `favorites bookId=${bad}`);
  }

  const admin = await loginAs({ admin: true });
  for (const path of [`/admin/members?view=${HUGE}`, `/admin/blog?edit=${HUGE}`, `/admin/announcements?edit=${HUGE}`, `/admin/members?view=abc`]) {
    const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: admin.header() } });
    await res.text();
    assert.equal(res.status, 200, path);
  }
  const opt = await post(admin, "/admin/charity-options", { charityId: HUGE });
  assert.equal(opt.status, 302);
  const ann = await post(admin, "/admin/announcements", { title: "T", body: "B", eventId: HUGE, statusAction: "draft" });
  assert.notEqual(ann.status, 500);
});

test("deleting a book that has an order explains why instead of a 500", async () => {
  const admin = await loginAs({ admin: true });
  const bookId = await newBook();
  const copyId = await newCopy(bookId, "sold");
  await ordered(copyId);

  const del = await post(admin, `/admin/inventory/${bookId}/delete`, {});
  assert.equal(del.status, 302);
  assert.equal(del.headers.get("location"), `/admin/inventory/${bookId}?notice=has-orders`);
  assert.equal((await pool.query("SELECT 1 FROM books WHERE id = $1", [bookId])).rows.length, 1);

  const page = await fetch(`${app.base}${del.headers.get("location")}`, { headers: { cookie: admin.header() } });
  assert.match(await page.text(), NOTICE);

  const delCopy = await post(admin, `/admin/inventory/${bookId}/copies/${copyId}/delete`, {});
  assert.equal(delCopy.status, 302);
  assert.equal(delCopy.headers.get("location"), `/admin/inventory/${bookId}?notice=has-orders`);
  assert.equal((await pool.query("SELECT 1 FROM book_copies WHERE id = $1", [copyId])).rows.length, 1);

  // Control: a never-ordered book still deletes.
  const plain = await newBook();
  const ok = await post(admin, `/admin/inventory/${plain}/delete`, {});
  assert.equal(ok.headers.get("location"), "/admin/inventory");
  assert.equal((await pool.query("SELECT 1 FROM books WHERE id = $1", [plain])).rows.length, 0);
});

test("deleting a session whose drop-in seat was ordered explains why instead of a 500", async () => {
  const admin = await loginAs({ admin: true });
  const { rows: cls } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Ordered Class', now() + interval '3 days', 5, 8) RETURNING id"
  );
  const { rows: order } = await pool.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', $1, 8, 'paid') RETURNING id", [`d-${uniq()}@example.test`]);
  const { rows: seat } = await pool.query("INSERT INTO class_dropin_seats (class_id, status, order_id) VALUES ($1, 'sold', $2) RETURNING id", [cls[0].id, order[0].id]);
  await pool.query("INSERT INTO order_items (order_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, 't', 8)", [order[0].id, seat[0].id]);

  const del = await post(admin, `/admin/sessions/${cls[0].id}/delete`, {});
  assert.equal(del.status, 302);
  assert.match(del.headers.get("location"), /notice=has-orders/);
  assert.equal((await pool.query("SELECT 1 FROM classes WHERE id = $1", [cls[0].id])).rows.length, 1);
  const page = await fetch(`${app.base}${del.headers.get("location")}`, { headers: { cookie: admin.header() } });
  assert.match(await page.text(), NOTICE);
});

test("the same ISBN added simultaneously ends up as one book with all the copies", async () => {
  const admin = await loginAs({ admin: true });
  const isbn = `978${Date.now()}`.slice(0, 13);
  const fields = {
    title: "Racy Book", author: "R", isbn, description: "d", descriptionFr: "d", coverUrl: "https://example.test/c.jpg", price: "5",
  };
  // One CSRF token for all six requests: six concurrent token fetches on one
  // session would race each other (each can replace the other's token).
  const token = await fetchCsrfToken(app.base, admin);
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    fetch(`${app.base}/admin/inventory`, {
      method: "POST",
      redirect: "manual",
      headers: { ...FORM, cookie: admin.header() },
      body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
    })
  ));
  for (const r of results) await r.text();
  for (const r of results) assert.equal(r.status, 302);
  const { rows: books } = await pool.query("SELECT id FROM books WHERE isbn = $1", [isbn]);
  assert.equal(books.length, 1);
  const { rows: copies } = await pool.query("SELECT 1 FROM book_copies WHERE book_id = $1", [books[0].id]);
  assert.equal(copies.length, 6);
});

test("when another request adds the ISBN between the lookup and the insert, the copy joins that book", async () => {
  const admin = await loginAs({ admin: true });
  const isbn = `979${Date.now()}`.slice(0, 13);
  // Deterministic stand-in for the race: a trigger inserts the "other
  // request's" book just before this request's own INSERT lands.
  await pool.query(`
    CREATE OR REPLACE FUNCTION abuse_test_race() RETURNS trigger AS $$
    BEGIN
      IF NEW.title = 'Race Loser ' || NEW.isbn THEN
        INSERT INTO books (title, isbn) VALUES ('Race Winner ' || NEW.isbn, NEW.isbn);
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await pool.query("CREATE TRIGGER abuse_test_race BEFORE INSERT ON books FOR EACH ROW EXECUTE FUNCTION abuse_test_race()");
  try {
    const res = await post(admin, "/admin/inventory", {
      title: `Race Loser ${isbn}`, isbn, description: "d", descriptionFr: "d", coverUrl: "https://example.test/c.jpg", price: "5",
    });
    assert.equal(res.status, 302);
  } finally {
    await pool.query("DROP TRIGGER abuse_test_race ON books");
  }
  const { rows: books } = await pool.query("SELECT id, title FROM books WHERE isbn = $1", [isbn]);
  assert.equal(books.length, 1);
  assert.match(books[0].title, /Race Winner/);
  assert.equal((await pool.query("SELECT 1 FROM book_copies WHERE book_id = $1", [books[0].id])).rows.length, 1);
});

test("migration 038 left a unique ISBN index in place, and ignores blank ISBNs", async () => {
  const { rows } = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_books_isbn_unique'");
  assert.equal(rows.length, 1);
  await pool.query("INSERT INTO books (title, isbn) VALUES ('Blank 1', ''), ('Blank 2', ''), ('Null 1', NULL), ('Null 2', NULL)");
  await assert.rejects(
    pool.query("INSERT INTO books (title, isbn) VALUES ('Dup 1', '9780000000001'), ('Dup 2', '9780000000001')"),
    (err) => err.code === "23505"
  );
});

// Last on purpose: it spends this app instance's cookie-less token budget.
test("/api/csrf-token is limited per IP for cookie-less callers, but not for a visitor who already has a token", async () => {
  // A normal visitor: one token fetch per page, many pages.
  const jar = makeCookieJar();
  await fetchCsrfToken(app.base, jar);
  for (let i = 0; i < 70; i++) {
    const res = await fetch(`${app.base}/api/csrf-token`, { headers: { cookie: jar.header() } });
    assert.equal(res.status, 200, `existing-session fetch #${i + 1}`);
    await res.text();
  }

  // A bot: no cookie each time, so each hit would create a session row.
  const before = (await pool.query("SELECT count(*)::int AS n FROM session")).rows[0].n;
  const statuses = [];
  for (let i = 0; i < 80; i++) {
    const res = await fetch(`${app.base}/api/csrf-token`);
    await res.text();
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), "expected a 429 for cookie-less hammering");
  const after = (await pool.query("SELECT count(*)::int AS n FROM session")).rows[0].n;
  assert.ok(after - before <= 61, `session rows created: ${after - before}`);
});
