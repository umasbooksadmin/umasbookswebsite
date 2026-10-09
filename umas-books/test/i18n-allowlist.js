// Text that may appear unchanged on a French page, each with the reason.
// `match` is an exact string (compared case-insensitively) or a RegExp.
// Add an entry only when the text is a proper noun, a legal identifier, stored
// content or French already; everything else must be translated.
const { ALLOWLIST } = require("./helpers/i18nAudit");

const ALLOW = [
  ...ALLOWLIST.map((match) => ({ match, reason: "shared brand / legal / place name (test/helpers/i18nAudit.js)" })),
  { match: /^Crawl /, reason: "seeded test data (titles, names), stored content" },
];

module.exports = { ALLOW };
