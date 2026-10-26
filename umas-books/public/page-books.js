// Books page (views/marketing/books.ejs): shelves filled from /api/books/*. Was an inline <script>; external so the marketing CSP needs no unsafe-inline.
(function () {
  var API = '/api/books';

  var UI = window.UmasUI;   // public/ui.js: escaping, money, cover attributes, the book card
  var esc = UI.esc, t = UI.t;

  var getJSON = UI.getJSON;   // public/ui.js: GET JSON with one retry, none when rate limited
  UI.installCoverFallback();  // a cover that fails to load becomes the "No cover" box
  var syncFavorites = UI.syncFavorites;

  // The genre buttons are in the page (views/marketing/books.ejs, from src/lib/browseGenres.js); read them back here.
  var genreList = document.getElementById('bk-genre-list'); // the track of the Browse by Genre carousel
  var GENRES = Array.prototype.map.call(genreList.querySelectorAll('.bk-genre'), function (el) {
    return { slug: el.getAttribute('data-slug'), key: el.querySelector('[data-i18n]').getAttribute('data-i18n'), topic: el.getAttribute('data-topic') };
  });

  var resultsEl = document.getElementById('bk-results');
  var resultsTitle = document.getElementById('bk-results-title');
  var resultsGrid = document.getElementById('bk-results-grid');
  var form = document.getElementById('shop-search-form');
  var input = document.getElementById('shop-search-input');
  var lastTitle = null;
  var newSection = document.querySelector('.bk-new');
  var moreBtn = document.getElementById('bk-more');
  var statusEl = document.getElementById('bk-status');   // visually-hidden status line for screen readers (no counts)
  // Say something short to screen readers. Cleared first so the same sentence twice in a row is announced again.
  function say(key) {
    if (!statusEl) return;
    statusEl.textContent = '';
    setTimeout(function () { statusEl.textContent = t(key); }, 60);
  }
  var moreOffset = null;
  var newShown = [];
  var pager = null;     // how the list on screen is paged: { urlFor(offset) }
  var collectionsEl = document.getElementById('bk-collections'); // absent when no collection is published

  // ---- Carousels: New In, Browse by Collection, Browse by Genre (public/carousel.js) ----
  var makeCarousel = window.UmasCarousel.make;

  var track = document.getElementById('bk-new-track');
  // New In arrives in batches of NEW_IN_BATCH (the API clamps at 100): the newest first, the next batch as the guest nears the end.
  var NEW_IN_BATCH = 60;
  var newInNext = 0;          // offset of the next batch, null once the server said there is no more
  var newInLoaded = false;    // the first batch is in
  var newInIds = {};          // ids already in the track (a book added meanwhile shifts the next batch by one: show each once)
  function appendNewIn(books) {
    var tmp = document.createElement('div');
    tmp.innerHTML = books.filter(function (b) {
      if (newInIds[b.id]) return false;
      newInIds[b.id] = true;
      return true;
    }).map(function (b) { return UI.bookCardHtml(b, true); }).join('');
    syncFavorites(tmp);
    var frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    track.appendChild(frag);
  }
  function newInBatchUrl(offset) { return API + '/new-in?offset=' + offset + '&limit=' + NEW_IN_BATCH; }
  var newCarousel = makeCarousel(track, document.getElementById('bk-new-prev'), document.getElementById('bk-new-next'), '.bk-book', {
    hasMore: function () { return newInLoaded && newInNext != null; },
    load: function (done) {
      getJSON(newInBatchUrl(newInNext), function (err, data) {
        if (err) { done(false); return; }
        appendNewIn(data.books || []);
        newInNext = data.nextOffset;
        // an empty batch with a next offset cannot happen; stop rather than ask for ever
        if (!(data.books || []).length) newInNext = null;
        done(true);
      });
    }
  });
  var layoutCarousel = newCarousel.layout;
  var genreCarousel = makeCarousel(genreList, document.getElementById('bk-genre-prev'), document.getElementById('bk-genre-next'), '.bk-genre');
  var collectionCarousel = collectionsEl
    ? makeCarousel(document.getElementById('bk-col-track'), document.getElementById('bk-col-prev'), document.getElementById('bk-col-next'), 'li')
    : null;
  // A hidden carousel has no width: lay each one out again when it is shown.
  function layoutAll() {
    layoutCarousel();
    genreCarousel.layout();
    if (collectionCarousel) collectionCarousel.layout();
  }

  // The search / genre state lives in the address (public/books-state.js): a genre tap or a search
  // adds a history entry, so Back returns to the previous results, and the address can be shared.
  var S = window.UmasBooksState;
  var SLUGS = GENRES.map(function (g) { return g.slug; });
  var current = S.empty();
  var cache = {};       // url -> books: Back / Forward re-shows results without asking the server again (the search limit is per minute)
  var requestSeq = 0;   // only the latest request may draw

  function setActiveGenre(index) {
    genreList.querySelectorAll('.bk-genre').forEach(function (el) {
      var on = String(index) === el.getAttribute('data-index');
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (index != null) genreCarousel.reveal(index);
  }
  function renderTitle() {
    if (!lastTitle) return;
    resultsTitle.textContent = lastTitle.q != null
      ? t('bk.results.for', 'Results for “{q}”').replace('{q}', lastTitle.q)
      : t(lastTitle.key);
  }
  var reducedMotion = UI.reducedMotion;
  function scrollToResults(again) {
    // The second call (after the results are drawn) is instant: a smooth scroll started while the
    // page was still changing height can be cut short, which left the page at the top on phones.
    resultsEl.scrollIntoView({ behavior: reducedMotion() || again ? 'auto' : 'smooth', block: 'start' });
    // Focus the heading so a keyboard / screen reader user lands on the results too (no second scroll).
    resultsTitle.setAttribute('tabindex', '-1');
    try { resultsTitle.focus({ preventScroll: true }); } catch { /* old browser: the scroll is enough */ }
  }
  function drawBooks(books) {
    if (!books.length) { resultsGrid.innerHTML = '<p class="muted">' + esc(t('bk.empty')) + ' <a href="' + esc(UI.href('/request-a-book')) + '">' + esc(t('bk.empty.ask')) + '</a></p>'; return; }
    resultsGrid.innerHTML = books.map(function (b) { return UI.bookCardHtml(b, true); }).join('');
    syncFavorites(resultsGrid);
  }
  // Genre and search results page the same way as See All New In: 24 at a time with "Show more" (no count shown).
  function showResults(baseUrl, title, scroll) {
    lastTitle = title;
    renderTitle();
    resultsEl.hidden = false;
    pager = { urlFor: function (offset) { return baseUrl + '&paged=1&offset=' + offset + '&limit=24'; } };
    loadPage(0, false, ++requestSeq, scroll);
  }

  // "See All New In": every book that counts as New In (src/lib/latestArrivals.js newIn), 24 at a time with a
  // "Show more" button (no count is shown anywhere). Each page is cached by its address, so Back / Forward and a second visit ask nothing.
  function newInUrl(offset) { return API + '/new-in?offset=' + offset + '&limit=24'; }
  function drawPage(data, append, mine) {
    if (mine !== requestSeq) return;
    var firstNew = append ? newShown.length : 0;
    newShown = append ? newShown.concat(data.books) : data.books.slice();
    drawBooks(newShown);
    moreOffset = data.nextOffset;
    moreBtn.hidden = moreOffset == null;
    if (append) {
      var link = resultsGrid.querySelectorAll('.bk-book a')[firstNew];
      if (link) { try { link.focus({ preventScroll: false }); } catch { /* the books are drawn anyway */ } }
    }
  }
  function loadPage(offset, append, mine, scroll) {
    var url = pager.urlFor(offset);
    if (cache[url]) { drawPage(cache[url], append, mine); say(append ? 'bk.status.more' : 'bk.status.results'); if (scroll) scrollToResults(); return; }
    if (!append) resultsGrid.innerHTML = '<p class="muted">' + esc(t('bk.loading', 'Loading books…')) + '</p>';
    if (scroll) scrollToResults();
    moreBtn.setAttribute('aria-disabled', 'true');   // not disabled: the focused button keeps focus while the page loads
    getJSON(url, function (err, data) {
      if (mine !== requestSeq) return;
      moreBtn.removeAttribute('aria-disabled');
      if (err) { say(err.rateLimited ? 'bk.ratelimited' : 'bk.error'); resultsGrid.insertAdjacentHTML('beforeend', '<p class="muted">' + esc(t(err.rateLimited ? 'bk.ratelimited' : 'bk.error')) + '</p>'); return; }
      cache[url] = data;
      drawPage(data, append, mine);
      say(append ? 'bk.status.more' : 'bk.status.results');
      if (scroll && !append && Math.abs(resultsEl.getBoundingClientRect().top) > 40) scrollToResults(true);
    });
  }
  function showNewIn(scroll) {
    lastTitle = { key: 'bk.results.new' };
    renderTitle();
    resultsEl.hidden = false;
    pager = { urlFor: newInUrl };
    loadPage(0, false, ++requestSeq, scroll);
  }
  moreBtn.addEventListener('click', function () {
    if (moreBtn.getAttribute('aria-disabled') === 'true') return;
    if (moreOffset != null) loadPage(moreOffset, true, requestSeq, false);
  });

  // Put a state on the screen (no history change here).
  function render(state, scroll) {
    current = state;
    // The collection buttons (views/marketing/partials/collections_row.ejs) are for the plain Browse view only, like New In.
    if (collectionsEl) collectionsEl.hidden = !!(state.q || state.genre || state.isNew || /[?&]topic=/.test(location.search));
    // The New In carousel is only on the plain Browse view: a search, a genre or "See All New In" already fills the page with a grid.
    newSection.hidden = !!(state.q || state.genre || state.isNew);
    setTimeout(layoutAll, 0);
    moreBtn.hidden = true;
    if (state.q) {
      input.value = state.q;
      setActiveGenre(null);
      showResults(API + '/search?q=' + encodeURIComponent(state.q), { q: state.q }, scroll);
    } else if (state.genre) {
      var i = SLUGS.indexOf(state.genre);
      var g = GENRES[i];
      input.value = '';
      setActiveGenre(i);
      showResults(API + '/search?q=' + (g.topic ? '&topic=' + encodeURIComponent(g.topic) : ''), { key: g.key }, scroll);
    } else if (state.isNew) {
      input.value = '';
      setActiveGenre(null);
      showNewIn(scroll);
    } else {
      input.value = '';
      setActiveGenre(null);
      requestSeq++;
      lastTitle = null;
      resultsEl.hidden = true;
    }
  }
  // A person's choice: a new history entry (Back undoes it), unless it is what is already shown.
  function choose(state) {
    var url = location.pathname + S.serialize(state);
    if (S.same(state, current)) history.replaceState(state, '', url);
    else history.pushState(state, '', url);
    render(state, true);
  }

  genreList.addEventListener('click', function (e) {
    var btn = e.target.closest('.bk-genre');
    if (!btn) return;
    var g = SLUGS[Number(btn.getAttribute('data-index'))];
    choose({ q: '', genre: g, isNew: false });
  });

  // Searching is on submit, not on every key, so nothing is written to the address while typing.
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value.replace(/\s+/g, ' ').trim().slice(0, S.MAX_Q);
    if (!q) { input.focus(); return; }
    choose({ q: q, genre: '', isNew: false });
  });

  document.getElementById('bk-new-all').addEventListener('click', function () {
    choose({ q: '', genre: '', isNew: true });
  });

  // Back / Forward, and the address typed or shared: the screen follows the address.
  window.addEventListener('popstate', function () {
    render(S.parse(location.search, SLUGS), false);
  });
  render(S.parse(location.search, SLUGS), true);

  getJSON(newInBatchUrl(0), function (err, data) {
    if (err) { track.innerHTML = '<p class="muted">' + esc(t('bk.error')) + '</p>'; layoutCarousel(); return; }
    var books = data.books || [];
    if (!books.length) { track.innerHTML = '<p class="muted">' + esc(t('bk.new.empty')) + '</p>'; layoutCarousel(); return; }
    track.innerHTML = '';
    appendNewIn(books);
    newInNext = data.nextOffset;
    newInLoaded = true;
    layoutCarousel();
    // covers and fonts load after this: sizes are in cqw so nothing moves, but re-check the end room once everything is in
    window.addEventListener('load', layoutCarousel);
  });

  document.querySelectorAll('.langtoggle button').forEach(function (b) {
    b.addEventListener('click', function () { setTimeout(function () { renderTitle(); }, 0); });
  });
})();
