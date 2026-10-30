// "Possible duplicate books" (Admin > Reports): books that look like the same book entered twice. READ ONLY: this
// finds and lists; nothing is merged, moved or changed (merging two books is a decision for a person, because two
// records with the same title and author can be two real editions).
//
// Two books are linked when
//   - they have the same ISBN written as ISBN-10 and as ISBN-13 (the same book; they became two books before the
//     add-book form converted ISBN-10 to ISBN-13), or
//   - they have the same title and author once case, accents, punctuation and spacing are ignored (often the same
//     book entered without an ISBN, or a different edition: only a person can tell).
// Linked books are grouped (A~B and B~C give one group of three) with the reason(s).

const { isbnForms } = require("./bookSources");
const { isValidIsbn } = require("./bookLookup");

function norm(text) {
  return String(text == null ? "" : text)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

// Pure: rows = [{ id, isbn, title, authors, ... }] -> [{ books: [row...], reasons: ["isbn"|"title"] }], biggest first.
function findDuplicateGroups(rows) {
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const links = [];

  const byIsbn = new Map();
  const byTitle = new Map();
  for (const r of rows) {
    const isbn = String(r.isbn || "").replace(/[^0-9Xx]/g, "").toUpperCase();
    if (isbn && isValidIsbn(isbn)) {
      const k = isbnForms(isbn).isbn13;
      (byIsbn.get(k) || byIsbn.set(k, []).get(k)).push(r);
    }
    const t = norm(r.title);
    if (t) {
      const k = `${t}|${norm(r.authors)}`;
      (byTitle.get(k) || byTitle.set(k, []).get(k)).push(r);
    }
  }
  for (const [kind, map] of [["isbn", byIsbn], ["title", byTitle]]) {
    for (const members of map.values()) {
      if (members.length < 2) continue;
      for (const m of members) union(members[0].id, m.id);
      links.push({ kind, ids: members.map((m) => m.id) });
    }
  }
  const groups = new Map();
  for (const r of rows) {
    const root = find(r.id);
    if (!groups.has(root)) groups.set(root, { books: [], reasons: new Set() });
    groups.get(root).books.push(r);
  }
  for (const l of links) groups.get(find(l.ids[0])).reasons.add(l.kind);
  return [...groups.values()]
    .filter((g) => g.books.length > 1)
    .map((g) => ({ books: g.books.sort((a, b) => a.id - b.id), reasons: [...g.reasons].sort() }))
    .sort((a, b) => b.books.length - a.books.length || a.books[0].id - b.books[0].id);
}

async function listDuplicateBooks(db) {
  const { rows } = await db.query(
    `SELECT b.id, b.isbn, b.title, b.authors,
            COUNT(c.id)::int AS copies, COUNT(c.id) FILTER (WHERE c.status = 'in_stock')::int AS in_stock
     FROM books b LEFT JOIN book_copies c ON c.book_id = b.id
     GROUP BY b.id ORDER BY b.id`
  );
  return findDuplicateGroups(rows);
}

module.exports = { findDuplicateGroups, listDuplicateBooks, norm };
