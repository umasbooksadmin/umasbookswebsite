// Text that may appear unchanged on a French page, each entry with the reason.
// `match` is an exact string (compared case-insensitively) or a RegExp.
//
// Add an entry only when the text is a proper noun, a legal identifier, stored
// content or a word spelled the same in French. Everything else must be
// translated (see docs/i18n-audit.md, "Definition of done"). The reason is
// checked by the test: an entry without one fails.
const { ALLOWLIST } = require("./helpers/i18nAudit");

// The entries shared with the older per-page tests (test/helpers/i18nAudit.js): brand names,
// legal identifiers, the shop address, program names, the processors named in the privacy policy.
const SHARED = ALLOWLIST.map((match) => ({ match, reason: "shared allow-list (test/helpers/i18nAudit.js): brand, legal identifier, place or program name" }));

const ALLOW = [
  ...SHARED,
  { match: /^Crawl /, reason: "the crawler's own seeded data (book titles, names, descriptions): stored content, the same in both languages" },
  { match: "Éveil", reason: "program name, French in both languages" },
  { match: "Message", reason: "the same word in French (form label)" },
  { match: "Code", reason: "the same word in French (two-step verification code field)" },
  { match: "Blog", reason: "the word is spelled the same in French (page title and heading of the blog list)" },
  { match: "and Adventures", reason: "second half of the brand lockup \"Uma's Books and Adventures\" on the members' dashboard, which must stay exactly as written" },
  { match: "Cloudflare", reason: "company name in the privacy policy" },
  { match: "Have I Been Pwned", reason: "service name in the privacy policy (the password-breach check)" },
  { match: "umasbooks_lang", reason: "literal name of the language cookie, shown in code style in the legal notice" },
  { match: /^[A-Z2-7]{32}$/, reason: "the generated two-step verification key (base32), shown for typing into an app" },
  { match: "Fiction", reason: "genre button on Browse Books (src/lib/browseGenres.js, drawn by the server): \"Fiction\" is spelled the same in French" },
  { match: "Romance", reason: "genre button on Browse Books (src/lib/browseGenres.js, drawn by the server): \"Romance\" is spelled the same in French" },
  { match: /^1 vote$/, reason: "\"1 vote\" is spelled the same in French" },
  // Book genres are English on both sites (Sharon, 2026-10-28): the Browse genre buttons on /fr/ show the managed genres'
  // English labels (marked lang="en"). Stored content, not interface text; the "All Genres" button stays French.
  ...require("./fixtures/browseGenres.golden.json").genres.filter((g) => g.slug !== "all")
    .map((g) => ({ match: g.en, reason: "genre button on Browse Books: book genres are English on the French site too (stored content, marked lang=\"en\")" })),
];

module.exports = { ALLOW };
