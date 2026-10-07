// Shelf-sticker colors: the shop marks every copy with a colored price sticker.
// This module is the single source of truth for the scheme. The admin views
// get the levels from here (the price control ships them to its script as JSON)
// and nothing else hard-codes a color.
//
// A copy's color is DERIVED from its data, in this order:
//   1. is_clearance                       -> orange   (clearance)
//   2. condition 'new'                    -> white    (retail: publisher's price, loi Lang)
//   3. price is exactly 3 / 5 / 8 / 10    -> yellow / green / blue / red
//   4. any other price on a used book     -> purple   (custom / special)
// Nothing is stored: changing a price or a condition changes the color.

// text: the text color that stays readable on the chip. border: only the
// retail (white) chip needs a visible border.
const LEVELS = [
  { key: "yellow", eur: 3, label: "Yellow", labelFr: "Jaune", hex: "#FFD93D", text: "#2B2B2B" },
  { key: "green", eur: 5, label: "Green", labelFr: "Vert", hex: "#237A3C", text: "#FFFFFF" },
  { key: "blue", eur: 8, label: "Blue", labelFr: "Bleu", hex: "#2F6FDE", text: "#FFFFFF" },
  { key: "red", eur: 10, label: "Red", labelFr: "Rouge", hex: "#D83B3B", text: "#FFFFFF" },
  { key: "purple", eur: null, label: "Purple", labelFr: "Violet", hex: "#7B4FD0", text: "#FFFFFF", special: true },
  { key: "orange", eur: 1, label: "Orange", labelFr: "Orange", hex: "#FF8A1F", text: "#2B2B2B", clearance: true },
  { key: "white", eur: null, label: "White", labelFr: "Blanc", hex: "#FFFFFF", text: "#2B2B2B", border: "#2B2B2B", retail: true },
];

const BY_KEY = Object.fromEntries(LEVELS.map((l) => [l.key, l]));
const COLOR_KEYS = LEVELS.map((l) => l.key);
// Print/sort order on the sticker sheet: used levels by price, then special, clearance, retail.
const SORT_ORDER = ["orange", "yellow", "green", "blue", "red", "purple", "white"];

const cents = (price) => Math.round(Number(price) * 100);

// { price, condition, isClearance } (a copy row works too: is_clearance) -> level.
function colorFor(copy) {
  const c = copy || {};
  const clearance = c.isClearance != null ? c.isClearance : c.is_clearance;
  if (clearance) return BY_KEY.orange;
  if (c.condition === "new") return BY_KEY.white;
  if (c.price != null && c.price !== "" && Number.isFinite(Number(c.price))) {
    const p = cents(c.price);
    const hit = LEVELS.find((l) => !l.special && !l.clearance && !l.retail && l.eur * 100 === p);
    if (hit) return hit;
  }
  return BY_KEY.purple;
}

const eur = (n) => `EUR ${Number(n).toFixed(2).replace(/\.00$/, "")}`;

// The (English) text for a chip, e.g. "Green sticker, EUR 5". New books: the
// sticker is white and carries the publisher's price, so the text says to
// write it. The French names (labelFr) are kept for the public side later.
function chipText(level, price) {
  const hasPrice = price != null && price !== "" && Number.isFinite(Number(price));
  if (level.retail) return `White sticker: publisher price${hasPrice ? ` ${eur(price)}` : ""}, write it on the sticker`;
  if (level.clearance) return `${level.label} sticker, clearance ${eur(level.eur)}`;
  if (level.special) return `${level.label} sticker, custom price${hasPrice ? ` ${eur(price)}` : ""}`;
  return `${level.label} sticker, ${eur(level.eur)}`;
}

// One-line meaning of each level, for the legend.
function meaning(level) {
  if (level.retail) return "New book at the publisher's price (write the price on the sticker)";
  if (level.clearance) return "Clearance";
  if (level.special) return "Custom / special price (any other price)";
  return eur(level.eur);
}

// What the price control's script needs (no functions).
function clientConfig() {
  return { levels: LEVELS, order: SORT_ORDER };
}

// Express middleware: makes the scheme available to the views as `priceColors`.
function exposeToViews(req, res, next) {
  res.locals.priceColors = module.exports;
  next();
}

module.exports = { exposeToViews, LEVELS, COLOR_KEYS, SORT_ORDER, colorFor, chipText, meaning, clientConfig, byKey: (k) => BY_KEY[k] || null };
