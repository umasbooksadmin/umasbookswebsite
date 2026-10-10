// GET /img/<sha256>.<jpg|png|webp> — stored image bytes (lib/imageStore.js).
//
// Mounted in index.js BEFORE the session store, like /assets, so an image
// request never reads or sets a session cookie. The key is the SHA-256 of the
// content, so the bytes behind a URL can never change: cache forever.
//
// Rate limit: generous per-IP cap (300/min) on the requests that actually read
// the database. A book page legitimately fires dozens of image requests at once
// and a school or library shares one IP, so the cap is far above normal use; it
// only stops a script walking the store. Malformed names (no DB read) and
// If-None-Match hits (304, no DB read) are answered BEFORE the limiter and are
// not counted. The query string plays no part: the route matches the path only
// and the ETag is the content hash, so /img/<hash>.jpg?x=1 and ?x=2 are the same
// image with the same validators (a CDN should be set to ignore the query string
// for /img/*).
//
// Smaller copies: /img/<sha256>-w300.jpg (also -w450, -w600) is the same JPEG scaled to that
// width, never cropped (lib/imageVariants.js). Only those three widths exist; any other
// name is a 404, so the URL cannot be used to make the server render arbitrary sizes.
// Same cache headers; the ETag carries the width.

const express = require("express");
const { getImage, FILE_RE, TYPE_BY_EXT } = require("../lib/imageStore");
const { getVariant, VARIANT_RE } = require("../lib/imageVariants");

const { limit } = require("../middleware/rateLimits");

const router = express.Router();

// Counted only for requests that reach the database (see above).
const IMG_LIMIT_PER_MINUTE = 300;
const imgLimiter = limit({ windowMs: 60 * 1000, max: IMG_LIMIT_PER_MINUTE });

const IMMUTABLE = "public, max-age=31536000, immutable";

function notFound(res) {
  res.status(404).set("X-Content-Type-Options", "nosniff").type("text/plain").send("Not found");
}

// Step 1 (no database, not rate limited): validate the name, answer 304.
function precheck(req, res, next) {
  const v = VARIANT_RE.exec(req.params.file);
  const m = v || FILE_RE.exec(req.params.file);
  if (!m) return notFound(res);
  const etag = v ? `"${v[1]}-w${v[2]}"` : `"${m[1]}"`;

  // The hash IS the content, so a client that already holds it needs nothing.
  const inm = req.get("if-none-match");
  if (inm && (inm.trim() === "*" || inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag))) {
    res.set({ ETag: etag, "Cache-Control": IMMUTABLE });
    return res.status(304).end();
  }
  req.imgKey = v ? { id: v[1], ext: "jpg", etag, width: Number(v[2]) } : { id: m[1], ext: m[2], etag };
  next();
}

// Step 2: the database read.
router.get("/img/:file", precheck, imgLimiter, async (req, res) => {
  const { id, ext, etag, width } = req.imgKey;
  const image = width ? await getVariant(id, width) : await getImage(id);
  // The extension must agree with what was stored (a .png URL can't serve a JPEG).
  if (!image || image.contentType !== TYPE_BY_EXT[ext]) return notFound(res);

  res.set({
    "Content-Type": image.contentType,
    "Content-Length": String(image.data.length),
    "Cache-Control": IMMUTABLE,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    // Public content, embeddable anywhere (same as /api/blog/posts).
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  res.end(image.data);
});

module.exports = router;
module.exports.IMG_LIMIT_PER_MINUTE = IMG_LIMIT_PER_MINUTE;
