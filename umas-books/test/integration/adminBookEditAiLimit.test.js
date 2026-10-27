// Saving a book (POST /admin/inventory/:id) writes an AI description when the description box is empty. That path
// is counted against the same per-admin limit as the other AI buttons (10 a minute); a normal save with a
// description typed is never limited.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("book_edit_ai_limit", ["inventory"], { isolated: true });
const { AI_LIMIT_MESSAGE } = require("../../src/middleware/rateLimits");

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
  const { rows } = await h.pool.query("INSERT INTO books (title, authors, description) VALUES ($1, 'Someone', 'old') RETURNING id", [title]);
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

test("saves with an empty description are limited per admin: the 11th in a minute is refused and nothing is changed", async () => {
  const id = await newBook("Empty description");
  let refused = null;
  for (let i = 0; i < 12 && !refused; i++) {
    const r = await h.post(`/admin/inventory/${id}`, { title: `Empty description ${i}`, author: "Someone", description: "" });
    // A refusal is a 303 the harness follows: the book page, with the sentence and what was typed.
    if (r.res.status === 200 && r.text.includes("Empty description 10")) refused = { i, r };
  }
  assert.ok(refused, "a refusal happened");
  assert.equal(refused.i, 10, "the first ten are served");
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&#34;");
  assert.ok(refused.r.text.includes(AI_LIMIT_MESSAGE) || refused.r.text.includes(esc(AI_LIMIT_MESSAGE)), "the page says why");
  const { rows } = await h.pool.query("SELECT title FROM books WHERE id = $1", [id]);
  assert.equal(rows[0].title, "Empty description 9", "the refused save changed nothing");
});

test("while the AI limit is used up, a save with a description still works", async () => {
  const id = await newBook("Still fine");
  const r = await h.post(`/admin/inventory/${id}`, { title: "Still fine", author: "Someone", description: "typed by hand" });
  assert.equal(r.res.status, 302);
});
