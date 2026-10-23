#!/usr/bin/env node
// Re-records test/fixtures/intakeGolden.json from the CURRENT code (see test/helpers/intakeGolden.js and
// test/integration/intakeGolden.test.js). Only for a deliberate change of what adding or editing a copy answers or stores:
// review the fixture diff, and say in the PR what changed and why.
//   node scripts/record-intake-golden.js [output path]

const fs = require("node:fs");
const path = require("node:path");
const { boot, runMatrix } = require("../test/helpers/intakeGolden");

(async () => {
  const out = process.argv[2] || path.join(__dirname, "..", "test", "fixtures", "intakeGolden.json");
  const h = await boot("intake_record");
  try {
    fs.writeFileSync(out, JSON.stringify(await runMatrix(h), null, 1) + "\n");
    console.log(`wrote ${out}`);
  } finally { await h.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
