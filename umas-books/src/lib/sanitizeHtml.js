// Strips down the rich-text editor's contenteditable output (see
// data-richtext in public/app.js) to a small allowlist before it's
// stored — an admin account is already trusted with far more than this,
// but the result is shown to every member on the dashboard, so this is a
// defense-in-depth backstop against a stray pasted <script>/<img onerror>
// rather than a hard security boundary. No jsdom/DOMPurify dependency:
// the editor only ever produces a handful of predictable tags, so a
// small regex allowlist covers it.

const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "ul", "ol", "li", "blockquote", "a", "p", "br", "div", "span"]);

function sanitizeHtml(html) {
  if (!html) return "";
  return html.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, tag, attrs) => {
    const lower = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(lower)) return "";
    if (match.startsWith("</")) return `</${lower}>`;
    if (lower === "a") {
      const hrefMatch = attrs.match(/href\s*=\s*"([^"]*)"/i) || attrs.match(/href\s*=\s*'([^']*)'/i);
      let href = hrefMatch ? hrefMatch[1] : "";
      if (!/^(https?:|mailto:)/i.test(href)) href = "#";
      return `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">`;
    }
    return `<${lower}>`;
  });
}

module.exports = { sanitizeHtml };
