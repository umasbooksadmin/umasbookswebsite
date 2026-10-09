// The pricing rules engine (src/lib/pricing/rules.js): pure, table-driven.
// Order of evaluation, first match wins:
//   new -> no ISBN -> (not mass market and value >= 50) review -> clearance
//   -> mass market 5 / trade 5 -> A (< 6) 5 / B (< 20) 10 / C (< 50) 75% rounded -> hardcover floor 10
// (EUR 8 is no longer a price: the standard levels are 3, 5, 10)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { suggestFromRules, referenceFrom, DEFAULT_SETTINGS } = require("../../src/lib/pricing/rules");
const { suggestPrice } = require("../../src/lib/pricing");

const ISBN = "9780140449136";
const S = DEFAULT_SETTINGS;
const rules = (o) => suggestFromRules({ condition: "very_good", isbn: ISBN, settings: S, ...o });
const summary = (r) => [r.ruleSet, r.price];

test("Rule A / B / C boundaries (other bindings), every edge", () => {
  const table = [
    // market value (EUR), expected rule, expected price
    [0, "A", 5], [2, "A", 5], [5, "A", 5], [5.5, "A", 5], [5.99, "A", 5], // the 5.00-5.99 gap belongs to A
    [6, "B", 10], [12, "B", 10], [19.99, "B", 10], // EUR 8 retired: the old Rule B price now rounds up to 10
    [20, "C", 15], [24, "C", 18], [35, "C", 26.5], [49.99, "C", 37.5], // 75% rounded to the nearest 0.50
  ];
  for (const binding of [null, undefined, "other"]) {
    for (const [m, rule, price] of table) {
      const r = rules({ binding, marketEur: m });
      assert.deepEqual(summary(r), [rule, price], `${binding} market ${m}`);
    }
  }
});

test("Rule C rounding: 75% of the value to the nearest 0.50, and the rounding step is a setting", () => {
  assert.equal(rules({ marketEur: 21 }).price, 16); // 15.75 is halfway between 15.5 and 16: rounds up
  assert.equal(rules({ marketEur: 22 }).price, 16.5); // 16.5
  assert.equal(rules({ marketEur: 23 }).price, 17.5); // 17.25 -> 17.5
  assert.equal(rules({ settings: { ...S, roundingStep: 1 }, marketEur: 23 }).price, 17); // step 1: 17.25 -> 17
  assert.equal(rules({ settings: { ...S, cFactor: 0.5 }, marketEur: 30 }).price, 15);
});

test("market value 50 or more is manual review (no price), also just above", () => {
  for (const m of [50, 50.01, 80, 400]) {
    const r = rules({ marketEur: m });
    assert.equal(r.price, null, `market ${m}`);
    assert.equal(r.ruleSet, "review");
    assert.equal(r.needsReview, true);
    assert.match(r.reviewMessage, /^Manual review: online value EUR 50\.00 or more$/);
  }
});

test("no ISBN is manual review, beating every rule except new", () => {
  for (const isbn of [null, undefined, "", "abc", "12345"]) {
    for (const binding of [null, "hardcover", "mass_market"]) {
      const r = rules({ isbn, binding, marketEur: 3, existingCopies: 5 });
      assert.equal(r.price, null);
      assert.equal(r.ruleSet, "review");
      assert.equal(r.reviewMessage, "Manual review: no ISBN barcode");
    }
  }
  // new still takes the publisher's price without an ISBN
  const n = rules({ isbn: "", condition: "new", publisherPrice: 12.5 });
  assert.deepEqual(summary(n), ["new", 12.5]);
});

test("new condition: publisher price, no levels, no clearance, no floor; none without a publisher price", () => {
  const r = rules({ condition: "new", publisherPrice: "9.90", binding: "hardcover", existingCopies: 9, marketEur: 80 });
  assert.deepEqual(summary(r), ["new", 9.9]);
  assert.equal(r.low, 9.41); // loi Lang: at most 5% off
  assert.equal(r.high, 9.9);
  for (const bad of [undefined, null, "", 0, -3, "abc"]) {
    assert.equal(rules({ condition: "new", publisherPrice: bad }), null, `publisher price ${bad}`);
  }
});

test("mass market: EUR 5 whatever it is worth online, even above 50; no ISBN still beats it", () => {
  for (const m of [2, 12, 60, 80]) {
    assert.deepEqual(summary(rules({ binding: "mass_market", marketEur: m })), ["mass_market", 5], `market ${m}`);
  }
  assert.equal(rules({ binding: "mass_market", marketEur: 80, isbn: "" }).ruleSet, "review");
});

test("trade: EUR 5 whatever it is worth online, even above 50; no ISBN still beats it; the price is a setting", () => {
  for (const m of [0, 2, 12, 19.99, 30, 60, 80, null]) {
    assert.deepEqual(summary(rules({ binding: "trade", marketEur: m })), ["trade", 5], `market ${m}`);
  }
  assert.equal(rules({ binding: "trade", marketEur: 80, isbn: "" }).ruleSet, "review");
  assert.equal(rules({ binding: "trade", comparables: [30, 40, 50] }).price, 5);
  assert.equal(rules({ binding: "trade", marketEur: 12, settings: { ...S, tradePrice: 6 } }).price, 6);
  assert.equal(rules({ binding: "mass_market", marketEur: 12, settings: { ...S, tradePrice: 6 } }).price, 5, "trade price does not affect mass market");
  assert.equal(rules({ binding: "trade", marketEur: 12, settings: { ...S, massMarketPrice: 6 } }).price, 5, "mass market price does not affect trade");
});

test("trade and mass market ignore the number of copies except for clearance, and never the condition", () => {
  for (const binding of ["trade", "mass_market"]) {
    for (const n of [0, 1]) assert.equal(rules({ binding, marketEur: 12, existingCopies: n }).price, 5);
    for (const condition of ["like_new", "good", "acceptable", undefined]) assert.equal(rules({ binding, condition, marketEur: 12 }).price, 5);
  }
});

test("levels are 3, 5, 10 and the defaults no longer contain 8", () => {
  assert.deepEqual([...S.levels], [3, 5, 10]);
  assert.equal(S.bPrice, 10);
  assert.deepEqual(S.fallbackEur, { hardcover: 12, trade: 5, mass_market: 5, unknown: 5 });
  assert.equal(S.tradePrice, 5);
  // every suggestion the default rules can make is a standard price, clearance or a Rule C price
  for (const binding of [null, "other", "hardcover", "trade", "mass_market"]) {
    for (const m of [0, 3, 5.99, 6, 7, 8, 9, 12, 19.99]) {
      const p = rules({ binding, marketEur: m }).price;
      assert.ok([5, 10].includes(p), `${binding} ${m} -> ${p}`);
    }
  }
});

test("clearance: with 0/1/2/3/4 copies in stock, Set A and mass market go to EUR 1 from the third copy", () => {
  const cases = [
    // [binding, market value, existing copies, expected rule, price]
    ["other", 3, 0, "A", 5], ["other", 3, 1, "A", 5], ["other", 3, 2, "clearance", 1], ["other", 3, 3, "clearance", 1], ["other", 3, 4, "clearance", 1],
    ["trade", 99, 1, "trade", 5], ["trade", 99, 2, "clearance", 1],
    ["mass_market", 99, 1, "mass_market", 5], ["mass_market", 99, 2, "clearance", 1], ["mass_market", null, 4, "clearance", 1],
    // not Set A: stays at the normal price
    ["other", 12, 3, "B", 10], ["other", 30, 3, "C", 22.5],
  ];
  for (const [binding, m, n, rule, price] of cases) {
    const r = rules({ binding, marketEur: m, existingCopies: n });
    assert.deepEqual(summary(r), [rule, price], `${binding} ${m} with ${n}`);
    assert.equal(r.clearance, rule === "clearance");
  }
  const c = rules({ binding: "other", marketEur: 3, existingCopies: 2 });
  assert.deepEqual(c.normal, { ruleSet: "A", price: 5, level: 5 });
  assert.equal(c.level, "clearance");
});

test("clearance applies-to 'all_sets' extends it to B and C, but never over manual review", () => {
  const s = { ...S, clearance: { ...S.clearance, appliesTo: "all_sets" } };
  assert.deepEqual(summary(rules({ settings: s, marketEur: 12, existingCopies: 2 })), ["clearance", 1]);
  assert.deepEqual(summary(rules({ settings: s, marketEur: 30, existingCopies: 2 })), ["clearance", 1]);
  assert.equal(rules({ settings: s, marketEur: 70, existingCopies: 9 }).ruleSet, "review");
  assert.deepEqual(summary(rules({ settings: s, marketEur: 12, existingCopies: 1 })), ["B", 10]);
});

test("clearance threshold is a setting", () => {
  const s = { ...S, clearance: { ...S.clearance, afterCopies: 4, price: 1.5 } };
  assert.deepEqual(summary(rules({ settings: s, marketEur: 3, existingCopies: 3 })), ["A", 5]);
  assert.deepEqual(summary(rules({ settings: s, marketEur: 3, existingCopies: 4 })), ["clearance", 1.5]);
});

test("hardcover floor: Sets A and B become 10, Set C stays when above 10, the floor is a setting", () => {
  const cases = [[2, 10], [5.99, 10], [6, 10], [19.99, 10], [20, 15], [24, 18], [49.99, 37.5]];
  for (const [m, price] of cases) {
    const r = rules({ binding: "hardcover", marketEur: m });
    assert.equal(r.price, price, `hardcover ${m}`);
    assert.equal(r.floorApplied, m < 6, `floorApplied ${m}`); // from 6 up Rule B is already 10
  }
  // a C price below the floor (only possible with lower thresholds) is raised too
  const low = { ...S, aMax: 1, bMax: 2, cMax: 50, cFactor: 0.25 };
  const r = rules({ settings: low, binding: "hardcover", marketEur: 20 }); // 25% of 20 = 5 < 10
  assert.deepEqual([r.ruleSet, r.price, r.floorApplied], ["C", 10, true]);
  // custom floor
  assert.equal(rules({ settings: { ...S, hardcoverMinPrice: 12 }, binding: "hardcover", marketEur: 8 }).price, 12);
});

test("hardcover and clearance: a hardcover with 2+ copies in stock still goes to EUR 1, unless the setting says otherwise", () => {
  assert.deepEqual(summary(rules({ binding: "hardcover", marketEur: 3, existingCopies: 2 })), ["clearance", 1]);
  const s = { ...S, hardcoverMinAppliesToClearance: true };
  assert.deepEqual(summary(rules({ settings: s, binding: "hardcover", marketEur: 3, existingCopies: 2 })), ["clearance", 10]);
  // the usual price, floored, is what clearance replaces
  assert.deepEqual(rules({ binding: "hardcover", marketEur: 3, existingCopies: 2 }).normal, { ruleSet: "A", price: 10, level: 10 });
});

test("other and unknown binding are unaffected by the floor and the flat prices", () => {
  for (const binding of [null, undefined, "other"]) {
    assert.equal(rules({ binding, marketEur: 3 }).price, 5);
    assert.equal(rules({ binding, marketEur: 12 }).price, 10);
  }
});

test("the value comes from listings: median, outliers trimmed from 4 listings, one listing, original price, fallback by binding", () => {
  const cases = [
    // [options, expected value, source, confidence]
    [{ comparables: [4, 6, 8] }, 6, "median", "medium"],
    [{ comparables: [4, 6] }, 5, "median", "medium"],
    [{ comparables: [5, 6, 7, 8] }, 6.5, "median", "high"],
    [{ comparables: [5, 6, 7, 8, 200] }, 6.5, "median", "high"], // 200 is more than 3x the median: dropped
    [{ comparables: [1, 6, 7, 8, 9] }, 7.5, "median", "high"], // 1 is below a third of the median: dropped
    [{ comparables: [9] }, 9, "single", "medium"],
    [{ comparables: [], originalPrice: 20 }, 7, "original", "medium"], // 20 x 0.35
    [{ comparables: [] }, 5, "fallback", "low"],
    [{ comparables: [], binding: "hardcover" }, 12, "fallback", "low"],
    [{ comparables: [], binding: "trade" }, 5, "fallback", "low"],
    [{ comparables: [], binding: "mass_market" }, 5, "fallback", "low"],
  ];
  for (const [opts, value, source, confidence] of cases) {
    const ref = referenceFrom({ settings: S, ...opts });
    assert.deepEqual([ref.valueEur, ref.source, ref.confidence], [value, source, confidence], JSON.stringify(opts));
  }
  assert.equal(referenceFrom({ settings: S, comparables: [5, 6, 7, 8, 200] }).dropped, 1);
  // two or three listings are never trimmed, however far apart
  assert.equal(referenceFrom({ settings: S, comparables: [1, 100] }).used, 2);
});

test("a rule decision is made from the listings: [5,6,7,8] -> median 6.5 -> Rule B; fallback by binding picks the rule", () => {
  assert.deepEqual(summary(rules({ comparables: [5, 6, 7, 8] })), ["B", 10]);
  assert.deepEqual(summary(rules({ comparables: [2, 3, 4] })), ["A", 5]);
  assert.deepEqual(summary(rules({ comparables: [], binding: "hardcover" })), ["B", 10]); // value 12 -> B (10)
  assert.deepEqual(summary(rules({ comparables: [], binding: "trade" })), ["trade", 5]); // flat price
  assert.deepEqual(summary(rules({ comparables: [], binding: "other" })), ["A", 5]); // fallback 5 -> Rule A
  assert.deepEqual(summary(rules({ comparables: [] })), ["A", 5]);
  assert.deepEqual(summary(rules({ comparables: [], originalPrice: 12 })), ["A", 5]); // 12 x 0.35 = 4.2
});

test("the condition never changes the result", () => {
  for (const o of [{ marketEur: 3 }, { marketEur: 12 }, { marketEur: 30 }, { marketEur: 60 }, { binding: "hardcover", marketEur: 3, existingCopies: 2 }, { binding: "mass_market" }]) {
    const results = ["like_new", "very_good", "acceptable", "good", "fair", "poor", undefined].map((c) => JSON.stringify(rules({ condition: c, ...o })));
    assert.equal(new Set(results).size, 1, JSON.stringify(o));
  }
});

test("range: neighbouring standard prices for A/B, +-20% for Rule C, a single price for clearance", () => {
  const a = rules({ marketEur: 3 });
  assert.deepEqual([a.low, a.high], [3, 10]);
  const b = rules({ marketEur: 12 });
  assert.deepEqual([b.low, b.high], [5, 10]); // nothing higher than the top level
  const c = rules({ marketEur: 30 }); // 22.5
  assert.deepEqual([c.low, c.high], [18, 27]);
  const cl = rules({ marketEur: 3, existingCopies: 2 });
  assert.deepEqual([cl.low, cl.high], [1, 1]);
});

test("every number is a setting: thresholds, prices, factor, step", () => {
  const s = { ...S, aMax: 10, aPrice: 4, bMax: 30, bPrice: 9, cMax: 100, cFactor: 0.5, roundingStep: 1, massMarketPrice: 6, tradePrice: 7 };
  assert.deepEqual(summary(rules({ settings: s, marketEur: 9.99 })), ["A", 4]);
  assert.deepEqual(summary(rules({ settings: s, marketEur: 10 })), ["B", 9]);
  assert.deepEqual(summary(rules({ settings: s, marketEur: 30 })), ["C", 15]);
  assert.deepEqual(summary(rules({ settings: s, marketEur: 101 })), ["review", null]);
  assert.equal(rules({ settings: s, binding: "mass_market" }).price, 6);
  assert.equal(rules({ settings: s, binding: "trade" }).price, 7);
});

test("suggestPrice: names the rule that fired in plain English, never mentions condition as a factor, and never throws", async () => {
  const brokenPool = { query: async () => { throw new Error("db down"); } };
  const r = await suggestPrice(brokenPool, { isbn: ISBN, binding: "trade", condition: "very_good" }, { market: false });
  assert.equal(r.ruleSet, "trade"); // flat price, using the built-in settings
  assert.equal(r.price, 5);
  assert.match(r.rationale.join(" "), /Trade paperbacks are priced at EUR 5\.00/);
  assert.match(r.rationale.join(" "), /condition does not change the price/);
  assert.equal(r.label, "Suggested EUR 5.00 (range 3.00-10.00, high confidence)");
  const o = await suggestPrice(brokenPool, { isbn: ISBN, binding: "other", condition: "very_good" }, { market: false });
  assert.deepEqual([o.ruleSet, o.price], ["A", 5]); // nothing known: fallback 5 -> Rule A
  const h = await suggestPrice(brokenPool, { isbn: ISBN, binding: "hardcover", condition: "very_good" }, { market: false });
  assert.deepEqual([h.ruleSet, h.price], ["B", 10]);
  assert.match(h.rationale.join(" "), /Rule B \(mid-range standard stock\)/);

  const cases = [
    [{ binding: "mass_market" }, /Mass market paperbacks are priced at EUR 5\.00/],
    [{ isbn: "" }, /Manual review: no ISBN barcode/],
    [{ condition: "new", publisherPrice: "14.00" }, /publisher's price, EUR 14\.00/],
  ];
  for (const [input, pattern] of cases) {
    const x = await suggestPrice(brokenPool, { isbn: ISBN, condition: "good", ...input }, { market: false });
    assert.match(x.rationale.join(" "), pattern);
  }
  const cheapHardback = { ...S, fallbackEur: { ...S.fallbackEur, hardcover: 3 } };
  const hb = await suggestPrice(brokenPool, { isbn: ISBN, binding: "hardcover", condition: "good" }, { market: false, settings: cheapHardback });
  assert.match(hb.rationale.join(" "), /Hardback: minimum price EUR 10\.00/);
  const all = { ...S, clearance: { ...S.clearance, appliesTo: "all_sets" } };
  const cl = await suggestPrice(brokenPool, { isbn: ISBN, binding: "other", condition: "good", existingCopies: 2 }, { market: false, settings: all });
  assert.match(cl.rationale.join(" "), /copy no\. 3 of this book in stock, so it is on clearance/);
  assert.match(cl.rationale.join(" "), /Clearance rule/);
  assert.equal(cl.price, 1);
});
