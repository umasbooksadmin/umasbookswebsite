// Saving a book (POST /admin/inventory/:id) never writes an AI description (review 6B M5): an empty description box
// stays empty, so the save is never counted against the per-admin AI limit and never waits for the AI. The owner
// cleared AI-guessed descriptions on purpose (migration 110); saving such a book again must not bring one back.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("book_edit_ai_limit", ["inventory"], { isolated: true });

const realFetch = global.fetch;
let outbound = 0;
before(async () => {
  global.fetch = async (url, opts) => {
    if (String(url).startsWith("http://127.0.0.1")) return realFetch(url, opts);
    outbound += 1;
    throw new Error("no outbound requests in this test");
  };
  await h.start();
});
after(async () => { global.fetch = realFetch; await h.stop(); });

async function newBook(title, description = "old") {
  const { rows } = await h.pool.query("INSERT INTO books (title, authors, description) VALUES ($1, 'Someone', $2) RETURNING id", [title, description]);
  return rows[0].id;
}

test("saves with a description typed are never limited, however many", async () => {
  const id = await newBook("Typed description");
  for (let i = 0; i < 15; i++) {
    const r = await h.post(`/admin/inventory/${id}`, { title: "Typed description", author: "Someone", description: `Text ${i}` });
    assert.equal(r.res.status, 302, `save ${i}`);
    assert.equal(r.res.headers.get("location"), `/admin/inventory/${id}`);
  }
  const { rows } = await h.pool.query("SELECT description FROM books WHERE id = $1", [id]);
  assert.equal(rows[0].description, "Text 14");
});

test("saves with an empty description keep it empty, call no AI and are never limited", async () => {
  const id = await newBook("Empty description", null);
  outbound = 0;
  for (let i = 0; i < 12; i++) {
    const r = await h.post(`/admin/inventory/${id}`, { title: `Empty description ${i}`, author: "Someone", description: "" });
    assert.equal(r.res.status, 302, `save ${i}`);
  }
  const { rows } = await h.pool.query("SELECT title, description FROM books WHERE id = $1", [id]);
  assert.equal(rows[0].title, "Empty description 11", "every save went through");
  assert.equal(rows[0].description, null, "no description was written");
  assert.equal(outbound, 0, "no AI (or any outside) request");
});

test("clearing a description on purpose keeps the book without one", async () => {
  const id = await newBook("Cleared on purpose", "A guessed blurb.");
  const r = await h.post(`/admin/inventory/${id}`, { title: "Cleared on purpose", author: "Someone", description: "" });
  assert.equal(r.res.status, 302);
  const { rows } = await h.pool.query("SELECT description FROM books WHERE id = $1", [id]);
  assert.equal(rows[0].description, null);
});
