/* Uma's Books & Adventures — blog rendering shared by index.html (latest
   posts feed) and blog.html (all posts + single post). Posts live in
   assets/posts.js. */
(function () {
  var UI = {
    en: { readMore: "Read more", more: "Show older posts", allPosts: "All posts", back: "All posts", empty: "No posts yet — check back soon.", notFound: "Sorry, we couldn’t find that post." },
    fr: { readMore: "Lire la suite", more: "Voir les articles plus anciens", allPosts: "Tous les articles", back: "Tous les articles", empty: "Pas encore d’articles — revenez bientôt.", notFound: "Désolé, cet article est introuvable." }
  };

  function lang() {
    try { return localStorage.getItem("umasbooks.lang") === "fr" ? "fr" : "en"; } catch (e) { return "en"; }
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pick(field, l) {
    if (!field) return "";
    if (typeof field === "string" || Array.isArray(field)) return field;
    return field[l] || field.en || "";
  }
  function posts() {
    return (window.UMAS_POSTS || []).slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
  }
  function fmtDate(iso, l) {
    var d = new Date(iso + "T12:00:00");
    if (isNaN(d)) return "";
    return d.toLocaleDateString(l === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
  }
  function image(p, cls) {
    if (!p.image) return '<div class="' + cls + ' blog-img-none" aria-hidden="true"></div>';
    return '<div class="' + cls + (p.imageFit === "contain" ? " is-contain" : "") + '"><img src="' + esc(/^(\/|[a-z][a-z0-9+.-]*:)/i.test(p.image) ? p.image : "/" + p.image) + '" alt="" loading="lazy"></div>';
  }
  function card(p, l, base) {
    var href = (base || "blog.html") + "?post=" + encodeURIComponent(p.slug);
    return '<article class="blog-card">' +
      '<a class="blog-card-link" href="' + esc(href) + '">' +
        image(p, "blog-card-img") +
        '<div class="blog-card-body">' +
          '<div class="blog-date">' + esc(fmtDate(p.date, l)) + '</div>' +
          '<h2 class="blog-title">' + esc(pick(p.title, l)) + '</h2>' +
          '<p class="blog-excerpt">' + esc(pick(p.excerpt, l)) + '</p>' +
          '<span class="blog-more">' + esc(UI[l].readMore) + ' <span aria-hidden="true">&rarr;</span></span>' +
        '</div>' +
      '</a></article>';
  }

  var ARROW_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6 8.5 12l6 6"/></svg>';
  var ARROW_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';
  var CUI = {
    en: { prev: "Previous post", next: "Next post", goTo: "Show post" },
    fr: { prev: "Article précédent", next: "Article suivant", goTo: "Afficher l’article" }
  };

  function slide(p, l) {
    var href = "blog.html?post=" + encodeURIComponent(p.slug);
    var cat = pick(p.category, l);
    return '<div class="wn-slide">' +
      image(p, "wn-img") +
      '<div class="wn-text">' +
        (cat ? '<span class="wn-tag">' + esc(cat) + '</span>' : '') +
        '<h3 class="wn-title">' + esc(pick(p.title, l)) + '</h3>' +
        '<div class="wn-date">' + esc(fmtDate(p.date, l)) + '</div>' +
        '<p class="wn-excerpt">' + esc(pick(p.excerpt, l)) + '</p>' +
        '<a class="h-btn" href="' + esc(href) + '"><span>' + esc(UI[l].readMore) + '</span> <span class="arrow" aria-hidden="true">&rarr;</span></a>' +
      '</div></div>';
  }

  window.UmasBlog = {
    ui: function (key) { return UI[lang()][key]; },
    lang: lang,
    esc: esc,
    pick: pick,
    posts: posts,
    fmtDate: fmtDate,
    image: image,
    card: card,
    // "What's New" slider on the home page: one post at a time (picture left,
    // text card right) with arrows and dots; re-renders on language switch.
    carousel: function (el, n) {
      if (!el) return;
      var i = 0;
      function draw() {
        var l = lang(), list = posts().slice(0, n || 5);
        if (!list.length) { el.innerHTML = '<p class="blog-empty">' + esc(UI[l].empty) + "</p>"; return; }
        i = (i + list.length) % list.length;
        var multi = list.length > 1;
        el.innerHTML =
          (multi ? '<button type="button" class="wn-arrow prev" aria-label="' + esc(CUI[l].prev) + '">' + ARROW_L + '</button>' : '') +
          '<div class="wn-stage" aria-live="polite">' + slide(list[i], l) + '</div>' +
          (multi ? '<button type="button" class="wn-arrow next" aria-label="' + esc(CUI[l].next) + '">' + ARROW_R + '</button>' : '') +
          (multi ? '<div class="wn-dots">' + list.map(function (_, k) {
            return '<button type="button" class="wn-dot' + (k === i ? ' is-active' : '') + '" data-k="' + k + '" aria-label="' + esc(CUI[l].goTo) + ' ' + (k + 1) + '"' + (k === i ? ' aria-current="true"' : '') + '></button>';
          }).join('') + '</div>' : '');
        if (!multi) return;
        el.querySelector('.wn-arrow.prev').onclick = function () { i--; draw(); };
        el.querySelector('.wn-arrow.next').onclick = function () { i++; draw(); };
        el.querySelectorAll('.wn-dot').forEach(function (d) {
          d.onclick = function () { i = Number(d.getAttribute('data-k')); draw(); };
        });
      }
      draw();
      document.querySelectorAll(".langtoggle button").forEach(function (b) {
        b.addEventListener("click", function () { setTimeout(draw, 0); });
      });
      // Posts now live in the database (see assets/blog-live.js) and
      // arrive after an async fetch — re-draw once they're in, same as a
      // language switch, so the slider picks up the real list instead of
      // whatever (if anything) was available at first paint.
      window.addEventListener("umasposts:updated", draw);
    },
    // Render the newest `n` posts as cards into `el`; re-renders on language switch.
    feed: function (el, n) {
      if (!el) return;
      function draw() {
        var l = lang(), list = posts().slice(0, n || 3);
        el.innerHTML = list.length
          ? list.map(function (p) { return card(p, l); }).join("")
          : '<p class="blog-empty">' + esc(UI[l].empty) + "</p>";
      }
      draw();
      document.querySelectorAll(".langtoggle button").forEach(function (b) {
        b.addEventListener("click", function () { setTimeout(draw, 0); });
      });
      window.addEventListener("umasposts:updated", draw);
    }
  };
})();
