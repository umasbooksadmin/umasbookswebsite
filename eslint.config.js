// Lints the marketing site's browser scripts in assets/, which sit outside the app folder (umas-books/) and so outside
// umas-books/eslint.config.js. `npm run lint` (in umas-books/) runs both; the packages come from umas-books/node_modules.
const path = require("node:path");
const { createRequire } = require("node:module");
const appRequire = createRequire(path.join(__dirname, "umas-books", "package.json"));
const js = appRequire("@eslint/js");
const globals = appRequire("globals");

module.exports = [
  js.configs.recommended,
  {
    files: ["assets/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script", // plain <script> files, not modules
      // Browser globals; UmasUI is public/ui.js, UmasBlog is defined in assets/blog.js, UMAS_POSTS in assets/posts.js
      globals: { ...globals.browser, UmasUI: "readonly", UmasFrHref: "readonly" },
    },
    rules: { "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] },
  },
];
