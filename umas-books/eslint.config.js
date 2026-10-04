const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      // Catches real bugs (a typo'd variable, a forgotten import) without
      // being pedantic about style — this project has no existing lint
      // config, so start from eslint:recommended rather than a large
      // opinionated preset that would surface hundreds of pre-existing
      // style violations unrelated to correctness.
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The end-to-end tests (e2e/) run small functions inside a real browser
    // page (page.evaluate / page.$eval), so those files also see browser globals.
    files: ["e2e/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    ignores: ["node_modules/**", "public/**", "scripts/sitemap/*.json", "scripts/sitemap/*-filled.html", "e2e/artifacts/**"],
  },
];
