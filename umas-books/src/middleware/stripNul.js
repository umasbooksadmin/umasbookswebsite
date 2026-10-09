// NUL bytes (%00 in a URL or form) are valid in HTTP but not in Postgres text:
// one reaching a query parameter throws "invalid byte sequence for encoding
// UTF8: 0x00" -> a 500 and an alert email. Scanners send them on purpose.
//   - In the URL PATH (/books/a%00b, /my-requests/%00): 400, nothing can match.
//   - In the query string and the form body: the NUL characters are removed
//     (a%00b is read as ab), so the request is handled like the same one
//     without them. lib/validation.js clean() does the same for any other
//     source of strings (multipart fields, session data).
const NUL_IN_PATH = /%00/i;
const withoutNul = (str) => (str.includes("\0") ? str.split("\0").join("") : str);

function stripNulDeep(value, depth = 0) {
  if (typeof value === "string") return withoutNul(value);
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripNulDeep(v, depth + 1));
  const out = Object.create(Object.getPrototypeOf(value));
  for (const [k, v] of Object.entries(value)) out[withoutNul(k)] = stripNulDeep(v, depth + 1);
  return out;
}

// Before the session middleware: a refused request costs nothing.
function rejectNulInPath(req, res, next) {
  const raw = req.url || "";
  const q = raw.indexOf("?");
  const pathPart = q === -1 ? raw : raw.slice(0, q);
  if (NUL_IN_PATH.test(pathPart) || pathPart.includes("\0")) {
    res.status(400).set("Cache-Control", "no-store").type("text/plain").send("Bad request.");
    return;
  }
  next();
}

// After the body parser. Express 5's req.query is a getter that parses the URL
// again on every read, so the cleaned copy is pinned on the request.
function stripNulFromInput(req, res, next) {
  const query = stripNulDeep(req.query);
  Object.defineProperty(req, "query", { value: query, writable: true, configurable: true, enumerable: true });
  if (req.body && typeof req.body === "object") req.body = stripNulDeep(req.body);
  next();
}

module.exports = { rejectNulInPath, stripNulFromInput, stripNulDeep };
