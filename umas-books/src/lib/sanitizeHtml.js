// Strips down the rich-text editor's contenteditable output (see
// data-richtext in public/app.js) to a small allowlist before it's
// stored — an admin account is already trusted with far more than this,
// but the result is shown to every member on the dashboard, so this is a
// defense-in-depth backstop against a stray pasted <script>/<img onerror>
// rather than a hard security boundary. Uses sanitize-html (a real,
// maintained HTML parser) rather than hand-rolled regex — regex-based
// HTML "parsing" has a long history of subtle bypasses (nested-tag
// obfuscation, broken-attribute quote escapes, etc.) that are easy to
// miss even when each individual case looks handled.

const sanitizeHtmlLib = require("sanitize-html");

const ALLOWED_TAGS = ["b", "strong", "i", "em", "u", "ul", "ol", "li", "blockquote", "a", "p", "br", "div", "span"];

function sanitizeHtml(html) {
  if (!html) return "";
  return sanitizeHtmlLib(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ["href", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    // A disallowed/invalid href (a bare "#", a javascript: URI, ...)
    // becomes this instead of being dropped, matching the previous
    // sanitizer's behavior of keeping the link text but neutering it.
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: "a",
        attribs: { href: attribs.href || "#", target: "_blank", rel: "noopener" },
      }),
    },
  });
}

module.exports = { sanitizeHtml };
