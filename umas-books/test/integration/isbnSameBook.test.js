// Review 5, item C: the add-book form keeps ONE book per ISBN (ISBN-10 and ISBN-13 are the same book), refuses junk
// ISBNs and oversized text, and the read-only "Possible duplicate books" report lists existing duplicates
// without changing anything.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");
const { findDuplicateGroups } = require("../../src/lib/duplicateBooks");

const h = adminHarness("isbn_same_book", ["priceSuggestions", "inventory", "duplicateBooks", "reports"], { isolated: true });
before(() => h.start());
after(() => h.stop());

// 0-14-312755-0 / 978-0-14-312755-0 -> valid pair (checked below by the code under test)
const ISBN13 = "9780143127550";
const ISBN10 = "0143127551";

const add = (fields) => h.post("/admin/inventory", { title: "Pair Book", condition: "good", status: "in_stock", description: "d", coverUrl: "/c.png", priceLevel: "5", ...fields });
const bookCount = async (like) => (await h.q("SELECT COUNT(*)::int n FROM books WHERE title = $1", [like]))[0].n;

test("an ISBN-10 and the ISBN-13 of the same book are one book with two copies, stored as ISBN-13", async () => {
  const first = await add({ title: "Pair Book", isbn: ISBN10 });
  assert.equal(first.res.status, 302, first.text.slice(0, 200));
  const second = await add({ title: "Pair Book", isbn: ISBN13 });
  assert.equal(second.res.status, 302);
  assert.equal(await bookCount("Pair Book"), 1);
  const [b] = await h.q("SELECT id, isbn FROM books WHERE title = 'Pair Book'");
  assert.equal(b.isbn, ISBN13);
  assert.equal((await h.q("SELECT COUNT(*)::int n FROM book_copies WHERE book_id = $1", [b.id]))[0].n, 2);
});

test("a copy added by ISBN-13 goes to an EXISTING book stored under its ISBN-10 (older data)", async () => {
  const [old] = await h.q("INSERT INTO books (isbn, title) VALUES ('0306406152', 'Old Ten') RETURNING id");
  const r = await add({ title: "Old Ten", isbn: "9780306406157" });
  assert.equal(r.res.status, 302);
  assert.equal(await bookCount("Old Ten"), 1);
  assert.equal((await h.q("SELECT COUNT(*)::int n FROM book_copies WHERE book_id = $1", [old.id]))[0].n, 1);
});

test("junk ISBNs are refused with a message and nothing is saved; no ISBN at all is still fine", async () => {
  for (const bad of ["12", "9780143127551", "abc", "0143127552"]) {
    const r = await add({ title: `Junk ${bad}`, isbn: bad });
    assert.equal(r.res.status, 200, bad); // the refused form, shown again (Post/Redirect/Get followed by the harness)
    assert.match(r.text, /That ISBN is not valid/, bad);
    assert.equal(await bookCount(`Junk ${bad}`), 0, bad);
  }
  const none = await add({ title: "No Isbn Book", isbn: "" });
  assert.equal(none.res.status, 302);
  assert.equal(await bookCount("No Isbn Book"), 1);
});

test("oversized text is refused with a clear message (a 50,000-character title is not saved)", async () => {
  const r = await add({ title: "x".repeat(50000), isbn: "" });
  assert.equal(r.res.status, 200);
  assert.equal((await h.q("SELECT COUNT(*)::int n FROM books WHERE length(title) > 1000"))[0].n, 0);
  assert.match(r.text, /Title is too long \(50000 characters; the most allowed is 300\)/);
  for (const field of [["author", "Author"], ["publisher", "Publisher"], ["description", "Description"], ["copyNotes", "Copy notes"]]) {
    const long = await add({ title: `Long ${field[0]}`, isbn: "", [field[0]]: "y".repeat(6000) });
    assert.equal(long.res.status, 200, field[0]);
    assert.match(long.text, /is too long/, field[0]);
    assert.equal(await bookCount(`Long ${field[0]}`), 0, field[0]);
  }
  const ok = await add({ title: "t".repeat(300), isbn: "" });
  assert.equal(ok.res.status, 302, "exactly the limit is accepted");
});

test("duplicates report: finds ISBN-10/13 pairs and same title+author, links both books, changes nothing", async () => {
  const mk = async (isbn, title, authors) => (await h.q("INSERT INTO books (isbn, title, authors) VALUES ($1, $2, $3) RETURNING id", [isbn, title, authors]))[0].id;
  const a = await mk("0553213113", "Moby Dick", "Herman Melville");
  const b = await mk("9780553213119", "Moby-Dick", "Herman  Melville");
  const c = await mk(null, "Écume Du Jour", "Boris Vian");
  const d = await mk(null, "ecume du jour", "boris vian");
  const lone = await mk("9780140449136", "Lonely Unique Book", "Nobody");
  const beforeRows = await h.q("SELECT id, isbn, title FROM books ORDER BY id");
  const page = await h.get("/admin/reports/possible-duplicate-books");
  assert.equal(page.res.status, 200);
  for (const id of [a, b, c, d]) assert.ok(page.text.includes(`/admin/inventory/${id}"`), `book ${id} linked`);
  assert.ok(!page.text.includes(`/admin/inventory/${lone}"`));
  assert.match(page.text, /same ISBN \(10 and 13 forms\)/);
  assert.match(page.text, /same title and author/);
  assert.deepEqual(await h.q("SELECT id, isbn, title FROM books ORDER BY id"), beforeRows, "read only");
  const notAdmin = await h.get("/admin/reports/possible-duplicate-books", h.member);
  assert.equal(notAdmin.res.status, 403);
  assert.match((await h.get("/admin/reports")).text, /Possible duplicate books/);
});

test("findDuplicateGroups: groups chain together, different ISBNs with different titles are not linked", () => {
  const rows = [
    { id: 1, isbn: "0143127551", title: "A", authors: "X" },
    { id: 2, isbn: "9780143127550", title: "B", authors: "Y" },
    { id: 3, isbn: null, title: "b", authors: "y" },
    { id: 4, isbn: "9780140449136", title: "C", authors: "Z" },
  ];
  const g = findDuplicateGroups(rows);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].books.map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(g[0].reasons, ["isbn", "title"]);
});
