(function () {
  var COMMON = {
    en: {
      "brand.tag": "English Pre-Loved Books",
      "footer.addr": "Rue Peyrolière, 81000 Albi",
      "nav.books": "Books",
      "nav.classes": "Éveil Classes",
      "nav.events": "Events",
      "nav.about": "About",
      "nav.visit": "Visit",
      "icon.search": "Search",
      "icon.account": "Account / Membership",
      "icon.wishlist": "Wish List",
      "icon.cart": "Shop",
      "footer.contact": "Contact",
      "footer.wishlist": "Wish List",
      "footer.volunteer": "Volunteer",
      "footer.membership": "Membership",
      "footer.hours.l": "Tuesday – Saturday, 10:00–19:00",
      "footer.tagline": "Good books. Brighter lives."
    },
    fr: {
      "brand.tag": "Livres anglais d’occasion",
      "footer.addr": "Rue Peyrolière, 81000 Albi",
      "nav.books": "Livres",
      "nav.classes": "Cours Éveil",
      "nav.events": "Événements",
      "nav.about": "À propos",
      "nav.visit": "Nous rendre visite",
      "icon.search": "Rechercher",
      "icon.account": "Compte / Adhésion",
      "icon.wishlist": "Liste de souhaits",
      "icon.cart": "Boutique",
      "footer.contact": "Contact",
      "footer.wishlist": "Liste de souhaits",
      "footer.volunteer": "Bénévolat",
      "footer.membership": "Adhésion",
      "footer.hours.l": "Mardi – samedi, 10h00–19h00",
      "footer.tagline": "De bons livres. Des vies plus lumineuses."
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
