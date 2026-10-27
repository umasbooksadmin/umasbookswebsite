// Language of parts (WCAG 3.1.2 AA, RGAA 8.7): the shop sells English books, so on a French page a book's title and
// author are English words inside French text. Wrapped in <span lang="en"> a screen reader speaks them with an English
// voice instead of a French one. The text is escaped here, so views print it with <%- %>.
//
// The catalogue has no language field (lib/bookLookup.js reads one from the book APIs but it is not stored), so every
// title counts as English. If a book ever carries `language` (an ISO code or a name), a French one is left unwrapped.
// public/ui.js enSpan() is the browser copy of the same rule (test/unit/bookText.test.js keeps them in step).

// the same escapes as EJS's <%= %>, so a title prints the same whether or not it is wrapped
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);

// Is a book in English? No language given = English (the catalogue is English books).
function isEnglishBook(language) {
  const l = String(language || "").trim().toLowerCase();
  return !l || l === "en" || l.indexOf("en-") === 0 || l === "eng" || l === "english";
}

// Escaped text; on a French page, an English book's text is wrapped in <span lang="en">.
function bookText(text, pageLang, language) {
  const t = esc(text);
  return pageLang === "fr" && t && isEnglishBook(language) ? `<span lang="en">${t}</span>` : t;
}

// The favourite heart's accessible name as HTML. English pages keep a plain aria-label (nothing to mark up); on a French
// page an aria-label cannot carry a lang, so the sentence goes in a visually-hidden span inside the button, with the
// title wrapped: « Ajouter <span lang="en">Title</span> aux favoris ».
function favName(title, pageLang, language) {
  return pageLang === "fr" ? `Ajouter ${bookText(title, "fr", language)} aux favoris` : `Add ${esc(title)} to favorites`;
}

// The cart icon's accessible name on a book card (views/partials/card_cart.ejs), the same rule as the heart: an English
// page gets { attr: ' aria-label="..."' }, a French page { span: '<span class="bk-cart-name">... <span lang="en">Title</span> ...</span>' }
// (text inside the control). public/ui.js cartName() is the browser copy (test/unit/uiHelpers.test.js compares them).
const CART_NAMES = {
  add: ["Add {t} to cart", "Ajouter {t} au panier"],
  inCart: ["{t} is in your cart (view cart)", "{t} est dans votre panier (voir le panier)"],
  choose: ["Choose a copy of {t} to add to cart", "Choisir un exemplaire de {t} à ajouter au panier"],
};
function cartName(key, title, pageLang, language) {
  const [en, fr] = CART_NAMES[key];
  if (pageLang !== "fr") return { attr: ` aria-label="${esc(en.split("{t}").join(String(title == null ? "" : title)))}"`, span: "" };
  const parts = fr.split("{t}");
  return { attr: "", span: `<span class="bk-cart-name">${esc(parts[0])}${bookText(title, "fr", language)}${esc(parts.slice(1).join("{t}"))}</span>` };
}

module.exports = { bookText, favName, cartName, isEnglishBook, esc };
