// Small helpers shared by the admin routes that save a copy's price: reading
// the "price level" choice from a form, and the data kept for the learning
// loop (what was suggested, and whether the volunteer kept it).

// A suggested price as sent back in a hidden field. Numeric check only: a
// tampered value cannot do more than record a wrong number.
function parseSuggestedPrice(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (text === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0 || n >= 100000) return null;
  return Math.round(n * 100) / 100;
}

// '3', '5.5', 'custom', 'clearance' or 'review' (as sent in a hidden field), else null.
function normalizeSuggestedLevel(raw) {
  const text = String(raw == null ? "" : raw).trim();
  return /^(\d{1,3}(\.\d{1,2})?|custom|clearance|review)$/.test(text) ? text : null;
}

// The level of a suggestion as text, for the hidden field and the database.
function levelText(suggestion) {
  if (!suggestion || suggestion.level == null) return null;
  return String(suggestion.level);
}

// 'manual' when a person had to decide (review) or no suggestion existed,
// 'suggested' when the final price is the suggestion, 'adjusted' when it
// differs. null when there is no price and nothing to say about it.
function priceBasisFor(price, suggestedPrice, suggestedLevel) {
  if (suggestedLevel === "review") return "manual";
  if (price == null || !Number.isFinite(Number(price))) return null;
  if (suggestedPrice == null) return "manual";
  return Math.round(Number(price) * 100) === Math.round(suggestedPrice * 100) ? "suggested" : "adjusted";
}

// Reads the "Price level" radio group (name priceLevel). Without it (an older
// form, a script) the plain price field is used. Returns { rawPrice,
// isClearance }: isClearance is null when the form did not say, and is never
// true for a new book (French fixed price law: new books are never on clearance).
function priceFromLevelChoice(condition, body, settings) {
  const choice = body.priceLevel === undefined ? undefined : String(body.priceLevel);
  if (condition === "new" || choice === undefined) return { rawPrice: body.price, isClearance: condition === "new" ? false : null };
  if (choice === "clearance") return { rawPrice: String(settings.clearance.price), isClearance: true };
  if (settings.levels.map(String).includes(choice)) return { rawPrice: choice, isClearance: false };
  return { rawPrice: body.price, isClearance: false }; // custom
}

// Which radio is selected for a price: a standard level, clearance or custom.
function levelKeyFor(price, isClearance, levels) {
  if (price == null) return "";
  if (isClearance) return "clearance";
  return levels.map(Number).includes(Number(price)) ? String(Number(price)) : "custom";
}

module.exports = { parseSuggestedPrice, normalizeSuggestedLevel, levelText, priceBasisFor, priceFromLevelChoice, levelKeyFor };
