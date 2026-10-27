// The list filters an admin screen returns to after a save or a bulk action.
//
// The list page puts its current filters in a hidden `backQuery` field; the POST handler redirects to the list with
// them so the admin lands where they were. That text comes back from the browser, so it is never appended as it
// arrives (it could carry any other parameter, a fragment, a CR/LF, a `//host` or an over-long string). Instead the
// query string is REBUILT from a whitelist: each screen names the keys it accepts and how each value is checked, every
// kept value is clamped, and URLSearchParams encodes the result.
//
//   const back = makeBackQuery({ status: oneOf(["draft", "published"]), q: text(100), page: pageNumber });
//   res.redirect(`/admin/blog${back(req.body.backQuery)}`);   // "" or "?status=draft&q=..."
//
// A checker returns the value to keep, or "" / null to drop the key.

const { clean } = require("./validation");

const RAW_MAX = 500; // characters of the posted text that are even looked at

const oneOf = (allowed) => (v) => (allowed.includes(v) ? v : "");

// Search text: trimmed, NUL removed, at most `max` characters (clean()). CR/LF and other control characters are kept
// but always percent-encoded by URLSearchParams, so they can never split the Location header or the URL.
const text = (max) => (v) => clean(v, max);

// A page number 1..99999, normalised ("007" -> "7").
const pageNumber = (v) => (/^\d{1,5}$/.test(v) && Number(v) >= 1 ? String(Number(v)) : "");

// spec: { key: checker }. The returned function takes the posted `backQuery` (anything) and gives "" or "?k=v&...".
// Keys come out in the spec's order, each at most once (the first occurrence wins).
function makeBackQuery(spec) {
  const keys = Object.keys(spec);
  return function backQuery(raw) {
    if (typeof raw !== "string" || !raw) return "";
    const src = new URLSearchParams(raw.slice(0, RAW_MAX).replace(/^\?/, ""));
    const out = new URLSearchParams();
    for (const key of keys) {
      const value = src.get(key);
      if (value === null) continue;
      const kept = spec[key](value);
      if (kept) out.set(key, kept);
    }
    const qs = out.toString();
    return qs ? `?${qs}` : "";
  };
}

module.exports = { makeBackQuery, oneOf, text, pageNumber, RAW_MAX };
