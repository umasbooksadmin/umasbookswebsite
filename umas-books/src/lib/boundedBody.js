// Reads an outside service's answer with a SIZE LIMIT. A catalog (or something pretending to be one) must not be
// able to make the server buffer a huge body: the Content-Length is checked first, then the body is read as a stream
// and aborted as soon as more than `maxBytes` have arrived. Anything over the limit throws BodyTooLargeError, which
// every caller treats as "this source failed" (a lookup error), never as data.
//
// Works with a real fetch Response (streamed) and with the simple fakes used in tests (text()/json() only: the size
// is then checked after the fact).

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB
const XML_MAX_BYTES = 2 * 1024 * 1024; // 2 MB (BnF XML)

class BodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`response body larger than ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

async function readBoundedText(res, maxBytes = DEFAULT_MAX_BYTES) {
  const declared = Number(res && res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { if (res.body && typeof res.body.cancel === "function") await res.body.cancel(); } catch { /* ignore */ }
    throw new BodyTooLargeError(maxBytes);
  }
  if (res && res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new BodyTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
  }
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new BodyTooLargeError(maxBytes);
  return text;
}

async function readBoundedJson(res, maxBytes = DEFAULT_MAX_BYTES) {
  // A fake that only has json() (tests) is used as it is.
  if (res && typeof res.text !== "function" && typeof res.json === "function") return res.json();
  return JSON.parse(await readBoundedText(res, maxBytes));
}

module.exports = { readBoundedText, readBoundedJson, BodyTooLargeError, DEFAULT_MAX_BYTES, XML_MAX_BYTES };
