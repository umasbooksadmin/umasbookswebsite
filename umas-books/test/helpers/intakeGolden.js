// Golden matrix for POST /admin/inventory (the add-copy path). runMatrix() drives the real route module through
// HTTP on a fresh database and returns a snapshot (responses, rows, audit entries, intake tokens) with ids, times and
// hashes normalised. The snapshot recorded from the code BEFORE the lib/inventoryIntake.js extraction is
// test/fixtures/intakeGolden.json; test/integration/intakeGolden.test.js asserts the current code produces the same.
// Record again with: node scripts/record-intake-golden.js (only for a deliberate change; say so in the PR).

const express = require("express");
const multer = require("multer");
const { prepareDatabase, buildApp, listen } = require("./inProcessApp");
const { isbn13From, isbn10From } = require("./isbn");

const Y = new Date().getFullYear();

async function runMatrix({ pool, server, adminId, realFetch }) {
  const cookieJar = { c: "" };
  const adminHeader = { "x-test-user": JSON.stringify({ id: adminId, email: "golden-admin@example.test", displayName: "Admin", isAdmin: true }) };
  const { settled } = require("../../src/lib/afterResponse");

  async function post(form, { json = false, photo, path = "/admin/inventory", followBook = false } = {}) {
    const headers = { ...adminHeader };
    if (cookieJar.c) headers.cookie = cookieJar.c;
    if (json) headers.accept = "application/json";
    let body;
    if (photo) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form)) fd.append(k, v);
      fd.append("coverPhoto", new Blob([photo.buffer], { type: photo.type || "image/png" }), "cover.png");
      body = fd;
    } else {
      body = new URLSearchParams(form).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await realFetch(`${server.base}${path}`, { method: "POST", redirect: "manual", headers, body, signal: AbortSignal.timeout(30000) });
    const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
    if (set.length) cookieJar.c = set.join("; ");
    const text = await res.text();
    let follow = null;
    const loc = res.headers.get("location");
    if (loc && loc.startsWith("/admin/inventory/new/again")) {
      const f = await realFetch(`${server.base}${loc}`, { redirect: "manual", headers: { ...adminHeader, cookie: cookieJar.c } });
      const fset = f.headers.getSetCookie().map((c) => c.split(";")[0]);
      if (fset.length) cookieJar.c = fset.join("; ");
      follow = { status: f.status, text: await f.text() };
    }
    if (loc && followBook && /^\/admin\/inventory\/\d+(\?|$)/.test(loc)) {
      const f = await realFetch(`${server.base}${loc}`, { redirect: "manual", headers: { ...adminHeader, cookie: cookieJar.c } });
      const fset = f.headers.getSetCookie().map((c) => c.split(";")[0]);
      if (fset.length) cookieJar.c = fset.join("; ");
      const ft = await f.text();
      const grab = (re) => { const m = ft.match(re); return m ? m[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&") : null; };
      follow = { status: f.status, page: { error: grab(/class="error-box"[^>]*>([^<]*)</), notice: grab(/class="notice-box"[^>]*>([^<]*)</), openCopies: (ft.match(/<details open>/g) || []).length } };
    }
    return { status: res.status, type: res.headers.get("content-type"), location: loc, text, follow };
  }
  const { makeOrder } = require("./orderFixtures");
  // Saves a copy through the route and returns the real ids.
  async function mk(over = {}) {
    const r = await post(base({ isbn: isbn(), fast: "1", ...over }), { json: true });
    const j = JSON.parse(r.text);
    return { bookId: j.bookId, copyId: j.copyId };
  }
  const edit = (ids, form, o = {}) => post(form, { path: `/admin/inventory/${ids.bookId}/copies/${o.copyId || ids.copyId}`, followBook: true });
  const row = async (copyId) => (await pool.query("SELECT status, price, publisher_price, acquisition_cost, acquired_at, notes, location, source, condition, suggested_price, suggested_level, price_basis, is_clearance, reserved_by_name, reserved_at IS NOT NULL AS has_reserved_at, cart_order_id IS NOT NULL AS has_order FROM book_copies WHERE id = $1", [copyId])).rows[0] || null;

  let seq = 0;
  let tseq = 0;
  const isbn = () => isbn13From(`978${String(7000000 + (++seq)).padStart(9, "0")}`);
  const tok = () => `golden-token-${String(++tseq).padStart(3, "0")}-abcdefghij`;
  const base = (over = {}) => ({ title: `Golden ${seq + 1}`, author: "A. Writer", description: "A description.", coverUrl: "/img/0123456789abcdef.jpg", binding: "trade", status: "in_stock", condition: "very_good", price: "5", location: "Store", source: "donation", intakeToken: tok(), ...over });
  const png = await require("sharp")({ create: { width: 40, height: 60, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();

  // Cases: [name, async (post) => [response, ...]]. Every case runs on the same database in order.
  const cases = [];
  const add = (name, fn) => cases.push([name, fn]);

  add("used copy, form post", async () => [await post(base({ title: "Used form", isbn: isbn() }))]);
  add("used copy, no isbn, form post", async () => [await post(base({ title: "No isbn form" }))]);
  add("used copy, fast=1 JSON", async () => [await post(base({ title: "Fast json", isbn: isbn(), fast: "1" }), { json: true })]);
  add("used copy, fast=1 form", async () => [await post(base({ title: "Fast form", isbn: isbn(), fast: "1", condition: "good" }))]);
  add("fromScan JSON", async () => [await post(base({ title: "Scan json", isbn: isbn(), fromScan: "1", location: "Shelf 2", source: "purchase" }), { json: true })]);
  add("fromScan form", async () => [await post(base({ title: "Scan form", isbn: isbn(), fromScan: "1", location: "Shelf 2", source: "purchase", binding: "hardcover" }))]);
  add("addAnother form", async () => [await post(base({ title: "Another form", isbn: isbn(), addAnother: "1" }))]);
  add("fast=0 beats fromScan", async () => [await post(base({ title: "Fast zero", isbn: isbn(), fast: "0", fromScan: "1" })), await post(base({ title: "Fast zero json", isbn: isbn(), fast: "0", fromScan: "1" }), { json: true })]);
  add("new copy, publisher price only (recent)", async () => [await post(base({ title: "New recent", isbn: isbn(), condition: "new", price: "", publisherPrice: "12.90", publishedYear: String(Y) }))]);
  add("new copy, 5% off", async () => [await post(base({ title: "New five off", isbn: isbn(), condition: "new", price: "12.26", publisherPrice: "12.90", publishedYear: String(Y) }), { json: true, })]);
  add("new copy, prices around the 5% limit", async () => {
    const out = [];
    for (const price of ["11.90", "12.25", "12.26", "12.89", "12.90", "12.91"]) out.push(await post(base({ title: `New edge ${price}`, isbn: isbn(), condition: "new", price, publisherPrice: "12.90", publishedYear: String(Y) }), { json: true }));
    for (const publisherPrice of ["0", "-5", "abc", "0.004"]) out.push(await post(base({ title: `New pub ${publisherPrice}`, isbn: isbn(), condition: "new", price: "5", publisherPrice, publishedYear: String(Y) }), { json: true }));
    return out;
  });
  add("new copy, price too low", async () => {
    const f = base({ title: "New too low", isbn: isbn(), condition: "new", price: "9", publisherPrice: "12.90", publishedYear: String(Y) });
    return [await post(f), await post({ ...f, intakeToken: tok() }, { json: true })];
  });
  add("new copy, price above publisher price", async () => [await post(base({ title: "New too high", isbn: isbn(), condition: "new", price: "20", publisherPrice: "12.90", publishedYear: String(Y) }), { json: true })]);
  add("new copy, no publisher price (recent)", async () => {
    const f = base({ title: "New no pub", isbn: isbn(), condition: "new", price: "6", publishedYear: String(Y) });
    return [await post(f), await post({ ...f, intakeToken: tok() }, { json: true })];
  });
  add("old new book (2-year rule), price typed, no publisher price", async () => [await post(base({ title: "Old new", isbn: isbn(), condition: "new", price: "4", publishedYear: String(Y - 3) }))]);
  add("old new book, publisher price and no price", async () => [await post(base({ title: "Old new pub", isbn: isbn(), condition: "new", price: "", publisherPrice: "10", publishedYear: String(Y - 3) }), { json: true })]);
  add("old new book, publisher price 0", async () => [await post(base({ title: "Old new zero", isbn: isbn(), condition: "new", price: "3", publisherPrice: "0", publishedYear: String(Y - 3) }), { json: true })]);
  add("old new book, year from the existing isbn", async () => {
    const i = isbn();
    return [
      await post(base({ title: "Year known", isbn: i, publishedYear: String(Y - 5) })),
      await post(base({ title: "Year known", isbn: i, condition: "new", price: "3.50" }), { json: true }),
    ];
  });
  add("bad price", async () => {
    const f = base({ title: "Bad price", isbn: isbn(), price: "abc" });
    return [await post(f), await post({ ...f, intakeToken: tok(), price: "1.234" }, { json: true }), await post({ ...f, intakeToken: tok(), price: "-1" }, { json: true }), await post({ ...f, intakeToken: tok(), price: "20000" }, { json: true })];
  });
  add("blank price used copy", async () => [await post(base({ title: "Blank price", isbn: isbn(), price: "" }), { json: true })]);
  add("bad acquired date", async () => {
    const f = base({ title: "Bad date", isbn: isbn(), acquiredAt: "2020-13-45" });
    return [await post(f), await post({ ...f, intakeToken: tok() }, { json: true })];
  });
  add("good acquired date and cost", async () => [await post(base({ title: "Good date", isbn: isbn(), acquiredAt: "2024-03-09", acquisitionCost: "2.50", copyNotes: "  signed  " }))]);
  add("bad acquisition cost", async () => [await post(base({ title: "Bad cost", isbn: isbn(), acquisitionCost: "-3" })), await post(base({ title: "Bad cost", isbn: isbn(), acquisitionCost: "x" }), { json: true })]);
  add("bad published year", async () => [await post(base({ title: "Bad year", isbn: isbn(), publishedYear: "abc" })), await post(base({ title: "Bad year", isbn: isbn(), publishedYear: String(Y + 5) }), { json: true }), await post(base({ title: "Bad year", isbn: isbn(), publishedYear: "999" }), { json: true })]);
  add("bad condition falls back", async () => [await post(base({ title: "Bad cond", isbn: isbn(), condition: "weird" }), { json: true }), await post(base({ title: "No cond", isbn: isbn(), condition: undefined }), { json: true })]);
  add("location variants", async () => {
    const out = [];
    for (const location of ["  Back   room\t", "", "x".repeat(200), "Line\nbreak\u0001ctl", "STORE", "store", undefined]) {
      out.push(await post(base({ title: `Loc ${out.length}`, isbn: isbn(), location }), { json: true }));
    }
    return out;
  });
  add("source variants", async () => {
    const out = [];
    for (const source of ["lot", "other", "bogus", "", undefined]) out.push(await post(base({ title: `Src ${out.length}`, isbn: isbn(), source }), { json: true }));
    return out;
  });
  add("status variants", async () => {
    const out = [];
    for (const status of ["sold", "reserved", "damaged", "nonsense", undefined]) out.push(await post(base({ title: `Stat ${out.length}`, isbn: isbn(), status }), { json: true }));
    return out;
  });
  add("duplicate token, JSON", async () => {
    const f = base({ title: "Dup json", isbn: isbn(), fast: "1" });
    return [await post(f, { json: true }), await post(f, { json: true })];
  });
  add("duplicate token, form", async () => {
    const f = base({ title: "Dup form", isbn: isbn() });
    return [await post(f), await post(f), await post({ ...f, fast: "1", location: "Elsewhere", condition: "good", binding: "hardcover" })];
  });
  add("duplicate token, different title", async () => {
    const t = tok();
    return [await post(base({ title: "Dup first", isbn: isbn(), intakeToken: t, fast: "1" }), { json: true }), await post(base({ title: "Dup second", isbn: isbn(), intakeToken: t, fast: "1" }), { json: true })];
  });
  add("missing and malformed token", async () => [
    await post(base({ title: "No token", isbn: isbn(), intakeToken: undefined }), { json: true }),
    await post(base({ title: "Short token", isbn: isbn(), intakeToken: "short" }), { json: true }),
    await post(base({ title: "Bad chars", isbn: isbn(), intakeToken: "bad token with spaces!!" })),
  ]);
  add("isbn existing then new, binding fill", async () => {
    const i = isbn();
    return [
      await post(base({ title: "Existing", isbn: i, binding: "", description: "", coverUrl: "" }), { json: true }),
      await post(base({ title: "Existing again", isbn: i, binding: "hardcover", price: "6" }), { json: true }),
      await post(base({ title: "Existing thrice", isbn: i, binding: "mass_market", price: "7" }), { json: true }),
    ];
  });
  add("isbn formats", async () => {
    const i13 = isbn();
    const i10 = isbn10From("014312755");
    return [
      await post(base({ title: "Isbn hyphens", isbn: `${i13.slice(0, 3)}-${i13.slice(3)}` }), { json: true }),
      await post(base({ title: "Isbn ten", isbn: i10 }), { json: true }),
      await post(base({ title: "Isbn ten again", isbn: i10 }), { json: true }),
      await post(base({ title: "Isbn junk", isbn: "not-an-isbn" }), { json: true }),
    ];
  });
  add("cover photo upload", async () => [await post(base({ title: "Photo", isbn: isbn(), coverUrl: "" }), { photo: { buffer: png }, json: true }), await post(base({ title: "Photo form", isbn: isbn(), coverUrl: "" }), { photo: { buffer: png } })]);
  add("cover photo that is not an image releases the token", async () => {
    const f = base({ title: "Bad photo", isbn: isbn(), coverUrl: "" });
    const bad = await post(f, { photo: { buffer: Buffer.from("not an image at all") } });
    const retry = await post(f, { json: true });
    return [bad, retry];
  });
  add("cover address variants", async () => [
    await post(base({ title: "Cover ol", isbn: isbn(), coverUrl: "https://covers.openlibrary.org/b/id/1-L.jpg" }), { json: true }),
    await post(base({ title: "Cover bad", isbn: isbn(), coverUrl: "http://127.0.0.1/x.jpg" }), { json: true }),
    await post(base({ title: "Cover none", isbn: isbn(), coverUrl: "" }), { json: true }),
  ]);
  add("missing title", async () => [
    await post(base({ title: "", isbn: isbn(), publishedYear: "1999", price: "x", publisherPrice: "9" })),
    await post(base({ title: "   ", isbn: isbn() }), { json: true }),
    await post(base({ title: undefined, isbn: undefined, genre: "Fiction, Mystery", condition: "new", binding: "hardcover", fromScan: "1", priceLevel: "3" })),
  ]);
  add("genres and french genres", async () => [
    await post(base({ title: "Genres", isbn: isbn(), genre: "Fiction, Mystery" }), { json: true }),
    await post(base({ title: "Genres fr", isbn: isbn(), genre: "Fiction" }), { json: true }),
    await post(base({ title: "Genres none", isbn: isbn(), genre: "" }), { json: true }),
  ]);
  add("learning loop fields and price levels", async () => [
    await post(base({ title: "Learn kept", isbn: isbn(), price: "4", suggestedPrice: "4", suggestedLevel: "4" }), { json: true }),
    await post(base({ title: "Learn adjusted", isbn: isbn(), price: "6", suggestedPrice: "4", suggestedLevel: "4" }), { json: true }),
    await post(base({ title: "Learn review", isbn: isbn(), price: "", suggestedLevel: "review" }), { json: true }),
    await post(base({ title: "Learn clearance", isbn: isbn(), price: "1", suggestedPrice: "1", suggestedLevel: "clearance" }), { json: true }),
    await post(base({ title: "Level custom", isbn: isbn(), priceLevel: "custom", price: "8.5" }), { json: true }),
    await post(base({ title: "Level standard", isbn: isbn(), priceLevel: "3", price: "99" }), { json: true }),
    await post(base({ title: "Level clearance", isbn: isbn(), priceLevel: "clearance", price: "99" }), { json: true }),
    await post(base({ title: "Level unknown", isbn: isbn(), priceLevel: "7777", price: "9" }), { json: true }),
  ]);
  add("clearance reprices the other copies (scope all)", async () => {
    const i = isbn();
    return [
      await post(base({ title: "Clear base", isbn: i, price: "5" }), { json: true }),
      await post(base({ title: "Clear base", isbn: i, price: "6" }), { json: true }),
      await post(base({ title: "Clear base", isbn: i, priceLevel: "clearance", repriceOthers: "1" }), { json: true }),
      await post(base({ title: "Clear base", isbn: i, priceLevel: "clearance" }), { json: true }),
    ];
  });
  add("customer request matched", async () => {
    const i = isbn();
    await pool.query("INSERT INTO book_requests (title, isbn, email, name, status, manage_token_hash, expires_at) VALUES ('Wanted golden', $1, 'wanter@example.test', 'W', 'open', 'golden-hash-1', now() + interval '12 months')", [i]);
    return [await post(base({ title: "Wanted golden", isbn: i, fast: "1" }), { json: true }), await post(base({ title: "Wanted golden", isbn: i }))];
  });
  add("customer requests matched: redirect carries the count", async () => {
    const a = isbn();
    const b = isbn();
    for (const [i, n] of [[a, "A"], [b, "B"]]) await pool.query("INSERT INTO book_requests (title, isbn, email, name, status, manage_token_hash, expires_at) VALUES ($1, $2, $3, 'W', 'open', $4, now() + interval '12 months')", [`Wanted ${n}`, i, `wanter-${n}@example.test`, `golden-hash-${n}`]);
    await pool.query("INSERT INTO book_requests (title, isbn, email, name, status, manage_token_hash, expires_at) VALUES ('Wanted A2', $1, 'wanter-a2@example.test', 'W', 'open', 'golden-hash-a2', now() + interval '12 months')", [a]);
    return [await post(base({ title: "Wanted A", isbn: a })), await post(base({ title: "Wanted B", isbn: b, fromScan: "1" }))];
  });
  add("token busy", async () => {
    await pool.query("INSERT INTO copy_intake_tokens (token) VALUES ('golden-busy-token-abcdefghij'), ('golden-busy-token-bbcdefghij')");
    const [a, b] = await Promise.all([
      post(base({ title: "Busy json", isbn: isbn(), intakeToken: "golden-busy-token-abcdefghij" }), { json: true }),
      post(base({ title: "Busy form", isbn: isbn(), intakeToken: "golden-busy-token-bbcdefghij", condition: "new", publisherPrice: "9.9", publishedYear: String(Y) })),
    ]);
    return [a, b];
  });

  // ---- the sibling handlers: edit a copy, delete, cancel a reservation ----
  const state = async (ids) => ({ copy: await row(ids.copyId) });
  const withState = async (r, ids) => { r.extra = await state(ids); return r; };
  add("edit copy: price, location, source, notes", async () => {
    const ids = await mk({ title: "Edit one", location: "Store", source: "donation" });
    const r = await edit(ids, { condition: "good", price: "6.5", acquisitionCost: "1", acquiredAt: "2024-05-05", notes: "  scuffed ", location: " Back  room ", source: "purchase", status: "in_stock", renderedStatus: "in_stock" });
    const same = await edit(ids, { condition: "good", price: "6.5", location: "back room", source: "bogus", status: "in_stock", renderedStatus: "in_stock" });
    return [await withState(r, ids), await withState(same, ids)];
  });
  add("edit copy: refused values", async () => {
    const ids = await mk({ title: "Edit refuse" });
    const f = { condition: "good", price: "6", location: "Shelf", source: "donation", status: "in_stock", renderedStatus: "in_stock" };
    return [
      await withState(await edit(ids, { ...f, price: "abc" }), ids),
      await withState(await edit(ids, { ...f, acquisitionCost: "-1" }), ids),
      await withState(await edit(ids, { ...f, acquiredAt: "2020-02-31" }), ids),
      await withState(await edit(ids, { ...f, condition: "new" }), ids),
      await withState(await edit(ids, { ...f, condition: "new", publisherPrice: "10", price: "5", status: "sold", renderedStatus: "in_stock" }), ids),
    ];
  });
  add("edit copy: new condition with publisher price and the 2-year rule", async () => {
    const recent = await mk({ title: "Edit new recent", publishedYear: String(Y) });
    const old = await mk({ title: "Edit new old", publishedYear: String(Y - 4) });
    return [
      await withState(await edit(recent, { condition: "new", price: "", publisherPrice: "11", location: "Store", source: "lot", status: "in_stock", renderedStatus: "in_stock" }), recent),
      await withState(await edit(old, { condition: "new", price: "3", publisherPrice: "", location: "Store", source: "lot", status: "in_stock", renderedStatus: "in_stock" }), old),
    ];
  });
  add("edit copy: status changes", async () => {
    const ids = await mk({ title: "Edit status" });
    const f = { condition: "good", price: "6", location: "Store", source: "donation" };
    const out = [];
    out.push(await withState(await edit(ids, { ...f, status: "reserved", renderedStatus: "in_stock" }), ids));
    out.push(await withState(await edit(ids, { ...f, status: "in_stock", renderedStatus: "reserved" }), ids));
    out.push(await withState(await edit(ids, { ...f, status: "damaged", renderedStatus: "reserved" }), ids));
    out.push(await withState(await edit(ids, { ...f, status: "donated", renderedStatus: "in_stock" }), ids));
    out.push(await withState(await edit(ids, { ...f, status: "nonsense", renderedStatus: "damaged" }), ids));
    out.push(await withState(await edit(ids, { ...f }), ids));
    return out;
  });
  add("edit copy: sold and reserved-by-order copies keep their status", async () => {
    const sold = await mk({ title: "Edit sold", status: "sold" });
    const { copyIds } = await makeOrder(pool, { status: "reserved" });
    const held = { bookId: (await pool.query("SELECT book_id FROM book_copies WHERE id = $1", [copyIds[0]])).rows[0].book_id, copyId: copyIds[0] };
    const f = { condition: "good", price: "7", location: "Shelf", source: "donation" };
    return [
      await withState(await edit(sold, { ...f, status: "in_stock", renderedStatus: "sold" }), sold),
      await withState(await edit(held, { ...f, status: "in_stock", renderedStatus: "reserved" }), held),
    ];
  });
  add("edit copy: clearance and learning fields", async () => {
    const ids = await mk({ title: "Edit clear", price: "5" });
    const f = { condition: "good", location: "Store", source: "donation", status: "in_stock", renderedStatus: "in_stock" };
    return [
      await withState(await edit(ids, { ...f, priceLevel: "clearance", suggestedPrice: "1", suggestedLevel: "clearance" }), ids),
      await withState(await edit(ids, { ...f, price: "1", notes: "same price" }), ids),
      await withState(await edit(ids, { ...f, priceLevel: "custom", price: "9" }), ids),
      await withState(await edit(ids, { ...f, priceLevel: "3", suggestedPrice: "4", suggestedLevel: "4" }), ids),
    ];
  });
  add("edit copy: missing copy or wrong book", async () => {
    const a = await mk({ title: "Edit wrong a" });
    const b = await mk({ title: "Edit wrong b" });
    const f = { condition: "good", price: "6", location: "Elsewhere", source: "donation", status: "damaged", renderedStatus: "in_stock" };
    return [
      await withState(await post(f, { path: `/admin/inventory/${a.bookId}/copies/${b.copyId}`, followBook: true }), b),
      await post(f, { path: `/admin/inventory/${a.bookId}/copies/999999`, followBook: true }),
    ];
  });
  add("delete a copy, the last copy, a reserved copy", async () => {
    const i = isbn();
    const a = await mk({ title: "Del two", isbn: i });
    const b = await mk({ title: "Del two", isbn: i });
    const out = [await post({}, { path: `/admin/inventory/${a.bookId}/copies/${a.copyId}/delete` })];
    out.push(await post({}, { path: `/admin/inventory/${b.bookId}/copies/${b.copyId}/delete` }));
    const { copyIds } = await makeOrder(pool, { status: "reserved" });
    const bk = (await pool.query("SELECT book_id FROM book_copies WHERE id = $1", [copyIds[0]])).rows[0].book_id;
    out.push(await post({}, { path: `/admin/inventory/${bk}/copies/${copyIds[0]}/delete`, followBook: true }));
    out.push(await post({}, { path: `/admin/inventory/${bk}/copies/424242/delete` }));
    return out;
  });
  add("delete a book", async () => {
    const i = isbn();
    const a = await mk({ title: "Del book", isbn: i });
    await mk({ title: "Del book", isbn: i });
    const { copyIds } = await makeOrder(pool, { status: "reserved" });
    const bk = (await pool.query("SELECT book_id FROM book_copies WHERE id = $1", [copyIds[0]])).rows[0].book_id;
    return [
      await post({}, { path: `/admin/inventory/${bk}/delete`, followBook: true }),
      await post({}, { path: `/admin/inventory/${a.bookId}/delete` }),
      await post({}, { path: `/admin/inventory/${a.bookId}/delete` }),
    ];
  });
  add("cancel a reservation", async () => {
    const held = await mk({ title: "Cancel res", status: "reserved" });
    await pool.query("UPDATE book_copies SET reserved_by_name = 'Pat', reserved_by_email = 'pat@example.test', reserved_at = now() WHERE id = $1", [held.copyId]);
    const fresh = await mk({ title: "Cancel none" });
    const { copyIds } = await makeOrder(pool, { status: "reserved" });
    const bk = (await pool.query("SELECT book_id FROM book_copies WHERE id = $1", [copyIds[0]])).rows[0].book_id;
    const path = (b, c) => `/admin/inventory/${b}/copies/${c}/cancel-reservation`;
    const r1 = await withState(await post({}, { path: path(held.bookId, held.copyId), followBook: true }), held);
    const r2 = await withState(await post({}, { path: path(held.bookId, held.copyId), followBook: true }), held);
    const r3 = await withState(await post({}, { path: path(fresh.bookId, fresh.copyId), followBook: true }), fresh);
    const r4 = await post({}, { path: path(bk, copyIds[0]), followBook: true });
    r4.extra = { order: (await pool.query("SELECT status FROM book_copies WHERE id = $1", [copyIds[0]])).rows[0] };
    const r5 = await post({}, { path: path(bk, 987654), followBook: true });
    return [r1, r2, r3, r4, r5];
  });

  // ---- run ----
  const norm = (s) => s;
  const out = { cases: {} };
  const idMaps = { book: new Map(), copy: new Map() };
  const rankIds = async () => {
    idMaps.book = new Map((await pool.query("SELECT id FROM books ORDER BY id")).rows.map((r, n) => [r.id, `B${n + 1}`]));
    idMaps.copy = new Map((await pool.query("SELECT id FROM book_copies ORDER BY id")).rows.map((r, n) => [r.id, `C${n + 1}`]));
  };
  const scrub = (text) => String(text)
    .replace(/intakeToken" value="[^"]*"/g, 'intakeToken" value="<token>"')
    .replace(/name="intakeToken" value="[^"]*"/g, 'name="intakeToken" value="<token>"')
    .replace(/\/img\/[0-9a-f]{16,}\.jpg/g, "/img/<hash>.jpg")
    .replace(/\?v=[0-9a-z]+/g, "?v=<v>");
  const idsIn = (s) => String(s)
    .replace(/\/admin\/inventory\/(\d+)/g, (m, n) => `/admin/inventory/${idMaps.book.get(Number(n)) || `?${n}`}`)
    .replace(/copyId=(\d+)/g, (m, n) => `copyId=${idMaps.copy.get(Number(n)) || `?${n}`}`);
  const shape = (r) => {
    let body = r.text;
    if (r.type && r.type.includes("json")) {
      const j = JSON.parse(r.text);
      if (j.copyId != null) j.copyId = idMaps.copy.get(j.copyId) || `?${j.copyId}`;
      if (j.bookId != null) j.bookId = idMaps.book.get(j.bookId) || `?${j.bookId}`;
      body = j;
    } else body = scrub(body);
    return { status: r.status, type: r.type, location: r.location ? idsIn(r.location) : null, body, follow: r.follow ? (r.follow.page ? { status: r.follow.status, page: r.follow.page } : { status: r.follow.status, text: scrub(r.follow.text) }) : null, extra: r.extra || null };
  };
  // Only what the cases log: rows written by the migrations (e.g. migration 107's Admin activity line) are not a case's.
  let auditSeen = (await pool.query("SELECT COALESCE(max(id), 0)::int AS id FROM admin_audit_log")).rows[0].id;
  for (const [name, fn] of cases) {
    const responses = await fn();
    await settled();
    await rankIds();
    const audit = (await pool.query("SELECT id, actor_label, action, target_type, target_id, detail FROM admin_audit_log WHERE id > $1 ORDER BY id", [auditSeen])).rows;
    if (audit.length) auditSeen = audit[audit.length - 1].id;
    out.cases[name] = {
      responses: responses.map(shape),
      audit: audit.map((a) => ({ actor: a.actor_label, action: a.action, type: a.target_type, target: a.target_type === "book_copy" ? idMaps.copy.get(a.target_id) : a.target_id, detail: a.detail })),
    };
  }
  const books = (await pool.query("SELECT * FROM books ORDER BY id")).rows;
  const copies = (await pool.query("SELECT * FROM book_copies ORDER BY id")).rows;
  const drop = new Set(["id", "created_at", "updated_at", "title_sort", "search_vector", "acquired_at_ts"]);
  const clean = (row, extra = {}) => {
    const o = {};
    for (const [k, v] of Object.entries(row)) {
      if (drop.has(k)) continue;
      o[k] = v instanceof Date ? "<date>" : v;
    }
    for (const [k, v] of Object.entries(extra)) o[k] = v;
    for (const k of Object.keys(o)) if (typeof o[k] === "string") o[k] = o[k].replace(/fx-\d+-(\d+)@/, "fx-<ts>-$1@");
    if (typeof o.cover_url === "string") o.cover_url = o.cover_url.replace(/\/img\/[0-9a-f]{16,}\.jpg/, "/img/<hash>.jpg");
    if (typeof o.published_year === "number" && Math.abs(o.published_year - Y) < 20) o.published_year = `Y${o.published_year - Y >= 0 ? "+" : ""}${o.published_year - Y}`;
    return o;
  };
  out.books = books.map((b, n) => clean(b, { _id: `B${n + 1}` }));
  out.copies = copies.map((c) => clean(c, { _id: idMaps.copy.get(c.id), book_id: idMaps.book.get(c.book_id), acquired_at: c.acquired_at instanceof Date ? c.acquired_at.toISOString().slice(0, 10) : c.acquired_at }));
  out.tokens = (await pool.query("SELECT token, copy_id, book_id, requests FROM copy_intake_tokens ORDER BY token")).rows.map((t) => ({ token: t.token, copy: t.copy_id ? idMaps.copy.get(t.copy_id) : null, book: t.book_id ? idMaps.book.get(t.book_id) : null, requests: t.requests }));
  out.requests = (await pool.query("SELECT title, status, matched_copy_id FROM book_requests ORDER BY id")).rows.map((r) => ({ title: r.title, status: r.status, copy: r.matched_copy_id ? idMaps.copy.get(r.matched_copy_id) : null }));
  void norm;
  // The refused-year message names next year: keep the fixture valid after New Year.
  return JSON.parse(JSON.stringify(out).replaceAll(`between 1000 and ${Y + 1}`, "between 1000 and <next year>"));
}

// Boots the route module on a throwaway database (own database locally, a private copy of the CI server's in CI).
async function boot(label = "intake_golden") {
  const db = prepareDatabase(label, { isolated: true });
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
    if (u.startsWith("https://openlibrary.org/")) return new Response(JSON.stringify({ docs: [] }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`golden run refused a real outbound request to ${u}`);
  };
  db.create();
  const { pool } = require("../../src/db");
  const coverStore = require("../../src/lib/coverStore");
  coverStore.setLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  const { requireAdmin } = require("../../src/middleware/auth");
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  const gate = express.Router();
  gate.use("/admin/inventory", requireAdmin, upload.fields([{ name: "photo", maxCount: 1 }, { name: "coverPhoto", maxCount: 1 }]));
  const server = await listen(buildApp([gate, require("../../src/routes/admin/inventoryLookup"), require("../../src/routes/admin/inventory")]));
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ('golden-admin@example.test', 'x', 'Golden Admin', true) RETURNING id");
  await pool.query("UPDATE pricing_settings SET clearance_scope = 'all' WHERE id = 1");
  return {
    pool, server, adminId: rows[0].id, realFetch,
    async close() { global.fetch = realFetch; await server.close(); await pool.end(); db.drop(); },
  };
}

module.exports = { runMatrix, boot };
