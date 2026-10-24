// "Translate to French" on the admin blog editor (views/admin/blog.ejs). Sends the English title, excerpt and content
// (and the French text already typed) to /admin/blog/translate and puts the answer into the French fields. Nothing is
// saved: the admin reads the French, changes it, and presses Save. A French field that already has text is only
// replaced after the admin confirms.
(function () {
  var btn = document.getElementById('blog-translate-btn');
  var form = document.getElementById('blog-form');
  if (!btn || !form) return;
  var statusEl = document.getElementById('blog-translate-status');

  function say(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('blog-fr-error', !!isError);
  }
  function editors() {
    var list = form.querySelectorAll('.richtext-editor');
    return { en: list[0], fr: document.getElementById('blog-content-fr') };
  }
  function val(name) {
    var el = form.querySelector('[name=' + name + ']');
    return el ? el.value : '';
  }
  function hasText(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return !!d.textContent.replace(/\u00a0/g, ' ').trim();
  }

  btn.addEventListener('click', function () {
    var ed = editors();
    var bodyEn = ed.en ? ed.en.innerHTML.trim() : '';
    var bodyFr = ed.fr ? ed.fr.innerHTML.trim() : '';
    if (!val('title').trim() && !hasText(bodyEn)) { say('Write the English title and content first, then translate.', true); return; }
    var hasFrench = val('title_fr').trim() || val('excerpt_fr').trim() || hasText(bodyFr);
    var overwrite = false;
    if (hasFrench) {
      overwrite = window.confirm('Some of the French text is already filled in. Replace all of it with a new translation of the English? (Cancel keeps what you wrote and only fills the empty French fields.)');
    }
    var params = new URLSearchParams();
    params.set('_csrf', val('_csrf'));
    params.set('title', val('title'));
    params.set('excerpt', val('excerpt'));
    params.set('body', bodyEn);
    params.set('title_fr', val('title_fr'));
    params.set('excerpt_fr', val('excerpt_fr'));
    params.set('body_fr', bodyFr);
    if (overwrite) params.set('overwrite', '1');

    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Translating…';
    say('Translating, this can take up to a minute…', false);
    fetch(btn.getAttribute('data-translate-url'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok) { say(r.data.error || 'Could not translate. Nothing was changed.', true); return; }
        var d = r.data;
        if (d.filled.indexOf('title_fr') !== -1) form.querySelector('[name=title_fr]').value = d.titleFr;
        if (d.filled.indexOf('excerpt_fr') !== -1) form.querySelector('[name=excerpt_fr]').value = d.excerptFr;
        if (d.filled.indexOf('body_fr') !== -1 && ed.fr) {
          ed.fr.innerHTML = d.bodyFr;
          form.querySelector('[name=body_fr]').value = d.bodyFr;
        }
        say(d.notice, false);
      })
      .catch(function () { say('Could not reach the server. Check your connection and try again. Nothing was changed.', true); })
      .finally(function () { btn.disabled = false; btn.textContent = label; });
  });
})();
