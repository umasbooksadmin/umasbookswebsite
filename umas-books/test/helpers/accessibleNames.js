// Finds form controls without an accessible name in a piece of rendered HTML.
// A control (input, select, textarea; not hidden/submit/button/reset/image) is named when it has
// a non-empty aria-label, an aria-labelledby, a <label for="its id"> with text, or sits inside a <label>
// that has text. Placeholder and title do not count: a placeholder disappears as soon as someone types.
// Used by test/integration/adminControlsLabelled.test.js.

const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function findUnnamedControls(html) {
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  // text of every <label for="x">
  const forLabels = new Map();
  for (const m of body.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const f = attr(m[0], "for");
    const text = m[2].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
    if (f && text) forLabels.set(f, true);
  }
  const problems = [];
  const re = /<(input|select|textarea)\b[^>]*>/gi;
  let m;
  while ((m = re.exec(body))) {
    const tag = m[0];
    const type = (attr(tag, "type") || "text").toLowerCase();
    if (m[1].toLowerCase() === "input" && SKIP_TYPES.has(type)) continue;
    if ((attr(tag, "aria-label") || "").trim()) continue;
    if (attr(tag, "aria-labelledby")) continue;
    const id = attr(tag, "id");
    if (id && forLabels.has(id)) continue;
    // inside an open <label>…</label> that has text?
    const before = body.slice(0, m.index);
    const open = before.lastIndexOf("<label");
    if (open > before.lastIndexOf("</label>")) {
      const rest = body.slice(open, body.indexOf("</label>", m.index) + 8).replace(/<(input|select|textarea)\b[^>]*>/gi, "").replace(/<[^>]*>/g, "").trim();
      if (rest) continue;
    }
    problems.push(tag.length > 140 ? tag.slice(0, 140) + "…" : tag);
  }
  return problems;
}

module.exports = { findUnnamedControls };
