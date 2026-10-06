// Events page (views/marketing/events.ejs): schedule from /api/events/upcoming. Was an inline <script>.
(function () {
  var list = document.getElementById('events-schedule');
  if (!list) return;
  var events = null;
  var state = 'loading';

  function lang() {
    try { return localStorage.getItem('umasbooks.lang') === 'fr' ? 'fr' : 'en'; } catch (e) { return 'en'; }
  }
  function t(key, fallback) {
    var dict = (window.PAGE_I18N && window.PAGE_I18N[lang()]) || {};
    return dict[key] || fallback;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(iso, opts) {
    opts.timeZone = 'Europe/Paris';
    return new Date(iso).toLocaleString(lang() === 'fr' ? 'fr-FR' : 'en-GB', opts);
  }

  function render() {
    if (state === 'error') { list.innerHTML = '<p class="ev-empty">' + esc(t('events.error', "Couldn't load the schedule right now.")) + '</p>'; return; }
    if (state === 'loading') return;
    if (!events.length) { list.innerHTML = '<p class="ev-empty">' + esc(t('events.empty', 'Nothing on the calendar right now.')) + '</p>'; return; }
    list.innerHTML = events.map(function (e) {
      var when = fmt(e.startsAt, { weekday: 'long', hour: '2-digit', minute: '2-digit' });
      if (e.endsAt) when += '–' + fmt(e.endsAt, { hour: '2-digit', minute: '2-digit' });
      var meta = [when];
      if (e.location) meta.push(e.location);
      if (e.capacity != null) meta.push(e.signupCount + '/' + e.capacity + ' ' + t('events.spots', 'spots taken'));
      else if (Number(e.signupCount) > 0) meta.push(e.signupCount + ' ' + t('events.signedup', 'signed up'));
      return '<article class="ev-item">' +
        '<div class="ev-date" aria-hidden="true"><span class="d">' + esc(fmt(e.startsAt, { day: 'numeric' })) + '</span>' +
          '<span class="m">' + esc(fmt(e.startsAt, { month: 'short' }).replace('.', '')) + '</span></div>' +
        '<div>' +
          '<h3 class="ev-title">' + esc(e.title) + '</h3>' +
          '<div class="ev-meta"><span class="sr-date">' + esc(fmt(e.startsAt, { day: 'numeric', month: 'long' })) + ' · </span>' + esc(meta.join(' · ')) + '</div>' +
          (e.description ? '<p class="ev-desc">' + esc(e.description) + '</p>' : '') +
        '</div>' +
        '<a class="h-btn" href="' + esc(e.url) + '">' + esc(t('events.signup', 'Sign up')) + ' <span class="arrow" aria-hidden="true">&rarr;</span></a>' +
      '</article>';
    }).join('');
  }

  function loadEvents(isRetry) {
    fetch('/api/events/upcoming')
      .then(function (res) { if (!res.ok) throw new Error('bad response'); return res.json(); })
      .then(function (data) { events = data; state = 'ok'; render(); })
      .catch(function () {
        if (!isRetry) { setTimeout(function () { loadEvents(true); }, 4000); return; }
        state = 'error'; render();
      });
  }
  loadEvents(false);

  document.querySelectorAll('.langtoggle button').forEach(function (b) {
    b.addEventListener('click', function () { setTimeout(render, 0); });
  });
})();
