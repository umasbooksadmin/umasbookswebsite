// GET /img/<sha256>.<jpg|png|webp> — stored image bytes (lib/imageStore.js).
//
// Mounted in index.js BEFORE the session store, like /assets, so an image
// request never reads or sets a session cookie. The key is the SHA-256 of the
// content, so the bytes behind a URL can never change: cache forever.
//
// No rate limiter on purpose: responses are immutable and cacheable (browsers
// and any CDN stop asking), the lookup is one primary-key read, and a book
// page legitimately fires dozens of image requests at once — a per-IP limit
// would break normal browsing (shared school/library IPs) while protecting
// almost nothing.

const express = require("express");
const { getImage, FILE_RE, TYPE_BY_EXT } = require("../lib/imageStore");

const router = express.Router();

const IMMUTABLE = "public, max-age=31536000, immutable";

function notFound(res) {
  res.status(404).set("X-Content-Type-Options", "nosniff").type("text/plain").send("Not found");
}

router.get("/img/:file", async (req, res) => {
  const m = FILE_RE.exec(req.params.file);
  if (!m) return notFound(res);
  const [, id, ext] = m;
  const etag = `"${id}"`;

  // The hash IS the content, so a client that already holds it needs nothing.
  const inm = req.get("if-none-match");
  if (inm && (inm.trim() === "*" || inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag))) {
    res.set({ ETag: etag, "Cache-Control": IMMUTABLE });
    return res.status(304).end();
  }

  const image = await getImage(id);
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
