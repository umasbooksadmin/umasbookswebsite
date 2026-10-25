// "Translate to French" in the admin editors of events, sessions, announcements and charities (the fieldset made by
// views/partials/admin_french_fields.ejs). Sends the English text of the form (and the French already typed) to
// /admin/translate-french/<kind> and puts the answer into the French fields. Nothing is saved: the admin reads the
// French, changes it, and presses Save. A French field that already has text is only replaced after the admin confirms.
(function () {
  function hasText(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return !!d.textContent.replace(/\u00a0/g, ' ').trim();
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.fr-translate-btn');
    if (!btn) return;
    var form = btn.closest('form');
    var box = btn.closest('.fr-version');
    if (!form || !box) return;
    var statusEl = box.querySelector('.fr-translate-status');
    function say(text, isError) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.classList.toggle('fr-error', !!isError);
    }
    var fields = (btn.getAttribute('data-fr-fields') || '').split(',').filter(Boolean);
    var htmlFields = (btn.getAttribute('data-fr-html') || '').split(',').filter(Boolean);
    function frEditor(f) { return box.querySelector('.richtext-editor[data-fr-field="' + f + '"]'); }
    function enEditor() { return form.querySelector('.richtext-editor:not([data-fr-field])'); }
    function enValue(f) {
      if (htmlFields.indexOf(f) !== -1) { var ed = enEditor(); return ed ? ed.innerHTML.trim() : ''; }
      return form.elements[f] ? form.elements[f].value : '';
    }
    function frValue(f) {
      if (htmlFields.indexOf(f) !== -1) { var ed = frEditor(f); return ed ? ed.innerHTML.trim() : ''; }
      return form.elements[f + '_fr'] ? form.elements[f + '_fr'].value : '';
    }
    function isFilled(f, v) { return htmlFields.indexOf(f) !== -1 ? hasText(v) : !!String(v).trim(); }

    if (!fields.some(function (f) { return isFilled(f, enValue(f)); })) { say('Write the English text first, then translate.', true); return; }
    var overwrite = false;
    if (fields.some(function (f) { return isFilled(f, frValue(f)); })) {
      overwrite = window.confirm('Some of the French text is already filled in. Replace all of it with a new translation of the English? (Cancel keeps what you wrote and only fills the empty French fields.)');
    }
    var params = new URLSearchParams();
    params.set('_csrf', form.elements._csrf ? form.elements._csrf.value : '');
    fields.forEach(function (f) {
      params.set(f, enValue(f));
      params.set(f + '_fr', frValue(f));
    });
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
        fields.forEach(function (f) {
          if (d.filled.indexOf(f + '_fr') === -1) return;
          if (htmlFields.indexOf(f) !== -1) {
            var ed = frEditor(f);
            if (ed) ed.innerHTML = d.values[f + '_fr'];
            if (form.elements[f + '_fr']) form.elements[f + '_fr'].value = d.values[f + '_fr'];
          } else if (form.elements[f + '_fr']) {
            form.elements[f + '_fr'].value = d.values[f + '_fr'];
          }
        });
        say(d.notice, false);
      })
      .catch(function () { say('Could not reach the server. Check your connection and try again. Nothing was changed.', true); })
      .finally(function () { btn.disabled = false; btn.textContent = label; });
  });
})();
