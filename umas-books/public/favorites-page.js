// Renders the Favorites page's book list (views/favorites.ejs) — the
// favorited ids live in localStorage (see favorites.js), so the list
// itself has to be fetched and rendered client-side; there's nothing to
// query server-side without an account.
(function () {
  var list = document.getElementById("favorites-list");
  if (!list) return;

  // The server renders <html lang="en|fr"> from the person's language.
  var fr = (document.documentElement.lang || "").toLowerCase().indexOf("fr") === 0;
  function t(en, frText) { return fr ? frText : en; }
  function render(books) {
    if (!books.length) {
      list.innerHTML = fr
        ? '<p class="muted">Aucun favori pour l’instant\u00a0: parcourez les <a href="/books">livres</a> et touchez le cœur de ceux qui vous plaisent.</p>'
        : '<p class="muted">No favorites yet — browse <a href="/books">Books</a> and tap the heart on anything you like.</p>';
      return;
    }
    list.innerHTML = books.map(window.UmasUI.favoriteCardHtml).join("");
    list.querySelectorAll(".favorite-toggle").forEach(function (btn) {
      if (window.UmasFavorites) window.UmasFavorites.sync(btn);
    });
  }

  function load() {
    var ids = window.UmasFavorites ? window.UmasFavorites.get() : [];
    if (!ids.length) {
      render([]);
      return;
    }
    fetch("/api/books/by-ids?ids=" + ids.join(","))
      .then(function (res) { return res.json(); })
      .then(render)
      .catch(function () {
        list.innerHTML = '<p class="muted">' + t("Couldn't load your favorites right now — try refreshing.", "Impossible de charger vos favoris pour le moment\u00a0: essayez d’actualiser la page.") + "</p>";
      });
  }

  // A card removes itself the moment its heart is un-favorited, rather
  // than waiting for a page reload — matches what tapping a filled
  // heart on this page implies.
  document.addEventListener("favoritechange", function (e) {
    if (e.detail.isFavorite) return;
    var card = e.target.closest(".book-card-wrap");
    if (card) card.remove();
    if (!list.querySelector(".book-card-wrap")) render([]);
  });

  load();
})();
