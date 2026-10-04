// Parses the admin's "Add awards (comma separated)" box:
//   "Booker Prize (2019), Hugo Award for Best Novel"
// into [{ label, year, kind }]. A trailing "(1990)" is the year; labels are
// trimmed, cut to 200 characters, and de-duplicated (case-insensitive).

const MAX_MANUAL = 20;

function parseManualAwards(text) {
  const out = [];
  const seen = new Set();
  for (const part of String(text || "").split(",")) {
    let label = part.replace(/\s+/g, " ").trim();
    if (!label) continue;
    let year = null;
    const m = label.match(/^(.*?)\s*\((\d{4})\)$/);
    if (m && m[1].trim()) {
      const y = Number(m[2]);
      if (y >= 1000 && y <= 2200) {
        label = m[1].trim();
        year = y;
      }
    }
    label = label.slice(0, 200).trim();
    if (!label) continue;
    const key = `${label.toLowerCase()}|${year || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, year, kind: /best[\s-]?sellers?/i.test(label) ? "bestseller" : "award" });
    if (out.length >= MAX_MANUAL) break;
  }
  return out;
}

module.exports = { parseManualAwards };
