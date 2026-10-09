// Reads every tr(english, french) call in the customer-facing source (views,
// routes, libs, middleware, client scripts' server-side callers) and checks the
// pair: French present, different from the English, no English function words
// left in it, "e-mail" spelled the site's way, and the same {placeholders} on
// both sides. Pure source analysis (no app, no database).
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

function files() {
  const out = [];
  const walk = (dir, skip) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.includes(e.name)) walk(p, skip); }
      else if (/\.(js|ejs)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, "src"), []);
  walk(path.join(ROOT, "views"), []);
  return out.filter((f) => !/[\\/](admin|pricing)[\\/]|[\\/]till|clearTestData|demoData|[\\/]reports/.test(f));
}

// Splits the argument list that starts right after "tr(" at `i` into top-level arguments (source text).
function splitArgs(src, i) {
  const args = [];
  let depth = 0, cur = "", n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; cur += ch; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { cur += src[i] + src[i + 1]; i += 2; continue; }
        if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
          let d = 0;
          while (i < n) { cur += src[i]; if (src[i] === "{") d++; else if (src[i] === "}") { d--; if (!d) { i++; break; } } i++; }
          continue;
        }
        cur += src[i]; i++;
      }
      cur += q; i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) { args.push(cur); return args; }
      depth--;
    }
    if (ch === "," && depth === 0) { args.push(cur); cur = ""; i++; continue; }
    cur += ch; i++;
  }
  return args;
}

// The text of an argument made only of string literals joined by "+": null when it is anything else.
function literalValue(arg) {
  const a = arg.trim();
  if (!a) return null;
  let out = "", i = 0;
  const n = a.length;
  while (i < n) {
    while (i < n && /[\s+]/.test(a[i])) i++;
    if (i >= n) break;
    const q = a[i];
    if (q !== '"' && q !== "'" && q !== "`") {
      // a non-literal part (variable, call): keep a hole, a pair with holes is still comparable
      let d = 0;
      while (i < n && !(d === 0 && a[i] === "+")) { if ("([{".includes(a[i])) d++; if (")]}".includes(a[i])) d--; if ("\"'`".includes(a[i])) { const qq = a[i]; i++; while (i < n && a[i] !== qq) { if (a[i] === "\\") i++; i++; } } i++; }
      out += "{}";
      continue;
    }
    i++;
    while (i < n && a[i] !== q) {
      if (a[i] === "\\") { const nx = a[i + 1]; out += nx === "n" ? "\n" : nx; i += 2; continue; }
      if (q === "`" && a[i] === "$" && a[i + 1] === "{") {
        let d = 0;
        while (i < n) { if (a[i] === "{") d++; else if (a[i] === "}") { d--; if (!d) { i++; break; } } i++; }
        out += "{}";
        continue;
      }
      out += a[i]; i++;
    }
    i++;
  }
  return out;
}

function pairs() {
  const found = [];
  const CALL = /(?<![\w$])(?:[\w$]+\.)*(?:tr|emailTr\([^)]*\))\(/g;
  for (const file of files()) {
    const src = fs.readFileSync(file, "utf8");
    CALL.lastIndex = 0;
    let m;
    while ((m = CALL.exec(src))) {
      const args = splitArgs(src, CALL.lastIndex);
      if (args.length < 2) continue;
      const en = literalValue(args[0]);
      const fr = literalValue(args[1]);
      if (en === null) continue;
      const line = src.slice(0, m.index).split("\n").length;
      // a French side like `n < 2 ? "{n} vote" : "{n} votes"`: every alternative is checked
      const computed = /\?[^?.]/.test(args[1].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')) && fr !== null && args[1].includes("?");
      const alts = computed ? [...args[1].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((x) => x[1] ?? x[2] ?? x[3]) : null;
      found.push({ file: path.relative(ROOT, file), line, en, fr: computed ? alts.join(" | ") : fr, alts, frArg: args[1] });
    }
  }
  return found;
}

const EN_STOP = /\b(the|and|your|please|click|here|with|from|you|our|are|this|that|have|will|has|was|can|would|should|been|their|they|but|there|than|into)\b/i;
const FR_HINT = /\b(le|la|les|un|une|des|du|de|et|est|sont|vous|votre|vos|nous|notre|nos|pour|dans|avec|sur|par|ce|cette|ces|au|aux|pas|ou|où|que|qui|il|elle|se|sa|son|ses|en)\b|[àâçéèêëîïôûùüÿœ]/i;
const BRAND = /Uma(?:'|’)s Books (?:and|&) Adventures/gi;

// Problems with a pair, as short reasons.
function problems(p) {
  if (p.alts) {
    // alternatives of one French side: only a side where ALL of them equal the English is an error
    const all = [...new Set(p.alts.flatMap((a) => problems({ en: p.en, fr: a })))];
    return p.alts.some((a) => a.trim() !== p.en.trim()) ? all.filter((x) => x !== "French equals English") : all;
  }
  const out = [];
  if (p.fr === null) { out.push("French is not plain text (computed)"); return out; }
  const fr = p.fr.trim(), en = p.en.trim();
  if (!fr) out.push("French is empty (falls back to English)");
  else {
    if (fr === en && (fr.match(/\p{L}/gu) || []).length >= 3) out.push("French equals English");
    if (EN_STOP.test(fr.replace(BRAND, "")) && !FR_HINT.test(fr.replace(BRAND, ""))) out.push("French reads as English");
    if (/\b[eE]mails?\b/.test(fr.replace(/https?:\S+|\S+@\S+|\{\w*\}/g, ""))) out.push("write e-mail with a hyphen in French");
    if (/\bcourriels?\b/i.test(fr)) out.push("courriel: the site says e-mail");
  }
  return out;
}

module.exports = { pairs, problems };
