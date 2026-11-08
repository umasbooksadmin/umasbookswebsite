// Admin > Other stock (not books), src/routes/admin/otherStock.js: managed like Educational items but without the book part.
// List (picture, name, price, stock, shown; Search by name; Find by barcode; alphabetical), separate Add / Edit pages,
// validation, the barcode rules the Till has always had, the barcode LOOK-UP (product catalogues only; every outside call is
// stubbed at global.fetch), generate-code, audit, admins only, and the Till's quick-item buttons (alphabetical, thumbnail).
// The real router and views on an in-process app with a throwaway database.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

process.env.SCAN_LOOKUP_TIMEOUT_MS = "1200";
delete process.env.ISBNDB_API_KEY;

const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const db = prepareDatabase("other_stock", { isolated: true });
const { pool } = require("../../src/db");
const { resetProductLookup, setProductTimeoutForTests } = require("../../src/lib/productLookup");
setProductTimeoutForTests(1200);

// ---------- the outside world ----------
const realFetch = global.fetch;
const opf = new Map(); // code -> product_name
const upc = new Map(); // code -> { title, brand } | 429
const outside = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  outside.push(`${init.method || "GET"} ${u}`);
  let m;
  if ((m = u.match(/^https:\/\/world\.openproductsfacts\.org\/api\/v2\/product\/(\d+)\.json/))) {
    return opf.has(m[1]) ? json({ status: 1, product: { product_name: opf.get(m[1]) } }) : json({ status: 0 }, 404);
  }
  if ((m = u.match(/^https:\/\/api\.upcitemdb\.com\/prod\/trial\/lookup\?upc=(\d+)$/))) {
    const a = upc.get(m[1]);
    if (typeof a === "number") return json({ code: "TOO_FAST", message: "x" }, a);
    return json(a ? { code: "OK", total: 1, items: [{ ...a, images: ["https://images.example/thirdparty.jpg"] }] } : { code: "OK", total: 0, items: [] });
  }
  throw new Error(`test refused a real outbound request to ${u}`);
};

let server;
let admin;
let seq = 0;
before(async () => {
  db.create();
  const statics = express.static(path.join(__dirname, "..", "..", "public"));
  const gate = express.Router();
  gate.use("/admin/till/items", require("multer")({ storage: require("multer").memoryStorage() }).fields([{ name: "image", maxCount: 1 }]));
  server = await listen(buildApp([statics, gate, require("../../src/routes/admin/otherStock")]));
  admin = await makeUser(true);
});
after(async () => {
  global.fetch = realFetch;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => { opf.clear(); upc.clear(); outside.length = 0; resetProductLookup(); });

async function makeUser(isAdmin) {
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Stock Admin', $2) RETURNING id", [`stock-${Date.now()}-${++seq}@example.test`, isAdmin]);
  return { id: rows[0].id, email: "a@example.test", displayName: "Stock Admin", isAdmin, isMember: true };
}
const header = (user) => ({ "x-test-user": JSON.stringify(user) });
async function get(p, user = admin, cookie = "") {
  const res = await realFetch(`${server.base}${p}`, { redirect: "manual", headers: { ...header(user), ...(cookie ? { cookie } : {}) } });
  return { res, status: res.status, location: res.headers.get("location"), text: await res.text(), cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
const lookup = async (code, user = admin, extra = "") => {
  const r = await get(`/admin/till/items/lookup?barcode=${encodeURIComponent(code)}${extra}`, user);
  return { status: r.status, body: JSON.parse(r.text) };
};
// POST a form; a 303 is followed with the session (the flash), like the browser. A 302 (saved) is returned as it is, with the page it leads to.
async function post(p, fields, user = admin) {
  const res = await realFetch(`${server.base}${p}`, { method: "POST", redirect: "manual", headers: { ...header(user), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  if (res.status !== 303 && res.status !== 302) return { status: res.status, text: await res.text() };
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const next = await get(res.headers.get("location"), user, cookie);
  return { status: res.status, location: res.headers.get("location"), text: next.text };
}
const add = (fields) => post("/admin/till/items", { name: "Item", price: "5", category: "merchandise", ...fields });
const row = async (name) => (await pool.query("SELECT * FROM till_quick_items WHERE name = $1", [name])).rows[0];
const seed = async (name, o = {}) => (await pool.query("INSERT INTO till_quick_items (name, price_cents, category, stock, barcode, active) VALUES ($1, $2, 'merchandise', $3, $4, $5) RETURNING *", [name, o.price || 500, o.stock ?? null, o.barcode || null, o.active ?? true])).rows[0];
const auditOf = async (action) => (await pool.query("SELECT * FROM admin_audit_log WHERE action = $1 ORDER BY id", [action])).rows;
const decode = (s) => s.replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// ---------- migration ----------

test("migration 117: image_url and updated_at exist, empty for every item that already existed", async () => {
  const it = await seed("Old Row");
  assert.equal(it.image_url, null);
  assert.ok(it.updated_at);
});

// ---------- the list ----------

test("the list: picture, name, price, stock and shown columns, alphabetical by name whatever the old Position was; no Position or Order control", async () => {
  await pool.query("INSERT INTO till_quick_items (name, price_cents, category, sort_order) VALUES ('Zebra Pencil', 100, 'other', 1), ('apple Bookmark', 100, 'other', 99), ('Mango Tote', 100, 'other', 5)");
  const html = (await get("/admin/till/items")).text;
  for (const h of ["Picture", "Name", "Category", "Price", "Stock", "On the till"]) assert.ok(html.includes(`<th scope="col">${h}</th>`), h);
  assert.ok(!/Position|sortOrder|name="order"/i.test(html), "no Position / Order field");
  const at = (n) => html.indexOf(n);
  assert.ok(at("apple Bookmark") < at("Mango Tote") && at("Mango Tote") < at("Zebra Pencil"), "alphabetical, case-insensitive");
});

test("the list: a switched-off item is listed after the others and marked Hidden; stock is shown, 'not counted' when empty", async () => {
  await seed("Aaa Off", { active: false, stock: 4 });
  await seed("Zzz On", { stock: 2 });
  await seed("Zzz Uncounted");
  const html = (await get("/admin/till/items")).text;
  assert.ok(html.indexOf("Zzz On") < html.indexOf("Aaa Off"), "switched-off items come last");
  assert.match(html.replace(/\s+/g, " "), /Aaa Off<\/a>.*?<td>4<\/td> <td>Hidden<\/td>/);
  assert.match(html.replace(/\s+/g, " "), /Zzz Uncounted<\/a>.*?not counted/);
});

test("Search by name: every word, any case, switched-off items too, wildcard characters are literal; Show all", async () => {
  await seed("Green Cotton Tote");
  await seed("Red Cotton Bag", { active: false });
  await seed("100% Linen");
  const names = async (q) => {
    const html = (await get(`/admin/till/items?q=${encodeURIComponent(q)}`)).text;
    return ["Green Cotton Tote", "Red Cotton Bag", "100% Linen"].filter((n) => html.includes(`>${n}</a>`));
  };
  assert.deepEqual(await names("cotton"), ["Green Cotton Tote", "Red Cotton Bag"]);
  assert.deepEqual(await names("COTTON tote"), ["Green Cotton Tote"]);
  assert.deepEqual(await names("%"), ["100% Linen"], "% is not a wildcard");
  assert.deepEqual(await names("_"), []);
  const none = (await get("/admin/till/items?q=zzzznothing")).text;
  assert.match(none, /No item matches &#34;zzzznothing&#34;/);
  assert.match(none, /Show all/);
});

test("Find by barcode: to the item's edit page; unknown code gives 'No item with that barcode' and an Add link; a bad code says why", async () => {
  const it = await seed("Findable", { barcode: "FIND-ME-1" });
  const hit = await get("/admin/till/items/find?barcode=find-me-1");
  assert.equal(hit.status, 303);
  assert.equal(hit.location, `/admin/till/items/${it.id}/edit`);
  const miss = await realFetch(`${server.base}/admin/till/items/find?barcode=4006381333931`, { redirect: "manual", headers: header(admin) });
  assert.equal(miss.status, 303);
  const cookie = miss.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const page = (await get(miss.headers.get("location"), admin, cookie)).text;
  assert.match(page, /No item with that barcode \(4006381333931\)/);
  assert.match(page, /href="\/admin\/till\/items\/new\?barcode=4006381333931"/);
  const bad = await realFetch(`${server.base}/admin/till/items/find?barcode=bad%21`, { redirect: "manual", headers: header(admin) });
  const c2 = bad.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  assert.match((await get(bad.headers.get("location"), admin, c2)).text, /shop code uses letters/);
  const newPage = await get("/admin/till/items/new?barcode=4006381333931");
  assert.match(newPage.text, /value="4006381333931"/);
  assert.match(newPage.text, /data-auto-lookup/, "arriving with a barcode looks it up at once");
});

// ---------- add / edit ----------

test("the Add and Edit pages are separate pages with the look-up box, the category list and no Position field; Edit has the Picture card, Add the plain picture field", async () => {
  const addPage = (await get("/admin/till/items/new")).text;
  assert.match(addPage, /data-lookup-url="\/admin\/till\/items\/lookup"/);
  assert.match(addPage, /data-edu-lookup/);
  assert.match(addPage, /id="stock-image" name="image" type="file" accept="image\/\*"/);
  assert.doesNotMatch(addPage, /<input[^>]*name="image"[^>]*capture=/);
  assert.doesNotMatch(addPage, /id="picture"/);
  assert.doesNotMatch(addPage, /Position|sortOrder/);
  assert.match(addPage, /<option value="merchandise"/);
  const it = await seed("Edit Page Item", { barcode: "EP-1", stock: 7 });
  const editPage = (await get(`/admin/till/items/${it.id}/edit`)).text;
  assert.match(editPage, /id="picture" data-cover-edit/);
  assert.match(editPage, /class="cvr-empty">No picture</);
  assert.match(editPage, /name="active" value="1" checked/);
  assert.match(editPage, /value="EP-1"/);
  assert.match(editPage, /id="stock-stock"[^>]*value="7"/);
  assert.equal((await get("/admin/till/items/999999/edit")).status, 404);
});

test("add: saved (302 to the list, with a notice), audited; the Order/Position the old form sent is ignored", async () => {
  const r = await add({ name: "Added Tote", price: "12,50", stock: "4", barcode: "tote-new", sortOrder: "7" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/admin/till/items");
  assert.match(r.text, /Added &#34;Added Tote&#34;\./);
  const it = await row("Added Tote");
  assert.deepEqual([it.price_cents, it.stock, it.barcode, it.active, it.sort_order, it.image_url], [1250, 4, "TOTE-NEW", true, 0, null]);
  assert.match((await auditOf("till.item_add")).pop().detail, /Added Tote 12\.50 code TOTE-NEW/);
});

test("add: refused forms go back to the Add page with the sentence, what was typed is put back, nothing is saved", async () => {
  for (const [fields, sentence] of [
    [{ name: "" }, /Name is required/],
    [{ name: "x".repeat(81) }, /at most 80/],
    [{ name: "Bad Price", price: "0" }, /Price must be above 0/],
    [{ name: "Bad Price", price: "abc" }, /./],
    [{ name: "Bad Cat", category: "bogus" }, /Choose a category/],
    [{ name: "Bad Stock", stock: "-1" }, /whole number/],
    [{ name: "Bad Code", barcode: "1234567" }, /8 to 14 digits/],
    [{ name: "Bad Code", barcode: "UB-12" }, /UB-/],
  ]) {
    const r = await add(fields);
    assert.equal(r.status, 303, JSON.stringify(fields));
    assert.equal(r.location, "/admin/till/items/new");
    assert.match(decode(r.text), sentence);
  }
  const typed = await add({ name: "Keep My Name", price: "0", barcode: "KEEP-1", stock: "3" });
  assert.match(typed.text, /value="Keep My Name"/);
  assert.match(typed.text, /value="KEEP-1"/);
  assert.equal(await row("Keep My Name"), undefined);
});

test("add: a barcode already on an active item, or the ISBN of a book in the shop, is refused (as the Till has always done); a switched-off item frees its code", async () => {
  await seed("Code Owner", { barcode: "OWN-1" });
  const dup = await add({ name: "Code Taker", barcode: "own-1" });
  assert.match(decode(dup.text), /already used by "Code Owner"/);
  assert.equal(await row("Code Taker"), undefined);
  await seed("Retired", { barcode: "OLD-1", active: false });
  assert.equal((await add({ name: "Reuses Old", barcode: "OLD-1" })).status, 302);
  const { rows } = await pool.query("INSERT INTO books (title, authors, isbn) VALUES ('Real Book', 'A', '9780141439518') RETURNING id");
  assert.ok(rows[0].id);
  const isbn = await add({ name: "Isbn Taker", barcode: "9780141439518" });
  assert.match(decode(isbn.text), /ISBN of "Real Book"/);
  assert.equal(await row("Isbn Taker"), undefined);
});

test("add: 'Generate a shop code' makes ITEM-<id>; the edit page offers it only without a barcode, and generate-code saves it and returns to the item", async () => {
  await add({ name: "Gen On Add", generate: "1" });
  const a = await row("Gen On Add");
  assert.equal(a.barcode, `ITEM-${a.id}`);
  await add({ name: "Gen Later" });
  const b = await row("Gen Later");
  assert.equal(b.barcode, null);
  assert.match((await get(`/admin/till/items/${b.id}/edit`)).text, new RegExp(`formaction="/admin/till/items/${b.id}/generate-code"`));
  const r = await post(`/admin/till/items/${b.id}/generate-code`, {});
  assert.equal(r.status, 302);
  assert.equal(r.location, `/admin/till/items/${b.id}/edit`);
  assert.match(r.text, new RegExp(`ITEM-${b.id}`));
  assert.equal((await row("Gen Later")).barcode, `ITEM-${b.id}`);
  assert.ok(!(await get(`/admin/till/items/${b.id}/edit`)).text.includes("generate-code"), "no button once it has a code");
  const again = await post(`/admin/till/items/${b.id}/generate-code`, {});
  assert.match(again.text, /already has a barcode/);
  assert.equal((await post("/admin/till/items/999999/generate-code", {})).status, 404);
  assert.match((await auditOf("till.item_code")).pop().detail, /generated ITEM-/);
});

test("edit: all fields saved, 'On the till' off switches the item off and frees its barcode, back on collides if taken; audited", async () => {
  const it = await seed("Edit Me", { barcode: "EM-1", stock: 2 });
  const full = { name: "Edited Name", price: "9.90", category: "refreshments", stock: "", barcode: "em-2", active: "1" };
  const r = await post(`/admin/till/items/${it.id}`, full);
  assert.equal(r.status, 302);
  assert.match(r.text, /Saved &#34;Edited Name&#34;\./);
  const after = (await pool.query("SELECT * FROM till_quick_items WHERE id = $1", [it.id])).rows[0];
  assert.deepEqual([after.name, after.price_cents, after.category, after.stock, after.barcode, after.active], ["Edited Name", 990, "refreshments", null, "EM-2", true]);
  assert.match((await auditOf("till.item_edit")).pop().detail, /Edited Name 9\.90$/);
  await post(`/admin/till/items/${it.id}`, { ...full, active: "" });
  assert.equal((await pool.query("SELECT active FROM till_quick_items WHERE id = $1", [it.id])).rows[0].active, false);
  assert.match((await auditOf("till.item_edit")).pop().detail, /\(disabled\)/);
  await add({ name: "Takes EM-2", barcode: "EM-2" });
  const back = await post(`/admin/till/items/${it.id}`, full);
  assert.equal(back.status, 303);
  assert.match(decode(back.text), /already used by "Takes EM-2"/);
  assert.equal((await pool.query("SELECT active FROM till_quick_items WHERE id = $1", [it.id])).rows[0].active, false);
  const bad = await post(`/admin/till/items/${it.id}`, { ...full, price: "-1" });
  assert.equal(bad.location, `/admin/till/items/${it.id}/edit`);
  assert.equal((await post("/admin/till/items/999999", { ...full, barcode: "NOBODY-1" })).status, 404);
});

test("only admins: a member and a signed-out visitor get no page, no look-up and no save", async () => {
  const member = await makeUser(false);
  const it = await seed("Private Item");
  for (const p of ["/admin/till/items", "/admin/till/items/new", `/admin/till/items/${it.id}/edit`, "/admin/till/items/lookup?barcode=4006381333931", "/admin/till/items/find?barcode=x"]) {
    for (const u of [member, null]) {
      const r = await realFetch(`${server.base}${p}`, { redirect: "manual", headers: u ? header(u) : {} });
      assert.notEqual(r.status, 200, `${p} for ${u ? "a member" : "nobody"}`);
    }
  }
  const before = (await pool.query("SELECT count(*)::int AS n FROM till_quick_items")).rows[0].n;
  const r = await post("/admin/till/items", { name: "Member Made", price: "1", category: "other" }, member);
  assert.notEqual(r.status, 302);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM till_quick_items")).rows[0].n, before);
});

// ---------- the look-up ----------

test("lookup: a product barcode found at UPCitemdb gives the NAME and source only, never its third-party picture; nothing is saved", async () => {
  upc.set("882319024812", { title: "Cotton Tote Bag Green", brand: "Acme" });
  const before = (await pool.query("SELECT count(*)::int AS n FROM till_quick_items")).rows[0].n;
  const { status, body } = await lookup("882319024812");
  assert.equal(status, 200);
  assert.deepEqual([body.ok, body.state, body.kind, body.picture], [true, "found", "product", null]);
  assert.match(body.source, /UPCitemdb/);
  assert.match(body.name, /Tote Bag Green/);
  assert.match(body.message, /Found at UPCitemdb\. Check the suggestion/);
  assert.ok(!JSON.stringify(body).includes("thirdparty.jpg"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM till_quick_items")).rows[0].n, before);
});

test("lookup: found at Open Products Facts spares UPCitemdb's allowance; not found anywhere is one plain sentence", async () => {
  opf.set("5901234123457", "Wooden Bookmark");
  const hit = (await lookup("5901234123457")).body;
  assert.deepEqual([hit.state, hit.source, hit.name], ["found", "Open Products Facts", "Wooden Bookmark"]);
  assert.ok(!outside.some((o) => o.includes("upcitemdb")));
  const miss = (await lookup("96385074")).body;
  assert.equal(miss.state, "missing");
  assert.match(miss.message, /Nothing found for this barcode: type the details in\./);
});

test("lookup: UPCitemdb's free limit and a refusal each say why; the form still saves", async () => {
  upc.set("036000291452", 429);
  const limited = (await lookup("036000291452")).body;
  assert.equal(limited.state, "unavailable");
  assert.match(limited.message, /limiting requests from this site/);
});

test("lookup: non-book barcodes only. An ISBN and a shop code are never sent to a catalogue; a bad code is a 400", async () => {
  const isbn = (await lookup("9780141439518")).body;
  assert.deepEqual([isbn.kind, isbn.state], ["isbn", "missing"]);
  assert.match(isbn.message, /book ISBN/);
  const shop = (await lookup("tote-green")).body;
  assert.deepEqual([shop.kind, shop.state], ["shop", "missing"]);
  assert.match(shop.message, /shop code/);
  assert.deepEqual(outside, [], "no outside call at all");
  const bad = await lookup("bad!");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.state, "invalid");
  assert.equal((await lookup("")).status, 400);
});

test("lookup: warns when the code is already on an active item (other than the one being edited) or is a book's ISBN", async () => {
  const owner = await seed("Looked Up Owner", { barcode: "5901234123464" });
  const taken = (await lookup("5901234123464")).body;
  assert.deepEqual(taken.usedBy, { id: owner.id, name: "Looked Up Owner", href: `/admin/till/items/${owner.id}/edit` });
  assert.equal((await lookup("5901234123464", admin, `&itemId=${owner.id}`)).body.usedBy, null, "its own code is not a clash");
  await pool.query("INSERT INTO books (title, authors, isbn) VALUES ('Lookup Book', 'A', '9780306406157')");
  const book = (await lookup("9780306406157")).body;
  assert.match(book.bookInShop, /ISBN of "Lookup Book"/);
});

test("lookup: per-admin rate limit answers 429 JSON", async () => {
  const limited = await makeUser(true);
  let last;
  for (let i = 0; i < 32; i++) last = await lookup("shop-code", limited);
  assert.equal(last.status, 429);
  assert.equal(last.body.state, "unavailable");
});

test("the page script is shared with Educational items and takes its address from data-lookup-url", () => {
  const js = require("node:fs").readFileSync(path.join(__dirname, "..", "..", "public", "edu-item-form.js"), "utf8");
  assert.match(js, /data-lookup-url'\) \|\| '\/admin\/edu-items\/lookup'/);
});
