// Favorites are per-browser only (localStorage), not tied to an
// account — matches the rest of the public site (search, wishlist) not
// needing to log in. Any ".favorite-toggle[data-book-id]" button on any
// page gets wired up automatically; the Favorites page itself (see
// favorites.ejs) also uses UmasFavorites.get()/sync() to fetch and
// render the saved list.
(function () {
  var KEY = "umasbooks.favorites";

  function getFavorites() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(raw) ? raw.filter(function (n) { return Number.isInteger(n); }) : [];
    } catch (e) {
      return [];
    }
  }

  function setFavorites(ids) {
    try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch (e) {}
  }

  function isFavorite(id) { return getFavorites().indexOf(id) !== -1; }

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
  });

  window.UmasFavorites = { get: getFavorites, has: isFavorite, toggle: toggleFavorite, sync: sync };
})();
