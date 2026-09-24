(function () {
  var COMMON = {
    en: {
      "nav.books": "Books",
      "nav.events": "Events",
      "nav.ateliers": "Ateliers",
      "nav.about": "About",
      "nav.contact": "Contact",
      "icon.search": "Search books",
      "icon.account": "My account",
      "icon.cart": "Basket",
      "nav.login": "Log In",
      "nav.logout": "Log Out",
      "foot.books": "Books",
      "foot.community": "Community",
      "foot.english": "English",
      "foot.creativity": "Creativity",
      "foot.visit": "Visit Us",
      "foot.volunteer": "Volunteer",
      "foot.membership": "Membership",
      "foot.wishlist": "Notify Me",
      "foot.favorites": "Favorites"
    },
    fr: {
      "nav.books": "Livres",
      "nav.events": "Événements",
      "nav.ateliers": "Ateliers",
      "nav.about": "À propos",
      "nav.contact": "Contact",
      "icon.search": "Rechercher des livres",
      "icon.account": "Mon compte",
      "icon.cart": "Panier",
      "nav.login": "Connexion",
      "nav.logout": "Déconnexion",
      "foot.books": "Livres",
      "foot.community": "Communauté",
      "foot.english": "Anglais",
      "foot.creativity": "Créativité",
      "foot.visit": "Nous rendre visite",
      "foot.volunteer": "Bénévolat",
      "foot.membership": "Adhésion",
      "foot.wishlist": "Me prévenir",
      "foot.favorites": "Favoris"
    }
  };

  var STORE_KEY = "umasbooks.lang";

  function mergedDict(lang) {
    var page = (window.PAGE_I18N && window.PAGE_I18N[lang]) || {};
    var out = {};
    var base = COMMON[lang] || {};
    for (var k in base) out[k] = base[k];
    for (var k2 in page) out[k2] = page[k2];
    return out;
  }

  function apply(lang) {
    if (lang !== "fr") lang = "en";
    var dict = mergedDict(lang);
    document.documentElement.lang = lang;

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var v = dict[el.getAttribute("data-i18n")];
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var v = dict[el.getAttribute("data-i18n-html")];
      if (v != null) el.innerHTML = v;
    });
    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      el.getAttribute("data-i18n-attr").split(";").forEach(function (pair) {
        var parts = pair.split(":");
        var attr = parts[0].trim(), key = parts[1] && parts[1].trim();
        var v = key && dict[key];
        if (attr && v != null) el.setAttribute(attr, v);
      });
    });
    document.querySelectorAll(".langtoggle button").forEach(function (b) {
      var on = b.getAttribute("data-lang") === lang;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) {}
  }

  function wireMailtoForms() {
    document.querySelectorAll("form[data-mailto]").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var lines = [];
        form.querySelectorAll("[data-field]").forEach(function (el) {
          if ((el.type === "radio" || el.type === "checkbox") && !el.checked) return;
          var val = (el.value || "").trim();
          if (val) lines.push(el.getAttribute("data-field") + ": " + val);
        });
        var address = form.getAttribute("data-mailto");
        var subject = form.getAttribute("data-subject") || "";
        var url = "mailto:" + address + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(lines.join("\n"));
        window.location.href = url;
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var stored = null;
    try { stored = localStorage.getItem(STORE_KEY); } catch (e) {}
    var initial = stored || (/^fr\b/i.test(navigator.language || "") ? "fr" : "en");

    document.querySelectorAll(".langtoggle button").forEach(function (b) {
      b.addEventListener("click", function () { apply(b.getAttribute("data-lang")); });
    });

    wireMailtoForms();
    apply(initial);
  });
})();
