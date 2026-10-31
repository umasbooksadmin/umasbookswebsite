// lib/coverSearch.js: ranking and parsing of Open Library candidates (no network).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rank, parseCoverId, coverAddress, candidatesFromEditionList, findCoverCandidates, searchCache } = require("../../src/lib/coverSearch");

test("a cover number is digits only; the address is built from it, never taken from the browser", () => {
  for (const ok of ["1", "9630188", " 42 "]) assert.ok(parseCoverId(ok), ok);
  for (const bad of ["0", "-1", "1e5", "https://x/1", "12 34", "1234567890", "", null, undefined, "١٢"]) assert.equal(parseCoverId(bad), null, String(bad));
  assert.equal(coverAddress(7), "https://covers.openlibrary.org/b/id/7-L.jpg");
  assert.equal(coverAddress(7, "M"), "https://covers.openlibrary.org/b/id/7-M.jpg");
});

test("rank: ISBN matches first, then the book's own publisher and year, then editions before a work's main cover; duplicates collapse", () => {
  const c = (o) => ({ kind: "edition", isbnMatch: false, publisher: null, year: null, ...o });
  const out = rank([
    c({ coverId: 1, kind: "work" }),
    c({ coverId: 2, publisher: "Other", year: 2001 }),
    c({ coverId: 3, publisher: "Picador", year: 1987 }),
    c({ coverId: 4, publisher: "Picador", year: 1990 }),
    c({ coverId: 5, isbnMatch: true, publisher: "Zed", year: 1950 }),
    c({ coverId: 2, kind: "work" }),
  ], { publisher: "picador", year: 1987 });
  assert.deepEqual(out.map((x) => x.coverId), [5, 3, 4, 2, 1]);
  assert.equal(out.find((x) => x.coverId === 2).kind, "edition", "the edition entry wins over the work's");
});

test("editions list: covers -1 or missing are skipped, ISBN-10 and ISBN-13 both count, year read from the date, language from the key", () => {
  const mine = new Set(["9780330298117", "0330298119"]);
  const out = candidatesFromEditionList([
    { key: "/books/OL1M", covers: [-1], publishers: ["A"] },
    { key: "/books/OL2M", covers: [10], publishers: ["P"], publish_date: "March 1987", isbn_10: ["0-330-29811-9"], languages: [{ key: "/languages/eng" }] },
    { key: "/books/OL3M", covers: [11], publishers: ["Q"], isbn_13: ["9780099478331"] },
  ], { title: "T", author_name: ["A. Writer"] }, mine);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { coverId: 10, kind: "edition", title: "T", author: "A. Writer", publisher: "P", year: 1987, language: "eng", isbnMatch: true, editionKey: "OL2M" });
  assert.equal(out[1].isbnMatch, false);
});

test("findCoverCandidates: no title and no ISBN means no request; a failed search says so; at most 8 come back", async () => {
  searchCache.clear();
  let n = 0;
  const none = await findCoverCandidates({ title: "", authors: "", isbn: null }, { fetchImpl: async () => { n++; return new Response("{}"); } });
  assert.equal(none.state, "empty");
  assert.equal(n, 0);
  const down = await findCoverCandidates({ title: "Dune" }, { fetchImpl: async () => new Response("no", { status: 503 }) });
  assert.equal(down.state, "error");
  searchCache.clear();
  const many = { docs: [{ key: "/works/OL1W", title: "Dune", cover_i: 1, editions: { docs: Array.from({ length: 20 }, (_, i) => ({ key: `/books/OL${i}M`, cover_i: 100 + i, publisher: ["P"], publish_year: [2000 + i] })) } }] };
  const full = await findCoverCandidates({ title: "Dune" }, { fetchImpl: async (u) => new Response(JSON.stringify(String(u).includes("/works/") ? { entries: [] } : many)) });
  assert.equal(full.state, "ok");
  assert.equal(full.candidates.length, 8);
});
