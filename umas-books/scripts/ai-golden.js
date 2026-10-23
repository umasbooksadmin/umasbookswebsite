"use strict";
// Writes the golden outputs of the Anthropic equivalence matrix (test/helpers/aiMatrix.js) for the code in <root>:
//   node scripts/ai-golden.js <path to a checkout of umas-books/> > test/fixtures/ai-client-golden.json
// Run it against a checkout of the code from BEFORE a refactor of the AI calls (the golden file was made from origin/main
// before lib/anthropic.js existed); test/unit/aiClientEquivalence.test.js then proves the current code behaves the same.
const path = require("node:path");
const { runMatrix } = require("../test/helpers/aiMatrix");

runMatrix(path.resolve(process.argv[2] || path.join(__dirname, ".."))).then((m) => {
  process.stdout.write(`${JSON.stringify(m, null, 1)}\n`);
}, (err) => { console.error(err); process.exit(1); });
