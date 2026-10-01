// Where uploaded image bytes live. Callers (the admin upload handlers) hand
// over a Buffer and get back a short URL string to store in their own row;
// nothing else about the storage leaks out. Today the bytes are a row in the
// `images` table (migrations/033_image_store.sql), keyed by the SHA-256 of the
// bytes and served by routes/img.js. To move to object storage (Backblaze/S3)
// later, reimplement saveImage/getImage here (and have routes/img.js redirect
// or stream) — no caller changes.

const crypto = require("node:crypto");
const { pool } = require("../db");

const EXT_BY_TYPE = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const TYPE_BY_EXT = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

const FILE_RE = /^([0-9a-f]{64})\.(jpg|png|webp)$/;
const STORED_URL_RE = /^\/img\/[0-9a-f]{64}\.(jpg|png|webp)$/;

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Stores the bytes (a repeat of identical bytes is a no-op) and returns the
// URL to put in the row, e.g. /img/<64 hex>.jpg.
async function saveImage(buffer, contentType = "image/jpeg", db = pool) {
  const ext = EXT_BY_TYPE[contentType];
  if (!ext) throw new Error(`Unsupported image type: ${contentType}`);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("saveImage needs a non-empty Buffer");
  const id = sha256Hex(buffer);
  await db.query(
    `INSERT INTO images (id, content_type, data, byte_size) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, contentType, buffer, buffer.length]
  );
  return `/img/${id}.${ext}`;
}

// -> { id, contentType, data } or null.
async function getImage(id, db = pool) {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const { rows } = await db.query("SELECT id, content_type, data FROM images WHERE id = $1", [id]);
  return rows[0] ? { id: rows[0].id, contentType: rows[0].content_type, data: rows[0].data } : null;
}

// True for a URL produced by saveImage (as opposed to an http(s) URL typed
// in, or a legacy data: URI).
function isStoredImageUrl(value) {
  return typeof value === "string" && STORED_URL_RE.test(value);
}

module.exports = { saveImage, getImage, isStoredImageUrl, sha256Hex, FILE_RE, TYPE_BY_EXT };
