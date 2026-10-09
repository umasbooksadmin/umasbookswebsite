// Rows of the price-sticker colour chart on the Pricing rules page (read only).
// By kind of book: orange clearance, yellow children's, green Mass Market,
// blue Trade, red hardback, purple special price, white new book. Prices
// follow the saved settings. Colours are the original shelf-sticker scheme
// (accessible green #237A3C). There is no EUR 8 row any more.

const euro = (n) => `${Number(n).toFixed(2).replace(/\.?0+$/, "")} euro`;

// The legend is by kind of book (Uma's wording), seven rows in this order.
// Prices follow the settings: clearance price, Children's = the lowest
// standard price, Mass Market and Trade = their own flat prices, Hardback =
// the highest standard price. Green and blue are both EUR 5 by default.
function colorChartRows(settings) {
  const levels = [...settings.levels].map(Number).sort((a, b) => a - b);
  return [
    { key: "orange", name: "Orange", hex: "#FF8A1F", text: "#2B2B2B", price: euro(settings.clearance.price), when: "Clearance" },
    { key: "yellow", name: "Yellow", hex: "#FFD93D", text: "#2B2B2B", price: euro(levels[0]), when: "Children's" },
    { key: "green", name: "Green", hex: "#237A3C", text: "#FFFFFF", price: euro(settings.massMarketPrice), when: "Mass Market" },
    { key: "blue", name: "Blue", hex: "#2F6FDE", text: "#FFFFFF", price: euro(settings.tradePrice), when: "Trade" },
    { key: "red", name: "Red", hex: "#D83B3B", text: "#FFFFFF", price: euro(levels[levels.length - 1]), when: "Hardback" },
    { key: "purple", name: "Purple", hex: "#7B4FD0", text: "#FFFFFF", price: "Special price", when: "Any other price" },
    { key: "white", name: "White", hex: "#FFFFFF", text: "#2B2B2B", border: "#2B2B2B", price: "Publisher's price", when: "New book" },
  ];
}

module.exports = { colorChartRows };
