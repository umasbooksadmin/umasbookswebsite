// Saving a book's genre through the real routes and database: "Children's Fiction§" (the § key of a Mac ISO keyboard),
// a phone's curly apostrophe, a typo and wrong capitals of a managed genre are stored clean, on edit, on Add Book,
// and while genre rules exist. English only.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("genre_spelling_save", ["inventory"], { isolated: true });
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

async function newBook(title) {
  const { rows } = await h.pool.query("INSERT INTO books (title, authors, description, categories) VALUES ($1, 'Someone', 'd', 'Fiction') RETURNING id", [title]);
  return rows[0].id;
}
async function edit(id, genre) {
  const r = await h.post(`/admin/inventory/${id}`, { title: `Book ${id}`, author: "Someone", description: "d", coverUrl: "/c.png", genre });
  assert.equal(r.res.status, 302, r.text && r.text.slice(0, 300));
  return (await h.pool.query("SELECT categories FROM books WHERE id = $1", [id])).rows[0].categories;
}

for (const [bad, good] of [
  ["Children's Fiction§", "Children's Fiction"],
  ["Children’s Fiction", "Children's Fiction"],
  ["children’s fiction§ ", "Children's Fiction"],
  ["Chidren's Fiction", "Children's Fiction"],
  ["Fantasy§ ,, fantasy, Mystery", "Fantasy, Mystery"],
]) {
  test(`edit: genre ${JSON.stringify(bad)} is stored as ${JSON.stringify(good)}`, async () => {
    assert.equal(await edit(await newBook(`edit ${bad}`), bad), good);
  });
}

test("edit: a managed genre typed with the wrong capitals takes the managed spelling", async () => {
  await h.pool.query("INSERT INTO managed_genres (name_en, sort_order, browse_slug) VALUES ('Art & Design', 900, 'art-design-test')");
  clearAll(h.pool);
  assert.equal(await edit(await newBook("managed"), "art & Design§"), "Art & Design");
});

test("edit while genre rules exist: the cleaned genre still goes through the rules, then the spelling", async () => {
  const { rows: [g] } = await h.pool.query("SELECT id FROM managed_genres WHERE name_en = 'Children''s Fiction'");
  await h.pool.query("INSERT INTO genre_rules (kind, pattern, pattern_key, action, target_managed_genre_id) VALUES ('exact', 'Kids', 'kids', 'map', $1)", [g.id]);
  clearAll(h.pool);
  try {
    assert.equal(await edit(await newBook("with rules"), "Children’s Fiction§"), "Children's Fiction");
    assert.equal(await edit(await newBook("with rules 2"), "Kids§"), "Children's Fiction");
  } finally {
    await h.pool.query("DELETE FROM genre_rules");
    clearAll(h.pool);
  }
});

test("Add Book: a new book with the bad genre is stored clean", async () => {
  const title = `Intake ${h.uniq()}`;
  const r = await h.post("/admin/inventory", { title, condition: "good", status: "in_stock", description: "d", coverUrl: "/c.png", genre: "Children’s Fiction§" });
  assert.equal(r.res.status, 302, r.text && r.text.slice(0, 300));
  const { rows } = await h.pool.query("SELECT categories FROM books WHERE title = $1", [title]);
  assert.equal(rows[0].categories, "Children's Fiction");
});
