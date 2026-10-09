// Static half of the French audit: finds string literals in the customer-facing
// server code (src/routes except admin, src/lib, src/middleware, src/mailer)
// that read as English sentences and are NOT inside a tr()/emailTr() pair.
// A literal counts when it has at least two words and either contains an English
// function word or starts with a capital letter followed by lower-case words.
// Candidates are reviewed by a person: logs, SQL, errors thrown for developers and
// admin-only code are ignored here by pattern, and the rest is listed in
// docs/i18n-audit.md.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const FR_WORDS = /[àâçéèêëîïôûùüœ]|\b(le|la|les|des|du|vous|votre|vos|nous|est|pour|dans|avec|une?|ce|cette|pas|sur)\b/i;
const EN_STOP = /\b(the|and|your|please|click|here|with|from|you|our|not|are|this|that|have|will|for|has|was|can|if|to|of|is|it|be|by|we|must|should|could|would|been|their|they|but|all|any|there|than|into)\b/i;

// The server code a customer can reach: every non-admin route and middleware, plus the
// libraries that build customer messages (emails, notices, errors, legal text). The rest of
// src/lib is admin, till, reports, jobs or plumbing, whose English is meant for staff and logs.
const CUSTOMER_LIBS = [
  "cart", "errorHandler", "orderEmail", "orderSweeps", "bookRequests", "privacy", "membership", "marketingForms",
  "forumModeration", "reservations", "legal", "legalText", "inventory", "emailVerification", "passwordReset",
  "memberExport", "privacyRequests", "returnTo", "orderItems", "dates", "money", "calendar", "genres",
  "charityCategories", "membershipPage", "accountTypes", "baseUrl", "bookSeo", "bookDescription",
];

function listFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "admin") walk(p); } else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  walk(path.join(ROOT, "src", "routes"));
  walk(path.join(ROOT, "src", "middleware"));
  for (const l of CUSTOMER_LIBS) { const f = path.join(ROOT, "src", "lib", l + ".js"); if (fs.existsSync(f)) out.push(f); }
  out.push(path.join(ROOT, "src", "index.js"));
  return out;
}

// [start, end) character ranges of the arguments of every tr(...) / req.tr(...) call.
function trRanges(src) {
  const { splitArgs } = require("./i18nPairs");
  const out = [];
  const CALL = /(?<![\w$])(?:[\w$]+\.)*(?:tr|emailTr\([^)]*\))\(/g;
  let m;
  while ((m = CALL.exec(src))) {
    const args = splitArgs(src, CALL.lastIndex);
    out.push([CALL.lastIndex, CALL.lastIndex + args.reduce((n, a) => n + a.length + 1, 0)]);
  }
  return out;
}

// Strings in `src` with line numbers; comments are blanked first.
function literals(src) {
  const out = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "\n") { line++; i++; continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; } i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i, startLine = line, q = ch;
      i++;
      let val = "";
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { val += src[i + 1]; i += 2; continue; }
        if (src[i] === "\n") line++;
        if (q === "`" && src[i] === "$" && src[i + 1] === "{") { // skip the expression, keep a hole
          let d = 0;
          while (i < n) { if (src[i] === "{") d++; else if (src[i] === "}") { d--; if (!d) { i++; break; } } else if (src[i] === "\n") line++; i++; }
          val += "{}";
          continue;
        }
        val += src[i]; i++;
      }
      i++;
      out.push({ value: val, line: startLine, start, end: i, quote: q });
      continue;
    }
    i++;
  }
  return out;
}

const IGNORE_CONTEXT = /console\.\w+\(|new Error\(|throw |require\(|logger|\.query\(|SELECT |INSERT |UPDATE |DELETE |CREATE |ALTER |process\.env|res\.set\(|\.setHeader\(|\.header\(|Cache-Control|Content-|audit\(|logAudit|recordAudit|admin_audit|JSON\.parse|\.on\(|require\.main/;

function scan() {
  const found = [];
  for (const file of listFiles()) {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    const ranges = trRanges(src);
    const lits = literals(src);
    const frenchy = (l) => l && FR_WORDS.test(l.value) && !EN_STOP.test(l.value);
    for (let i = 0; i < lits.length; i++) {
      const lit = lits[i];
      if (ranges.some(([a, b]) => lit.start >= a && lit.start < b)) continue;
      // [english, french] arrays and { en, fr } objects: the English next to a French sibling is a pair
      const prev = lits[i - 1], next = lits[i + 1];
      if ((frenchy(next) && next.start - lit.end < 400) || (frenchy(prev) && lit.start - prev.end < 400)) continue;
      const v = lit.value.replace(/\s+/g, " ").trim();
      if (v.length < 8 || !/\s/.test(v)) continue;
      if (/^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER)\b/i.test(v) || /[{};=<>]/.test(v.slice(0, 3)) || /^[\w./:-]+$/.test(v)) continue;
      const words = v.split(" ");
      const englishy = EN_STOP.test(v) || /^[A-Z][a-z]+( [a-z]+)+/.test(v);
      if (!englishy) continue;
      if (/[àâçéèêëîïôûùüœ]/i.test(v) && !EN_STOP.test(v)) continue;
      const lineText = lines[lit.line - 1] || "";
      if (IGNORE_CONTEXT.test(lineText)) continue;
      if (words.length < 2) continue;
      found.push({ file: path.relative(ROOT, file), line: lit.line, text: v });
    }
  }
  return found;
}

module.exports = { scan, literals };
