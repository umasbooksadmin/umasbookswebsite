// Admin > Educational items, the add / edit form (views/admin/edu_item_form.ejs): the "Scan or type barcode" box.
// A scanner types the digits and Enter: Enter here looks the barcode up (GET /admin/edu-items/lookup, routes/admin/
// eduItems.js) instead of sending the form. The answer only SUGGESTS: the Name is filled in only when it is empty (or
// still holds an earlier suggestion), never over what the admin typed; price, stock and genre are never touched; the
// picture is used only after "Use this picture". Nothing is saved until the admin presses Save / Add item.
// Without this script the box is a plain field that is saved (and checked) with the form.
(function () {
  'use strict';
  var box = document.querySelector('[data-edu-barcode]');
  if (!box) return;
  var form = box.closest('form');
  var input = document.getElementById('edu-barcode');
  var button = box.querySelector('[data-edu-lookup]');
  var result = box.querySelector('[data-edu-lookup-result]');
  var useCover = box.querySelector('[data-edu-use-cover]');
  var nameInput = form.elements.name;
  var UNAVAILABLE = 'Lookup unavailable right now: type the details in.';
  var filledName = null; // the name this script put in the box (replaced by a later lookup unless the admin edited it)
  var running = null;

  if (button) button.hidden = false;
  if (nameInput) nameInput.addEventListener('input', function () { filledName = null; });

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function show(nodes) {
    result.textContent = '';
    nodes.forEach(function (n) { if (n) result.appendChild(n); });
    result.hidden = !nodes.length;
  }

  function render(body) {
    var nodes = [];
    if (body.convertedFrom) {
      input.value = body.barcode;
      nodes.push(el('p', 'small', 'The 10-digit ISBN ' + body.convertedFrom + ' will be saved as its 13-digit form ' + body.barcode + '.'));
    }
    var head = el('p', body.state === 'found' ? 'edu-lookup-found' : 'edu-lookup-none', body.message || UNAVAILABLE);
    nodes.push(head);
    if (body.state === 'found' && body.name) {
      var nameEmpty = nameInput && (!nameInput.value.trim() || (filledName !== null && nameInput.value === filledName));
      if (nameEmpty) {
        nameInput.value = body.name;
        filledName = body.name;
        nodes.push(el('p', 'small', 'The Name was filled in with "' + body.name + '": change it if you like.'));
      } else if (nameInput && nameInput.value.trim() !== body.name) {
        var p = el('p', 'small', 'Suggested name: "' + body.name + '". Your Name was kept. ');
        var use = el('button', 'btn btn-outline btn-small', 'Use this name');
        use.type = 'button';
        use.addEventListener('click', function () { nameInput.value = body.name; filledName = body.name; use.disabled = true; use.textContent = 'Name replaced'; });
        p.appendChild(use);
        nodes.push(p);
      }
      if (body.details) nodes.push(el('p', 'muted small', body.details));
    }
    if (body.usedBy) {
      var u = el('p', 'edu-lookup-warn', 'This barcode is already on the item "' + body.usedBy.name + '": saving will be refused. ');
      var a = el('a', null, 'Open that item');
      a.href = body.usedBy.href;
      u.appendChild(a);
      nodes.push(u);
    }
    if (body.bookInShop) nodes.push(el('p', 'edu-lookup-warn', body.bookInShop));
    if (body.picture) nodes.push(pictureOffer(body.picture));
    else if (useCover) useCover.value = '';
    show(nodes);
  }

  // Open Library's picture for this exact ISBN: shown, and used only after "Use this picture".
  function pictureOffer(src) {
    var wrap = el('div', 'edu-lookup-picture');
    var img = el('img');
    img.src = src; img.alt = 'Open Library picture for this ISBN'; img.width = 96; img.height = 128;
    var side = el('div');
    side.appendChild(el('p', 'small', 'Open Library has a picture for this exact ISBN. It is saved only if you press "Use this picture". A photo you choose below always wins.'));
    var btn = el('button', 'btn btn-outline btn-small', 'Use this picture');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    if (useCover) useCover.value = '';
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? 'This picture will be saved (press to undo)' : 'Use this picture';
      if (useCover) useCover.value = on ? '1' : '';
    });
    side.appendChild(btn);
    wrap.appendChild(img);
    wrap.appendChild(side);
    return wrap;
  }

  function lookup() {
    var code = input.value.trim();
    if (!code) { show([el('p', 'edu-lookup-none', 'Scan or type a barcode first.')]); return; }
    if (running) running.abort();
    var ctrl = new AbortController();
    running = ctrl;
    var timer = setTimeout(function () { ctrl.abort(); }, 16000);
    show([el('p', 'muted small', 'Looking up ' + code + '…')]);
    var q = 'barcode=' + encodeURIComponent(code) + (box.getAttribute('data-item-id') ? '&itemId=' + encodeURIComponent(box.getAttribute('data-item-id')) : '');
    fetch('/admin/edu-items/lookup?' + q, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: ctrl.signal })
      .then(function (r) { return r.json().catch(function () { return { ok: false, state: 'unavailable', message: 'The site answered with an error (' + r.status + '). Try again, or type the details in.' }; }); })
      .then(function (body) {
        if (running !== ctrl) return;
        if (!body || !body.ok) { show([el('p', body && body.state === 'invalid' ? 'edu-lookup-warn' : 'edu-lookup-none', (body && body.message) || UNAVAILABLE)]); return; }
        render(body);
      })
      .catch(function (err) { if (running === ctrl) show([el('p', 'edu-lookup-none', err && err.name === 'AbortError' ? 'The lookup took too long. Try again, or type the details in.' : 'Could not reach the site. Check the connection, then try again, or type the details in.')]); })
      .then(function () { clearTimeout(timer); if (running === ctrl) running = null; });
  }

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); lookup(); }
  });
  if (button) button.addEventListener('click', lookup);
  // A different barcode typed by hand: an earlier "Use this picture" no longer applies.
  input.addEventListener('input', function () { if (useCover && useCover.value) { useCover.value = ''; show([]); } });
  if (box.hasAttribute('data-auto-lookup') && input.value.trim()) lookup();
})();
