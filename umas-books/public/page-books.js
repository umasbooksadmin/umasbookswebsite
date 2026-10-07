// Books page (views/marketing/books.ejs): shelves filled from /api/books/*. Was an inline <script>; external so the marketing CSP needs no unsafe-inline.
(function () {
  var API = '/api/books';

  function lang() {
    // The server renders <html lang> from the person's language; the toggle keeps it current.
    return (document.documentElement.lang || '').toLowerCase().indexOf('fr') === 0 ? 'fr' : 'en';
  }
  // Same output as lib/money.js formatEuro: 12,50 € in French, €12.50 in English.
  function euro(n) {
    n = Number(n);
    if (!isFinite(n)) return '';
    if (lang() !== 'fr') return '€' + n.toFixed(2);
    try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n); } catch (e) { return n.toFixed(2).replace('.', ',') + ' €'; }
  }
  function t(key, fallback) {
    var dict = (window.PAGE_I18N && window.PAGE_I18N[lang()]) || {};
    return dict[key] || fallback || key;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getJSON(url, cb, isRetry) {
    fetch(url)
      .then(function (res) { if (!res.ok) throw new Error('bad response'); return res.json(); })
      .then(function (data) { cb(null, data); })
      .catch(function (err) {
        if (!isRetry) { setTimeout(function () { getJSON(url, cb, true); }, 4000); return; }
        cb(err);
      });
  }

  var HEART = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 20s-7-4.4-9.5-8.8C.8 7.8 2.4 4.5 5.8 4c2-.3 3.7.7 4.8 2.4L12 8l1.4-1.6C14.5 4.7 16.2 3.7 18.2 4c3.4.5 5 3.8 3.3 7.2C19 15.6 12 20 12 20z"/></svg>';

  function bookCard(b, withFavorite) {
    var cover = b.coverUrl
      ? '<img class="cover" src="' + esc(b.coverUrl) + '" alt="" width="200" height="300" loading="lazy" decoding="async" data-cover>'
      : '<div class="cover cover-none">' + esc(t('bk.nocover', 'No cover')) + '</div>';
    var price = b.price != null ? euro(b.price) : '';
    var fav = withFavorite
      ? '<button type="button" class="favorite-toggle" data-book-id="' + esc(b.id) + '" aria-pressed="false" aria-label="' + esc(t('bk.fav.add', 'Add {t} to favorites').replace('{t}', b.title)) + '">' + HEART + '</button>'
      : '';
    return '<div class="bk-book">' + fav +
      '<a href="' + esc(b.url) + '">' + cover +
        '<div class="t">' + esc(b.title) + '</div>' +
        (b.author ? '<div class="a">' + esc(b.author) + '</div>' : '') +
        (price ? '<div class="p">' + esc(price) + '</div>' : '') +
      '</a></div>';
  }
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('cover')) return;
    var ph = document.createElement('div');
    ph.className = 'cover cover-none';
    ph.textContent = t('bk.nocover', 'No cover');
    img.replaceWith(ph);
  }, true);

  function syncFavorites(root) {
    if (window.UmasFavorites) root.querySelectorAll('.favorite-toggle').forEach(window.UmasFavorites.sync);
  }

  var I = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
  var GENRES = [
    { key: 'g.fiction', bg: '#f7dcdc', fg: '#a65347', topic: 'fiction', svg: '<path d="M12 6.5C10.2 5.2 7.6 4.5 4 4.5v14c3.6 0 6.2.7 8 2 1.8-1.3 4.4-2 8-2v-14c-3.6 0-6.2.7-8 2z"/><path d="M12 6.5v14"/><path d="M6.5 8.5c1.5 0 2.8.3 3.8.8M6.5 11.5c1.5 0 2.8.3 3.8.8M17.5 8.5c-1.5 0-2.8.3-3.8.8M17.5 11.5c-1.5 0-2.8.3-3.8.8"/>' },
    { key: 'g.children', bg: '#e0ebdc', fg: '#2b2a26', topic: 'juvenile,child,picture book,baby', svg: '<path d="M4 18h12"/><path d="M5 18c-1-2-1-4 .5-5.5"/><path d="M15 18c1-2 1-4-.5-5.5"/><path d="M6 13h8.5c1.5 0 2.5-1 2.5-2.5V8.5l2-1.5-2-1-1.2-1.5c-.8 1-1.8 1.5-3 1.5H9c-2 0-3 1.5-3 3.5V13z"/><path d="M8 13l-.5 5M13 13l.5 5"/><circle cx="15" cy="7.2" r=".5" fill="currentColor" stroke="none"/>' },
    { key: 'g.ya', bg: '#f4e4d2', fg: '#a65347', topic: 'young adult', svg: '<path d="M6 20c1-7 5-12 13-15-1 8-6 12-13 15z"/><path d="M6 20 15 9"/><path d="M9.5 15.5H7M11.5 13v-2.5M11.5 13H14M14 10V8"/>' },
    { key: 'g.nonfiction', bg: '#dbe8f0', fg: '#2b2a26', topic: 'nonfiction,non-fiction,history,social science,political,philosophy,psychology,business,education,true crime,nature,religion,language', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5S9.5 5.8 12 3.5z"/>' },
    { key: 'g.classics', bg: '#f3d6d1', fg: '#a65347', topic: 'classic', svg: '<path d="M4 7.5h14.5a1.5 1.5 0 0 1 0 3H4z"/><path d="M5 10.5h13a1.5 1.5 0 0 1 0 3H5z"/><path d="M4 13.5h14.5a1.5 1.5 0 0 1 0 3H4z"/><path d="M5 16.5h13a1.5 1.5 0 0 1 0 3H5z"/><path d="M6 4.5h12a1.5 1.5 0 0 1 0 3H6z"/>' },
    { key: 'g.mystery', bg: '#e0ebdc', fg: '#2b2a26', topic: 'mystery,thriller,suspense,crime,detective', svg: '<circle cx="10" cy="10" r="6"/><path d="M14.5 14.5 20 20"/><path d="M7 9.5a3 3 0 0 1 3-3"/>' },
    { key: 'g.romance', bg: '#f7dcdc', fg: '#a65347', topic: 'romance,love', svg: '<path d="M12 20s-7.5-4.6-9.5-9.3C1.2 7.3 3.3 4.5 6.3 4.5c2 0 3.8 1.3 5.7 3.5 1.9-2.2 3.7-3.5 5.7-3.5 3 0 5.1 2.8 3.8 6.2C19.5 15.4 12 20 12 20z"/>' },
    { key: 'g.biography', bg: '#f7dfe2', fg: '#a65347', topic: 'biography,memoir,autobiography', svg: '<circle cx="12" cy="7.5" r="2.6"/><circle cx="6" cy="9" r="2.1"/><circle cx="18" cy="9" r="2.1"/><path d="M7.5 19.5c0-3 2-5.3 4.5-5.3s4.5 2.3 4.5 5.3"/><path d="M2.5 18.5c0-2.4 1.5-4.3 3.5-4.3 1 0 1.8.4 2.4 1"/><path d="M21.5 18.5c0-2.4-1.5-4.3-3.5-4.3-1 0-1.8.4-2.4 1"/>' },
    { key: 'g.health', bg: '#e0ebdc', fg: '#43523a', topic: 'health,fitness,wellness,self-help,mind,body', svg: '<path d="M12 18c-2-2-3-4.5-3-7.5S10 5 12 3.5c2 1.5 3 4 3 7s-1 5.5-3 7.5z"/><path d="M12 18c-3.5 0-6.5-2-8-5 2-.8 4.3-.7 6 .5"/><path d="M12 18c3.5 0 6.5-2 8-5-2-.8-4.3-.7-6 .5"/><path d="M4 18.5h16"/>' },
    { key: 'g.arts', bg: '#f4e4d2', fg: '#a65347', topic: 'arts,crafts,hobbies,design,music,photography,antiques,performing', svg: '<path d="M12 3.5c-4.8 0-8.5 3.6-8.5 8.2 0 4.2 3.2 7.8 7.2 7.8 1.3 0 1.8-.8 1.8-1.6 0-1.3-1-1.6-1-2.7 0-1 .8-1.7 1.8-1.7h2.2c2.7 0 4.9-2 4.9-4.6C20.4 6.5 16.8 3.5 12 3.5z"/><circle cx="7.8" cy="11" r="1.2"/><circle cx="10" cy="7.3" r="1.2"/><circle cx="14.5" cy="7.3" r="1.2"/><circle cx="17" cy="10.8" r="1.1"/>' },
    { key: 'g.travel', bg: '#dbe8f0', fg: '#2b2a26', topic: 'travel', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M7 5.5c.5 2 2.2 2.5 3 3.8.8 1.4-.4 2.3.8 3.4 1 1 2.6.2 3.2 1.6.4 1-.6 2.4-.4 3.6"/><path d="M15.5 4.5c-.6 1.3.2 2.3 1.4 2.6 1.3.3 2.5 1 3 2.2"/><path d="M4 13c1.5.2 2.6 1 3 2.5.3 1.2 0 2.5.8 3.5"/>' },
    { key: 'g.food', bg: '#f7dede', fg: '#a65347', topic: 'cooking,food,drink,wine,recipe,baking', svg: '<path d="M7 13.5V20h10v-6.5"/><path d="M7 13.5a4 4 0 0 1-.7-7.9A4.5 4.5 0 0 1 12 3.5a4.5 4.5 0 0 1 5.7 2.1 4 4 0 0 1-.7 7.9z"/><path d="M7 17h10"/>' },
    { key: 'g.home', bg: '#e0ebdc', fg: '#2b2a26', topic: 'gardening,garden,house,home,interior', svg: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/><path d="M9 11h6"/>' },
    { key: 'g.all', bg: '#f6e6d4', fg: '#a65347', topic: '', svg: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>' }
  ];

  var genreList = document.getElementById('bk-genre-list');
  genreList.innerHTML = GENRES.map(function (g, i) {
    return '<button type="button" class="bk-genre" data-index="' + i + '">' +
      '<span class="chip" style="background:' + g.bg + ';color:' + g.fg + '"><svg ' + I + ' aria-hidden="true">' + g.svg + '</svg></span>' +
      '<span data-i18n="' + g.key + '">' + esc(t(g.key)) + '</span></button>';
  }).join('');

  var resultsEl = document.getElementById('bk-results');
  var resultsTitle = document.getElementById('bk-results-title');
  var resultsGrid = document.getElementById('bk-results-grid');
  var form = document.getElementById('shop-search-form');
  var input = document.getElementById('shop-search-input');
  var lastTitle = null;

  function setActiveGenre(index) {
    genreList.querySelectorAll('.bk-genre').forEach(function (el) {
      var on = String(index) === el.getAttribute('data-index');
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function renderTitle() {
    if (!lastTitle) return;
    resultsTitle.textContent = lastTitle.q != null
      ? t('bk.results.for', 'Results for “{q}”').replace('{q}', lastTitle.q)
      : t(lastTitle.key);
  }
  function showResults(url, title) {
    lastTitle = title;
    renderTitle();
    resultsEl.hidden = false;
    resultsGrid.innerHTML = '<p class="muted">' + esc(t('bk.loading', 'Loading books…')) + '</p>';
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    getJSON(url, function (err, books) {
      if (err) { resultsGrid.innerHTML = '<p class="muted">' + esc(t('bk.error')) + '</p>'; return; }
      if (!books.length) { resultsGrid.innerHTML = '<p class="muted">' + esc(t('bk.empty')) + ' <a href="/request-a-book">' + esc(t('bk.empty.ask')) + '</a></p>'; return; }
      resultsGrid.innerHTML = books.map(function (b) { return bookCard(b, true); }).join('');
      syncFavorites(resultsGrid);
    });
  }

  genreList.addEventListener('click', function (e) {
    var btn = e.target.closest('.bk-genre');
    if (!btn) return;
    var g = GENRES[Number(btn.getAttribute('data-index'))];
    input.value = '';
    setActiveGenre(btn.getAttribute('data-index'));
    showResults(API + '/search?q=' + (g.topic ? '&topic=' + encodeURIComponent(g.topic) : ''), { key: g.key });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) { input.focus(); return; }
    setActiveGenre(null);
    showResults(API + '/search?q=' + encodeURIComponent(q), { q: q });
  });

  document.getElementById('bk-new-all').addEventListener('click', function () {
    input.value = '';
    setActiveGenre(null);
    showResults(API + '/latest-arrivals?days=0&limit=24', { key: 'bk.results.new' });
  });

  var rec = null;
  var recSection = document.querySelector('.bk-rec');
  var recLink = document.getElementById('bk-rec-link');
  var recCoverSlot = document.getElementById('bk-rec-cover-slot');
  function setRecCover(src) {
    recCoverSlot.innerHTML = src
      ? '<img class="rec-cover" src="' + esc(src) + '" alt="' + esc(rec.title) + '" width="172" height="258" decoding="async" data-cover>'
      : '<div class="rec-cover cover-none">' + esc(rec.title) + '</div>';
    var img = recCoverSlot.querySelector('img');
    if (img) img.addEventListener('error', function () { setRecCover(null); }, { once: true });
  }
  function renderRecText() {
    if (!rec) return;
    document.getElementById('bk-rec-title').textContent = rec.title;
    document.getElementById('bk-rec-author').textContent = rec.author || '';
    document.getElementById('bk-rec-blurb').textContent = (rec.blurb && (rec.blurb[lang()] || rec.blurb.en)) || '';
  }
  getJSON(API + '/recommendation', function (err, data) {
    if (err || !data) { recSection.hidden = true; return; }
    rec = data;
    renderRecText();
    setRecCover(rec.coverUrl);
    recLink.setAttribute('href', rec.url);
  });

  var track = document.getElementById('bk-new-track');
  getJSON(API + '/latest-arrivals?days=0&limit=12', function (err, books) {
    if (err) { track.innerHTML = '<p class="muted">' + esc(t('bk.error')) + '</p>'; return; }
    if (!books.length) { track.innerHTML = '<p class="muted">' + esc(t('bk.new.empty')) + '</p>'; return; }
    track.innerHTML = books.map(function (b) { return bookCard(b, true); }).join('');
    syncFavorites(track);
  });
  function page(dir) { track.scrollBy({ left: dir * track.clientWidth * 0.8, behavior: 'smooth' }); }
  document.getElementById('bk-new-prev').addEventListener('click', function () { page(-1); });
  document.getElementById('bk-new-next').addEventListener('click', function () { page(1); });

  document.querySelectorAll('.langtoggle button').forEach(function (b) {
    b.addEventListener('click', function () { setTimeout(function () { renderTitle(); if (rec) renderRecText(); }, 0); });
  });
})();
