// Shared sharp entry points for admin-uploaded photos.

const sharp = require("sharp");

// sharp's default input cap is ~268 MP, i.e. over a gigabyte of decoded
// pixels — a small "pixel bomb" file (tiny on the wire, huge decoded) could
// exhaust the 512 MB container. 40 MP covers any real phone/camera photo.
const MAX_INPUT_PIXELS = 40_000_000;

// Use instead of sharp(buffer) for anything decoded from an upload.
function sharpFromUpload(buffer) {
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS });
}

// The vision scan used to forward multer's client-supplied mimetype (and the
// raw bytes, up to 8 MB) straight to Anthropic: a wrong or spoofed type is
// rejected there, and a big photo base64-encodes past its per-image limit.
// Decode it ourselves instead and send what we produced — always a JPEG, at
// the size the model actually uses — so the declared type can't disagree
// with the bytes. Throws if the upload isn't a decodable image.
async function reencodeForVision(buffer) {
  const data = await sharpFromUpload(buffer)
    .rotate()
    .resize(1568, 1568, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { buffer: data, mimeType: "image/jpeg" };
}

module.exports = { sharpFromUpload, reencodeForVision, MAX_INPUT_PIXELS };
