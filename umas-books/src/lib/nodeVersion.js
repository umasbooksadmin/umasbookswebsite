// Minimum safe Node.js version per major, and a pure check of the version the
// app is RUNNING. No network calls: the table is edited by hand when Node
// publishes a security release (docs/runbook.md, "Node.js security updates").
// Pinned in umas-books/.node-version; shown on /admin/diagnostics/client-ip and
// as a warning on the admin dashboard when the running version is older.
//
// 22.23.4 / 24.22.1 / 26.12.1: the 2026-10-20/21 security releases (TLS hostname
// check, Brotli decompression, CA store update), asked for by Render on 2026-10-27.
const MINIMUM_NODE = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// -1, 0 or 1 like a comparator; null if either is not a version.
function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// { version, major, minimum, ok, known }. ok is false only when the major is in
// the table and the version is older than its minimum. A major not in the table
// (or an unparseable version) is reported as unknown, never as a warning.
function checkNodeVersion(version = process.version, table = MINIMUM_NODE) {
  const p = parse(version);
  if (!p) return { version: String(version), major: null, minimum: null, ok: true, known: false };
  const minimum = table[p[0]] || null;
  if (!minimum) return { version: String(version), major: p[0], minimum: null, ok: true, known: false };
  return { version: String(version), major: p[0], minimum, ok: compareVersions(version, minimum) >= 0, known: true };
}

module.exports = { MINIMUM_NODE, compareVersions, checkNodeVersion };
