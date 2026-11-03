// The cart icon on book cards (src/lib/cardCart.js decides what it does; views/partials/card_cart.ejs and public/ui.js
// cartControlHtml draw it). A plain script, loaded after assets/site.js and public/ui.js; it sets window.UmasCart.
//
//   - Pressing the icon posts the add itself (POST /cart/add with the CSRF token from /api/csrf-token, Accept: application/json),
//     whatever the form in the page says (a page drawn for everyone has a plain GET form to the book's page, a signed-in
//     person's a POST form): no page reload. Added: every icon of that book on the page turns into "in your cart" (focus moves
//     onto it), the header's cart count follows, and a status line tells screen readers. Signed in or not, the same: a
//     signed-out visitor's book goes into the session's cart (which login carries across) and they stay on the page.
//   - "In your cart" comes from /api/session (cartBookIds, the same request assets/site.js makes for the cart count): every icon
//     on the page, and the cards a page script draws later (UmasCart.sync(root)).
//   - Without JavaScript the forms work as they are (see card_cart.ejs).
(function () {
  var UI = window.UmasUI;
  if (!UI || !window.fetch || !document.querySelectorAll) return;

  var inCart = {};   // book id -> true; an educational item is 'e<id>' -> true (cards with data-edu-id, POST /cart/add-edu)

  // A visually-hidden polite status line (assets: .bk-cart-status in public/site-header.css). Cleared first so the same
  // sentence twice in a row is announced again.
  var statusEl = document.createElement('p');
  statusEl.className = 'bk-cart-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  function addStatusLine() { if (!statusEl.parentNode && document.body) document.body.appendChild(statusEl); }
  if (document.body) addStatusLine(); else document.addEventListener('DOMContentLoaded', addStatusLine);
  function say(text) {
    addStatusLine();
    statusEl.textContent = '';
    setTimeout(function () { statusEl.textContent = text; }, 60);
  }

  // The key of an icon: the book id, or 'e' + the educational item id.
  function keyOf(box) { return box.hasAttribute('data-edu-id') ? 'e' + box.getAttribute('data-edu-id') : box.getAttribute('data-book-id'); }
  function boxesOf(root, key) {
    var r = root || document;
    if (key == null) return Array.prototype.slice.call(r.querySelectorAll('.bk-cart[data-book-id], .bk-cart[data-edu-id]'));
    var sel = String(key).charAt(0) === 'e' ? '.bk-cart[data-edu-id="' + String(Number(String(key).slice(1))) + '"]' : '.bk-cart[data-book-id="' + String(Number(key)) + '"]';
    return Array.prototype.slice.call(r.querySelectorAll(sel));
  }
  // Show "in your cart" in one icon. Focus that was on the add button moves onto the cart link in its place.
  function showInCart(box) {
    var link = box.querySelector('.bk-cart-in');
    if (!link || !link.hidden) return;
    var hadFocus = box.contains(document.activeElement);
    Array.prototype.forEach.call(box.children, function (el) { if (el !== link) el.hidden = true; });
    link.hidden = false;
    if (hadFocus) { try { link.focus(); } catch { /* the state is shown anyway */ } }
  }
  function sync(root) {
    boxesOf(root).forEach(function (box) { if (inCart[keyOf(box)]) showInCart(box); });
  }

  // The card around an icon, for its title (status lines) and its link (where focus goes if the icon has to go).
  function cardOf(box) { return box.closest('.bk-book, .book-card-wrap, li') || box.parentNode; }
  function titleOf(box) {
    var card = cardOf(box), sels = ['.t', '.book-card-title', 'a'];
    for (var i = 0; card && i < sels.length; i++) {
      var t = card.querySelector(sels[i]);
      if (t) return t.textContent.replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  var tokenPromise = null;
  function csrfToken(fresh) {
    if (fresh || !tokenPromise) {
      tokenPromise = fetch('/api/csrf-token', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) { return (data && data.token) || null; })
        .catch(function () { return null; });
    }
    return tokenPromise;
  }
  // id = a book copy's id, or { edu: itemId } for an educational item (one unit; the quantity is changed in the cart).
  function post(id, retried) {
    return csrfToken(retried).then(function (token) {
      if (!token) throw new Error('no token');
      var body = (typeof id === 'object'
        ? 'eduItemId=' + encodeURIComponent(id.edu) + '&qty=1'
        : 'copyId=' + encodeURIComponent(id)) +
        '&backTo=' + encodeURIComponent(UI.here()) + '&via=card&_csrf=' + encodeURIComponent(token);
      return fetch(typeof id === 'object' ? '/cart/add-edu' : '/cart/add', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body,
      });
    }).then(function (res) {
      // A stale token (the session changed since it was read): read a fresh one once.
      if (res.status === 403 && !retried) return post(id, true);
      return res;
    });
  }

  function add(form) {
    var box = form.closest('.bk-cart');
    var btn = form.querySelector('button');
    if (!box || !btn || btn.getAttribute('aria-busy') === 'true') return;
    var key = keyOf(box), isEdu = box.hasAttribute('data-edu-id');
    var title = titleOf(box);
    btn.setAttribute('aria-busy', 'true');
    function done() { btn.removeAttribute('aria-busy'); }
    post(isEdu ? { edu: box.getAttribute('data-edu-id') } : form.getAttribute('data-copy-id'), false).then(function (res) {
      if (res.status === 429) { done(); say(UI.cartText('busy')); return null; }
      if (!res.ok) throw new Error('status ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data) return;
      done();
      if (data.ok) {
        inCart[key] = true;
        boxesOf(document, key).forEach(showInCart);
        if (typeof data.cartCount === 'number') {
          if (window.UmasShowCartCount) window.UmasShowCartCount(data.cartCount);
          else document.querySelectorAll('[data-cart-count]').forEach(function (el) { el.textContent = String(data.cartCount); });
        }
        say(UI.cartText('added', title));
      } else if (data.error === 'full') {
        say(UI.cartText(isEdu ? 'fullEdu' : 'full'));
      } else {
        // Sold or reserved since the page was drawn: the icon goes (never a dead one); focus goes to the book's link.
        boxesOf(document, key).forEach(function (b) {
          var soldOut = isEdu && b.querySelector('.bk-cart-soldout');
          if (soldOut) {
            // An educational item that ran out: its icon becomes the disabled "sold out" one (focus stays on the card).
            var had = b.contains(document.activeElement);
            Array.prototype.forEach.call(b.children, function (el) { el.hidden = el !== soldOut; });
            if (had) { var t = cardOf(b); t = t && t.querySelector('.t'); if (t) { t.setAttribute('tabindex', '-1'); try { t.focus(); } catch { /* shown anyway */ } } }
            return;
          }
          var hadFocus = b.contains(document.activeElement);
          b.hidden = true;
          var link = hadFocus && cardOf(b) && cardOf(b).querySelector('a[href]:not(.bk-cart-btn)');
          if (link) { try { link.focus(); } catch { /* the icon is gone anyway */ } }
        });
        say(UI.cartText(isEdu ? 'soldOut' : 'gone', title));
      }
    }).catch(function () { done(); say(UI.cartText('error', title)); });
  }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.classList || !form.classList.contains('bk-cart-add')) return;
    e.preventDefault();
    add(form);
  });

  if (window.UmasSession) {
    window.UmasSession().then(function (data) {
      ((data && data.cartBookIds) || []).forEach(function (id) { inCart[String(id)] = true; });
      ((data && data.cartEduIds) || []).forEach(function (id) { inCart['e' + String(id)] = true; });
      sync(document);
    });
  }

  window.UmasCart = { sync: sync };
})();
