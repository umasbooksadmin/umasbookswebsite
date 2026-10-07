// OPT-IN live check against the real Wikidata SPARQL endpoint. Skipped unless
// WIKIDATA_LIVE=1, so CI and `npm test` never touch the network:
//   WIKIDATA_LIVE=1 node --test test/live/wikidataAwards.live.test.js
// Each lookup can take 10-60 s (retries included); the tests wait patiently.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lookupWikidataAwards } = require("../../src/lib/awards/wikidata");

const live = process.env.WIKIDATA_LIVE === "1";
const UNRELATED = /grammy|golden globe|laureus|oscar|academy award|emmy|brit award|ballon/i;

const CASES = [
  { title: "Beloved", isbn: "9781400033416", expect: /Pulitzer Prize for Fiction/ },
  { title: "Life of Pi", isbn: "9780156027328", expect: /Booker/ },
  { title: "The Remains of the Day", isbn: "9780679731726", expect: /Booker/ },
];

for (const c of CASES) {
  test(`live Wikidata: ${c.title}`, { skip: !live && "set WIKIDATA_LIVE=1 to run", timeout: 240000 }, async () => {
    const res = await lookupWikidataAwards({ isbn: c.isbn }, {});
    console.log(`${c.title}: ${res.items.map((i) => `${i.label}${i.year ? " " + i.year : ""} [${i.kind}]`).join("; ")}`);
    assert.equal(res.error, false, "the lookup must not time out or fail");
    assert.ok(!res.suspicious);
    assert.ok(res.items.some((i) => c.expect.test(i.label)), `expected an award matching ${c.expect}`);
    assert.ok(res.items.length <= 15);
    assert.ok(!res.items.some((i) => UNRELATED.test(i.label)), "no unrelated awards");
  });
}
