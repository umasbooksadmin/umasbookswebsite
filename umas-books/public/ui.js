// Shared browser helpers for the pages that draw books from JSON (Browse, Favorites, the events list, the blog): the one
// copy of HTML escaping, money, cover attributes and the two book-card layouts. A plain script (no module syntax, the
// marketing CSP allows only same-origin scripts): load it BEFORE the page script that uses it, e.g. in
// views/marketing/books.ejs extraScripts. It sets window.UmasUI; test/unit/uiHelpers.test.js loads it in Node too.
//
//   UmasUI.esc(s)                 HTML-escape text or an attribute value (null/undefined -> '')
//   UmasUI.lang()                 'fr' or 'en', from <html lang> (the server renders it; the toggle keeps it current)
//   UmasUI.t(key, fallback)       a string of the page's own dictionary (window.PAGE_I18N, see page-i18n.js)
//   UmasUI.euro(n)                12,50 € in French, €12.50 in English: the same as lib/money.js formatEuro
//   UmasUI.coverSrcset(url)       "/img/<hash>-w300.jpg 300w, ..." for a stored cover, '' for any other address
//   UmasUI.coverAttrs(url, sizes) ' srcset="..." sizes="..."' (leading space) or ''
//   UmasUI.bookCardHtml(b, withFavorite)   the Browse card (.bk-book): the New In carousel and the search/genre grid;
//                                          views/marketing/collection.ejs draws the same card on the server
//   UmasUI.favoriteCardHtml(b)             the Favorites page card (.book-card-wrap), which also shows stock
//   UmasUI.enSpan(text, language)  escaped text; on a French page an English book's text wrapped in <span lang="en"> (WCAG 3.1.2;
//                                 src/lib/bookText.js is the server twin, test/unit/bookText.test.js keeps them in step)
//   UmasUI.favNameHtml(title, language)   the heart's spoken name for a French page: « Ajouter <span lang="en">T</span> aux favoris »
//   UmasUI.reducedMotion()        true when the person asked for less motion
(function (root, factory) {
  var api = factory();
  if (typeof window !== 'undefined') window.UmasUI = api;
  else if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UmasUI = api;
})(this, function () {
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  function lang() {
    var l = typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : '';
    return (l || '').toLowerCase().indexOf('fr') === 0 ? 'fr' : 'en';
  }

  function t(key, fallback) {
    var dict = (typeof window !== 'undefined' && window.PAGE_I18N && window.PAGE_I18N[lang()]) || {};
    return dict[key] || fallback || key;
  }

  // Same output as lib/money.js formatEuro: 12,50 € in French, €12.50 in English.
  function euro(n) {
    n = Number(n);
    if (!isFinite(n)) return '';
    if (lang() !== 'fr') return '€' + n.toFixed(2);
    try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n); } catch { return n.toFixed(2).replace('.', ',') + '\u00a0€'; }
  }

  // Smaller copies of a stored cover (routes/img.js: /img/<hash>-w300.jpg, -w450, -w600) so a phone does not
  // download the 600 px file for a 160 px slot. Mirrors lib/imageVariants.js coverSrcset; other addresses get none.
  function coverSrcset(u) {
    var m = /^\/img\/([0-9a-f]{64})\.jpg$/.exec(u || '');
    return m ? '/img/' + m[1] + '-w300.jpg 300w, /img/' + m[1] + '-w450.jpg 450w, ' + u + ' 600w' : '';
  }
  function coverAttrs(u, sizes) {
    var s = coverSrcset(u);
    return s ? ' srcset="' + esc(s) + '" sizes="' + sizes + '"' : '';
  }
  var COVER_SIZES = '(max-width: 700px) 45vw, 200px';

  // Language of parts (WCAG 3.1.2): the shop sells English books, so on a French page a title or an author is English
  // text inside French text. A book with a `language` that is not English (none today: the catalogue has no such field)
  // is left alone, like lib/bookText.js isEnglishBook.
  function isEnglishBook(language) {
    var l = String(language == null ? '' : language).trim().toLowerCase();
    return !l || l === 'en' || l.indexOf('en-') === 0 || l === 'eng' || l === 'english';
  }
  function enSpan(text, language) {
    var h = esc(text);
    return h && lang() === 'fr' && isEnglishBook(language) ? '<span lang="en">' + h + '</span>' : h;
  }
  // The heart's name on a French page: an aria-label cannot carry a lang, so it is a visually-hidden span inside the
  // button (class fav-name, public/site-header.css) with the title marked up. English pages keep the aria-label.
  function favNameHtml(title, language) {
    var parts = t('bk.fav.add', 'Ajouter {t} aux favoris').split('{t}'); // French pages only (favButton); the fallback is French because the Favorites page has no dictionary
    return esc(parts[0]) + enSpan(frApos(title), language) + esc(parts.slice(1).join('{t}'));
  }
  function favButton(id, title, language, pressed, labelEn) {
    var open = '<button type="button" class="favorite-toggle" data-book-id="' + esc(id) + '" aria-pressed="' + pressed + '"';
    return lang() === 'fr'
      ? open + '>' + HEART + '<span class="fav-name">' + favNameHtml(title, language) + '</span></button>'
      : open + ' aria-label="' + esc(labelEn) + '">' + HEART + '</button>';
  }

  // On a /fr/ page the cards link to /fr/books/12 (assets/site.js decides which paths have a French address).
  function href(u) { return typeof window !== 'undefined' && window.UmasFrHref ? window.UmasFrHref(u) : u; }

  var HEART = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 20s-7-4.4-9.5-8.8C.8 7.8 2.4 4.5 5.8 4c2-.3 3.7.7 4.8 2.4L12 8l1.4-1.6C14.5 4.7 16.2 3.7 18.2 4c3.4.5 5 3.8 3.3 7.2C19 15.6 12 20 12 20z"/></svg>';

  // The Browse card. b = { id, title, author, price, coverUrl, url }.
  function bookCardHtml(b, withFavorite) {
    var cover = b.coverUrl
      ? '<img class="cover" src="' + esc(b.coverUrl) + '"' + coverAttrs(b.coverUrl, COVER_SIZES) + ' alt="" width="200" height="300" loading="lazy" decoding="async" data-cover>'
      : '<div class="cover cover-none" aria-hidden="true">' + esc(t('bk.nocover', 'No cover')) + '</div>';
    var price = b.price != null ? euro(b.price) : '';
    var fav = withFavorite ? favButton(b.id, b.title, b.language, 'false', t('bk.fav.add', 'Add {t} to favorites').replace('{t}', b.title)) : '';
    return '<div class="bk-book">' + fav +
      '<a href="' + esc(href(b.url)) + '">' + cover +
        '<div class="t">' + enSpan(b.title, b.language) + '</div>' +
        (b.author ? '<div class="a">' + enSpan(b.author, b.language) + '</div>' : '') +
        (price ? '<div class="p">' + esc(price) + '</div>' : '') +
      '</a></div>';
  }

  // French typography: a curly apostrophe in a title ("L'Étranger" -> "L’Étranger") in the French label.
  function frApos(text) { return String(text || '').replace(/'/g, '’'); }

  // The Favorites page card. b = { id, title, author, price, coverUrl, url, inStockCount }. Always a filled heart.
  function favoriteCardHtml(b) {
    var fr = lang() === 'fr';
    function pick(en, frText) { return fr ? frText : en; }
    var cover = b.coverUrl
      ? '<img src="' + esc(b.coverUrl) + '"' + coverAttrs(b.coverUrl, COVER_SIZES) + ' alt="" class="book-card-cover" width="200" height="300" loading="lazy" decoding="async" data-cover>'
      : '<div class="book-card-cover book-thumb-placeholder" aria-hidden="true">' + pick('No cover', 'Pas de couverture') + '</div>';
    var price = b.price != null ? '<span class="book-card-price">' + euro(b.price) + '</span>' : '';
    var availability = b.inStockCount > 0
      ? '<span class="availability-badge is-in-stock"><span class="dot"></span>' + b.inStockCount + ' ' + pick('in stock', 'en stock') + '</span>'
      : '<span class="availability-badge is-out">&middot; ' + pick('Currently unavailable', 'Actuellement indisponible') + '</span>';
    return '<div class="book-card-wrap">' +
      favButton(b.id, b.title, b.language, 'true', 'Add ' + b.title + ' to favorites') +
      '<a class="book-card" href="' + esc(b.url) + '">' + cover +
        '<div class="book-card-body">' +
          '<div class="book-card-title">' + enSpan(b.title, b.language) + '</div>' +
          '<div class="muted small">' + (b.author ? enSpan(b.author, b.language) : esc(pick('Unknown author', 'Auteur inconnu'))) + '</div>' +
          '<div class="book-card-meta">' + price + availability + '</div>' +
        '</div>' +
      '</a>' +
    '</div>';
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  return {
    esc: esc, enSpan: enSpan, favNameHtml: favNameHtml, lang: lang, t: t, euro: euro, href: href,
    coverSrcset: coverSrcset, coverAttrs: coverAttrs,
    HEART: HEART, bookCardHtml: bookCardHtml, favoriteCardHtml: favoriteCardHtml,
    reducedMotion: reducedMotion,
  };
});
