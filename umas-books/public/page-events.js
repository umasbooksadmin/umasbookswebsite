// Events page (views/marketing/events.ejs): schedule from /api/events/upcoming. Was an inline <script>.
(function () {
  var list = document.getElementById('events-schedule');
  if (!list) return;
  var events = null;
  var state = 'loading';

  function lang() {
    try { return localStorage.getItem('umasbooks.lang') === 'fr' ? 'fr' : 'en'; } catch { return 'en'; }
  }
  // The language of the page itself (the server sets <html lang>; /fr/ pages are always French): the schedule is
  // asked for in that language (?lang=fr gives an event's French text where it has a ready French version).
  function pageLang() { return document.documentElement.lang === 'fr' ? 'fr' : 'en'; }
  function t(key, fallback) {
    var dict = (window.PAGE_I18N && window.PAGE_I18N[lang()]) || {};
    return dict[key] || fallback;
  }
  var esc = window.UmasUI.esc; // public/ui.js
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
      // A French page whose event has no ready French text shows the English text, marked as English.
      var fallback = pageLang() === 'fr' && e.lang === 'en';
      var enAttr = fallback ? ' lang="en"' : '';
      var meta = [esc(when)];
      if (e.location) meta.push(fallback ? '<span lang="en">' + esc(e.location) + '</span>' : esc(e.location));
      if (e.capacity != null) meta.push(esc(e.signupCount + '/' + e.capacity + ' ' + t('events.spots', 'spots taken')));
      else if (Number(e.signupCount) > 0) meta.push(esc(e.signupCount + ' ' + t('events.signedup', 'signed up')));
      return '<article class="ev-item">' +
        '<div class="ev-date" aria-hidden="true"><span class="d">' + esc(fmt(e.startsAt, { day: 'numeric' })) + '</span>' +
          '<span class="m">' + esc(fmt(e.startsAt, { month: 'short' }).replace('.', '')) + '</span></div>' +
        '<div>' +
          '<h3 class="ev-title"' + enAttr + '>' + esc(e.title) +
            (fallback ? ' <span class="ev-lang"><span aria-hidden="true">EN</span><span class="sr-date" lang="fr"> Événement présenté en anglais</span></span>' : '') + '</h3>' +
          '<div class="ev-meta"><span class="sr-date">' + esc(fmt(e.startsAt, { day: 'numeric', month: 'long' })) + ' · </span>' + meta.join(' · ') + '</div>' +
          (e.description ? '<p class="ev-desc"' + enAttr + '>' + esc(e.description) + '</p>' : '') +
        '</div>' +
        '<a class="h-btn" href="' + esc(window.UmasFrHref ? window.UmasFrHref(e.url) : e.url) + '">' + esc(t('events.signup', 'Sign up')) + ' <span class="arrow" aria-hidden="true">&rarr;</span></a>' +
      '</article>';
    }).join('');
  }

  function loadEvents(isRetry) {
    fetch('/api/events/upcoming?lang=' + pageLang())
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
