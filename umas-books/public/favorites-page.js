// Renders the Favorites page's book list (views/favorites.ejs) — the
// favorited ids live in localStorage (see favorites.js), so the list
// itself has to be fetched and rendered client-side; there's nothing to
// query server-side without an account.
(function () {
  var list = document.getElementById("favorites-list");
  if (!list) return;

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(books) {
    if (!books.length) {
      list.innerHTML = '<p class="muted">No favorites yet — browse <a href="/books">Books</a> and tap the heart on anything you like.</p>';
      return;
    }
    list.innerHTML = books.map(function (b) {
      var cover = b.coverUrl
        ? '<img src="' + esc(b.coverUrl) + '" alt="" class="book-card-cover">'
        : '<div class="book-card-cover book-thumb-placeholder">No cover</div>';
      var price = b.price != null ? '<span class="book-card-price">€' + Number(b.price).toFixed(2) + "</span>" : "";
      var availability = b.inStockCount > 0
        ? '<span class="availability-badge is-in-stock"><span class="dot"></span>' + b.inStockCount + " in stock</span>"
        : '<span class="availability-badge is-out">&middot; Currently unavailable</span>';
      return '<div class="book-card-wrap">' +
        '<button type="button" class="favorite-toggle" data-book-id="' + b.id + '" aria-pressed="true" aria-label="Favorite">' +
          '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 20s-7-4.4-9.5-8.8C.8 7.8 2.4 4.5 5.8 4c2-.3 3.7.7 4.8 2.4L12 8l1.4-1.6C14.5 4.7 16.2 3.7 18.2 4c3.4.5 5 3.8 3.3 7.2C19 15.6 12 20 12 20z"/></svg>' +
        "</button>" +
        '<a class="book-card" href="' + esc(b.url) + '">' + cover +
          '<div class="book-card-body">' +
            '<div class="book-card-title">' + esc(b.title) + "</div>" +
            '<div class="muted small">' + esc(b.author || "Unknown author") + "</div>" +
            '<div class="book-card-meta">' + price + availability + "</div>" +
          "</div>" +
        "</a>" +
      "</div>";
    }).join("");
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
        list.innerHTML = '<p class="muted">Couldn\'t load your favorites right now — try refreshing.</p>';
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
