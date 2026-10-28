// Collection page (views/marketing/collection.ejs): the book list is the Browse genre results. The server draws the first 24 books;
// "Show more" asks /api/collections/<slug>/books (?lang= the page's language) for the next 24 at a time and draws them with the
// same card (public/ui.js bookCardHtml, with the genre and "why" lines of itemHtml below) and the same behaviour as the Browse
// results (public/page-books.js loadPage): the button is greyed with aria-disabled (never disabled: it has focus), a
// visually-hidden status line says "More books added to the results." (no counts), and focus moves to the first new book. Plain script, loaded after ui.js (the marketing CSP allows only same-origin scripts).
(function () {
  var UI = window.UmasUI;
  var esc = UI.esc, t = UI.t;
  var section = document.getElementById('bk-results');
  var grid = document.getElementById('bk-results-grid');
  var moreBtn = document.getElementById('bk-more');
  var statusEl = document.getElementById('bk-status');
  if (!section || !grid || !moreBtn) return;   // an empty collection has no list
  UI.installCoverFallback();

  var PAGE = 24;
  var slug = section.getAttribute('data-collection');
  var attr = section.getAttribute('data-next-offset');
  var nextOffset = attr == null || attr === '' ? null : Number(attr);   // absent: every book is already in the page
  var errorEl = null;
  moreBtn.hidden = nextOffset == null;   // hidden in the HTML: without JavaScript a button would do nothing

  // Say something short to screen readers. Cleared first so the same sentence twice in a row is announced again.
  function say(key) {
    if (!statusEl) return;
    statusEl.textContent = '';
    setTimeout(function () { statusEl.textContent = t(key); }, 60);
  }
  function showError(key) {
    say(key);
    errorEl = document.createElement('p');
    errorEl.className = 'muted';
    errorEl.textContent = t(key);
    grid.appendChild(errorEl);
  }

  // One book: the Browse card in a .col-item, with its genre and "why it's here" line under it when the API gives them
  // (lib/collections.js bookExtras: the why line in the page's language, the genre always English, so marked lang="en"
  // on a French page). The same markup as views/marketing/collection.ejs.
  function itemHtml(b) {
    var genreLang = document.documentElement.lang === 'fr' ? ' lang="en"' : '';
    var more = (b.genre ? '<p class="col-genre"' + genreLang + '>' + esc(b.genre) + '</p>' : '') +
      (b.why ? '<p class="col-why">' + esc(b.why) + '</p>' : '');
    return '<div class="col-item">' + UI.bookCardHtml(b, true) + (more ? '<div class="col-more">' + more + '</div>' : '') + '</div>';
  }

  function append(books) {
    if (errorEl) { errorEl.remove(); errorEl = null; }
    var seen = {};
    grid.querySelectorAll('.favorite-toggle').forEach(function (b) { seen[b.getAttribute('data-book-id')] = true; });
    // a book sold or added meanwhile shifts the next page by one: show each book once
    var fresh = books.filter(function (b) { return !seen[String(b.id)]; });
    var tmp = document.createElement('div');
    tmp.innerHTML = fresh.map(itemHtml).join('');
    // French page: the server draws the first 24 with curly apostrophes (lib/frenchTypography.js), so the next ones get them too
    if (UI.lang() === 'fr') tmp.querySelectorAll('.t, .a').forEach(function (el) {
      var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n;
      while ((n = w.nextNode())) n.nodeValue = UI.frApos(n.nodeValue);
    });
    UI.syncFavorites(tmp);
    if (window.UmasCart) window.UmasCart.sync(tmp);   // cart icons of books already in the cart (public/cart-add.js)
    var first = tmp.querySelector('.bk-book > a');
    var frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    grid.appendChild(frag);
    return first;
  }

  moreBtn.addEventListener('click', function () {
    if (moreBtn.getAttribute('aria-disabled') === 'true' || nextOffset == null) return;
    moreBtn.setAttribute('aria-disabled', 'true');   // not disabled: the focused button keeps focus while the page loads
    UI.getJSON('/api/collections/' + encodeURIComponent(slug) + '/books?offset=' + nextOffset + '&limit=' + PAGE + '&lang=' + UI.lang(), function (err, data) {
      moreBtn.removeAttribute('aria-disabled');
      if (err) { showError(err.rateLimited ? 'bk.ratelimited' : 'bk.error'); return; }
      var books = data.books || [];
      nextOffset = books.length ? data.nextOffset : null;   // an empty page with a next offset cannot happen; stop rather than ask for ever
      moreBtn.hidden = nextOffset == null;
      var link = append(books);
      if (link) { try { link.focus({ preventScroll: false }); } catch { /* the books are drawn anyway */ } }
      say('bk.status.more');
    });
  });
})();
