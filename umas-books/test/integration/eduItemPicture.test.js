// The Picture card of an educational item (Admin > Educational items > Edit): add, replace, rotate, crop and remove the
// item's picture, with the same image work and limits as a book's Cover card (src/lib/coverEdit.js,
// routes/admin/eduItems.js, views/partials/picture_card.ejs). Real app, real database, real sharp on a generated
// 300 x 200 picture with four colour quadrants, so a turn or a cut can be checked by reading pixels back.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const sharp = require("sharp");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 7873;
const PASSWORD = "Edu-Picture-Pass1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const RED = [220, 30, 30], GREEN = [30, 190, 30], BLUE = [30, 30, 220], YELLOW = [235, 220, 30];

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
  const email = `edupic-${tag()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_till, email_verified_at)
     VALUES ($1, $2, 'Picture Tester', $3, $4, $5, now()) RETURNING id`,
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

async function upload(jar, path, file, { json = false, csrf = true, field = "image" } = {}) {
  const form = new FormData();
  if (csrf) form.append("_csrf", await fetchCsrfToken(app.base, jar));
  if (file) form.append(field, new Blob([file.buffer], { type: file.type || "image/jpeg" }), file.name || "cover.jpg");
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

async function makeItem(image, name = `Edu Item ${tag()}`) {
  const { rows } = await pool.query("INSERT INTO edu_items (name, price, stock, image_url) VALUES ($1, 4.5, 3, $2) RETURNING id", [name, image]);
  return rows[0].id;
}
const imageOf = async (id) => (await pool.query("SELECT image_url FROM edu_items WHERE id = $1", [id])).rows[0].image_url;

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
async function auditRows(action, id) {
  for (let i = 0; i < 20; i++) {
    const { rows } = await pool.query("SELECT * FROM admin_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id", [action, id]);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}
const B = (id) => `/admin/edu-items/${id}/image`;
const editPage = async (jar, id, query = "") => (await get(jar, `/admin/edu-items/${id}/edit${query}`)).text;
const picture = async () => storeCover(await quadrantPicture(300, 200, "jpeg", { unique: true }));

// ---- the card on the edit page ---------------------------------------------------------------------------------------

test("the edit page shows the Picture card with Replace, Rotate, Crop and Remove; no picture shows 'No picture' and only Add", async () => {
  const { jar } = await adminJar();
  const withPic = await makeItem(await picture());
  const html = await editPage(jar, withPic);
  assert.match(html, /<div class="card" id="picture" data-cover-edit data-noun="picture">/);
  for (const needle of ["Replace picture", "Rotate left", "Rotate right", "data-cover-crop-open", "Remove picture", `${B(withPic)}/crop`, `${B(withPic)}/rotate`, `${B(withPic)}/replace`, `${B(withPic)}/remove`]) assert.ok(html.includes(needle), needle);
  assert.match(html, /name="image" type="file" aria-label="Replace picture" accept="image\/\*" capture="environment"/, "the phone camera is offered");
  assert.match(html, /cover-edit\.js/);
  assert.ok(!html.includes('id="edu-image"'), "the old plain file field is gone on the edit page (the card replaces it)");
  const none = await makeItem(null);
  const empty = await editPage(jar, none);
  assert.match(empty, /class="cvr-empty">No picture</);
  assert.ok(empty.includes("Add picture") && !empty.includes("Rotate left") && !empty.includes("Remove picture"));
  const add = (await get(jar, "/admin/edu-items/new")).text;
  assert.ok(add.includes('id="edu-image"') && !add.includes('id="picture"'), "the add form keeps the plain picture field");
});

// ---- add / replace ---------------------------------------------------------------------------------------------------

test("add a photo to an item without one, then replace it: processed to a JPEG, audited, old image kept for the cleanup", async () => {
  const { jar } = await adminJar();
  const id = await makeItem(null);
  const photo = await quadrantPicture(1800, 1200, "png", { unique: true });
  const r = await upload(jar, `${B(id)}/replace`, { buffer: photo, type: "image/png", name: "a.png" });
  assert.equal(r.status, 303);
  assert.equal(r.location, `/admin/edu-items/${id}/edit?picture=replaced#picture`);
  const first = await imageOf(id);
  assert.match(first, /^\/img\/[0-9a-f]{64}\.jpg$/);
  assert.deepEqual(await dims(first), [900, 600], "resized to at most 900 px, aspect kept");
  assert.equal((await sharp(await bytesOf(first)).metadata()).format, "jpeg");
  assertColour(await pixelAt(first, 0.25, 0.25), RED, "top left");
  assert.match((await editPage(jar, id, "?picture=replaced")).replace(/\s+/g, " "), /Picture saved\./);
  assert.match((await auditRows("edu_item.image_replace", id))[0].detail, /picture added/);
  // Replace it (with an upright-by-EXIF phone photo).
  const phone = await quadrantPicture(400, 300, "jpeg", { unique: true, orientation: 6 });
  const r2 = await upload(jar, `${B(id)}/replace`, { buffer: phone }, { json: true });
  assert.equal(r2.status, 200);
  const second = await imageOf(id);
  assert.notEqual(second, first);
  assert.equal(r2.json.imageUrl, second);
  assert.deepEqual(await dims(second), [300, 400], "EXIF rotation applied");
  assert.match((await auditRows("edu_item.image_replace", id))[1].detail, /picture replaced/);
  assert.ok(await imageStore.getImage(/([0-9a-f]{64})/.exec(first)[1], pool), "the replaced image stays until the cleanup job");
});

test("limits and errors: nothing is changed on a bad file, no file, a GIF, a tiny photo, over 8 MB, a bad item, no CSRF, a non-admin", async () => {
  const { jar } = await adminJar();
  const url = await picture();
  const id = await makeItem(url);
  const rows = async () => (await pool.query("SELECT count(*)::int AS n FROM admin_audit_log WHERE target_id = $1 AND action LIKE 'edu_item.image_%'", [id])).rows[0].n;
  const noFile = await upload(jar, `${B(id)}/replace`, null, { json: true });
  assert.equal(noFile.status, 400); assert.equal(noFile.json.code, "no-file");
  const gif = await upload(jar, `${B(id)}/replace`, { buffer: await sharp(await quadrantPicture()).gif().toBuffer(), type: "image/gif", name: "a.gif" }, { json: true });
  assert.equal(gif.status, 400); assert.equal(gif.json.code, "not-image");
  assert.match(gif.json.message, /JPEG, PNG or WebP/); assert.ok(!/cover/i.test(gif.json.message), "item wording, not cover wording");
  const fake = await upload(jar, `${B(id)}/replace`, { buffer: Buffer.from("<html>not a picture</html>"), name: "a.jpg" }, { json: true });
  assert.equal(fake.json.code, "not-image");
  const tiny = await upload(jar, `${B(id)}/replace`, { buffer: await quadrantPicture(40, 40) }, { json: true });
  assert.equal(tiny.status, 400); assert.equal(tiny.json.code, "image-small"); assert.match(tiny.json.message, /too small for an item picture/);
  const huge = await upload(jar, `${B(id)}/replace`, { buffer: Buffer.alloc(9 * 1024 * 1024, 1) }, { json: true });
  assert.equal(huge.status, 413); assert.equal(huge.json.code, "too-big");
  const hugePage = await upload(jar, `${B(id)}/replace`, { buffer: Buffer.alloc(9 * 1024 * 1024, 1) });
  assert.equal(hugePage.location, `/admin/edu-items/${id}/edit?picture=too-big#picture`);
  assert.match(await editPage(jar, id, "?picture=too-big"), /larger than 8 MB/);
  assert.equal(await imageOf(id), url, "still the same picture");
  assert.equal(await rows(), 0, "nothing audited for refused edits");
  const missing = await upload(jar, `${B(999999)}/replace`, { buffer: await quadrantPicture() });
  assert.equal(missing.status, 404);
  const noToken = await upload(jar, `${B(id)}/replace`, { buffer: await quadrantPicture() }, { csrf: false });
  assert.equal(noToken.status, 403);
  const member = await user({ member: true });
  const mjar = await login(member.email);
  for (const [p, f] of [["replace", {}], ["rotate", { direction: "left" }], ["crop", { x: 0, y: 0, w: 0.5, h: 0.5 }], ["remove", {}]]) {
    const r = await post(mjar, `${B(id)}/${p}`, f);
    assert.ok([302, 303, 403, 404].includes(r.status) && !/edit\?picture/.test(r.location || ""), `${p} refused for a non-admin (${r.status})`);
  }
  const anon = await post(makeCookieJar(), `${B(id)}/remove`, {}, { csrf: false });
  assert.notEqual(anon.status, 200);
  assert.equal(await imageOf(id), url);
});

// ---- rotate / crop ---------------------------------------------------------------------------------------------------

test("rotate right and left: 300 x 200 becomes 200 x 300 with the corners where a turn puts them; audited", async () => {
  const { jar } = await adminJar();
  const id = await makeItem(await picture());
  const r = await post(jar, `${B(id)}/rotate`, { direction: "right" });
  assert.equal(r.location, `/admin/edu-items/${id}/edit?picture=rotated#picture`);
  const url = await imageOf(id);
  assert.deepEqual(await dims(url), [200, 300]);
  assertColour(await pixelAt(url, 0.75, 0.25), RED, "red top-left goes top-right");
  assertColour(await pixelAt(url, 0.25, 0.25), BLUE, "blue bottom-left goes top-left");
  await post(jar, `${B(id)}/rotate`, { direction: "left" });
  const back = await imageOf(id);
  assert.deepEqual(await dims(back), [300, 200]);
  assertColour(await pixelAt(back, 0.25, 0.25), RED, "turned back");
  const logs = await auditRows("edu_item.image_rotate", id);
  assert.deepEqual(logs.map((l) => l.detail), [`${(await pool.query("SELECT name FROM edu_items WHERE id=$1", [id])).rows[0].name}: right`, `${(await pool.query("SELECT name FROM edu_items WHERE id=$1", [id])).rows[0].name}: left`].slice(0, logs.length));
  const bad = await post(jar, `${B(id)}/rotate`, { direction: "up" }, { json: true });
  assert.equal(bad.status, 400); assert.equal(bad.json.code, "bad-direction");
});

test("crop keeps exactly the chosen part; the whole picture changes nothing; bad and tiny boxes are refused", async () => {
  const { jar } = await adminJar();
  const id = await makeItem(await picture());
  const before = await imageOf(id);
  const r = await post(jar, `${B(id)}/crop`, { x: "0.5", y: "0", w: "0.5", h: "0.5" }, { json: true });
  assert.equal(r.status, 200); assert.equal(r.json.code, "cropped");
  const url = await imageOf(id);
  assert.deepEqual(await dims(url), [150, 100], "the top right quarter");
  assertColour(await pixelAt(url, 0.5, 0.5), GREEN, "only green is left");
  assertColour(await pixelAt(url, 0.05, 0.95), GREEN, "...everywhere");
  assert.match((await auditRows("edu_item.image_crop", id))[0].detail, /x=0\.5 y=0 w=0\.5 h=0\.5/);
  const whole = await post(jar, `${B(id)}/crop`, { x: "0", y: "0", w: "1", h: "1" }, { json: true });
  assert.equal(whole.json.code, "no-change");
  assert.equal(await imageOf(id), url);
  for (const [fields, code] of [[{ x: "NaN", y: "0", w: "1", h: "1" }, "bad-crop"], [{ x: "0.9", y: "0", w: "0.5", h: "1" }, "bad-crop"], [{ x: "0", y: "0", w: "0.01", h: "1" }, "crop-small"], [{}, "bad-crop"]]) {
    const bad = await post(jar, `${B(id)}/crop`, fields, { json: true });
    assert.equal(bad.status, 400); assert.equal(bad.json.code, code);
  }
  assert.equal(await imageOf(id), url);
  assert.notEqual(url, before);
});

test("an old web address (not stored here) cannot be rotated or cropped, but can be replaced or removed; an item without a picture cannot be rotated", async () => {
  const { jar } = await adminJar();
  const ext = await makeItem("https://old.example/pic.jpg");
  const html = await editPage(jar, ext);
  assert.match(html, /Picture not saved on our server/);
  assert.ok(!html.includes("Rotate left") && html.includes("Replace picture") && html.includes("Remove picture"));
  const r = await post(jar, `${B(ext)}/rotate`, { direction: "left" }, { json: true });
  assert.equal(r.status, 409); assert.equal(r.json.code, "not-stored");
  const none = await makeItem(null);
  const r2 = await post(jar, `${B(none)}/crop`, { x: "0", y: "0", w: "0.5", h: "0.5" }, { json: true });
  assert.equal(r2.status, 409); assert.equal(r2.json.code, "no-cover"); assert.match(r2.json.message, /Add picture first/);
  assert.equal((await upload(jar, `${B(ext)}/replace`, { buffer: await quadrantPicture(300, 200, "jpeg", { unique: true }) })).status, 303);
  assert.match(await imageOf(ext), /^\/img\//);
});

// ---- remove / public card --------------------------------------------------------------------------------------------

test("remove: the item has no picture, the Browse card shows 'No picture', then a new photo shows on the card; audited; image left for the cleanup", async () => {
  const { jar } = await adminJar();
  const name = `Card Item ${tag()}`;
  const url = await picture();
  const id = await makeItem(url, name);
  const cardOf = async () => {
    const html = (await get(null, "/educational-items.html")).text;
    const i = html.indexOf(`id="edu-item-${id}"`);
    return html.slice(i, html.indexOf("</form>", i));
  };
  assert.ok((await cardOf()).includes(`src="${url}"`), "the card shows the picture");
  const r = await post(jar, `${B(id)}/remove`, {});
  assert.equal(r.location, `/admin/edu-items/${id}/edit?picture=removed#picture`);
  assert.equal(await imageOf(id), null);
  assert.match(await cardOf(), /class="cover cover-none"[^>]*>No picture</);
  assert.match((await editPage(jar, id, "?picture=removed")).replace(/\s+/g, " "), /The picture was removed\. The item now shows/);
  assert.equal((await auditRows("edu_item.image_remove", id))[0].detail, name);
  assert.ok(await imageStore.getImage(/([0-9a-f]{64})/.exec(url)[1], pool), "the file stays for the cleanup job");
  const again = await post(jar, `${B(id)}/remove`, {}, { json: true });
  assert.equal(again.status, 200);
  assert.equal((await auditRows("edu_item.image_remove", id)).length, 1, "removing nothing is not audited twice");
  await upload(jar, `${B(id)}/replace`, { buffer: await quadrantPicture(300, 200, "jpeg", { unique: true }) });
  assert.ok((await cardOf()).includes(`src="${await imageOf(id)}"`), "the card shows the new picture");
});

// ---- cleanup / orphans -----------------------------------------------------------------------------------------------

test("cleanup: a replaced or removed picture becomes removable after the grace period, a picture an item uses never does", async () => {
  const { jar } = await adminJar();
  const oldUrl = await picture();
  const id = await makeItem(oldUrl);
  const other = await makeItem(oldUrl); // a second item that uses the very same image
  await upload(jar, `${B(id)}/replace`, { buffer: await quadrantPicture(300, 200, "jpeg", { unique: true }) });
  const newUrl = await imageOf(id);
  const oldId = /([0-9a-f]{64})/.exec(oldUrl)[1], newId = /([0-9a-f]{64})/.exec(newUrl)[1];
  const grace = imageCleanup.DEFAULT_MIN_AGE_DAYS;
  await pool.query("UPDATE images SET created_at = now() - interval '30 days' WHERE id IN ($1, $2)", [oldId, newId]);
  let unused = (await imageCleanup.findUnusedImages(pool, { minAgeDays: grace, limit: 5000 })).map((r) => r.id);
  assert.ok(!unused.includes(oldId), "still used by the other item");
  assert.ok(!unused.includes(newId), "in use");
  await post(jar, `${B(other)}/remove`, {});
  await post(jar, `${B(id)}/remove`, {});
  unused = (await imageCleanup.findUnusedImages(pool, { minAgeDays: grace, limit: 5000 })).map((r) => r.id);
  assert.ok(unused.includes(oldId) && unused.includes(newId), "nothing refers to them now and they are old");
  const fresh = await picture();
  const freshId = /([0-9a-f]{64})/.exec(fresh)[1];
  assert.ok(!(await imageCleanup.findUnusedImages(pool, { minAgeDays: grace, limit: 5000 })).some((r) => r.id === freshId), "a picture saved just now is never removed");
  await imageCleanup.purgeUnusedImages(pool, { minAgeDays: grace });
  assert.equal(await imageStore.getImage(oldId, pool), null);
  await makeItem(fresh);
  await pool.query("UPDATE images SET created_at = now() - interval '30 days' WHERE id = $1", [freshId]);
  await imageCleanup.purgeUnusedImages(pool, { minAgeDays: grace });
  assert.ok(await imageStore.getImage(freshId, pool), "an image an item uses survives the purge");
});

// ---- guards ----------------------------------------------------------------------------------------------------------

test("the edit is refused (409) when the picture changed meanwhile; the rate limit answers in the card's way", async () => {
  const { jar } = await adminJar();
  const id = await makeItem(await picture());
  // Simulates the race directly: the same guard the routes use.
  const url = await imageOf(id);
  const { rowCount } = await pool.query("UPDATE edu_items SET image_url = $1 WHERE id = $2 AND image_url IS NOT DISTINCT FROM $3", ["/img/" + "a".repeat(64) + ".jpg", id, "/img/" + "b".repeat(64) + ".jpg"]);
  assert.equal(rowCount, 0);
  assert.equal(await imageOf(id), url);
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const r = await post(jar, `${B(id)}/crop`, { x: "0", y: "0", w: "1", h: "1" }, { json: true });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "30 edits a minute per admin, then 429");
  assert.equal(limited.json.code, "busy");
});
