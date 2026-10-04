// Language helpers shared by the request middleware, routes and email builders.
// Only two languages exist: 'en' and 'fr'.

function normLang(x) {
  return x === "fr" || x === "en" ? x : null;
}

// The first candidate that is a valid language, else null.
function pickLang(...candidates) {
  for (const c of candidates) {
    const l = normLang(c);
    if (l) return l;
  }
  return null;
}

// "Hi {name}" + { name: "Ana" } -> "Hi Ana". Unknown placeholders stay as-is.
// No HTML escaping: views print with <%= %>, which escapes.
function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

// (en, fr, vars?) => the string for `lang`; French falls back to English when empty.
function translator(lang) {
  const isFr = lang === "fr";
  return (en, fr, vars) => fill(isFr && fr ? fr : en, vars);
}

// For email builders: const tr = emailTr(order.lang); tr("Hello", "Bonjour").
// Unknown/missing lang means English.
function emailTr(lang) {
  return translator(normLang(lang) || "en");
}

module.exports = { normLang, pickLang, emailTr, translator, fill };
