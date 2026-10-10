// Reads a photo of a book (front cover or the barcode/ISBN on the back)
// and extracts whatever is visible, via a single Claude vision call.
// Fails open (returns null) on any error or missing config, so the
// caller falls back to manual entry rather than blocking the scan flow.

const { recordCall } = require("./aiUsageStats");
const { getAiLimits } = require("./aiLimits");

const VISION_MODEL = "claude-haiku-4-5-20251001";

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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("ANTHROPIC_API_KEY not set — photo scanning is disabled.");
    return null;
  }

  const slot = await getAiLimits().acquireAiCall(); // the shared daily cap (lib/aiLimits.js)
  if (!slot.ok) {
    console.warn(`Photo reading skipped: ${slot.message}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  const t0 = Date.now();
  let recorded = false; // usage statistics (counts only), see lib/aiUsageStats.js
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mimeType, data: buffer.toString("base64") } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      recorded = true;
      recordCall("cover", { status: res.status, bodyText: body, ms: Date.now() - t0 });
      console.warn("Vision API request failed:", res.status, body);
      return null;
    }

    const data = await res.json();
    recorded = true;
    recordCall("cover", { status: res.status, data, ms: Date.now() - t0 });
    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) {
      console.warn("Vision extraction skipped: unexpected response shape:", JSON.stringify(data).slice(0, 500));
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
    if (!recorded) recordCall("cover", { failed: true, ms: Date.now() - t0 });
    console.warn("Vision extraction skipped:", err.name === "AbortError" ? "request timed out" : err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { extractBookInfoFromPhoto };
