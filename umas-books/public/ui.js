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
//                                          views/marketing/partials/book_card.ejs draws the same card on the server (test/unit/uiHelpers.test.js compares them)
//   UmasUI.favoriteCardHtml(b)             the Favorites page card (.book-card-wrap), which also shows stock
//   UmasUI.cartControlHtml(b)              the cart icon on a card's price line (b.buy from the JSON, src/lib/cardCart.js);
//                                          views/partials/card_cart.ejs draws the same on the server; public/cart-add.js runs it
//   UmasUI.cartText(key, title)            the cart icon's words (status lines) in the page language, {t} = the title
//   UmasUI.here()                 this page's path and query (the sign-in page's returnTo)
//   UmasUI.enSpan(text, language)  escaped text; on a French page an English book's text wrapped in <span lang="en"> (WCAG 3.1.2;
//                                 src/lib/bookText.js is the server twin, test/unit/bookText.test.js keeps them in step)
//   UmasUI.favNameHtml(title, language)   the heart's spoken name for a French page: « Ajouter <span lang="en">T</span> aux favoris »
//   UmasUI.frApos(text)           a straight apostrophe as the curly one (French typography)
//   UmasUI.reducedMotion()        true when the person asked for less motion
//   UmasUI.getJSON(url, cb)       GET JSON, cb(err, data); one retry after 4 s, none when rate limited (err.rateLimited): Browse and the
//                                 collection page's "Show more" ask the server the same way
//   UmasUI.syncFavorites(root)    colour the hearts inside root from the saved favourites (public/favorites.js)
//   UmasUI.installCoverFallback() a cover that fails to load becomes the "No cover" box (one listener per page)
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

  // ---- The cart icon on a card's price line (src/lib/cardCart.js decides; public/cart-add.js does the adding) ----
  // The words, in both languages here (the Favorites page has no dictionary); views/partials/card_cart.ejs and
  // src/lib/bookText.js cartName() are the server's copy (test/unit/uiHelpers.test.js compares the HTML).
  var CART_TEXT = {
    en: {
      add: 'Add {t} to cart', inCart: '{t} is in your cart (view cart)', choose: 'Choose a copy of {t} to add to cart',
      added: 'Added to your cart: {t}.', gone: 'Sorry, {t} is no longer available.',
      full: 'Your cart is full: reserve or remove a book first.', error: 'Could not add {t} to your cart. Please try again.',
      busy: 'Too many tries. Please wait a moment and try again.',
    },
    fr: {
      add: 'Ajouter {t} au panier', inCart: '{t} est dans votre panier (voir le panier)', choose: 'Choisir un exemplaire de {t} à ajouter au panier',
      added: 'Ajouté à votre panier : {t}.', gone: 'Désolé, {t} n’est plus disponible.',
      full: 'Votre panier est plein : réservez ou retirez d’abord un livre.', error: 'Impossible d’ajouter {t} à votre panier. Veuillez réessayer.',
      busy: 'Trop de tentatives. Veuillez patienter un instant puis réessayer.',
    },
  };
  function cartText(key, title) { return CART_TEXT[lang()][key].split('{t}').join(String(title == null ? '' : title)); }
  // An English page names the control with aria-label; a French one with a visually-hidden span inside it, so the English
  // title can carry lang="en" (the same as the heart, favButton).
  function cartName(key, title, language) {
    if (lang() !== 'fr') return { attr: ' aria-label="' + esc(cartText(key, title)) + '"', span: '' };
    var parts = CART_TEXT.fr[key].split('{t}');
    return { attr: '', span: '<span class="bk-cart-name">' + esc(parts[0]) + enSpan(frApos(title), language) + esc(parts.slice(1).join('{t}')) + '</span>' };
  }
  var CART_ADD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.5 3.5h2.6l2.3 11.2a1.6 1.6 0 0 0 1.6 1.3h8.3a1.6 1.6 0 0 0 1.6-1.2l1.6-6.8H6"/><circle cx="9.5" cy="20" r="1.3"/><circle cx="17.5" cy="20" r="1.3"/><path d="M13.3 9.6v4M11.3 11.6h4"/></svg>';
  var CART_IN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 8h14.8l-1.6 6.8a1.6 1.6 0 0 1-1.6 1.2H9a1.6 1.6 0 0 1-1.6-1.3z" fill="currentColor"/><path d="M2.5 3.5h2.6L6 8"/><circle cx="9.5" cy="20" r="1.3"/><circle cx="17.5" cy="20" r="1.3"/><path d="m10.9 11.9 1.8 1.8 3.4-3.6" stroke="#fff"/></svg>';
  // Where the person is, for the sign-in page's returnTo (src/lib/returnTo.js accepts a local path up to 200 characters).
  function here() {
    if (typeof location === 'undefined' || !location.pathname) return '/';
    var p = location.pathname + (location.search || '');
    return p.length <= 200 ? p : location.pathname.slice(0, 200);
  }
  // b = { id, title, language, url, buy }; buy = null | { copyId } | { choose: true }. '' when there is nothing to buy online.
  // Drawn in the browser it is always the "not in your cart" state with a plain GET form to the sign-in page (works with no
  // session at all); public/cart-add.js turns it into the right state and posts the add itself.
  function cartControlHtml(b) {
    var buy = b && b.buy;
    if (!buy || !(buy.copyId > 0 || buy.choose)) return '';
    var control;
    if (buy.copyId > 0) {
      var add = cartName('add', b.title, b.language);
      control = '<form class="bk-cart-add" method="get" action="/books/' + esc(b.id) + '" data-copy-id="' + esc(buy.copyId) + '">' +
        '<button type="submit" class="bk-cart-btn"' + add.attr + '>' + CART_ADD_SVG + add.span + '</button></form>';
    } else {
      var choose = cartName('choose', b.title, b.language);
      control = '<a class="bk-cart-btn bk-cart-choose" href="' + esc(href(b.url)) + '"' + choose.attr + '>' + CART_ADD_SVG + choose.span + '</a>';
    }
    var inCart = cartName('inCart', b.title, b.language);
    return '<span class="bk-cart" data-book-id="' + esc(b.id) + '">' + control +
      '<a class="bk-cart-btn bk-cart-in" href="/cart"' + inCart.attr + ' hidden>' + CART_IN_SVG + inCart.span + '</a></span>';
  }

  // The Browse card. b = { id, title, author, price, coverUrl, url, buy }. The price line is outside the link: it carries the
  // cart icon (a form or a link of its own cannot sit inside a link).
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
      '</a>' +
      (price ? '<div class="p">' + esc(price) + cartControlHtml(b) + '</div>' : '') +
      '</div>';
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
    // The price line (price, stock, cart icon) is outside the link (a form cannot sit inside a link); the link still covers the
    // whole card (public/style.css .book-card::after), under the icon.
    return '<div class="book-card-wrap">' +
      favButton(b.id, b.title, b.language, 'true', 'Add ' + b.title + ' to favorites') +
      '<a class="book-card" href="' + esc(b.url) + '">' + cover +
        '<div class="book-card-body">' +
          '<div class="book-card-title">' + enSpan(b.title, b.language) + '</div>' +
          '<div class="muted small">' + (b.author ? enSpan(b.author, b.language) : esc(pick('Unknown author', 'Auteur inconnu'))) + '</div>' +
        '</div>' +
      '</a>' +
      '<div class="book-card-meta">' + price + cartControlHtml(b) + availability + '</div>' +
    '</div>';
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  function getJSON(url, cb, isRetry) {
    fetch(url)
      .then(function (res) {
        // 429 (too many searches from this connection): no automatic retry, say so.
        if (res.status === 429) { var e = new Error('rate limited'); e.rateLimited = true; throw e; }
        if (!res.ok) throw new Error('bad response');
        return res.json();
      })
      .then(function (data) { cb(null, data); })
      .catch(function (err) {
        if (err && err.rateLimited) { cb(err); return; }
        if (!isRetry) { setTimeout(function () { getJSON(url, cb, true); }, 4000); return; }
        cb(err);
      });
  }

  function syncFavorites(root) {
    if (window.UmasFavorites) root.querySelectorAll('.favorite-toggle').forEach(window.UmasFavorites.sync);
  }

  function installCoverFallback() {
    document.addEventListener('error', function (e) {
      var img = e.target;
      if (!img || img.tagName !== 'IMG' || !img.classList.contains('cover')) return;
      var ph = document.createElement('div');
      ph.className = 'cover cover-none';
      ph.setAttribute('aria-hidden', 'true');
      ph.textContent = t('bk.nocover', 'No cover');
      img.replaceWith(ph);
    }, true);
  }

  return {
    getJSON: getJSON, syncFavorites: syncFavorites, installCoverFallback: installCoverFallback,
    frApos: frApos, esc: esc, enSpan: enSpan, favNameHtml: favNameHtml, lang: lang, t: t, euro: euro, href: href,
    coverSrcset: coverSrcset, coverAttrs: coverAttrs,
    HEART: HEART, bookCardHtml: bookCardHtml, favoriteCardHtml: favoriteCardHtml,
    cartControlHtml: cartControlHtml, cartText: cartText, cartName: cartName, here: here,
    reducedMotion: reducedMotion,
  };
});
