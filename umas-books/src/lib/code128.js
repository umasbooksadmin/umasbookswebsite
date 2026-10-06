// Code 128 (subset B) barcodes as inline SVG, no dependency. Subset B covers
// printable ASCII (space to ~), which is plenty for copy labels such as
// "UB-1234". Used by the copy labels page (/admin/inventory/labels).
//
// How a Code 128 symbol works: every character is 6 alternating bars/spaces
// (bar first) 11 modules wide in total, given below as the widths of the
// elements; START B is value 104, STOP has 7 elements (13 modules). The check
// symbol is (104 + sum of position * value) mod 103.

const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232",
  "2331112", // 106 = STOP
];
const START_B = 104;
const STOP = 106;

// The symbol values for text: START B, one value per character, check, STOP.
function values(text) {
  const s = String(text);
  if (!s.length) throw new Error("Code 128: nothing to encode");
  const out = [START_B];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 || code > 126) throw new Error(`Code 128 (subset B) cannot encode character code ${code}`);
    out.push(code - 32);
  }
  let sum = START_B;
  for (let i = 1; i < out.length; i++) sum += i * out[i];
  out.push(sum % 103, STOP);
  return out;
}

// Modules as a string of "1" (bar) and "0" (space), without quiet zones.
function modules(text) {
  let bits = "";
  for (const v of values(text)) {
    [...PATTERNS[v]].forEach((w, i) => { bits += (i % 2 === 0 ? "1" : "0").repeat(Number(w)); });
  }
  return bits;
}

const QUIET = 10; // modules of white on each side, as the standard asks

// An inline <svg> with the bars as one path. It scales to the width of its
// box (preserveAspectRatio none keeps bars crisp at any size); `height` is in
// the SVG's own units and the viewBox keeps the proportions.
function svg(text, { height = 40, title = null } = {}) {
  const bits = modules(text);
  const width = bits.length + QUIET * 2;
  let d = "";
  for (let i = 0; i < bits.length;) {
    if (bits[i] === "1") {
      let j = i;
      while (j < bits.length && bits[j] === "1") j++;
      d += `M${i + QUIET} 0h${j - i}v${height}h-${j - i}z`;
      i = j;
    } else i++;
  }
  const label = String(title == null ? text : title).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<svg class="barcode" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Barcode ${label}"><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { PATTERNS, values, modules, svg, START_B, STOP };
