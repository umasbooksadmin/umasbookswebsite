#!/usr/bin/env node
// Developer tool: how good and how fast is the ISBN lookup of the scan page, against the REAL
// services (Open Library, the BnF, Google Books)? Runs a fixed list of real ISBNs (both ISBN forms, hyphens,
// French, children's, recent, 979-, mass market ...) one after the other (a pause between books and a longer
// one every 5: be polite to the services) and prints, per ISBN: found or not, the title, which fields are
// missing, the time; then the hit rate and p50/p95.
//
//   node scripts/profile-lookup.js                      the lookup as it is now
//   node scripts/profile-lookup.js --legacy FILE.js     an older lib/bookLookup.js (git show main:... > FILE.js) for a before/after
//
// No database needed. Does not write anything.

const path = require("node:path");
const args = process.argv.slice(2);
const legacyFile = args.includes("--legacy") ? path.resolve(args[args.indexOf("--legacy") + 1]) : null;
const lookup = legacyFile
  ? { run: async (isbn) => { const b = await require(legacyFile).lookupByIsbn(isbn); return { book: b, state: b ? "found" : "notfound", via: ["openlibrary"] }; } }
  : { run: (isbn) => require("../src/lib/bookLookup").lookupByIsbnDetailed(isbn, { cache: false }) };

// [isbn as typed, what it should be (lowercase part of the title) or null when only "something" is expected, kind]
const LIST = [
  ["9780142437230", "don quixote", "classic, 13"], ["9780141439518", "pride and prejudice", "classic, 13"], ["9780061120084", "mockingbird", "US paperback"],
  ["9780547928227", "hobbit", "US paperback"], ["9781400033416", "beloved", "US paperback"], ["9780156027328", "life of pi", "US paperback"],
  ["9780679731726", null, "US paperback"], ["9780385490818", "handmaid", "US paperback"], ["9780451524935", "1984", "mass market"], ["9780743273565", "gatsby", "US paperback"],
  ["0743273567", "gatsby", "ISBN-10"], ["0451524934", "1984", "ISBN-10"], ["0-06-112008-1", "mockingbird", "ISBN-10 hyphenated"], ["978-0-14-143951-8", "pride and prejudice", "ISBN-13 hyphenated"],
  ["9782070612758", "petit prince", "French"], ["9782070360024", "tranger", "French"], ["9782070541270", "harry potter", "French, children's"], ["2070612759", "petit prince", "French, ISBN-10"],
  ["9780399226908", "caterpillar", "children's board book"], ["9780064400558", "charlotte", "children's"], ["9780590353427", "harry potter", "children's US"],
  ["9780747532743", "harry potter", "UK first edition"], ["9781408855652", "harry potter", "UK 2014 edition"], ["9780099518471", "brave new world", "UK paperback"],
  ["9780735219090", "crawdads", "recent hardcover"], ["9780399590504", "educated", "recent hardcover"], ["9780735211292", "atomic habits", "recent"], ["9781649374042", "fourth wing", "recent (2023)"],
  ["9780441172719", "dune", "mass market"], ["9780553293357", "foundation", "mass market"], ["9780345391803", "hitchhiker", "mass market"], ["9780140283297", "on the road", "Penguin paperback"],
  ["9780553213119", null, "obscure paperback"], ["9780140449136", null, "obscure paperback"], ["9798662499577", null, "979-8 self-published"], ["9791032300152", null, "979-10 French"],
];

const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIELDS = ["author", "publisher", "publishedYear", "coverUrl", "description"];

(async () => {
  const times = [];
  let found = 0, right = 0, wrongOrUnknown = 0, complete = 0;
  console.log(`${legacyFile ? "LEGACY" : "NEW"} lookup, ${LIST.length} ISBNs`);
  for (let i = 0; i < LIST.length; i++) {
    const [raw, expect, kind] = LIST[i];
    const digits = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
    const t0 = performance.now();
    const r = await lookup.run(digits);
    const ms = performance.now() - t0;
    times.push(ms);
    const b = r.book;
    const missing = b ? FIELDS.filter((f) => !b[f]) : FIELDS;
    if (b && b.title) {
      found++;
      if (!missing.filter((f) => f !== "description").length) complete++;
      if (expect && b.title.toLowerCase().includes(expect)) right++; else if (expect) wrongOrUnknown++;
    }
    console.log(`${raw.padEnd(18)} ${kind.padEnd(22)} ${(b && b.title ? "FOUND  " : "NOT FOUND(" + r.state + ")").padEnd(9)} ${String(b && b.title || "").slice(0, 34).padEnd(34)} ${String(ms.toFixed(0)).padStart(5)} ms  via ${(r.via || []).join("+") || "-"}  missing: ${missing.join(",") || "-"}${b && expect && !b.title.toLowerCase().includes(expect) ? "  <-- title differs from expected" : ""}`);
    await sleep(i % 5 === 4 ? 3000 : 600);
  }
  const withExpect = LIST.filter((l) => l[1]).length;
  console.log(`\nfound with a title: ${found}/${LIST.length} (${Math.round(100 * found / LIST.length)}%); title matches the expected one: ${right}/${withExpect}; title differs: ${wrongOrUnknown}; with author+publisher+year+cover: ${complete}`);
  console.log(`time: p50 ${pct(times, 50).toFixed(0)} ms, p95 ${pct(times, 95).toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms`);
})();
