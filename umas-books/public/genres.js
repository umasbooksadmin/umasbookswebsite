// Admin > Genres (views/admin/genres.ejs): the "Slot into..." select saves at once, "Show matches" lists what a new
// rule would take, colour / icon previews follow their selects, "Tick all" for the AI proposals. Every control also works
// as a plain form post without this script.
(function () {
  'use strict';

  var ICONS = {};
  document.querySelectorAll('#gn-icons svg').forEach(function (s) { ICONS[s.getAttribute('data-icon')] = s.innerHTML; });

  function formBody(form) {
    var p = new URLSearchParams();
    new FormData(form).forEach(function (v, k) { p.append(k, String(v)); });
    return p;
  }

  // ---- Slot into... ----
  document.querySelectorAll('[data-gn-slot]').forEach(function (form) {
    var select = form.querySelector('select');
    var row = form.closest('tr');
    var msg = document.createElement('span');
    msg.className = 'gn-slot-msg';
    msg.setAttribute('role', 'status');
    form.appendChild(msg);
    select.addEventListener('change', function () {
      if (!select.value) return;
      form.setAttribute('data-state', 'busy');
      msg.textContent = '';
      fetch(form.action, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: formBody(form)
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          form.removeAttribute('data-state');
          if (!res.ok || !res.body.ok) { msg.textContent = (res.body && res.body.error) || 'Not saved: try again.'; return; }
          var label = row.querySelector('[data-gn-label]');
          var via = row.querySelector('[data-gn-via]');
          label.textContent = res.body.label || 'Unmapped';
          if (via) via.textContent = res.body.label ? '(exact rule)' : '';
          row.classList.remove('gn-unmapped');
          row.classList.add('gn-saved');
          if (!res.body.label) row.classList.add('gn-unmapped');
          msg.textContent = res.body.label ? 'Saved.' : 'Cleared.';
          if (!res.body.label) select.value = '';
        })
        .catch(function () { form.removeAttribute('data-state'); msg.textContent = 'Not saved: no connection.'; });
    });
  });

  // ---- Add a rule: Show matches ----
  var ruleForm = document.querySelector('[data-gn-ruleform]');
  if (ruleForm) {
    var showBtn = ruleForm.querySelector('[data-gn-show]');
    var out = ruleForm.querySelector('[data-gn-matches]');
    var word = ruleForm.querySelector('[data-gn-word]');
    showBtn.hidden = false;
    var show = function () {
      var pattern = word.value.trim();
      if (!pattern) { out.textContent = 'Type the word first.'; return; }
      out.textContent = 'Looking...';
      fetch('/admin/genres/rules/preview?kind=contains-word&pattern=' + encodeURIComponent(pattern), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          out.textContent = '';
          var p = document.createElement('p');
          p.textContent = j.genres ? 'This rule would slot ' + j.genres + ' genre' + (j.genres === 1 ? '' : 's') + ' (' + j.books + ' book' + (j.books === 1 ? '' : 's') + '):' : 'No genre that has no slot yet contains that word.';
          out.appendChild(p);
          if (j.takes.length) {
            var ul = document.createElement('ul');
            j.takes.forEach(function (t) { var li = document.createElement('li'); li.textContent = t.name + ' (' + t.books + ')'; ul.appendChild(li); });
            out.appendChild(ul);
            if (j.more) { var m = document.createElement('p'); m.textContent = 'and ' + j.more + ' more.'; out.appendChild(m); }
          }
          if (j.handled.length) {
            var h = document.createElement('p');
            h.className = 'muted small';
            h.textContent = 'Also contain the word but are already handled by another rule (they keep it): ' + j.handled.map(function (t) { return t.name + ' (' + t.books + ') by ' + t.by; }).join('; ') + '.';
            out.appendChild(h);
          }
        })
        .catch(function () { out.textContent = 'Could not look it up: try again.'; });
    };
    showBtn.addEventListener('click', show);
  }

  // ---- previews ----
  document.querySelectorAll('[data-gn-colour]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var o = sel.options[sel.selectedIndex];
      var sw = sel.parentNode.querySelector('[data-gn-swatch]');
      if (sw) { sw.style.background = o.getAttribute('data-bg'); sw.style.color = o.getAttribute('data-fg'); }
    });
  });
  document.querySelectorAll('[data-gn-icon]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var prev = sel.parentNode.querySelector('[data-gn-iconprev] svg');
      if (prev && ICONS[sel.value]) prev.innerHTML = ICONS[sel.value];
    });
  });

  // ---- AI proposals ----
  var tick = document.querySelector('[data-gn-tickall]');
  if (tick) tick.addEventListener('click', function () {
    document.querySelectorAll('.gn-proposals input[type="checkbox"]').forEach(function (c) { c.checked = true; });
  });
})();
