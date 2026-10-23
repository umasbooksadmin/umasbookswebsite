// public/carousel.js: the parts of the carousel's scroll maths that do not need a browser (which card is the first of the last
// page, when the next batch is asked for), and the shape of what the component exports. The rest of the component (measured
// card edges, arrows, keys, swipes, batches) is exercised in a real browser by e2e/specs/ci-subset.e2e.js in CI (npm run e2e:ci)
// and by G91 in the full e2e suite.

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../../public/carousel.js");

test("lastStartIndex: the first card of the last page, for pages of `per` cards", () => {
  // 10 cards, 4 per page: pages start at 0, 4, 8
  assert.equal(C.lastStartIndex(10, 4), 8);
  assert.equal(C.lastStartIndex(8, 4), 4, "a full last page starts one page back");
  assert.equal(C.lastStartIndex(9, 4), 8);
  assert.equal(C.lastStartIndex(1, 4), 0, "fewer cards than a page: nothing to scroll to");
  assert.equal(C.lastStartIndex(4, 4), 0);
  assert.equal(C.lastStartIndex(5, 4), 4);
  assert.equal(C.lastStartIndex(60, 1), 59, "one per page (a phone): the last card");
  assert.equal(C.lastStartIndex(60, 5), 55);
  assert.equal(C.lastStartIndex(61, 5), 60, "a batch boundary: 60 cards is 12 full pages, the 61st opens another");
});

test("wantsMoreAt: the next batch is asked for within NEAR_END cards of the last loaded one", () => {
  assert.equal(C.NEAR_END, 3);
  // 60 cards loaded, 4 per page: asked for once the first card in view is 53 or later (53 + 4 + 3 = 60)
  assert.equal(C.wantsMoreAt(52, 4, 60), false);
  assert.equal(C.wantsMoreAt(53, 4, 60), true);
  assert.equal(C.wantsMoreAt(56, 4, 60), true);
  assert.equal(C.wantsMoreAt(0, 4, 60), false, "the start of a long list does not ask");
  assert.equal(C.wantsMoreAt(0, 4, 7), true, "a list that is barely longer than a page asks at once");
  assert.equal(C.wantsMoreAt(0, 1, 60), false);
  assert.equal(C.wantsMoreAt(56, 1, 60), true, "one per page: 56 + 1 + 3 = 60");
  assert.equal(C.wantsMoreAt(55, 1, 60), false);
});

test("a batch boundary never loses a stop: every page start up to the end is reachable and the last one is lastStartIndex", () => {
  for (const per of [1, 2, 3, 4, 5, 6]) {
    for (const count of [1, per, per + 1, 59, 60, 61, 120, 121, 130]) {
      const last = C.lastStartIndex(count, per);
      assert.ok(last >= 0 && last < count, `per ${per}, ${count} cards: ${last} is a card`);
      assert.equal(last % per, 0, `per ${per}, ${count} cards: a page start`);
      assert.ok(last + per >= count, `per ${per}, ${count} cards: the last page reaches the last card`);
    }
  }
});

test("make is exported for page-books.js", () => {
  assert.equal(typeof C.make, "function");
});
