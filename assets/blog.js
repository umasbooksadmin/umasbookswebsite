/* Uma's Books & Adventures — the "What's New" slider on the home page. The blog itself (list and posts) is rendered by
   the server (src/routes/blogPages.js); this file only draws the slider from the JSON feed that assets/blog-live.js loads
   into window.UMAS_POSTS (the newest posts, in the page's language, each with `lang`: "en" marks an English fallback). */
(function () {
  var UI = {
    en: { readMore: "Read more", more: "Show older posts", allPosts: "All posts", back: "All posts", empty: "No posts yet — check back soon.", notFound: "Sorry, we couldn’t find that post." },
    fr: { readMore: "Lire la suite", more: "Voir les articles plus anciens", allPosts: "Tous les articles", back: "Tous les articles", empty: "Pas encore d’articles — revenez bientôt.", notFound: "Désolé, cet article est introuvable." }
  };

  // The language the server rendered the page in (<html lang>; assets/site.js keeps it in step with the EN / FR toggle).
  function lang() {
    return document.documentElement.lang === "fr" ? "fr" : "en";
  }
  var esc = window.UmasUI.esc; // public/ui.js, loaded before this file
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
  var ARROW_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6 8.5 12l6 6"/></svg>';
  var ARROW_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';
  var CUI = {
    en: { prev: "Previous post", next: "Next post", goTo: "Show post" },
    fr: { prev: "Article précédent", next: "Article suivant", goTo: "Afficher l’article" }
  };

  function slide(p, l) {
    // /fr/ pages keep their links under /fr/ (assets/site.js); a post with no French text is shown in English, marked "EN".
    var href = window.UmasFrHref ? window.UmasFrHref("/blog/" + encodeURIComponent(p.slug)) : "/blog/" + encodeURIComponent(p.slug);
    var cat = pick(p.category, l);
    var fallback = l === "fr" && p.lang === "en";
    var en = fallback ? ' lang="en"' : "";
    return '<div class="wn-slide">' +
      image(p, "wn-img") +
      '<div class="wn-text">' +
        (cat ? '<span class="wn-tag">' + esc(cat) + '</span>' : '') +
        '<h3 class="wn-title"' + en + '>' + esc(pick(p.title, l)) +
          (fallback ? ' <span class="wn-lang"><span aria-hidden="true">EN</span><span class="wn-sr" lang="fr"> Article disponible uniquement en anglais</span></span>' : '') + '</h3>' +
        '<div class="wn-date">' + esc(fmtDate(p.date, l)) + '</div>' +
        '<p class="wn-excerpt"' + en + '>' + esc(pick(p.excerpt, l)) + '</p>' +
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
    }
  };
})();
