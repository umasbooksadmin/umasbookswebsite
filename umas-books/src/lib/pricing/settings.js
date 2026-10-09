// The shop's pricing rules (table pricing_settings, a single row with id 1).
// Read through a 60 second cache so intake never waits on the database for
// them; saving clears the cache. If the table cannot be read the built-in
// defaults are used, so pricing never fails because of settings.

const { DEFAULT_SETTINGS } = require("./rules");

const CACHE_MS = 60 * 1000;

// One entry per editable number: the column (also the form field name), the
// label shown to volunteers, and the sane range it must stay within.
const NUMBER_FIELDS = [
  { col: "mass_market_price", label: "Mass market price (EUR)", min: 0.5, max: 50 },
  { col: "hardcover_min_price", label: "Hardback minimum price (EUR)", min: 1, max: 100 },
  { col: "a_max", label: "Rule A: market value under (EUR)", min: 1, max: 100 },
  { col: "a_price", label: "Rule A: price (EUR)", min: 0.5, max: 100 },
  { col: "b_max", label: "Rule B: market value under (EUR)", min: 2, max: 500 },
  { col: "b_price", label: "Rule B: price (EUR)", min: 0.5, max: 200 },
  { col: "c_max", label: "Rule C: market value under (EUR)", min: 5, max: 2000 },
  { col: "c_factor", label: "Rule C: share of the market value", min: 0.2, max: 1 },
  { col: "used_fraction", label: "Used value as a share of the publisher's price", min: 0.05, max: 1 },
  { col: "rounding_step", label: "Round Rule C prices to the nearest (EUR)", min: 0.05, max: 5 },
  { col: "fallback_hardcover", label: "Typical value when nothing is known: hardback (EUR)", min: 1, max: 500 },
  { col: "fallback_trade", label: "Typical value when nothing is known: trade (EUR)", min: 1, max: 500 },
  { col: "fallback_mass_market", label: "Typical value when nothing is known: mass market (EUR)", min: 1, max: 500 },
  { col: "fallback_unknown", label: "Typical value when nothing is known: binding unknown or other (EUR)", min: 1, max: 500 },
  { col: "usd_eur", label: "1 US dollar in euros", min: 0.3, max: 3 },
  { col: "gbp_eur", label: "1 British pound in euros", min: 0.3, max: 3 },
  { col: "clearance_after_copies", label: "Clearance: copies already in stock", min: 1, max: 20, integer: true },
  { col: "clearance_price", label: "Clearance price (EUR)", min: 0.5, max: 5 },
];
const ENUM_FIELDS = [
  { col: "clearance_scope", label: "Clearance applies to", values: ["extra", "all"] },
  { col: "clearance_applies_to", label: "Clearance rule covers", values: ["set_a", "all_sets"] },
];
const BOOL_FIELDS = [
  { col: "hardcover_min_applies_to_clearance", label: "Hardback minimum also applies on clearance" },
];
const LIST_FIELD ={ col: "levels", label: "Standard prices", min: 0.5, max: 500, minLength: 2, maxLength: 8 };
const COLUMNS = [...NUMBER_FIELDS.map((f) => f.col), ...ENUM_FIELDS.map((f) => f.col), ...BOOL_FIELDS.map((f) => f.col), LIST_FIELD.col];

function rowToSettings(row) {
  const n = (v) => Number(v);
  return {
    levels: (Array.isArray(row.levels) ? row.levels : DEFAULT_SETTINGS.levels).map(Number),
    massMarketPrice: n(row.mass_market_price),
    hardcoverMinPrice: n(row.hardcover_min_price),
    hardcoverMinAppliesToClearance: row.hardcover_min_applies_to_clearance === true,
    aMax: n(row.a_max), aPrice: n(row.a_price),
    bMax: n(row.b_max), bPrice: n(row.b_price),
    cMax: n(row.c_max), cFactor: n(row.c_factor),
    usedFraction: n(row.used_fraction),
    roundingStep: n(row.rounding_step),
    fallbackEur: {
      hardcover: n(row.fallback_hardcover), trade: n(row.fallback_trade),
      mass_market: n(row.fallback_mass_market), unknown: n(row.fallback_unknown),
    },
    usdEur: n(row.usd_eur),
    gbpEur: n(row.gbp_eur),
    clearance: {
      afterCopies: n(row.clearance_after_copies), price: n(row.clearance_price),
      scope: row.clearance_scope, appliesTo: row.clearance_applies_to,
    },
  };
}

// The defaults in the same flat shape as a table row (for the edit form).
function defaultRow() {
  const d = DEFAULT_SETTINGS;
  return {
    levels: [...d.levels], mass_market_price: d.massMarketPrice, hardcover_min_price: d.hardcoverMinPrice,
    hardcover_min_applies_to_clearance: d.hardcoverMinAppliesToClearance, a_max: d.aMax, a_price: d.aPrice, b_max: d.bMax, b_price: d.bPrice, c_max: d.cMax, c_factor: d.cFactor,
    used_fraction: d.usedFraction, rounding_step: d.roundingStep,
    fallback_hardcover: d.fallbackEur.hardcover, fallback_trade: d.fallbackEur.trade,
    fallback_mass_market: d.fallbackEur.mass_market, fallback_unknown: d.fallbackEur.unknown,
    usd_eur: d.usdEur, gbp_eur: d.gbpEur,
    clearance_after_copies: d.clearance.afterCopies, clearance_price: d.clearance.price,
    clearance_scope: d.clearance.scope, clearance_applies_to: d.clearance.appliesTo,
  };
}

let cache = null; // { at, settings, row }

function clearSettingsCache() {
  cache = null;
}

// Settings object (see rules.js DEFAULT_SETTINGS for the shape) and the raw
// row, cached for 60 s. `now` is injectable for tests.
async function getSettingsAndRow(pool, now = Date.now(), { fresh = false } = {}) {
  if (!fresh && cache && now - cache.at < CACHE_MS) return cache;
  try {
    const { rows } = await pool.query("SELECT * FROM pricing_settings WHERE id = 1");
    if (rows.length) {
      cache = { at: now, settings: rowToSettings(rows[0]), row: rows[0] };
      return cache;
    }
  } catch (err) {
    console.warn("Pricing settings could not be read, using defaults:", err.message);
  }
  return { at: now, settings: DEFAULT_SETTINGS, row: defaultRow() };
}

async function getSettings(pool, now) {
  return (await getSettingsAndRow(pool, now)).settings;
}

function parseList(raw) {
  return String(raw == null ? "" : raw).split(/[\s,;]+/).filter(Boolean).map((x) => Number(x.replace(",", ".")));
}

// Parses and checks the settings form. Returns { error } (plain English, all
// problems listed) or { values } keyed by column (levels as an array).
function validateSettingsInput(body) {
  const values = {};
  const problems = [];
  for (const f of NUMBER_FIELDS) {
    const raw = String(body && body[f.col] != null ? body[f.col] : "").trim().replace(",", ".");
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) problems.push(`${f.label}: enter a number.`);
    else if (f.integer && !Number.isInteger(n)) problems.push(`${f.label}: enter a whole number.`);
    else if (n < f.min || n > f.max) problems.push(`${f.label}: must be between ${f.min} and ${f.max}.`);
    else values[f.col] = n;
  }
  for (const f of ENUM_FIELDS) {
    const v = String(body && body[f.col] != null ? body[f.col] : "");
    if (f.values.includes(v)) values[f.col] = v;
    else problems.push(`${f.label}: choose one of the options.`);
  }
  // A tick box is only sent when ticked.
  for (const f of BOOL_FIELDS) values[f.col] = Boolean(body && (body[f.col] === "1" || body[f.col] === "on" || body[f.col] === "true"));
  const levels = parseList(body && body[LIST_FIELD.col]);
  const L = LIST_FIELD;
  if (levels.length < L.minLength || levels.length > L.maxLength || levels.some((x) => !Number.isFinite(x))) {
    problems.push(`${L.label}: enter between ${L.minLength} and ${L.maxLength} prices, separated by commas.`);
  } else if (levels.some((x) => x < L.min || x > L.max)) {
    problems.push(`${L.label}: each price must be between ${L.min} and ${L.max}.`);
  } else if (levels.some((x, i) => i > 0 && x <= levels[i - 1])) {
    problems.push(`${L.label}: list them from lowest to highest, with no repeats.`);
  } else {
    values.levels = levels;
  }
  if (values.a_max != null && values.b_max != null && values.c_max != null && !(values.a_max < values.b_max && values.b_max < values.c_max)) {
    problems.push("The market-value limits must go up: Rule A limit lower than Rule B limit, lower than Rule C limit.");
  }
  if (problems.length) return { error: problems.join(" ") };
  return { values };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Saves validated values; returns the columns that actually changed (for the
// audit log) and clears the cache.
async function saveSettings(pool, values) {
  const { row } = await getSettingsAndRow(pool, Date.now(), { fresh: true });
  const changed = COLUMNS.filter((c) => {
    if (c === "levels") return !same((row.levels || []).map(Number), values.levels);
    if (typeof values[c] === "string") return row[c] !== values[c];
    if (typeof values[c] === "boolean") return Boolean(row[c]) !== values[c];
    return Math.abs(Number(row[c]) - values[c]) > 1e-9;
  });
  if (changed.length) {
    const sets = changed.map((c, i) => `${c} = $${i + 1}`).join(", ");
    await pool.query(
      `UPDATE pricing_settings SET ${sets}, updated_at = now() WHERE id = 1`,
      changed.map((c) => (c === "levels" ? JSON.stringify(values[c]) : values[c]))
    );
  }
  clearSettingsCache();
  return changed;
}

module.exports = {
  NUMBER_FIELDS, ENUM_FIELDS, BOOL_FIELDS, CACHE_MS, getSettings, getSettingsAndRow, validateSettingsInput, saveSettings, clearSettingsCache, rowToSettings,
};
