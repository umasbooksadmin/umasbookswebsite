// Favorites are saved in the browser (localStorage), signed in or not:
// a signed-out visitor needs no account for them. Signed in, each toggle
// is also saved to the account, and once per login the browser's list is
// merged into the account (and the account's into the browser's, see
// mergeIntoAccount below). Any ".favorite-toggle[data-book-id]" button on any
// page gets wired up automatically; the Favorites page itself (see
// favorites.ejs) also uses UmasFavorites.get()/sync() to fetch and
// render the saved list.
(function () {
  var KEY = "umasbooks.favorites";

  function getFavorites() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(raw) ? raw.filter(function (n) { return Number.isInteger(n); }) : [];
    } catch {
      return [];
    }
  }

  function setFavorites(ids) {
    try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* storage unavailable (private mode): favorites just are not remembered */ }
  }

  function isFavorite(id) { return getFavorites().indexOf(id) !== -1; }

  // Best-effort sync to the server for logged-in users (see
  // POST /api/favorites/toggle), so favorites follow the account. Guests'
  // favorites stay local-only; the server silently no-ops for them. Never blocks the UI or
  // surfaces an error — a failed sync just means this toggle didn't
  // register server-side, which isn't worth interrupting anyone over.
  var cachedCsrfToken = null;
  function getCsrfToken() {
    if (cachedCsrfToken) return Promise.resolve(cachedCsrfToken);
    return fetch("/api/csrf-token", { credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { cachedCsrfToken = (data && data.token) || null; return cachedCsrfToken; })
      .catch(function () { return null; });
  }

  function syncToServer(id, isFav) {
    if (!window.fetch) return;
    getCsrfToken().then(function (token) {
      if (!token) return;
      var body = "bookId=" + encodeURIComponent(id) + "&isFavorite=" + (isFav ? "1" : "") + "&_csrf=" + encodeURIComponent(token);
      fetch("/api/favorites/toggle", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body,
      }).catch(function () {});
    });
  }

  function toggleFavorite(id) {
    var favs = getFavorites();
    var i = favs.indexOf(id);
    if (i === -1) favs.push(id); else favs.splice(i, 1);
    setFavorites(favs);
    return i === -1; // true if it's now favorited
  }

  function sync(btn) {
    var id = Number(btn.getAttribute("data-book-id"));
    var fav = isFavorite(id);
    btn.classList.toggle("is-favorite", fav);
    btn.setAttribute("aria-pressed", fav ? "true" : "false");
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".favorite-toggle").forEach(sync);
  });

  // After a sign-in (/api/session says favoritesMerge, once per login session): the favourites saved in this browser
  // while signed out go to the account (POST /api/favorites/merge), and the account's come back into the browser. The
  // hearts and the Favorites page follow (event "favoritesmerged"). Best effort: a failure changes nothing.
  function mergeIntoAccount() {
    if (!window.fetch || !window.UmasSession) return;
    window.UmasSession().then(function (data) {
      if (!data || !data.loggedIn || !data.favoritesMerge) return;
      return getCsrfToken().then(function (token) {
        if (!token) return;
        var body = "ids=" + encodeURIComponent(getFavorites().join(",")) + "&_csrf=" + encodeURIComponent(token);
        return fetch("/api/favorites/merge", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: body,
        }).then(function (res) { return res.ok && res.status !== 204 ? res.json() : null; }).then(function (out) {
          if (!out || !Array.isArray(out.ids)) return;
          var favs = getFavorites();
          var before = favs.length;
          out.ids.forEach(function (id) { if (Number.isInteger(id) && favs.indexOf(id) === -1) favs.push(id); });
          if (favs.length !== before) setFavorites(favs);
          document.querySelectorAll(".favorite-toggle").forEach(sync);
          document.dispatchEvent(new CustomEvent("favoritesmerged", { detail: { ids: favs } }));
        });
      });
    }).catch(function () {});
  }
  mergeIntoAccount();

  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".favorite-toggle");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var id = Number(btn.getAttribute("data-book-id"));
    var nowFav = toggleFavorite(id);
    btn.classList.toggle("is-favorite", nowFav);
    btn.setAttribute("aria-pressed", nowFav ? "true" : "false");
    btn.dispatchEvent(new CustomEvent("favoritechange", { bubbles: true, detail: { id: id, isFavorite: nowFav } }));
    syncToServer(id, nowFav);
  });

  window.UmasFavorites = { get: getFavorites, has: isFavorite, toggle: toggleFavorite, sync: sync, merge: mergeIntoAccount };
})();
