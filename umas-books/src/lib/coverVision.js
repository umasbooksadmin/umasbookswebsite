// Reads a photo of a book (front cover or the barcode/ISBN on the back)
// and extracts whatever is visible, via a single Claude vision call.
// Fails open (returns null) on any error or missing config, so the
// caller falls back to manual entry rather than blocking the scan flow.

const anthropic = require("./anthropic");

const PROMPT = `This is a photo of a physical book, either its front cover or its back cover/barcode area. Extract whatever of the following you can actually see:
- isbn: the ISBN-10 or ISBN-13 digits (from the barcode's printed digits or an "ISBN" label), digits only, no dashes
- title: the book's title
- author: the book's author(s)

Respond with ONLY a JSON object, no other text, in this exact shape:
{"isbn": "..." or null, "title": "..." or null, "author": "..." or null}
Use null for anything not clearly visible. Do not guess or invent values.`;

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function extractBookInfoFromPhoto(buffer, mimeType) {
  let r;
  try {
    r = await anthropic.request({
      feature: "cover", model: anthropic.MODELS.vision.id, maxTokens: 300, timeoutMs: 20000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: buffer.toString("base64") } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
  } catch (err) { // building the request failed (a bad buffer): nothing was sent, no slot taken
    console.warn("Vision extraction skipped:", err.message);
    return null;
  }
  if (!r.ok) {
    if (r.kind === "no-key") console.warn("ANTHROPIC_API_KEY not set — photo scanning is disabled.");
    else if (r.kind === "cap") console.warn(`Photo reading skipped: ${r.message}`);
    else if (r.status) console.warn("Vision API request failed:", r.status, r.body);
    else console.warn("Vision extraction skipped:", r.message);
    return null;
  }
  try {
    const text = anthropic.textOf(r.data);
    if (!text) {
      console.warn("Vision extraction skipped: unexpected response shape:", JSON.stringify(r.data).slice(0, 500));
      return null;
    }

    const parsed = extractJson(text);
    if (!parsed) {
      console.warn("Vision extraction skipped: couldn't parse JSON from model output:", text.slice(0, 300));
      return null;
    }

    return {
      isbn: parsed.isbn || null,
      title: parsed.title || null,
      author: parsed.author || null,
    };
  } catch (err) {
    console.warn("Vision extraction skipped:", err.message);
    return null;
  }
}

module.exports = { extractBookInfoFromPhoto };
