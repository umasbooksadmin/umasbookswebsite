// The Cover card of a book's admin page: replace, rotate, crop and remove a cover (src/lib/coverEdit.js,
// src/routes/admin/inventoryCover.js). Real app, real database, real sharp on generated pictures: a 300 x 200 test image
// with four colour quadrants, so a turn or a cut can be checked by reading pixels back.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const sharp = require("sharp");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 7850;
const PASSWORD = "Cover-Edit-Pass1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const RED = [220, 30, 30], GREEN = [30, 190, 30], BLUE = [30, 30, 220], YELLOW = [235, 220, 30];
// top-left, top-right, bottom-left, bottom-right of the original picture
const QUADRANTS = [RED, GREEN, BLUE, YELLOW];

let app, pool, imageStore, imageCleanup;
const tag = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  imageStore = require("../../src/lib/imageStore");
  imageCleanup = require("../../src/lib/imageCleanup");
  // The server runs its own image cleanup at boot: let it finish before any test adds an old image.
  await app.waitForLog(/Image cleanup/);
});
after(async () => {
  await pool.end();
  await app.stop();
});

// ---- helpers ---------------------------------------------------------------------------------------------------------

async function quadrantPicture(width = 300, height = 200, format = "jpeg", extra = {}) {
  const hw = width / 2, hh = height / 2;
  const block = (rgb, left, top) => ({ input: { create: { width: hw, height: hh, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }, left, top });
  let img = sharp({ create: { width, height, channels: 3, background: "#fff" } }).composite([block(RED, 0, 0), block(GREEN, hw, 0), block(BLUE, 0, hh), block(YELLOW, hw, hh)]);
  // One odd pixel in the corner makes every book's picture its own image (the store is keyed by the bytes), without moving a quadrant colour.
  if (extra.unique) img = sharp(await img.png().toBuffer()).composite([{ input: { create: { width: 2, height: 2, channels: 3, background: { r: Math.floor(Math.random() * 256), g: Math.floor(Math.random() * 256), b: Math.floor(Math.random() * 256) } } }, left: 0, top: 0 }]);
  if (extra.orientation) img = img.withMetadata({ orientation: extra.orientation });
  return format === "png" ? img.png().toBuffer() : format === "webp" ? img.webp({ quality: 95 }).toBuffer() : img.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
}

async function user(flags = {}) {
  const email = `cover-${tag()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_till, email_verified_at)
     VALUES ($1, $2, 'Cover Tester', $3, $4, $5, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), !!flags.admin, !!flags.member, !!flags.till]
  );
  return { id: rows[0].id, email };
}

async function login(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString() });
  jar.capture(res);
  assert.equal(res.status, 302, "test login");
  return jar;
}

async function adminJar() {
  const u = await user({ admin: true });
  const jar = await login(u.email);
  return { u, jar };
}

async function post(jar, path, fields = {}, { json = false, csrf = true, token = null } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of [].concat(v)) body.append(k, typeof item === "string" ? item : String(item));
  if (csrf) body.set("_csrf", token || await fetchCsrfToken(app.base, jar));
  const res = await fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header(), ...(json ? { accept: "application/json" } : {}) }, body: body.toString() });
  jar.capture(res);
  const text = await res.text();
  return { res, status: res.status, location: res.headers.get("location"), text, json: json ? JSON.parse(text) : null };
}

async function upload(jar, path, file, { json = false, csrf = true } = {}) {
  const form = new FormData();
  if (csrf) form.append("_csrf", await fetchCsrfToken(app.base, jar));
  if (file) form.append("coverPhoto", new Blob([file.buffer], { type: file.type || "image/jpeg" }), file.name || "cover.jpg");
  const res = await fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { cookie: jar.header(), ...(json ? { accept: "application/json" } : {}) }, body: form });
  jar.capture(res);
  const text = await res.text();
  return { res, status: res.status, location: res.headers.get("location"), text, json: json ? JSON.parse(text) : null };
}

async function get(jar, path) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar ? jar.header() : "" } });
  return { res, status: res.status, text: await res.text() };
}

async function storeCover(buffer) {
  return imageStore.saveImage(buffer, "image/jpeg", pool);
}

async function makeBook(cover, title = `Cover Book ${tag()}`) {
  const { rows } = await pool.query("INSERT INTO books (title, authors, cover_url) VALUES ($1, 'Cover Author', $2) RETURNING id", [title, cover]);
  await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5)", [rows[0].id]);
  return rows[0].id;
}
const coverOf = async (id) => (await pool.query("SELECT cover_url, cover_source_url, cover_removed_at FROM books WHERE id = $1", [id])).rows[0];
const imageCount = async () => (await pool.query("SELECT count(*)::int AS n FROM images")).rows[0].n;

async function bytesOf(url) {
  const id = /\/img\/([0-9a-f]{64})\./.exec(url)[1];
  return (await imageStore.getImage(id, pool)).data;
}
// The colour at a fractional position of a stored picture.
async function pixelAt(url, fx, fy) {
  const { data, info } = await sharp(await bytesOf(url)).raw().toBuffer({ resolveWithObject: true });
  const x = Math.min(info.width - 1, Math.floor(fx * info.width)), y = Math.min(info.height - 1, Math.floor(fy * info.height));
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
const near = (actual, expected, tol = 14) => actual.every((c, i) => Math.abs(c - expected[i]) <= tol);
function assertColour(actual, expected, where) {
  assert.ok(near(actual, expected), `${where}: got rgb(${actual.join(",")}), wanted about rgb(${expected.join(",")})`);
}
const dims = async (url) => { const m = await sharp(await bytesOf(url)).metadata(); return [m.width, m.height]; };
async function auditRows(action, bookId) {
  for (let i = 0; i < 20; i++) {
    const { rows } = await pool.query("SELECT * FROM admin_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id", [action, bookId]);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

async function freshBook(format = "jpeg") {
  const url = await storeCover(await quadrantPicture(300, 200, format === "png" ? "jpeg" : format, { unique: true }));
  return { id: await makeBook(url), url };
}

// ---- rotate ----------------------------------------------------------------------------------------------------------

test("rotate right turns the picture a quarter clockwise: 300 x 200 becomes 200 x 300 and the colours move round", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  const r = await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "right" });
  assert.equal(r.status, 303);
  assert.equal(r.location, `/admin/inventory/${id}?cover=rotated#cover`);
  const after = (await coverOf(id)).cover_url;
  assert.notEqual(after, url, "an edit makes a NEW image (new content-addressed address)");
  assert.match(after, /^\/img\/[0-9a-f]{64}\.jpg$/);
  assert.deepEqual(await dims(after), [200, 300]);
  // clockwise: top-left <- bottom-left, top-right <- top-left, bottom-left <- bottom-right, bottom-right <- top-right
  assertColour(await pixelAt(after, 0.25, 0.25), BLUE, "new top-left");
  assertColour(await pixelAt(after, 0.75, 0.25), RED, "new top-right");
  assertColour(await pixelAt(after, 0.25, 0.75), YELLOW, "new bottom-left");
  assertColour(await pixelAt(after, 0.75, 0.75), GREEN, "new bottom-right");
});

test("rotate left turns it a quarter the other way", async () => {
  const { jar } = await adminJar();
  const { id } = await freshBook();
  await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "left" });
  const after = (await coverOf(id)).cover_url;
  assert.deepEqual(await dims(after), [200, 300]);
  assertColour(await pixelAt(after, 0.25, 0.25), GREEN, "new top-left");
  assertColour(await pixelAt(after, 0.75, 0.25), YELLOW, "new top-right");
  assertColour(await pixelAt(after, 0.25, 0.75), RED, "new bottom-left");
  assertColour(await pixelAt(after, 0.75, 0.75), BLUE, "new bottom-right");
});

test("four turns bring the original back: same size, same colours (within JPEG tolerance), also with a double press", async () => {
  const { jar } = await adminJar();
  const { id } = await freshBook();
  for (let i = 0; i < 4; i++) {
    const r = await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "right" }, { json: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  }
  const after = (await coverOf(id)).cover_url;
  assert.deepEqual(await dims(after), [300, 200]);
  for (const [i, [fx, fy]] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].entries()) assertColour(await pixelAt(after, fx, fy), QUADRANTS[i], `quadrant ${i}`);
  // a PNG picture of the same drawing: also a plain pixel comparison of the whole thing against the original
  const original = await sharp(await quadrantPicture()).raw().toBuffer();
  const back = await sharp(await bytesOf(after)).raw().toBuffer();
  assert.equal(back.length, original.length);
  let far = 0;
  for (let i = 0; i < back.length; i += 97) if (Math.abs(back[i] - original[i]) > 30) far++;
  assert.ok(far < back.length / 97 * 0.03, `${far} sampled pixels differ strongly after four turns`);
});

test("two quick presses are two turns (no lost update, no error)", async () => {
  const { jar } = await adminJar();
  const { id } = await freshBook();
  const token = await fetchCsrfToken(app.base, jar);
  const results = await Promise.all([1, 2].map(() => post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "right" }, { json: true, token })));
  for (const r of results) assert.ok([200, 409].includes(r.status), `status ${r.status}`);
  const turned = results.filter((r) => r.status === 200).length;
  assert.ok(turned >= 1);
  const after = (await coverOf(id)).cover_url;
  assert.deepEqual(await dims(after), turned % 2 ? [200, 300] : [300, 200]);
});

test("rotate refuses a missing or odd direction and changes nothing", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  const before = await imageCount();
  for (const direction of [undefined, "", "up", "180", "LEFT", "left;right", "left right"]) {
    const r = await post(jar, `/admin/inventory/${id}/cover/rotate`, direction === undefined ? {} : { direction }, { json: true });
    assert.equal(r.status, 400, `direction ${JSON.stringify(direction)}`);
    assert.equal(r.json.code, "bad-direction");
    assert.match(r.json.message, /Rotate left or Rotate right/);
  }
  assert.equal((await coverOf(id)).cover_url, url);
  assert.equal(await imageCount(), before);
});

// ---- crop ------------------------------------------------------------------------------------------------------------

test("crop gives the expected size and the expected part of the picture", async () => {
  const { jar } = await adminJar();
  // the top-right quadrant: all green, 150 x 100
  let { id } = await freshBook();
  let r = await post(jar, `/admin/inventory/${id}/cover/crop`, { x: "0.5", y: "0", w: "0.5", h: "0.5" });
  assert.equal(r.location, `/admin/inventory/${id}?cover=cropped#cover`);
  let after = (await coverOf(id)).cover_url;
  assert.deepEqual(await dims(after), [150, 100]);
  for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9]]) assertColour(await pixelAt(after, fx, fy), GREEN, `green quadrant at ${fx},${fy}`);
  // the middle half: four colours meeting in the centre, 150 x 100
  ({ id } = await freshBook());
  await post(jar, `/admin/inventory/${id}/cover/crop`, { x: "0.25", y: "0.25", w: "0.5", h: "0.5" });
  after = (await coverOf(id)).cover_url;
  assert.deepEqual(await dims(after), [150, 100]);
  assertColour(await pixelAt(after, 0.1, 0.1), RED, "top-left of the middle");
  assertColour(await pixelAt(after, 0.9, 0.1), GREEN, "top-right of the middle");
  assertColour(await pixelAt(after, 0.1, 0.9), BLUE, "bottom-left of the middle");
  assertColour(await pixelAt(after, 0.9, 0.9), YELLOW, "bottom-right of the middle");
});

test("crop works on the picture as it is NOW (after a rotation) and is not enlarged", async () => {
  const { jar } = await adminJar();
  const { id } = await freshBook();
  await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "right" }); // now 200 x 300: blue/red over yellow/green
  await post(jar, `/admin/inventory/${id}/cover/crop`, { x: "0", y: "0", w: "1", h: "0.5" }); // the top half: 200 x 150
  const after = (await coverOf(id)).cover_url;
  assert.deepEqual(await dims(after), [200, 150]);
  assertColour(await pixelAt(after, 0.25, 0.5), BLUE, "left of the top half");
  assertColour(await pixelAt(after, 0.75, 0.5), RED, "right of the top half");
});

test("a box that covers the whole picture changes nothing, and a hair past the edge is pulled back to it", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  const whole = await post(jar, `/admin/inventory/${id}/cover/crop`, { x: "0", y: "0", w: "1", h: "1" }, { json: true });
  assert.equal(whole.status, 200);
  assert.equal(whole.json.code, "no-change");
  assert.equal((await coverOf(id)).cover_url, url);
  const edge = await post(jar, `/admin/inventory/${id}/cover/crop`, { x: "0.500000", y: "0.000000", w: "0.500400", h: "0.500000" }, { json: true });
  assert.equal(edge.status, 200);
  assert.deepEqual(await dims((await coverOf(id)).cover_url), [150, 100]);
});

test("invalid crop values are a friendly 400 and change nothing", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  const before = await imageCount();
  const ok = { x: "0.1", y: "0.1", w: "0.5", h: "0.5" };
  const bad = [
    { ...ok, x: "-0.1" }, { ...ok, y: "-1" }, { ...ok, w: "1.5" }, { ...ok, h: "2" }, { ...ok, x: "1.1" },
    { ...ok, w: "0" }, { ...ok, h: "0" }, { ...ok, w: "0.01" }, { ...ok, h: "0.04" },
    { ...ok, x: "NaN" }, { ...ok, w: "Infinity" }, { ...ok, y: "abc" }, { ...ok, h: "" }, { ...ok, x: "1e-1" }, { ...ok, w: "0x10" }, { ...ok, x: " " },
    { x: "0.7", y: "0.1", w: "0.5", h: "0.5" }, { x: "0.1", y: "0.8", w: "0.5", h: "0.5" },
    { x: "0.1", y: "0.1", w: "0.5" }, {},
  ];
  for (const fields of bad) {
    const r = await post(jar, `/admin/inventory/${id}/cover/crop`, fields, { json: true });
    assert.equal(r.status, 400, JSON.stringify(fields));
    assert.ok(["bad-crop", "crop-small"].includes(r.json.code), JSON.stringify(fields));
    assert.match(r.json.message, /nothing was changed/i);
    assert.doesNotMatch(r.text, /Error:|at \w+ \(/, "no stack trace");
  }
  // the page form gets the same sentence under the Cover card
  const form = await post(jar, `/admin/inventory/${id}/cover/crop`, { ...ok, x: "-1" });
  assert.equal(form.status, 303);
  assert.equal(form.location, `/admin/inventory/${id}?cover=bad-crop#cover`);
  const page = await get(jar, form.location.replace("#cover", ""));
  assert.equal(page.status, 200);
  assert.match(page.text, /Those crop values are not valid/);
  assert.equal((await coverOf(id)).cover_url, url);
  assert.equal(await imageCount(), before);
});

// ---- replace ---------------------------------------------------------------------------------------------------------

test("replace: a JPEG, a PNG and a WebP photo become the cover, as a standard JPEG without metadata", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  for (const [format, type, name] of [["jpeg", "image/jpeg", "a.jpg"], ["png", "image/png", "a.png"], ["webp", "image/webp", "a.webp"]]) {
    const before = (await coverOf(id)).cover_url;
    const r = await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: await quadrantPicture(1200, 1600, format), type, name }, { json: true });
    assert.equal(r.status, 200, format);
    assert.equal(r.json.code, "replaced");
    const now = (await coverOf(id)).cover_url;
    assert.notEqual(now, before);
    assert.equal(now, r.json.coverUrl);
    const meta = await sharp(await bytesOf(now)).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(meta.width <= 900 && meta.height <= 900, `${meta.width}x${meta.height} is within the cover size`);
    assert.equal(Math.round((meta.width / meta.height) * 100), 75, "same proportions, no crop, no stretch");
    assert.equal(meta.exif, undefined, "metadata is dropped");
  }
  assert.notEqual((await coverOf(id)).cover_url, url);
  const rows = await auditRows("cover.replace", id);
  assert.equal(rows.length, 3);
});

test("replace: a phone photo with EXIF orientation 6 is stood upright", async () => {
  const { jar } = await adminJar();
  const { id } = await freshBook();
  const phone = await quadrantPicture(300, 200, "jpeg", { orientation: 6 }); // pixels 300 x 200, "rotate 90 clockwise to view"
  assert.equal((await sharp(phone).metadata()).orientation, 6);
  const r = await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: phone, type: "image/jpeg" }, { json: true });
  assert.equal(r.status, 200);
  const now = (await coverOf(id)).cover_url;
  assert.deepEqual(await dims(now), [200, 300]);
  assert.equal((await sharp(await bytesOf(now)).metadata()).orientation, undefined);
  assertColour(await pixelAt(now, 0.25, 0.25), BLUE, "upright top-left"); // orientation 6 = turn clockwise
  assertColour(await pixelAt(now, 0.75, 0.25), RED, "upright top-right");
});

test("replace works on a book with no cover, and the book then has one", async () => {
  const { jar } = await adminJar();
  const id = await makeBook(null);
  const r = await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: await quadrantPicture(), type: "image/jpeg" });
  assert.equal(r.location, `/admin/inventory/${id}?cover=replaced#cover`);
  assert.match((await coverOf(id)).cover_url, /^\/img\/[0-9a-f]{64}\.jpg$/);
});

test("replace refuses files that are not usable pictures and changes nothing", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  const before = await imageCount();
  const gif = await sharp({ create: { width: 120, height: 160, channels: 3, background: "#c33" } }).gif().toBuffer();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="red"/></svg>');
  const html = Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>");
  const tiny = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#333" } }).jpeg().toBuffer();
  const truncated = (await quadrantPicture(600, 800)).subarray(0, 700);
  const cases = [
    ["a GIF", { buffer: gif, type: "image/gif", name: "a.gif" }, "not-image"],
    ["an SVG called .jpg", { buffer: svg, type: "image/jpeg", name: "a.jpg" }, "not-image"],
    ["an SVG", { buffer: svg, type: "image/svg+xml", name: "a.svg" }, "not-image"],
    ["HTML called .jpg", { buffer: html, type: "image/jpeg", name: "a.jpg" }, "not-image"],
    ["a cut-off JPEG", { buffer: truncated, type: "image/jpeg", name: "a.jpg" }, "not-image"],
    ["a 10 px picture", { buffer: tiny, type: "image/jpeg", name: "a.jpg" }, "image-small"],
    ["no file at all", null, "no-file"],
  ];
  for (const [what, file, code] of cases) {
    const r = await upload(jar, `/admin/inventory/${id}/cover/replace`, file, { json: true });
    assert.equal(r.status, 400, what);
    assert.equal(r.json.code, code, what);
    assert.match(r.json.message, /Nothing was changed/, what);
  }
  assert.equal((await coverOf(id)).cover_url, url);
  assert.equal(await imageCount(), before);
});

test("replace refuses a file over 8 MB (413 with a sentence, or back to the book) and a 40-megapixel picture", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  const before = await imageCount();
  const big = Buffer.concat([await quadrantPicture(), crypto.randomBytes(9 * 1024 * 1024)]);
  const j = await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: big, type: "image/jpeg" }, { json: true });
  assert.equal(j.status, 413);
  assert.equal(j.json.code, "too-big");
  assert.match(j.json.message, /larger than 8 MB/);
  const f = await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: big, type: "image/jpeg" });
  assert.equal(f.status, 303);
  assert.equal(f.location, `/admin/inventory/${id}?cover=too-big#cover`);
  // 7000 x 6000 = 42 MP: a few KB on the wire, over a hundred MB decoded
  const bomb = await sharp({ create: { width: 7000, height: 6000, channels: 3, background: "#808080" } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 8 * 1024 * 1024, `the test picture is ${bomb.length} bytes`);
  const b = await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: bomb, type: "image/png", name: "bomb.png" }, { json: true });
  assert.equal(b.status, 400);
  assert.equal(b.json.code, "too-many-pixels");
  assert.equal((await coverOf(id)).cover_url, url);
  assert.equal(await imageCount(), before);
});

// ---- remove ----------------------------------------------------------------------------------------------------------

test("remove puts the book back to No cover, keeps the picture for the cleanup job, and nothing brings it back by itself", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  await pool.query("UPDATE books SET cover_source_url = 'https://covers.openlibrary.org/b/id/1-L.jpg' WHERE id = $1", [id]);
  const before = await imageCount();
  const r = await post(jar, `/admin/inventory/${id}/cover/remove`);
  assert.equal(r.location, `/admin/inventory/${id}?cover=removed#cover`);
  const row = await coverOf(id);
  assert.equal(row.cover_url, null);
  assert.equal(row.cover_source_url, null, "the download address is forgotten so the background job cannot fetch it again");
  assert.ok(row.cover_removed_at);
  assert.equal(await imageCount(), before, "no image row is deleted by the request");
  assert.ok(await imageStore.getImage(/[0-9a-f]{64}/.exec(url)[0], pool));

  // public pages
  const page = await get(null, `/books/${id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="book-detail-cover book-thumb-placeholder"[^>]*>No cover</);
  assert.doesNotMatch(page.text, new RegExp(url.slice(5, 30)));
  const search = await (await fetch(`${app.base}/api/books/search?q=${encodeURIComponent((await pool.query("SELECT title FROM books WHERE id=$1", [id])).rows[0].title)}`)).json();
  assert.equal(search.find((b) => b.id === id).coverUrl, null);

  // saving the book's details (title only, no cover typed) does not look a cover up again
  const save = await post(jar, `/admin/inventory/${id}`, { title: "Removed Cover Book", description: "Has a description", descriptionFr: "Une description" });
  assert.equal(save.status, 302);
  assert.equal((await coverOf(id)).cover_url, null);

  // the shared fill and the background job leave it alone
  const { fillBookGaps } = require("../../src/lib/bookFill");
  const calls = [];
  await fillBookGaps(pool, id, { title: "x", coverUrl: "https://covers.openlibrary.org/b/id/2-L.jpg" }, {
    findCoverUrl: async () => { calls.push("find"); return "https://covers.openlibrary.org/b/id/3-L.jpg"; },
    prepareCover: async (u) => { calls.push(`prepare ${u}`); return { cover: null, source: u }; },
    generateBookDescription: async () => null,
  });
  assert.deepEqual(calls, [], "fillBookGaps does not look for a cover");
  await pool.query("UPDATE books SET cover_source_url = 'https://covers.openlibrary.org/b/id/4-L.jpg' WHERE id = $1", [id]);
  const fetched = [];
  const { backfillCovers } = require("../../src/lib/coverStore");
  await backfillCovers(pool, { limit: 50, delayMs: 0, fetchImpl: async (u) => { fetched.push(u); throw new Error("no network in tests"); } });
  assert.ok(!fetched.some((u) => u.includes("/4-L.jpg")), "the background job skips a book whose cover was removed on purpose");

  // typing a cover address again (or adding a photo) lifts the mark
  const photo = await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: await quadrantPicture(), type: "image/jpeg" });
  assert.equal(photo.status, 303);
  const after = await coverOf(id);
  assert.match(after.cover_url, /^\/img\//);
  assert.equal(after.cover_removed_at, null);
});

test("remove on a book with no cover is harmless", async () => {
  const { jar } = await adminJar();
  const id = await makeBook(null);
  const r = await post(jar, `/admin/inventory/${id}/cover/remove`, {}, { json: true });
  assert.equal(r.status, 200);
  assert.equal((await coverOf(id)).cover_url, null);
});

// ---- covers from the internet, and old external addresses ------------------------------------------------------------

test("a cover that came from the internet (copied into the images store by lib/coverStore.js) can be rotated and cropped", async () => {
  const { jar } = await adminJar();
  const { reencodeCover } = require("../../src/lib/coverStore");
  const downloaded = await sharp(await quadrantPicture(500, 750, "png")).png().toBuffer(); // what Open Library would send
  const stored = await storeCover(await reencodeCover(downloaded));
  const id = await makeBook(stored);
  assert.equal((await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "left" })).status, 303);
  const m = await dims((await coverOf(id)).cover_url);
  const src = await sharp(await bytesOf(stored)).metadata();
  assert.deepEqual(m, [src.height, src.width]);
  const c = await post(jar, `/admin/inventory/${id}/cover/crop`, { x: "0", y: "0", w: "0.5", h: "1" });
  assert.equal(c.location, `/admin/inventory/${id}?cover=cropped#cover`);
  const [w, h] = await dims((await coverOf(id)).cover_url);
  assert.equal(w, Math.round(src.height * 0.5));
  assert.equal(h, src.width);
});

test("an old external cover address is refused for rotate and crop with a clear message (never fetched, never a 500); replace and remove still work", async () => {
  const { jar } = await adminJar();
  const external = "https://covers.openlibrary.org/b/id/12345-L.jpg";
  const id = await makeBook(external);
  const page = await get(jar, `/admin/inventory/${id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /not saved on our server/);
  assert.doesNotMatch(page.text, /cover\/rotate/, "no Rotate button for a cover we do not hold");
  for (const [path, fields] of [["rotate", { direction: "left" }], ["crop", { x: "0.1", y: "0.1", w: "0.5", h: "0.5" }]]) {
    const r = await post(jar, `/admin/inventory/${id}/cover/${path}`, fields, { json: true });
    assert.equal(r.status, 409, path);
    assert.equal(r.json.code, "not-stored");
    assert.match(r.json.message, /not saved on our server/);
  }
  assert.equal((await coverOf(id)).cover_url, external);
  // data: and odd values are refused the same way
  for (const odd of ["data:image/png;base64,AAAA", "/not-an-image", "/img/" + "a".repeat(64) + ".jpg"]) {
    await pool.query("UPDATE books SET cover_url = $2 WHERE id = $1", [id, odd]);
    const r = await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "left" }, { json: true });
    assert.equal(r.status, 409, odd);
  }
  await pool.query("UPDATE books SET cover_url = $2 WHERE id = $1", [id, external]);
  assert.equal((await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: await quadrantPicture(), type: "image/jpeg" })).status, 303);
  assert.match((await coverOf(id)).cover_url, /^\/img\/[0-9a-f]{64}\.jpg$/);
  await pool.query("UPDATE books SET cover_url = $2 WHERE id = $1", [id, external]);
  assert.equal((await post(jar, `/admin/inventory/${id}/cover/remove`)).status, 303);
  assert.equal((await coverOf(id)).cover_url, null);
});

test("a book with no cover refuses rotate and crop politely", async () => {
  const { jar } = await adminJar();
  const id = await makeBook(null);
  const r = await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "left" }, { json: true });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "no-cover");
});

// ---- public pages, audit, cleanup ------------------------------------------------------------------------------------

test("the public book page, search and New In answer show the new cover address; the awards and AI follow-ups do not run", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  const title = (await pool.query("SELECT title FROM books WHERE id = $1", [id])).rows[0].title;
  const awardsBefore = (await pool.query("SELECT awards_checked_at FROM books WHERE id = $1", [id])).rows[0].awards_checked_at;
  await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "right" });
  const now = (await coverOf(id)).cover_url;
  const hash = /[0-9a-f]{64}/.exec(now)[0];
  const page = await get(null, `/books/${id}`);
  assert.ok(page.text.includes(hash), "book page");
  assert.ok(!page.text.includes(/[0-9a-f]{64}/.exec(url)[0]), "the old picture is no longer shown");
  const search = await (await fetch(`${app.base}/api/books/search?q=${encodeURIComponent(title)}`)).json();
  assert.ok(search.find((b) => b.id === id).coverUrl.includes(hash), "search");
  const newIn = await (await fetch(`${app.base}/api/books/new-in?limit=100`)).json();
  assert.ok(newIn.books.find((b) => b.id === id).coverUrl.includes(hash), "New In");
  // the new picture is served, immutable
  const img = await fetch(`${app.base}${now}`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get("cache-control"), /immutable/);
  const variant = await fetch(`${app.base}/img/${hash}-w300.jpg`);
  assert.equal(variant.status, 200);
  const row = (await pool.query("SELECT awards_checked_at FROM books WHERE id = $1", [id])).rows[0];
  assert.deepEqual(row.awards_checked_at, awardsBefore, "no awards check after a cover edit");
});

test("every edit is in the admin activity log with the book number", async () => {
  const { u, jar } = await adminJar();
  const { id } = await freshBook();
  await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "left" });
  await post(jar, `/admin/inventory/${id}/cover/crop`, { x: "0.1", y: "0.2", w: "0.5", h: "0.6" });
  await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: await quadrantPicture(), type: "image/jpeg" });
  await post(jar, `/admin/inventory/${id}/cover/remove`);
  for (const [action, detail] of [["cover.rotate", "left"], ["cover.crop", "x=0.1 y=0.2 w=0.5 h=0.6"], ["cover.replace", "replaced"], ["cover.remove", null]]) {
    const rows = await auditRows(action, id);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].actor_user_id, u.id);
    assert.equal(rows[0].target_type, "book");
    assert.equal(rows[0].detail, detail, action);
  }
  // a refused edit is not logged as a change
  const other = await freshBook();
  await post(jar, `/admin/inventory/${other.id}/cover/crop`, { x: "-1", y: "0", w: "1", h: "1" });
  assert.deepEqual(await auditRows("cover.crop", other.id).then((r) => r.length), 0);
});

test("the replaced picture is unused afterwards, protected by the grace period, and removable once it is old enough", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  const oldId = /[0-9a-f]{64}/.exec(url)[0];
  await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "right" });
  const newId = /[0-9a-f]{64}/.exec((await coverOf(id)).cover_url)[0];
  const grace = imageCleanup.DEFAULT_MIN_AGE_DAYS;
  // just uploaded: unreferenced but not yet old enough
  assert.ok(!(await imageCleanup.findUnusedImages(pool, { minAgeDays: grace, limit: 5000 })).some((r) => r.id === oldId), "grace period protects a picture uploaded a moment ago");
  assert.ok((await imageCleanup.findUnusedImages(pool, { minAgeDays: 0, limit: 5000 })).some((r) => r.id === oldId), "nothing refers to the old picture any more");
  assert.ok(!(await imageCleanup.findUnusedImages(pool, { minAgeDays: 0, limit: 5000 })).some((r) => r.id === newId), "the new picture is in use");
  await pool.query("UPDATE images SET created_at = now() - interval '30 days' WHERE id IN ($1, $2)", [oldId, newId]);
  const unused = (await imageCleanup.findUnusedImages(pool, { minAgeDays: grace, limit: 5000 })).map((r) => r.id);
  assert.ok(unused.includes(oldId), "eligible once it is older than the grace period");
  assert.ok(!unused.includes(newId), "the cover in use is never eligible, however old");
});

// ---- who may, CSRF, limits, the page ---------------------------------------------------------------------------------

test("only an admin can use the cover routes: guest, account, member and till-only account are refused and nothing changes", async () => {
  const { id, url } = await freshBook();
  const crop = { x: "0.1", y: "0.1", w: "0.5", h: "0.5" };
  const tries = [["rotate", { direction: "left" }], ["crop", crop], ["replace", null], ["remove", {}]];
  const identities = {
    guest: async () => makeCookieJar(),
    account: async () => login((await user()).email),
    member: async () => login((await user({ member: true })).email),
    till: async () => login((await user({ till: true })).email),
  };
  for (const [who, mk] of Object.entries(identities)) {
    const jar = await mk();
    for (const [action, fields] of tries) {
      const r = action === "replace"
        ? await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: await quadrantPicture(), type: "image/jpeg" })
        : await post(jar, `/admin/inventory/${id}/cover/${action}`, fields);
      const refused = r.status === 403 || r.status === 401 || (r.status === 302 && r.location === "/login");
      assert.ok(refused, `${who} ${action} -> ${r.status} ${r.location || ""}`);
    }
  }
  assert.equal((await coverOf(id)).cover_url, url);
  assert.equal((await coverOf(id)).cover_removed_at, null);
});

test("a cover POST without a CSRF token is refused and changes nothing", async () => {
  const { jar } = await adminJar();
  const { id, url } = await freshBook();
  const a = await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "left" }, { csrf: false });
  assert.equal(a.status, 403);
  const b = await post(jar, `/admin/inventory/${id}/cover/remove`, {}, { csrf: false });
  assert.equal(b.status, 403);
  const c = await upload(jar, `/admin/inventory/${id}/cover/replace`, { buffer: await quadrantPicture(), type: "image/jpeg" }, { csrf: false });
  assert.equal(c.status, 403);
  assert.equal((await coverOf(id)).cover_url, url);
});

test("a book that does not exist is the 404 page, a bad id too", async () => {
  const { jar } = await adminJar();
  for (const id of ["99999999", "abc", "0"]) {
    for (const action of ["rotate", "crop", "remove"]) {
      const r = await post(jar, `/admin/inventory/${id}/cover/${action}`, { direction: "left", x: "0", y: "0", w: "0.5", h: "0.5" });
      assert.equal(r.status, 404, `${id} ${action}`);
    }
  }
});

test("a script that edits covers too fast is told to wait (429, or back to the book with a sentence), and a calm admin is never limited", async () => {
  const { jar } = await adminJar();
  const { id } = await freshBook();
  let limited;
  for (let i = 0; i < 40 && !limited; i++) {
    const r = await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "right" }, { json: true });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "limited before 40 presses");
  assert.equal(limited.json.code, "busy");
  assert.match(limited.json.message, /wait a minute/);
  const form = await post(jar, `/admin/inventory/${id}/cover/rotate`, { direction: "right" });
  assert.equal(form.location, `/admin/inventory/${id}?cover=busy#cover`);
  // another admin has their own allowance
  const other = await adminJar();
  const fresh = await freshBook();
  assert.equal((await post(other.jar, `/admin/inventory/${fresh.id}/cover/rotate`, { direction: "right" }, { json: true })).status, 200);
});

test("the book page has the Cover card: Replace, Rotate, Remove and a script-only Crop button; without a cover only Add", async () => {
  const { jar } = await adminJar();
  const { id } = await freshBook();
  let page = await get(jar, `/admin/inventory/${id}`);
  assert.equal(page.status, 200);
  const t = page.text;
  assert.match(t, /<div class="section-title">Cover<\/div>/);
  assert.match(t, />Replace cover photo</);
  assert.match(t, /name="direction" value="left"/);
  assert.match(t, /name="direction" value="right"/);
  assert.match(t, /<button type="button" class="btn btn-outline btn-small" data-cover-crop-open hidden/, "Crop is hidden until the script shows it");
  assert.match(t, /data-confirm="Remove this book's cover\?/);
  assert.match(t, /<form class="cvr-crop-form" method="post" action="\/admin\/inventory\/\d+\/cover\/crop"/);
  assert.match(t, /<link rel="stylesheet" href="\/cover-edit\.css\?v=[^"]+">/);
  assert.match(t, /<script src="\/cover-edit\.js\?v=[^"]+"><\/script>/);
  assert.match(t, /capture="environment"/);
  assert.doesNotMatch(t, /<script>[^<]/, "no inline script");
  const none = await makeBook(null);
  page = await get(jar, `/admin/inventory/${none}`);
  assert.match(page.text, />Add cover photo</);
  assert.doesNotMatch(page.text, /name="direction"/);
  assert.doesNotMatch(page.text, /data-cover-crop-open/);
  assert.doesNotMatch(page.text, /cover\/remove/);
  assert.match(page.text, /This book has no cover/);
});
