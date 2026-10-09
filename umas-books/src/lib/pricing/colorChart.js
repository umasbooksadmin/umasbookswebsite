// Rows of the price-sticker colour chart on the Pricing rules page (read only).
// The used-book colours follow the "Standard prices" setting, lowest
// first (yellow, green, red; blue only with four prices), so the chart
// changes with the settings.
// Clearance follows the clearance price. Special and new have no fixed price.
// Colours are the original shelf-sticker scheme (accessible green #237A3C).

const USED = [
  { key: "yellow", name: "Yellow", hex: "#FFD93D", text: "#2B2B2B" },
  { key: "green", name: "Green", hex: "#237A3C", text: "#FFFFFF" },
  { key: "blue", name: "Blue", hex: "#2F6FDE", text: "#FFFFFF" },
  { key: "red", name: "Red", hex: "#D83B3B", text: "#FFFFFF" },
];

// With three standard prices (the default since EUR 8 was retired) they are
// yellow, green and red; the blue row stays in the chart, marked "No longer
// used", so old blue stickers on the shelves are still explained. With any
// other number of prices they go in order: yellow, green, blue, red.
function colorChartRows(settings) {
  const levels = [...settings.levels].map(Number).sort((a, b) => a - b);
  const eur = (n) => `EUR ${Number(n).toFixed(2).replace(/\.00$/, "")}`;
  const rows = [{
    key: "orange", name: "Orange", hex: "#FF8A1F", text: "#2B2B2B", price: eur(settings.clearance.price),
    when: "Clearance: a book the shop holds too many copies of.",
  }];
  const priceOf = levels.length === 3
    ? { yellow: levels[0], green: levels[1], red: levels[2] }
    : Object.fromEntries(USED.map((c, i) => [c.key, levels[i]]));
  USED.forEach((c) => {
    const price = priceOf[c.key];
    const retired = levels.length === 3 && c.key === "blue";
    rows.push({
      ...c,
      price: price != null ? eur(price) : retired ? "No longer used" : "Not in use",
      when: price != null ? "A used book at exactly this standard price."
        : retired ? "Old stickers only: EUR 8 is no longer a standard price." : "No standard price is set for this colour.",
    });
  });
  rows.push(
    { key: "purple", name: "Purple", hex: "#7B4FD0", text: "#FFFFFF", price: "Special price", when: "A used book at any other price than the ones above." },
    { key: "white", name: "White", hex: "#FFFFFF", text: "#2B2B2B", border: "#2B2B2B", price: "Publisher's price", when: "A new book: write the publisher's price on the sticker." },
  );
  return rows;
}

module.exports = { colorChartRows };
