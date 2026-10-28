// Saving a book's genre through the real routes and database: "Children's Fiction§" (the § key of a Mac ISO keyboard)
// and "Children’s Fiction" (a phone's curly apostrophe) are saved as "Children's Fiction" / "Fiction jeunesse", with
// the French box empty AND with the French box already holding the bad English (public/book-french.js or the admin
// filled it). Also through the Add Book form, the "Update the French" button's endpoint, and while genre rules exist.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("genre_cleanup_save", ["inventory"], { isolated: true });
const { clearAll } = require("../../src/lib/genreAdmin");

const realFetch = global.fetch;
before(async () => {
  global.fetch = async (url, opts) => {
    if (String(url).startsWith("http://127.0.0.1")) return realFetch(url, opts);
    throw new Error("no outbound requests in this test");
  };
  await h.start();
});
after(async () => { global.fetch = realFetch; await h.stop(); });

const BAD = ["Children's Fiction§", "Children’s Fiction", "children’s fiction§ "];

async function newBook(title) {
  const { rows } = await h.pool.query(
    "INSERT INTO books (title, authors, description, description_fr, categories, categories_fr) VALUES ($1, 'Someone', 'd', 'd', 'Fiction', 'Fiction') RETURNING id", [title]
  );
  return rows[0].id;
}
async function edit(id, genre, genreFr) {
  const r = await h.post(`/admin/inventory/${id}`, { title: `Book ${id}`, author: "Someone", description: "d", descriptionFr: "d", coverUrl: "/c.png", genre, genreFr });
  assert.equal(r.res.status, 302, r.text && r.text.slice(0, 300));
  const { rows } = await h.pool.query("SELECT categories, categories_fr FROM books WHERE id = $1", [id]);
  return rows[0];
}

for (const bad of BAD) {
  test(`edit: genre ${JSON.stringify(bad)}, French box empty -> Children's Fiction / Fiction jeunesse`, async () => {
    const id = await newBook(`empty ${bad}`);
    assert.deepEqual(await edit(id, bad, ""), { categories: "Children's Fiction", categories_fr: "Fiction jeunesse" });
  });

  test(`edit: genre ${JSON.stringify(bad)}, French box pre-filled with the same bad English -> Fiction jeunesse`, async () => {
    const id = await newBook(`prefilled ${bad}`);
    assert.deepEqual(await edit(id, bad, bad), { categories: "Children's Fiction", categories_fr: "Fiction jeunesse" });
  });
}

test("edit: a French box with real French and a stray § keeps the French, without the §", async () => {
  const id = await newBook("real french");
  assert.deepEqual(await edit(id, "Gothic§, Mystery", "Roman gothique§, Policier"), { categories: "Gothic, Mystery", categories_fr: "Roman gothique, Policier" });
});

test("edit: a managed genre outside the fixed list (Health & Wellness) gets its managed French", async () => {
  const id = await newBook("managed");
  assert.deepEqual(await edit(id, "health & wellness§", "Health & Wellness§"), { categories: "Health & Wellness", categories_fr: "Santé & Bien-être" });
});

test("edit while genre rules exist: the cleaned genre still goes through the rules", async () => {
  const { rows: [g] } = await h.pool.query("SELECT id FROM managed_genres WHERE name_en = 'Children''s Fiction'");
  await h.pool.query("INSERT INTO genre_rules (kind, pattern, pattern_key, action, target_managed_genre_id) VALUES ('exact', 'Kids', 'kids', 'map', $1)", [g.id]);
  clearAll(h.pool); // the rules are cached (as Admin > Genres does after a change)
  try {
    const id = await newBook("with rules");
    assert.deepEqual(await edit(id, "Children’s Fiction§", "Children’s Fiction§"), { categories: "Children's Fiction", categories_fr: "Fiction jeunesse" });
    const id2 = await newBook("with rules 2");
    assert.deepEqual(await edit(id2, "Kids§", ""), { categories: "Children's Fiction", categories_fr: "Fiction jeunesse" });
  } finally {
    await h.pool.query("DELETE FROM genre_rules");
    clearAll(h.pool);
  }
});

test("Add Book: a new book with the bad genre is stored clean", async () => {
  const title = `Intake ${h.uniq()}`;
  const r = await h.post("/admin/inventory", { title, condition: "good", status: "in_stock", description: "d", descriptionFr: "d", coverUrl: "/c.png", genre: "Children’s Fiction§", genreFr: "Children's Fiction§" });
  assert.equal(r.res.status, 302, r.text && r.text.slice(0, 300));
  const { rows } = await h.pool.query("SELECT categories, categories_fr FROM books WHERE title = $1", [title]);
  assert.deepEqual(rows[0], { categories: "Children's Fiction", categories_fr: "Fiction jeunesse" });
});

test("the \"Update the French from the English\" button's endpoint translates the bad genre too", async () => {
  for (const bad of BAD) {
    const r = await h.post("/admin/inventory/translate-french", { genre: bad, description: "" });
    assert.equal(r.res.status, 200);
    assert.equal(JSON.parse(r.text).genreFr, "Fiction jeunesse", bad);
  }
});
