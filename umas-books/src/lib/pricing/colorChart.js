// Rows of the price-sticker colour chart on the Pricing rules page (read only).
// The four used-book colours follow the "Standard prices" setting, lowest
// first (yellow, green, blue, red), so the chart changes with the settings.
// Clearance follows the clearance price. Special and new have no fixed price.
// Colours are the original shelf-sticker scheme (accessible green #237A3C).

const USED = [
  { key: "yellow", name: "Yellow", hex: "#FFD93D", text: "#2B2B2B" },
  { key: "green", name: "Green", hex: "#237A3C", text: "#FFFFFF" },
  { key: "blue", name: "Blue", hex: "#2F6FDE", text: "#FFFFFF" },
  { key: "red", name: "Red", hex: "#D83B3B", text: "#FFFFFF" },
];

function colorChartRows(settings) {
  const levels = [...settings.levels].map(Number).sort((a, b) => a - b);
  const eur = (n) => `EUR ${Number(n).toFixed(2).replace(/\.00$/, "")}`;
  const rows = [{
    key: "orange", name: "Orange", hex: "#FF8A1F", text: "#2B2B2B", price: eur(settings.clearance.price),
    when: "Clearance: a book the shop holds too many copies of.",
  }];
  USED.forEach((c, i) => rows.push({
    ...c, price: levels[i] == null ? "Not in use" : eur(levels[i]),
    when: levels[i] == null ? "No standard price is set for this colour." : "A used book at exactly this standard price.",
  }));
  rows.push(
    { key: "purple", name: "Purple", hex: "#7B4FD0", text: "#FFFFFF", price: "Special price", when: "A used book at any other price than the ones above." },
    { key: "white", name: "White", hex: "#FFFFFF", text: "#2B2B2B", border: "#2B2B2B", price: "Publisher's price", when: "A new book: write the publisher's price on the sticker." },
  );
  return rows;
}

module.exports = { colorChartRows };
