// One shared way to read a number out of a query string or form field.
//
// Why: a value that reaches SQL as an integer, a LIMIT or an OFFSET must be a
// safe integer. parseInt("99999999999999999999") is 1e20, which interpolates
// as "100000000000000000000" and Postgres answers "bigint out of range"; an id
// past 2^31 into `ANY($1::int[])` is "out of range for type integer". Both are
// a 500 plus an alert email that an anonymous visitor can trigger at will and
// that uses up the alert throttle window, hiding a real incident.
//
// parseIntParam never throws and never returns a non-integer:
//   - only plain decimal digits (optional leading "-") are numbers; an array
//     (?offset=1&offset=2), whitespace, "1e3", "0x10", "1.5", "+1", "" and
//     anything else give `default`;
//   - a well-formed number outside [min, max] is clamped to the nearest end
//     (clamp: false returns `default` instead), however many digits it has.

const INT4_MAX = 2147483647;

function parseIntParam(value, { min = 0, max = INT4_MAX, default: fallback = min, clamp = true } = {}) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string" || !/^-?\d{1,400}$/.test(value)) return fallback;
  const n = Number(value);
  // Number() of 400 digits is Infinity at worst: still ordered correctly.
  if (n >= min && n <= max && Number.isSafeInteger(n)) return n;
  if (!clamp) return fallback;
  return n < min ? min : max;
}

// A page size (?limit=): 1..max. Kept as it always behaved: absent, garbage or 0 mean `default`; a negative
// number or one above max is clamped to 1 or max.
function parseLimitParam(value, { max, default: fallback }) {
  const n = parseIntParam(value, { min: -1, max, default: 0 });
  return n === 0 ? fallback : Math.max(n, 1);
}

// A list of positive int4 ids from "1,2,3" (a ?ids= parameter). Anything that is
// not a valid id is dropped, duplicates are dropped, and at most `maxCount` are
// kept. Never throws.
function parseIdList(value, { maxCount = 200 } = {}) {
  if (typeof value !== "string") return [];
  const out = [];
  const seen = new Set();
  for (const part of value.split(",", maxCount * 2)) {
    const s = part.trim();
    if (!/^[1-9]\d{0,9}$/.test(s)) continue;
    const n = Number(s);
    if (n > INT4_MAX || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= maxCount) break;
  }
  return out;
}

// Search text made safe to put between % signs in a LIKE/ILIKE pattern:
// "\", "%" and "_" are matched literally (Postgres' default LIKE escape is the
// backslash). Without it "__" means "any two characters" and matches every row.
function escapeLike(text) {
  return String(text).replace(/[%_\\]/g, (m) => "\\" + m);
}

// `%text%` for "contains", with the wildcards in `text` taken literally.
function likeContains(text) {
  return `%${escapeLike(text)}%`;
}

module.exports = { parseIntParam, parseLimitParam, parseIdList, escapeLike, likeContains, INT4_MAX };
