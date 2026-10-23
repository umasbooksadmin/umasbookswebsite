// Reading the project's stylesheets in tests by MEANING instead of by their text.
//
// A test that matches the CSS source with a regular expression such as
// /\.wn-dot \{[^}]*width: 24px; height: 24px/ breaks when someone reorders two declarations, adds a space or
// merges two rules, although the page looks exactly the same. These helpers parse the file with postcss and
// answer "what does this selector declare?", whatever the order, spacing or comments:
//
//   const style = loadSheet("public/style.css");
//   style.getDecl(".card", "padding");                                  // "22px 24px"
//   style.getRule(".calendar-agenda .calendar-pill summary", { at: "@media (max-width: 480px)" });  // { "min-height": "44px", ... }
//   style.hasRule("main p a:not(.btn)");                                // true (the selector may be one of a comma list)
//
// Matching rules:
// - A selector matches a rule when it is one of that rule's comma-separated selectors (spacing around > + ~ and
//   commas does not matter). "a, b { x }" answers for both "a" and "b".
// - `at` picks the at-rule the rule sits in, written like the CSS: "@media (max-width: 700px), (pointer: coarse)".
//   Left out, only rules at the top level of the sheet are looked at. "*" means any context.
// - When several rules declare the same property for the selector, the LAST one wins (the cascade within one
//   sheet at equal specificity), exactly as the browser would pick it.
// - Values come back with whitespace tidied ("minmax(0, 1fr)"); compare against that form.
// - var(--token) is NOT resolved by getDecl: assert "var(--font-serif)" or use resolveVars() with tokens().

const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");

const APP = path.join(__dirname, "..", "..");
const REPO = path.join(APP, "..");

// "style.css" and "public/style.css" are the app's; "site.css" and "assets/site.css" the marketing site's.
function resolveSheet(name) {
  if (path.isAbsolute(name)) return name;
  const candidates = [
    path.join(REPO, name),
    path.join(APP, name),
    path.join(APP, "public", name),
    path.join(REPO, "assets", name),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`stylesheet not found: ${name}`);
  return hit;
}

// One canonical spelling of a selector: single spaces, " > " / " + " / " ~ " between compound selectors, ", " inside
// :is()/:where()/:not() lists. Characters inside (...) and [...] are only whitespace-collapsed (4n+2, [a~=b] stay).
function tidySelector(sel) {
  let out = "";
  let depth = 0;
  const flat = sel.replace(/\s+/g, " ").trim();
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (depth === 0 && (c === ">" || c === "+" || c === "~")) {
      out = out.replace(/ $/, "") + ` ${c} `;
      if (flat[i + 1] === " ") i++;
    } else if (depth > 0 && c === ",") {
      out = out.replace(/ $/, "") + ", ";
      if (flat[i + 1] === " ") i++;
    } else if (c === "(" && flat[i + 1] === " ") {
      out += c; i++;
    } else if (c === " " && flat[i + 1] === ")") {
      // drop the space before a closing bracket
    } else out += c;
  }
  return out.replace(/\s+/g, " ").trim();
}
const tidyValue = (v) =>
  v.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s*!\s*important/i, " !important").trim();
const tidyAt = (s) => s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s*:\s*/g, ": ").trim();

function atOf(node) {
  const p = node.parent;
  if (p && p.type === "atrule") return tidyAt(`@${p.name} ${p.params}`);
  return "";
}

class Sheet {
  constructor(file, text) {
    this.file = file;
    this.root = postcss.parse(text, { from: file });
    this.list = [];
    this.root.walkRules((rule) => {
      const parent = rule.parent;
      if (parent && parent.type === "atrule" && /keyframes$/i.test(parent.name)) return;
      const decls = [];
      rule.each((n) => { if (n.type === "decl") decls.push({ prop: n.prop, value: tidyValue(n.value), important: !!n.important }); });
      this.list.push({ selectors: rule.selectors.map(tidySelector), at: atOf(rule), decls, node: rule });
    });
  }

  // every rule (one entry per `{}` block) whose selector list contains `selector`
  getRules(selector, { at = "" } = {}) {
    const sel = tidySelector(selector);
    const want = at === "*" ? null : tidyAt(at);
    return this.list.filter((r) => r.selectors.includes(sel) && (want === null || r.at === want));
  }

  hasRule(selector, opts) { return this.getRules(selector, opts).length > 0; }

  // { property: value } as the cascade within this sheet leaves it, or null when no rule names the selector
  getRule(selector, opts) {
    const rules = this.getRules(selector, opts);
    if (!rules.length) return null;
    const out = {};
    for (const r of rules) for (const d of r.decls) out[d.prop] = d.value;
    return out;
  }

  getDecl(selector, prop, opts) {
    const rule = this.getRule(selector, opts);
    return rule ? rule[prop] : undefined;
  }

  // all declarations of a property anywhere in the sheet: [{ selector, at, value }]
  declsOf(prop) {
    const out = [];
    for (const r of this.list) for (const d of r.decls) if (d.prop === prop) out.push({ selectors: r.selectors, at: r.at, value: d.value });
    return out;
  }

  // the custom properties declared on :root, { "--ink": "#000", ... }
  tokens() {
    return this.getRule(":root", { at: "*" }) || {};
  }

  // every declaration of a property anywhere, @font-face and @page blocks included: [{ value, inside }]
  allDecls(prop) {
    const out = [];
    this.root.walkDecls(prop, (d) => {
      const p = d.parent;
      out.push({ value: tidyValue(d.value), inside: p.type === "atrule" ? `@${p.name}` : p.type === "rule" ? tidySelector(p.selector) : "" });
    });
    return out;
  }

  // the declarations of the @font-face rules: [{ "font-family": "'X'", src: "...", ... }]
  fontFaces() {
    const out = [];
    this.root.walkAtRules("font-face", (a) => {
      const o = {};
      a.each((n) => { if (n.type === "decl") o[n.prop] = tidyValue(n.value); });
      out.push(o);
    });
    return out;
  }

  // the declarations directly inside an at-rule such as @page: { margin: "4mm" } (merged when it appears several times)
  atRuleDecls(name) {
    const o = {};
    this.root.walkAtRules(name, (a) => a.each((n) => { if (n.type === "decl") o[n.prop] = tidyValue(n.value); }));
    return o;
  }

  // the text of the at-rules with this name, e.g. every "@media" prelude used in the sheet
  atRules(name) {
    const out = [];
    this.root.walkAtRules(name, (a) => out.push(tidyAt(`@${a.name} ${a.params}`)));
    return out;
  }
}

const cache = new Map();
function loadSheet(name) {
  const file = resolveSheet(name);
  if (!cache.has(file)) cache.set(file, new Sheet(file, fs.readFileSync(file, "utf8")));
  return cache.get(file);
}

const parseCss = (text, file = "inline.css") => new Sheet(file, text);

// Replace var(--x) with the token's value (and var(--x, fallback) with the fallback when the token is missing).
function resolveVars(value, tokens) {
  let out = value;
  for (let i = 0; i < 5 && /var\(/.test(out); i++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (m, name, fallback) =>
      tokens[name] !== undefined ? tokens[name] : fallback !== undefined ? fallback.trim() : m);
  }
  return out;
}

// functional forms, for a test that reads one or two declarations: getRule(sheet, ".x"), getDecl(sheet, ".x", "width")
const getRule = (sheet, selector, opts) => (typeof sheet === "string" ? loadSheet(sheet) : sheet).getRule(selector, opts);
const getDecl = (sheet, selector, prop, opts) => (typeof sheet === "string" ? loadSheet(sheet) : sheet).getDecl(selector, prop, opts);

module.exports = { loadSheet, parseCss, resolveSheet, resolveVars, getRule, getDecl, tidySelector, tidyValue, tidyAt, APP, REPO };
