// Combo boxes that accept new text but also show the existing ones (2026-11-08), end to end on the real app and database:
//   - Educational items: the Genre field of the item form is a text input with a <datalist> of the existing genres. Saving
//     matches the typed text to a genre without regard to case or spacing, else CREATES the genre (same rules as the list
//     page's "New genre"), in the same transaction as the item; both are audited; empty = no genre; refusals keep the
//     typed values and save nothing; the new genre shows on the customer page's filter buttons.
//   - Other stock: a NEW free-text Type (migration 118, till_quick_items.item_type), separate from the accounting Category,
//     with a datalist of the types in use; case-insensitive reuse of the stored spelling; shown in the list; the list's
//     Search finds by name, type or category label.
//   - Both lists' search boxes find by type (genre for Educational items). Port 5116.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");

let h;
before(async () => { h = await tillHarness({ port: 5116, ip: "10.51.16.1" }); });
after(async () => { await h.stop(); });

const q = (sql, p = []) => h.pool.query(sql, p).then((r) => r.rows);
const eduForm = (extra) => ({ name: `Combo ${h.uniq()}`, price: "3,50", stock: "4", ...extra });
const genreCount = async () => (await q("SELECT COUNT(*)::int AS n FROM edu_genres"))[0].n;

test("edu form: the Genre field is a labelled combo box with a datalist of the existing genres and a help line", async () => {
  for (const path of ["/admin/edu-items/new"]) {
    const { text } = await h.get(path);
    assert.match(text, /<label for="edu-genre">Genre<\/label>/);
    assert.match(text, /<input id="edu-genre" name="genre" type="text" list="edu-genre-list"[^>]*aria-describedby="edu-genre-help"/);
    assert.doesNotMatch(text, /<select id="edu-genre"/);
    const list = text.slice(text.indexOf('<datalist id="edu-genre-list">'), text.indexOf("</datalist>"));
    for (const g of await q("SELECT name FROM edu_genres")) assert.ok(list.includes(`<option value="${g.name}">`), `datalist lists ${g.name}`);
    assert.match(text, /Pick one of the list or type a new one: a new one is added to the genres automatically/);
  }
});

test("edu: an existing genre typed in any case / spacing is reused; no genre is created", async () => {
  const before = await genreCount();
  const name = `Reuse ${h.uniq()}`;
  await h.post("/admin/edu-items", eduForm({ name, genre: "  wORKsheets " }));
  const it = (await q("SELECT i.genre_id, g.name AS gname FROM edu_items i JOIN edu_genres g ON g.id = i.genre_id WHERE i.name = $1", [name]))[0];
  assert.equal(it.gname, "Worksheets");
  assert.equal(await genreCount(), before);
});

test("edu: a new genre text creates the genre (colour, icon, slug, appended order) with the item, audits both, and shows on the customer page", async () => {
  const name = `NewGenre ${h.uniq()}`;
  const last = (await q("SELECT sort_order FROM edu_genres ORDER BY sort_order DESC LIMIT 1"))[0].sort_order;
  const res = await h.post("/admin/edu-items", eduForm({ name, genre: "Puppet   Shows" }));
  assert.match(await res.text(), /The new genre &#34;Puppet Shows&#34; was added too\./);
  const g = (await q("SELECT * FROM edu_genres WHERE name = 'Puppet Shows'"))[0];
  assert.equal(g.slug, "puppet-shows");
  assert.equal(g.icon, "book");
  assert.ok(g.colour);
  assert.equal(g.sort_order, last + 1);
  const it = (await q("SELECT genre_id FROM edu_items WHERE name = $1", [name]))[0];
  assert.equal(it.genre_id, g.id);
  assert.ok((await h.audit("edu_genre.add")).some((a) => a.target_id === g.id && /Puppet Shows/.test(a.detail)));
  assert.match((await h.audit("edu_item.add")).pop().detail, /genre Puppet Shows/);
  // The same text again reuses it (case-insensitive), and the form now lists it.
  await h.post("/admin/edu-items", eduForm({ genre: "puppet shows" }));
  assert.equal((await q("SELECT COUNT(*)::int AS n FROM edu_genres WHERE lower(name) = 'puppet shows'"))[0].n, 1);
  assert.match((await h.get("/admin/edu-items/new")).text, /<option value="Puppet Shows">/);
  // Customer page: the item is shown, and the genre has a filter button.
  await q("UPDATE edu_items SET is_hidden = false WHERE name = $1", [name]);
  const page = (await h.get("/educational-items.html")).text;
  assert.match(page, /genre=puppet-shows/);
  assert.match(page, new RegExp(name));
});

test("edu: editing shows the current genre in the box, keeps it, changes it, creates on edit, and clears it when emptied", async () => {
  const name = `Edit ${h.uniq()}`;
  await h.post("/admin/edu-items", eduForm({ name, genre: "Worksheets" }));
  const it = (await q("SELECT * FROM edu_items WHERE name = $1", [name]))[0];
  assert.match((await h.get(`/admin/edu-items/${it.id}/edit`)).text, /id="edu-genre" name="genre"[^>]*value="Worksheets"/);
  const form = (genre) => ({ name, price: "3,50", stock: "4", genre });
  await h.post(`/admin/edu-items/${it.id}`, form("worksheets"));
  assert.equal((await q("SELECT genre_id FROM edu_items WHERE id = $1", [it.id]))[0].genre_id, it.genre_id, "kept");
  assert.match((await h.audit("edu_item.edit")).pop().detail, /no change/);
  await h.post(`/admin/edu-items/${it.id}`, form("Brand New On Edit"));
  const g = (await q("SELECT id FROM edu_genres WHERE name = 'Brand New On Edit'"))[0];
  assert.equal((await q("SELECT genre_id FROM edu_items WHERE id = $1", [it.id]))[0].genre_id, g.id);
  assert.match((await h.audit("edu_item.edit")).pop().detail, /genre -> Brand New On Edit/);
  assert.ok((await h.audit("edu_genre.add")).some((a) => a.target_id === g.id));
  await h.post(`/admin/edu-items/${it.id}`, form(""));
  assert.equal((await q("SELECT genre_id FROM edu_items WHERE id = $1", [it.id]))[0].genre_id, null, "empty = no genre");
  assert.match((await h.audit("edu_item.edit")).pop().detail, /genre removed/);
});

test("edu: a too-long genre is refused with the typed values kept and nothing saved (no item, no genre)", async () => {
  const name = `TooLong ${h.uniq()}`;
  const before = await genreCount();
  const long = "G".repeat(61);
  const res = await h.post("/admin/edu-items", eduForm({ name, genre: long }));
  const text = await res.text();
  assert.match(text, /A genre name is limited to 60 characters\. Nothing was saved\./);
  assert.ok(text.includes(`value="${name}"`) && text.includes(`value="${long}"`) , "typed values are back in the form");
  assert.equal((await q("SELECT 1 FROM edu_items WHERE name = $1", [name])).length, 0);
  assert.equal(await genreCount(), before);
});

test("edu: a failing item save does not leave the new genre behind (same transaction)", async () => {
  const before = await genreCount();
  // A barcode already used by another item is refused before the transaction; force a failure inside it instead.
  const name = `Atomic ${h.uniq()}`;
  await q("CREATE OR REPLACE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql");
  await q("CREATE TRIGGER boom_t BEFORE INSERT ON edu_items FOR EACH ROW WHEN (NEW.name LIKE 'Atomic %') EXECUTE FUNCTION boom()");
  try {
    const res = await h.post("/admin/edu-items", eduForm({ name, genre: "Should Roll Back" }));
    assert.equal(res.status, 500);
  } finally {
    await q("DROP TRIGGER boom_t ON edu_items");
  }
  assert.equal(await genreCount(), before);
  assert.equal((await q("SELECT 1 FROM edu_genres WHERE name = 'Should Roll Back'")).length, 0);
});

test("edu list: the search finds by name or by genre (type), the placeholder says so", async () => {
  const name = `Findable ${h.uniq()}`;
  await h.post("/admin/edu-items", eduForm({ name, genre: "Zebra Crossing Games" }));
  const page = (await h.get("/admin/edu-items")).text;
  assert.match(page, /<label for="edu-search-name">Search by name<\/label>/);
  assert.match(page, /placeholder="Part of the name or type \(genre\)"/);
  const byGenre = (await h.get("/admin/edu-items?q=zebra%20CROSSING")).text;
  assert.match(byGenre, new RegExp(name));
  const byName = (await h.get(`/admin/edu-items?q=${encodeURIComponent(name.toUpperCase())}`)).text;
  assert.match(byName, new RegExp(name));
  assert.match((await h.get("/admin/edu-items?q=qqqqnothing")).text, /No item matches/);
});

// ---------------------------------------------------------------- Other stock

const stockForm = (extra) => ({ name: `Stock ${h.uniq()}`, price: "5", category: "merchandise", stock: "", ...extra });
const typeOf = async (name) => (await q("SELECT item_type FROM till_quick_items WHERE name = $1", [name]))[0].item_type;

test("migration 118: item_type is nullable, trimmed and length-limited by the database", async () => {
  const col = (await q("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'till_quick_items' AND column_name = 'item_type'"))[0];
  assert.equal(col.is_nullable, "YES");
  const ins = (t) => h.pool.query("INSERT INTO till_quick_items (name, price_cents, category, item_type) VALUES ('Mig', 100, 'other', $1)", [t]);
  await assert.rejects(ins(" padded"), /check/i);
  await assert.rejects(ins(""), /check/i);
  await assert.rejects(ins("x".repeat(61)), /check/i);
  await ins(null);
  await ins("x".repeat(60));
  await q("DELETE FROM till_quick_items WHERE name = 'Mig'");
});

test("other stock form: a Type combo box (datalist of the types in use) next to the unchanged accounting Category select", async () => {
  await h.post("/admin/till/items", stockForm({ itemType: "Tote bags" }));
  await h.post("/admin/till/items", stockForm({ itemType: "Bookmarks" }));
  const { text } = await h.get("/admin/till/items/new");
  assert.match(text, /<label for="stock-type">Type \(optional\)<\/label>/);
  assert.match(text, /<input id="stock-type" name="itemType" type="text" list="stock-type-list"[^>]*aria-describedby="stock-type-help"/);
  const list = text.slice(text.indexOf('<datalist id="stock-type-list">'), text.indexOf("</datalist>"));
  assert.ok(list.includes('<option value="Tote bags">') && list.includes('<option value="Bookmarks">'));
  assert.match(text, /Pick one of the list or type a new one/);
  assert.match(text, /<label for="stock-cat">Category \(accounting\)<\/label>\s*<select id="stock-cat" name="category">/);
});

test("other stock: a new type is stored as typed (spaces collapsed); a case/space variant reuses the stored spelling; empty = none; audited", async () => {
  const a = stockForm({ itemType: "  Wall   Calendars " });
  await h.post("/admin/till/items", a);
  assert.equal(await typeOf(a.name), "Wall Calendars");
  const b = stockForm({ itemType: "wall CALENDARS" });
  await h.post("/admin/till/items", b);
  assert.equal(await typeOf(b.name), "Wall Calendars", "reuses the existing spelling");
  const c = stockForm({ itemType: "" });
  await h.post("/admin/till/items", c);
  assert.equal(await typeOf(c.name), null);
  assert.equal((await q("SELECT COUNT(DISTINCT item_type)::int AS n FROM till_quick_items WHERE lower(item_type) = 'wall calendars'"))[0].n, 1);
  assert.match((await h.audit("till.item_add")).find((x) => /Wall Calendars/.test(x.detail || "")).detail, /type Wall Calendars/);
});

test("other stock: validation keeps the typed values and saves nothing; the category stays a closed list", async () => {
  const f = stockForm({ itemType: "T".repeat(61) });
  const res = await h.post("/admin/till/items", f);
  const text = await res.text();
  assert.match(text, /The type is limited to 60 characters\./);
  assert.ok(text.includes(`value="${"T".repeat(61)}"`) && text.includes(`value="${f.name}"`));
  assert.equal((await q("SELECT 1 FROM till_quick_items WHERE name = $1", [f.name])).length, 0);
  const free = stockForm({ category: "Tote bags" });
  assert.match(await (await h.post("/admin/till/items", free)).text(), /Choose a category\./);
});

test("other stock: edit shows the type, keeps it, changes it, clears it; the type is in the list; audited", async () => {
  const f = stockForm({ itemType: "Postcards" });
  await h.post("/admin/till/items", f);
  const row = (await q("SELECT id FROM till_quick_items WHERE name = $1", [f.name]))[0];
  assert.match((await h.get(`/admin/till/items/${row.id}/edit`)).text, /id="stock-type" name="itemType"[^>]*value="Postcards"/);
  const save = (itemType) => h.post(`/admin/till/items/${row.id}`, { name: f.name, price: "5", category: "merchandise", stock: "", active: "1", itemType });
  await save("postcards");
  assert.equal(await typeOf(f.name), "Postcards");
  const list = (await h.get("/admin/till/items")).text;
  assert.match(list, /<th scope="col">Type<\/th><th scope="col">Category<\/th>/);
  assert.match(list, /<td>Postcards<\/td>\s*<td>Merchandise<\/td>/);
  await save("Greeting cards");
  assert.equal(await typeOf(f.name), "Greeting cards");
  assert.match((await h.audit("till.item_edit")).pop().detail, /type Greeting cards/);
  await save("");
  assert.equal(await typeOf(f.name), null);
});

test("other stock list: Search finds by name, by type, or by the category label (any case, any words)", async () => {
  const n1 = `Sturdy Thing ${h.uniq()}`;
  const n2 = `Plain Thing ${h.uniq()}`;
  await h.post("/admin/till/items", stockForm({ name: n1, itemType: "Canvas Satchels", category: "refreshments" }));
  await h.post("/admin/till/items", stockForm({ name: n2, itemType: "", category: "donation" }));
  const page = (await h.get("/admin/till/items")).text;
  assert.match(page, /placeholder="Part of the name, type or category"/);
  assert.match(page, /<label for="stock-search-name">Search by name<\/label>/);
  const find = async (term) => (await h.get(`/admin/till/items?q=${encodeURIComponent(term)}`)).text;
  let t = await find("satchels");
  assert.ok(t.includes(n1) && !t.includes(n2), "by type");
  t = await find("canvas THING");
  assert.ok(t.includes(n1) && !t.includes(n2), "words may be in the name and the type");
  t = await find("refreshments");
  assert.ok(t.includes(n1) && !t.includes(n2), "by category label");
  t = await find("Donation");
  assert.ok(t.includes(n2) && !t.includes(n1), "by category label");
  t = await find(n2.toLowerCase());
  assert.ok(t.includes(n2) && !t.includes(n1), "by name");
  assert.match(await find("zzzzqq"), /No item matches/);
  assert.ok(!(await find("%")).includes(n1), "a typed % is not a wildcard");
});

test("the till screen is unchanged: the Type does not appear on the till", async () => {
  const f = stockForm({ itemType: "Hidden From Till Screen" });
  await h.post("/admin/till/items", f);
  const till = (await h.get("/admin/till")).text;
  assert.ok(till.includes(f.name) || !till.includes("Hidden From Till Screen"));
  assert.doesNotMatch(till, /Hidden From Till Screen/);
});
