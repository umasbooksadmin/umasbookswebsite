"use strict";

// The least "Mark collected and paid" may take for an item (lib/orderActions.js collectionFloorCents) is
// the till's own price rule: a fixed-price NEW book at least 95% of the publisher's price (rounded up to the
// cent, the minimum inv.resolveCopyPricing accepts); a new book published over 2 years ago and a second-hand
// book free (0); a class seat its price. No database needed (the module only requires the pool lazily).
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/never_connected";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectionFloorCents } = require("../../src/lib/orderActions");
const inv = require("../../src/lib/inventory");

const book = (o) => ({ book_copy_id: 1, condition: "new", price: "20.00", publisher_price: "20.00", published_year: null, ...o });

test("a fixed-price new book: 95% of the publisher's price, rounded up, exactly the till's minimum", () => {
  assert.equal(collectionFloorCents(book({})), 1900);
  // every publisher's price from €0.01 to €60.00: the floor is the lowest price resolveCopyPricing accepts
  for (let pub = 1; pub <= 6000; pub += 7) {
    const floor = collectionFloorCents(book({ price: (pub / 100).toFixed(2), publisher_price: (pub / 100).toFixed(2) }));
    assert.equal(inv.resolveCopyPricing("new", (floor / 100).toFixed(2), (pub / 100).toFixed(2)).error, undefined, `pub ${pub}: ${floor} accepted`);
    if (floor > 1) assert.ok(inv.resolveCopyPricing("new", ((floor - 1) / 100).toFixed(2), (pub / 100).toFixed(2)).error, `pub ${pub}: ${floor - 1} refused`);
  }
  assert.equal(collectionFloorCents(book({ price: "15.99", publisher_price: "15.99" })), 1520);
});

test("never above the reserved price; no publisher's price on record: the reserved price (no discount)", () => {
  assert.equal(collectionFloorCents(book({ price: "18.00", publisher_price: "20.00" })), 1800);
  assert.equal(collectionFloorCents(book({ price: "12.00", publisher_price: null })), 1200);
  assert.equal(collectionFloorCents(book({ price: "12.00", publisher_price: "0" })), 1200);
});

test("the 2-year exception applies exactly as at the till (inv.isPublishedOverTwoYearsAgo, Paris date)", () => {
  // 2024 becomes "over 2 years old" on 1 January 2027
  assert.equal(collectionFloorCents(book({ published_year: 2024 }), "2026-12-31"), 1900);
  assert.equal(collectionFloorCents(book({ published_year: 2024 }), "2027-01-01"), 0);
  assert.equal(collectionFloorCents(book({ published_year: 2015 })), 0);
  assert.equal(collectionFloorCents(book({ published_year: null })), 1900, "unknown date: the law applies");
  for (const [y, d] of [[2024, "2026-12-31"], [2024, "2027-01-01"], [2010, "2026-10-27"]]) {
    assert.equal(collectionFloorCents(book({ published_year: y }), d) === 0, inv.isPublishedOverTwoYearsAgo(y, d), `${y} on ${d}`);
  }
});

test("a second-hand book is free-priced (0), a class seat keeps its price", () => {
  for (const condition of ["very_good", "good", "acceptable"]) assert.equal(collectionFloorCents(book({ condition })), 0, condition);
  assert.equal(collectionFloorCents({ book_copy_id: null, class_dropin_seat_id: 3, price: "9.00" }), 900);
});
