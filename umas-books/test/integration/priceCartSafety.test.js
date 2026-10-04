// Prices and cart safety: a copy without a real price (NULL / 0) is never
// purchasable, admin money and number inputs are validated on the server, and
// the admin status screens cannot overwrite a copy that changed under them.
//
// In-process (HelloAsso and mail stubbed); every value is unique because CI
// shares one database between test files.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeClient, makeUser, uniq } = require("../helpers/routeClient");
const { makeCookieJar } = require("../helpers/httpClient");

const db = prepareDatabase("price_safety", { isolated: true });

const mailer = require("../../src/mailer");
mailer.sendMail = async () => {};
const helloasso = require("../../src/lib/helloasso");
helloasso.isConfigured = () => true;
const createdIntents = [];
helloasso.createCheckoutIntent = async (args) => {
  createdIntents.push(args);
  return { id: `intent-${uniq()}`, redirectUrl: "https://pay.example.test/checkout/1" };
};

// No outbound HTTP (book lookups, description generation): fail loudly.
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, init);
  throw new Error(`unexpected outbound request: ${url}`);
};

const { pool } = require("../../src/db");
const { checkoutLimiter } = require("../../src/middleware/rateLimits");

let server, c, admin;
before(async () => {
  db.create();
  admin = await makeUser(pool, { admin: true, name: "Price Admin" });
  server = await listen(buildApp([
    require("../../src/routes/books"),
    require("../../src/routes/cart"),
    require("../../src/routes/admin/inventory"),
    require("../../src/routes/admin/sessions"),
  ]));
  c = makeClient(server.base);
});
after(async () => {
  await server.close();
  global.fetch = realFetch;
  await pool.end();
  db.drop();
});
beforeEach(() => {
  createdIntents.length = 0;
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) checkoutLimiter.resetKey(key);
});

// ---------- helpers ----------

async function makeBook(title = `Price Book ${uniq()}`) {
  const { rows } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'Price Author') RETURNING id", [title]);
  return rows[0].id;
}
async function makeCopy(bookId, { price = 7.5, status = "in_stock", condition = "very_good" } = {}) {
  const { rows } = await pool.query(
    "INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, $2, $3, $4) RETURNING id",
    [bookId, status, price, condition]
  );
  return rows[0].id;
}
const copyRow = async (id) => (await pool.query("SELECT * FROM book_copies WHERE id = $1", [id])).rows[0];
const adminPost = (path, fields) => c.post(path, fields, { as: admin });
const adminGet = (path) => c.get(path, { as: admin });

function visitor() {
  const jar = makeCookieJar();
  const send = async (path, { method = "GET", form, lang } = {}) => {
    const res = await fetch(`${server.base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        cookie: [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; "),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar.capture(res);
    return { res, text: await res.text() };
  };
  return {
    get: (p, o) => send(p, o),
    post: (p, form) => send(p, { method: "POST", form }),
    count: async () => JSON.parse((await send("/api/cart/count")).text).count,
  };
}

// A new book + copy through the real admin route (price and the rest as typed).
const intakeFields = (title, over = {}) => ({
  title, price: "6.50", condition: "very_good", status: "in_stock",
  description: "d", descriptionFr: "d fr", coverUrl: "http://cover.example/c.jpg", ...over,
});
const bookByTitle = async (title) => (await pool.query("SELECT * FROM books WHERE title = $1", [title])).rows;

// ---------- the public book page ----------

test("book page: a copy with no price or a 0 price has no Add to Cart button, only 'Ask in the shop'", async () => {
  const bookId = await makeBook();
  const good = await makeCopy(bookId, { price: 7.5 });
  const noPrice = await makeCopy(bookId, { price: null });
  const zero = await makeCopy(bookId, { price: 0 });

  const v = visitor();
  const en = await v.get(`/books/${bookId}`);
  assert.equal(en.res.status, 200);
  assert.match(en.text, new RegExp(`name="copyId" value="${good}"`));
  assert.doesNotMatch(en.text, new RegExp(`name="copyId" value="${noPrice}"`));
  assert.doesNotMatch(en.text, new RegExp(`name="copyId" value="${zero}"`));
  assert.equal((en.text.match(/action="\/cart\/add"/g) || []).length, 1, "one Add to Cart form, for the priced copy");
  assert.equal((en.text.match(/Ask in the shop/g) || []).length, 2);
  assert.match(en.text, /€7\.50/);

  const fr = await v.get(`/books/${bookId}`, { lang: "fr" });
  assert.equal((fr.text.match(/Se renseigner en boutique/g) || []).length, 2);
  assert.doesNotMatch(fr.text, /Ask in the shop/);
});

test("book page: when no copy has a price there is no price headline and no cart form at all", async () => {
  const bookId = await makeBook();
  await makeCopy(bookId, { price: null });
  const page = await visitor().get(`/books/${bookId}`);
  assert.equal(page.res.status, 200);
  assert.doesNotMatch(page.text, /action="\/cart\/add"/);
  assert.doesNotMatch(page.text, /Infinity/);
  assert.match(page.text, /Ask in the shop/);
});

// ---------- cart and checkout ----------

test("/cart/add ignores a copy without a real price (NULL or 0)", async () => {
  const bookId = await makeBook();
  const noPrice = await makeCopy(bookId, { price: null });
  const zero = await makeCopy(bookId, { price: 0 });
  const good = await makeCopy(bookId, { price: 4 });
  const v = visitor();
  await v.post("/cart/add", { copyId: noPrice });
  await v.post("/cart/add", { copyId: zero });
  assert.equal(await v.count(), 0);
  await v.post("/cart/add", { copyId: good });
  assert.equal(await v.count(), 1);
});

test("a copy whose price is removed while it sits in a cart drops out: the cart total never counts it as 0", async () => {
  const bookId = await makeBook();
  const copy = await makeCopy(bookId, { price: 9 });
  const v = visitor();
  await v.post("/cart/add", { copyId: copy });
  assert.match((await v.get("/cart")).text, /9\.00/);
  await pool.query("UPDATE book_copies SET price = NULL WHERE id = $1", [copy]);
  const page = await v.get("/cart");
  assert.doesNotMatch(page.text, new RegExp(`value="${copy}"`));
  assert.equal(await v.count(), 0, "the line is dropped from the session cart");

  // Checkout of that cart: nothing to buy, no order, the copy is untouched.
  const email = `nullprice-${uniq()}@example.test`;
  const res = await v.post("/cart/checkout", { name: "Buyer", email, acceptCgv: "on" });
  assert.equal(res.res.status, 200);
  assert.match(res.text, /Your cart is empty/);
  assert.equal((await pool.query("SELECT 1 FROM orders WHERE buyer_email = $1", [email])).rowCount, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
});

test("checkout lock: a price removed after the cart was read cannot be locked or ordered", async () => {
  const bookId = await makeBook();
  const copy = await makeCopy(bookId, { price: 12 });
  const v = visitor();
  await v.post("/cart/add", { copyId: copy });
  const email = `lockrace-${uniq()}@example.test`;
  // Fires inside the checkout transaction, after the cart was read (with its
  // price) and before the copy is locked: stands in for an admin blanking the price.
  const fn = `race_null_price_${Date.now()}`;
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger AS $$
    BEGIN
      IF NEW.buyer_email = '${email}' THEN UPDATE book_copies SET price = NULL WHERE id = ${copy}; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    const res = await v.post("/cart/checkout", { name: "Buyer", email, acceptCgv: "on" });
    assert.equal(res.res.status, 200, "no redirect to payment");
    assert.match(res.text, /taken by someone else/);
    assert.equal(createdIntents.length, 0, "no payment was started");
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${fn} ON orders`);
    await pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  const after = await copyRow(copy);
  assert.equal(after.status, "in_stock", "the copy was not locked");
  assert.equal((await pool.query("SELECT 1 FROM orders WHERE buyer_email = $1", [email])).rowCount, 0, "the order rolled back");
  assert.equal((await pool.query("SELECT 1 FROM order_items WHERE book_copy_id = $1", [copy])).rowCount, 0);
});

test("a copy with a real price still checks out normally", async () => {
  const bookId = await makeBook();
  const copy = await makeCopy(bookId, { price: 5.25 });
  const v = visitor();
  await v.post("/cart/add", { copyId: copy });
  const email = `ok-${uniq()}@example.test`;
  const res = await v.post("/cart/checkout", { name: "Buyer", email, acceptCgv: "on" });
  assert.equal(res.res.status, 302);
  assert.equal((await copyRow(copy)).status, "in_cart");
  assert.equal(createdIntents.at(-1).amountCents, 525);
});

// ---------- reservations and book-request holds ----------

test("public reservation skips a copy without a real price", async () => {
  const bookId = await makeBook();
  const noPrice = await makeCopy(bookId, { price: null });
  const priced = await makeCopy(bookId, { price: 5 });
  const v = visitor();
  const email = `reserve-${uniq()}@example.test`;
  await v.post(`/books/${bookId}/reserve`, { copyId: noPrice, name: "Rita", email });
  assert.equal((await copyRow(noPrice)).status, "in_stock");
  await v.post(`/books/${bookId}/reserve`, { copyId: priced, name: "Rita", email });
  assert.equal((await copyRow(priced)).status, "reserved");
});

// ---------- in-shop sale ----------

test("shop sale: an unpriced copy can be sold at a price typed at the counter; bad prices are refused", async () => {
  const bookId = await makeBook();
  const copy = await makeCopy(bookId, { price: null });
  for (const [bad, message] of [["abc", /Price must be a number/], ["-1", /cannot be negative/], ["10000.01", /between/], ["1.234", /at most 2 decimals/], ["1e3", /Price must be a number/], ["NaN", /Price must be a number/]]) {
    const res = await adminPost("/admin/inventory/sell", { copyId: String(copy), price: bad, payment: "cash" });
    assert.equal(res.status, 400, bad);
    assert.match(res.text, message, bad);
  }
  const blank = await adminPost("/admin/inventory/sell", { copyId: String(copy), price: "", payment: "cash" });
  assert.equal(blank.status, 400);
  assert.match(blank.text, /Enter the price the book was sold for/);
  assert.equal((await copyRow(copy)).status, "in_stock");
  assert.equal((await pool.query("SELECT 1 FROM shop_sales WHERE copy_id = $1", [copy])).rowCount, 0);

  const ok = await adminPost("/admin/inventory/sell", { copyId: String(copy), price: "12,50", payment: "cash" });
  assert.equal(ok.status, 302);
  assert.equal((await copyRow(copy)).status, "sold");
  const { rows } = await pool.query("SELECT price FROM shop_sales WHERE copy_id = $1", [copy]);
  assert.equal(Number(rows[0].price), 12.5);
});

// ---------- admin: add a book ----------

test("admin add book: bad price, cost or year is refused with a clear message, the form keeps the values, nothing is saved", async () => {
  const cases = [
    [{ price: "abc" }, /Price must be a number/, /name="price"[^>]*value="abc"/],
    [{ price: "-5" }, /Price cannot be negative/, /name="price"[^>]*value="-5"/],
    [{ price: "10000.01" }, /Price must be between/, /value="10000\.01"/],
    [{ price: "4.999" }, /at most 2 decimals/, /value="4\.999"/],
    [{ acquisitionCost: "-1" }, /Acquisition cost cannot be negative/, /name="acquisitionCost"[^>]*value="-1"/],
    [{ acquisitionCost: "20000" }, /Acquisition cost must be between/, /value="20000"/],
    [{ acquisitionCost: "1.234" }, /Acquisition cost can have at most 2 decimals/, /value="1\.234"/],
    [{ publishedYear: "999" }, /Published year must be a whole number between 1000 and \d{4}/, /name="publishedYear"[^>]*value="999"/],
    [{ publishedYear: "3000" }, /Published year must be a whole number/, /value="3000"/],
    [{ publishedYear: "19.5" }, /Published year must be a whole number/, /value="19\.5"/],
  ];
  for (const [over, message, kept] of cases) {
    const title = `Refused ${uniq()}`;
    const res = await adminPost("/admin/inventory", intakeFields(title, { price: "6.50", ...over }));
    assert.equal(res.status, 200, JSON.stringify(over));
    assert.match(res.text, message, JSON.stringify(over));
    assert.match(res.text, kept, `form keeps ${JSON.stringify(over)}`);
    assert.ok(res.text.includes(title), "the title is kept");
    assert.equal((await bookByTitle(title)).length, 0, "no half-created book");
  }
});

test("admin add book: a blank price on a used copy is stored as no price; a valid year and cost are saved", async () => {
  const title = `Blank price ${uniq()}`;
  const year = new Date().getFullYear() + 1;
  const res = await adminPost("/admin/inventory", intakeFields(title, { price: "", publishedYear: String(year), acquisitionCost: "2,5" }));
  assert.equal(res.status, 302, res.text.slice(0, 300));
  const [book] = await bookByTitle(title);
  assert.equal(book.published_year, year);
  const { rows } = await pool.query("SELECT price, acquisition_cost FROM book_copies WHERE book_id = $1", [book.id]);
  assert.equal(rows[0].price, null);
  assert.equal(Number(rows[0].acquisition_cost), 2.5);

  const title2 = `Blank year ${uniq()}`;
  const ok = await adminPost("/admin/inventory", intakeFields(title2, { publishedYear: "", acquisitionCost: "" }));
  assert.equal(ok.status, 302);
  const [book2] = await bookByTitle(title2);
  assert.equal(book2.published_year, null);
});

// ---------- admin: edit a copy / a book ----------

test("admin edit copy: a bad price or cost is refused, the copy is unchanged and the typed value is shown again", async () => {
  const bookId = await makeBook();
  const copy = await makeCopy(bookId, { price: 8 });
  for (const [over, message] of [
    [{ price: "abc" }, /Price must be a number/],
    [{ price: "-2" }, /cannot be negative/],
    [{ price: "10000.01" }, /Price must be between/],
    [{ price: "3.456" }, /at most 2 decimals/],
    [{ acquisitionCost: "-0.5" }, /Acquisition cost cannot be negative/],
    [{ acquisitionCost: "99999" }, /Acquisition cost must be between/],
  ]) {
    const res = await adminPost(`/admin/inventory/${bookId}/copies/${copy}`, { condition: "very_good", status: "in_stock", renderedStatus: "in_stock", price: "8", notes: "typed notes", ...over });
    assert.equal(res.status, 200, JSON.stringify(over));
    assert.match(res.text, message);
    assert.match(res.text, /typed notes/, "other typed values are kept");
    if (over.price) assert.ok(res.text.includes(`value="${over.price}"`), "the typed price is shown again");
    const row = await copyRow(copy);
    assert.equal(Number(row.price), 8);
    assert.equal(row.notes, null);
  }
  const blank = await adminPost(`/admin/inventory/${bookId}/copies/${copy}`, { condition: "very_good", status: "in_stock", renderedStatus: "in_stock", price: "" });
  assert.equal(blank.status, 302);
  assert.equal((await copyRow(copy)).price, null, "a blank price is saved as no price");
});

test("admin edit book: a bad published year is refused and the book is unchanged", async () => {
  const bookId = await makeBook();
  const res = await adminPost(`/admin/inventory/${bookId}`, { title: "Changed title", publishedYear: "20xx", description: "d", descriptionFr: "d", coverUrl: "http://cover.example/c.jpg" });
  assert.equal(res.status, 200);
  assert.match(res.text, /Published year must be a whole number/);
  assert.match(res.text, /value="20xx"/);
  const { rows } = await pool.query("SELECT title, published_year FROM books WHERE id = $1", [bookId]);
  assert.notEqual(rows[0].title, "Changed title");
  assert.equal(rows[0].published_year, null);
});

// ---------- status races ----------

test("cancel reservation only returns a copy that is still reserved", async () => {
  const bookId = await makeBook();
  const sold = await makeCopy(bookId, { status: "sold" });
  const inCart = await makeCopy(bookId, { status: "in_cart" });
  for (const id of [sold, inCart]) {
    const before = (await copyRow(id)).status;
    const res = await adminPost(`/admin/inventory/${bookId}/copies/${id}/cancel-reservation`, {});
    assert.equal(res.status, 409);
    assert.match(res.text, /already gone/);
    assert.equal((await copyRow(id)).status, before, "must not be put back on sale");
  }
  const reserved = await makeCopy(bookId, { status: "reserved" });
  await pool.query("UPDATE book_copies SET reserved_by_name='N', reserved_by_email='n@example.test', reserved_at=now() WHERE id=$1", [reserved]);
  const ok = await adminPost(`/admin/inventory/${bookId}/copies/${reserved}/cancel-reservation`, {});
  assert.equal(ok.status, 302);
  const row = await copyRow(reserved);
  assert.equal(row.status, "in_stock");
  assert.equal(row.reserved_by_email, null);
  assert.equal(row.reserved_at, null);
});

test("copy edit form posts the status it was rendered with", async () => {
  const bookId = await makeBook();
  const copy = await makeCopy(bookId, { status: "damaged" });
  const page = await adminGet(`/admin/inventory/${bookId}`);
  assert.match(page.text, new RegExp(`name="renderedStatus" value="damaged"`));
  assert.ok(page.text.includes(`id="status-${copy}"`));
});

test("copy edit: a status change is refused when the copy changed since the form was opened", async () => {
  const bookId = await makeBook();
  for (const current of ["sold", "in_cart", "reserved"]) {
    const copy = await makeCopy(bookId, { status: "in_stock" });
    // The form was rendered while in stock; meanwhile the copy moved on.
    await pool.query("UPDATE book_copies SET status = $2, reserved_at = CASE WHEN $2 = 'reserved' THEN now() END WHERE id = $1", [copy, current]);
    const res = await adminPost(`/admin/inventory/${bookId}/copies/${copy}`, { condition: "very_good", status: "damaged", renderedStatus: "in_stock", price: "9", notes: "stale edit" });
    assert.equal(res.status, 409, current);
    const label = { sold: "Sold", in_cart: "In a cart", reserved: "Reserved" }[current];
    assert.match(res.text, new RegExp(`This copy changed since you opened the form \\(now: ${label}\\)\\. Reload\\.`), current);
    const row = await copyRow(copy);
    assert.equal(row.status, current, "status not overwritten");
    assert.equal(row.notes, null, "nothing else was saved either");
  }
});

test("copy edit: a sold or in-cart copy keeps its status whatever the form says; the other fields are saved and the page says so", async () => {
  const bookId = await makeBook();
  for (const current of ["sold", "in_cart"]) {
    const copy = await makeCopy(bookId, { status: current });
    const res = await adminPost(`/admin/inventory/${bookId}/copies/${copy}`, { condition: "very_good", status: "in_stock", renderedStatus: current, price: "9", notes: "kept note" });
    assert.equal(res.status, 302);
    assert.equal(res.location, `/admin/inventory/${bookId}?notice=status-kept`);
    const row = await copyRow(copy);
    assert.equal(row.status, current, "never put back on sale");
    assert.equal(row.notes, "kept note");
    assert.match((await adminGet(res.location)).text, /status was not changed/);
    // Status left alone (form posts what it rendered): saved with no warning.
    const plain = await adminPost(`/admin/inventory/${bookId}/copies/${copy}`, { condition: "very_good", status: current, renderedStatus: current, price: "9", notes: "again" });
    assert.equal(plain.location, `/admin/inventory/${bookId}`);
    assert.equal((await copyRow(copy)).status, current);
  }
  // Form rendered in stock, copy sold since, person only edits the notes: status stays sold.
  const copy = await makeCopy(bookId, { status: "sold" });
  const res = await adminPost(`/admin/inventory/${bookId}/copies/${copy}`, { condition: "very_good", status: "in_stock", renderedStatus: "in_stock", price: "9", notes: "late note" });
  assert.equal(res.status, 302);
  const row = await copyRow(copy);
  assert.equal(row.status, "sold", "an unchanged status field never puts a sold copy back on sale");
  assert.equal(row.notes, "late note");
});

test("copy edit: normal status changes still work; reserving from the form sets reserved_at, leaving clears the hold", async () => {
  const bookId = await makeBook();
  const copy = await makeCopy(bookId, { status: "in_stock" });
  const post = (fields) => adminPost(`/admin/inventory/${bookId}/copies/${copy}`, { condition: "very_good", price: "9", ...fields });

  assert.equal((await post({ status: "damaged", renderedStatus: "in_stock" })).status, 302);
  assert.equal((await copyRow(copy)).status, "damaged");

  assert.equal((await post({ status: "reserved", renderedStatus: "damaged" })).status, 302);
  let row = await copyRow(copy);
  assert.equal(row.status, "reserved");
  assert.ok(row.reserved_at, "reserved_at is set so the hold expires like any other");
  assert.ok(Math.abs(Date.now() - new Date(row.reserved_at).getTime()) < 60000);

  await pool.query("UPDATE book_copies SET reserved_by_name='Held', reserved_by_email='held@example.test' WHERE id=$1", [copy]);
  assert.equal((await post({ status: "in_stock", renderedStatus: "reserved" })).status, 302);
  row = await copyRow(copy);
  assert.equal(row.status, "in_stock");
  assert.equal(row.reserved_at, null);
  assert.equal(row.reserved_by_email, null);
});

test("copy edit: a form from before renderedStatus existed (none posted) cannot touch a sold copy's status", async () => {
  const bookId = await makeBook();
  const copy = await makeCopy(bookId, { status: "sold" });
  const res = await adminPost(`/admin/inventory/${bookId}/copies/${copy}`, { condition: "very_good", status: "in_stock", price: "9" });
  assert.equal(res.status, 302);
  assert.equal((await copyRow(copy)).status, "sold");
  // ...and a status that is not one of ours changes nothing.
  const free = await makeCopy(bookId, { status: "damaged" });
  await adminPost(`/admin/inventory/${bookId}/copies/${free}`, { condition: "very_good", status: "borrowed", price: "9" });
  assert.equal((await copyRow(free)).status, "damaged");
  await adminPost(`/admin/inventory/${bookId}/copies/${free}`, { condition: "very_good", price: "9" });
  assert.equal((await copyRow(free)).status, "damaged", "a missing status field changes nothing");
});

// ---------- classes (sessions) ----------

const classRow = async (id) => (await pool.query("SELECT * FROM classes WHERE id = $1", [id])).rows[0];
async function makeClass({ capacity = 5, dropinPrice = 10 } = {}) {
  const { rows } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ($1, '2031-06-15 12:00+00', $2, $3) RETURNING id",
    [`Class ${uniq()}`, capacity, dropinPrice]
  );
  return rows[0].id;
}
async function addSeats(classId, n, status = "sold") {
  const { rows: o } = await pool.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', $1, 10, 'paid') RETURNING id", [`seat-${uniq()}@example.test`]);
  for (let i = 0; i < n; i++) await pool.query("INSERT INTO class_dropin_seats (class_id, status, order_id) VALUES ($1, $2, $3)", [classId, status, o[0].id]);
}
// The calendar shows the month of the fixed 2031 dates used here.
const MONTH = "?month=2031-06";
const editFields = (over) => ({ title: "Edited", startsAt: "2031-06-16T10:00", capacity: "5", dropinPrice: "10", ...over });

test("admin add session: bad drop-in price or capacity is refused, form values kept, no session created", async () => {
  const cases = [
    [{ dropinPrice: "-5" }, /Drop-in price cannot be negative/],
    [{ dropinPrice: "1.234" }, /Drop-in price can have at most 2 decimals/],
    [{ dropinPrice: "20000" }, /Drop-in price must be between/],
    [{ dropinPrice: "abc" }, /Drop-in price must be a number/],
    [{ dropinPrice: "0" }, /Drop-in price must be between €0\.01/],
    [{ capacity: "0" }, /Capacity must be a whole number between 1 and 1000/],
    [{ capacity: "-3" }, /Capacity must be a whole number/],
    [{ capacity: "2.5" }, /Capacity must be a whole number/],
    [{ capacity: "abc" }, /Capacity must be a whole number/],
  ];
  for (const [over, message] of cases) {
    const title = `Refused class ${uniq()}`;
    const res = await adminPost("/admin/sessions", { title, date: "2031-06-10", month: "2031-06", startTime: "10:00", capacity: "5", dropinPrice: "", ...over });
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.match(res.text, message);
    assert.ok(res.text.includes(`value="${title}"`), "the typed title is kept in the add form");
    const [bad] = Object.values(over);
    assert.ok(res.text.includes(`value="${bad}"`), `the typed ${bad} is kept`);
    assert.equal((await pool.query("SELECT 1 FROM classes WHERE title = $1", [title])).rowCount, 0);
  }
  const ok = await adminPost("/admin/sessions", { title: `Good class ${uniq()}`, date: "2031-06-10", startTime: "10:00", capacity: "", dropinPrice: "12,50" });
  assert.equal(ok.status, 302);
});

test("admin edit session: blank capacity keeps the current one (never unlimited); bad numbers are refused", async () => {
  const id = await makeClass({ capacity: 7, dropinPrice: 10 });
  const res = await adminPost(`/admin/sessions/${id}${MONTH}`, editFields({ capacity: "" }));
  assert.equal(res.status, 302);
  assert.equal((await classRow(id)).capacity, 7, "blank capacity must not turn the session unlimited");
  assert.equal((await classRow(id)).title, "Edited");

  for (const [over, message] of [[{ dropinPrice: "-1" }, /cannot be negative/], [{ dropinPrice: "1.234" }, /at most 2 decimals/], [{ capacity: "0" }, /Capacity must be/], [{ capacity: "abc" }, /Capacity must be/]]) {
    const bad = await adminPost(`/admin/sessions/${id}${MONTH}`, editFields({ title: "Should not save", ...over }));
    assert.equal(bad.status, 400, JSON.stringify(over));
    assert.match(bad.text, message);
    assert.ok(bad.text.includes("Should not save"), "typed values are kept in the edit form");
    assert.equal((await classRow(id)).title, "Edited");
  }
});

test("admin edit session: capacity cannot go below the seats already sold, nor the drop-in price be cleared while paid seats exist", async () => {
  const id = await makeClass({ capacity: 6, dropinPrice: 10 });
  await addSeats(id, 3, "sold");
  await addSeats(id, 1, "in_cart");

  const low = await adminPost(`/admin/sessions/${id}${MONTH}`, editFields({ capacity: "3" }));
  assert.equal(low.status, 400);
  assert.match(low.text, /Capacity can(?:'|&#39;)t be lowered to 3: 4 seats are already booked/);
  assert.equal((await classRow(id)).capacity, 6);

  const exact = await adminPost(`/admin/sessions/${id}${MONTH}`, editFields({ capacity: "4" }));
  assert.equal(exact.status, 302, "lowering to exactly the booked seats is fine");
  assert.equal((await classRow(id)).capacity, 4);

  const cleared = await adminPost(`/admin/sessions/${id}${MONTH}`, editFields({ capacity: "4", dropinPrice: "" }));
  assert.equal(cleared.status, 400);
  assert.match(cleared.text, /drop-in price can(?:'|&#39;)t be cleared: 4 paid drop-in seats/);
  assert.equal(Number((await classRow(id)).dropin_price), 10);

  const changed = await adminPost(`/admin/sessions/${id}${MONTH}`, editFields({ capacity: "4", dropinPrice: "12.5" }));
  assert.equal(changed.status, 302);
  assert.equal(Number((await classRow(id)).dropin_price), 12.5);

  const free = await makeClass({ capacity: 6, dropinPrice: 10 });
  const clearedFree = await adminPost(`/admin/sessions/${free}${MONTH}`, editFields({ dropinPrice: "" }));
  assert.equal(clearedFree.status, 302, "no paid seats: the price can be cleared");
  assert.equal((await classRow(free)).dropin_price, null);
});

// ---------- database constraints ----------

test("the database refuses an out-of-range price, cost or drop-in price (migration 056)", async () => {
  const bookId = await makeBook();
  for (const bad of ["-1", "100000", "NaN"]) {
    await assert.rejects(pool.query("INSERT INTO book_copies (book_id, price) VALUES ($1, $2)", [bookId, bad]), { code: "23514" }, `price ${bad}`);
    await assert.rejects(pool.query("INSERT INTO book_copies (book_id, acquisition_cost) VALUES ($1, $2)", [bookId, bad]), { code: "23514" }, `cost ${bad}`);
    await assert.rejects(pool.query("INSERT INTO classes (title, starts_at, dropin_price) VALUES ('x', now(), $1)", [bad]), { code: "23514" }, `dropin ${bad}`);
  }
  await pool.query("INSERT INTO book_copies (book_id, price, acquisition_cost) VALUES ($1, 99999.99, 0)", [bookId]);
  await pool.query("INSERT INTO book_copies (book_id, price) VALUES ($1, NULL)", [bookId]);
});
