// Step ids ("V12", "G4", "VO3", "A5b", "E7"...) in test names, and the list
// of ids in the manual script, so the summary and a unit test can prove the
// two stay in step.

const fs = require("node:fs");
const path = require("node:path");

const ID = /^((?:VO|[VGMAE])\d+[a-z]?)\b/;
const stepIdOf = (name) => (String(name).match(ID) || [])[1] || null;

const SCRIPT = path.join(__dirname, "..", "..", "..", "docs", "testing", "manual-test-scripts.md");

function manualStepIds(file = SCRIPT) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const ids = [];
  for (const m of text.matchAll(/^- \[ \] \*\*((?:VO|[VGMAE])\d+[a-z]?)[ .(*]/gm)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

module.exports = { stepIdOf, manualStepIds, SCRIPT };
