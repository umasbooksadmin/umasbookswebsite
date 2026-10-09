// Pricing settings (src/lib/pricing/settings.js): form validation and the 60 s cache.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { validateSettingsInput, getSettings, getSettingsAndRow, clearSettingsCache, rowToSettings, CACHE_MS, NUMBER_FIELDS } = require("../../src/lib/pricing/settings");
const { DEFAULT_SETTINGS } = require("../../src/lib/pricing/rules");

// The form as the page would send it with the default values.
const GOOD = {
  levels: "3, 5, 10", mass_market_price: "5", trade_price: "5", hardcover_min_price: "10", a_max: "6", a_price: "5", b_max: "20", b_price: "10",
  c_max: "50", c_factor: "0.75", used_fraction: "0.35", rounding_step: "0.5",
  fallback_hardcover: "12", fallback_trade: "5", fallback_mass_market: "5", fallback_unknown: "5",
  usd_eur: "0.92", gbp_eur: "1.15", clearance_after_copies: "2", clearance_price: "1",
  clearance_scope: "extra", clearance_applies_to: "set_a",
};

const row = (over = {}) => ({
  levels: [3, 5, 10], mass_market_price: "5.00", trade_price: "5.00", hardcover_min_price: "10.00", hardcover_min_applies_to_clearance: false,
  a_max: "6.00", a_price: "5.00", b_max: "20.00", b_price: "10.00", c_max: "50.00", c_factor: "0.75", used_fraction: "0.35", rounding_step: "0.50",
  fallback_hardcover: "12.00", fallback_trade: "5.00", fallback_mass_market: "5.00", fallback_unknown: "5.00",
  usd_eur: "0.9200", gbp_eur: "1.1500", clearance_after_copies: 2, clearance_price: "1.00", clearance_scope: "extra", clearance_applies_to: "set_a", ...over,
});

beforeEach(clearSettingsCache);

test("the default form is valid and maps to the defaults", () => {
  const { values, error } = validateSettingsInput(GOOD);
  assert.equal(error, undefined);
  assert.deepEqual(values.levels, [3, 5, 10]);
  assert.equal(values.trade_price, 5);
  assert.equal(values.a_max, 6);
  assert.equal(values.hardcover_min_applies_to_clearance, false);
  assert.deepEqual(rowToSettings(row()), { ...DEFAULT_SETTINGS, levels: [3, 5, 10], fallbackEur: { ...DEFAULT_SETTINGS.fallbackEur }, clearance: { ...DEFAULT_SETTINGS.clearance } });
});

test("a tick box is only sent when ticked; commas work as decimal separators", () => {
  assert.equal(validateSettingsInput({ ...GOOD, hardcover_min_applies_to_clearance: "1" }).values.hardcover_min_applies_to_clearance, true);
  assert.equal(validateSettingsInput({ ...GOOD, c_factor: "0,8", a_price: "4,5" }).values.c_factor, 0.8);
});

test("the market-value limits must go up: a_max < b_max < c_max", () => {
  for (const bad of [{ a_max: "20" }, { a_max: "25" }, { b_max: "50" }, { b_max: "60" }, { a_max: "30", b_max: "20" }]) {
    const { error } = validateSettingsInput({ ...GOOD, ...bad });
    assert.match(error, /limits must go up/, JSON.stringify(bad));
  }
  assert.equal(validateSettingsInput({ ...GOOD, a_max: "19.99" }).error, undefined);
});

test("every number is range-checked, with plain-English messages, all problems at once", () => {
  const bad = {
    c_factor: "1.5", used_fraction: "0", hardcover_min_price: "101", clearance_after_copies: "21", clearance_price: "0.1", mass_market_price: "51", trade_price: "0.1",
    a_price: "abc", rounding_step: "", usd_eur: "9", fallback_unknown: "0",
  };
  const { error } = validateSettingsInput({ ...GOOD, ...bad });
  for (const label of ["Rule C: share of the market value", "Used value as a share", "Hardback minimum price", "Clearance: copies already in stock", "Clearance price", "Mass market price", "Trade price (EUR)", "Rule A: price", "Round Rule C prices", "1 US dollar", "binding unknown"]) {
    assert.ok(error.includes(label), `mentions ${label}: ${error}`);
  }
  // edges that are allowed
  for (const ok of [{ c_factor: "0.2" }, { c_factor: "1" }, { clearance_after_copies: "1" }, { clearance_after_copies: "20" }, { clearance_price: "0.5" }, { clearance_price: "5" }, { mass_market_price: "0.5" }, { mass_market_price: "50" }, { trade_price: "0.5" }, { trade_price: "50" }, { hardcover_min_price: "1" }, { hardcover_min_price: "100" }]) {
    assert.equal(validateSettingsInput({ ...GOOD, ...ok }).error, undefined, JSON.stringify(ok));
  }
  assert.match(validateSettingsInput({ ...GOOD, clearance_after_copies: "2.5" }).error, /whole number/);
  assert.ok(NUMBER_FIELDS.every((f) => f.min < f.max));
});

test("enumerations must be one of the options", () => {
  assert.match(validateSettingsInput({ ...GOOD, clearance_scope: "everything" }).error, /Clearance applies to/);
  assert.match(validateSettingsInput({ ...GOOD, clearance_applies_to: "" }).error, /Clearance rule covers/);
  assert.equal(validateSettingsInput({ ...GOOD, clearance_scope: "all", clearance_applies_to: "all_sets" }).error, undefined);
});

test("standard prices: 2 to 8, strictly increasing, positive", () => {
  for (const bad of ["", "5", "3, 3, 5", "8, 5, 3", "3, x", "0, 5", "3 5 8 10 12 15 20 25 30", "0.1, 5"]) {
    assert.match(validateSettingsInput({ ...GOOD, levels: bad }).error, /Standard prices/, JSON.stringify(bad));
  }
  assert.deepEqual(validateSettingsInput({ ...GOOD, levels: "1;3 5,8" }).values.levels, [1, 3, 5, 8]);
});

test("settings are cached for 60 seconds and read again afterwards or after a save clears the cache", async () => {
  let reads = 0;
  let current = row();
  const pool = { query: async () => { reads += 1; return { rows: [current] }; } };
  const t0 = 1_000_000;
  assert.equal((await getSettings(pool, t0)).aPrice, 5);
  current = row({ a_price: "6.00" });
  assert.equal((await getSettings(pool, t0 + CACHE_MS - 1)).aPrice, 5, "still cached");
  assert.equal(reads, 1);
  assert.equal((await getSettings(pool, t0 + CACHE_MS)).aPrice, 6, "expired: read again");
  assert.equal(reads, 2);
  clearSettingsCache();
  current = row({ a_price: "7.00" });
  assert.equal((await getSettings(pool, t0 + CACHE_MS + 1)).aPrice, 7);
  assert.equal(reads, 3);
  assert.equal((await getSettingsAndRow(pool, t0 + CACHE_MS + 2, { fresh: true })).settings.aPrice, 7);
  assert.equal(reads, 4, "fresh always reads");
});

test("if the settings cannot be read the built-in defaults are used (and not cached)", async () => {
  let reads = 0;
  const pool = { query: async () => { reads += 1; throw new Error("db down"); } };
  assert.equal(await getSettings(pool, 5), DEFAULT_SETTINGS);
  await getSettings(pool, 6);
  assert.equal(reads, 2);
  const empty = { query: async () => ({ rows: [] }) };
  assert.equal(await getSettings(empty, 7), DEFAULT_SETTINGS);
});

test("a row without trade_price (before the migration) falls back to the default of EUR 5", () => {
  const r = row();
  delete r.trade_price;
  assert.equal(rowToSettings(r).tradePrice, 5);
  assert.equal(rowToSettings(row({ trade_price: "6.50" })).tradePrice, 6.5);
});

test("the Trade price field is required", () => {
  const { trade_price: _tradePrice, ...without } = GOOD;
  assert.match(validateSettingsInput(without).error, /Trade price \(EUR\): enter a number/);
});
