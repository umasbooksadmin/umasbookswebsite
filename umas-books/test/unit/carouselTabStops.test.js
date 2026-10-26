// The roving tab stops of the carousels (public/carousel.js tabStops): only items on screen are reachable by Tab.
const test = require("node:test");
const assert = require("node:assert/strict");
const { tabStops } = require("../../public/carousel.js");

const row = (n, w = 100, gap = 20, start = 0) => Array.from({ length: n }, (_, i) => ({ left: start + i * (w + gap), right: start + i * (w + gap) + w }));

test("a 260-card row with 4 cards in view has 4 tab stops, not 260", () => {
  const flags = tabStops(row(260), { left: 0, right: 460 });
  assert.equal(flags.length, 260);
  assert.deepEqual(flags.map((f, i) => (f ? i : -1)).filter((i) => i >= 0), [0, 1, 2, 3]);
});

test("a scrolled row: the cards in the window, and a half-cut card at the edge counts only from half", () => {
  const cards = row(20);                                  // card i at 120 * i .. 120 * i + 100
  assert.deepEqual(tabStops(cards, { left: 240, right: 700 }).map((f, i) => (f ? i : -1)).filter((i) => i >= 0), [2, 3, 4, 5]);
  // card 5 spans 600..700 so it is whole in the view; a view ending at 640 shows 40% of it: not a stop; ending at 660 shows 60%: a stop
  assert.equal(tabStops(cards, { left: 240, right: 640 })[5], false);
  assert.equal(tabStops(cards, { left: 240, right: 660 })[5], true);
});

test("a view between cards never leaves the row with no stop at all", () => {
  const flags = tabStops(row(5, 100, 20), { left: 90, right: 110 });
  assert.equal(flags.filter(Boolean).length, 1);
});

test("zero-width items are never stops; an empty row is fine", () => {
  assert.deepEqual(tabStops([], { left: 0, right: 10 }), []);
  assert.deepEqual(tabStops([{ left: 0, right: 0 }, { left: 5, right: 5 }], { left: 0, right: 10 }).filter(Boolean).length, 1);
});
