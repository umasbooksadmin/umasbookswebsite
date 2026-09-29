(function () {
  // A double-click (or any accidental repeat click) on "Log Out" fires
  // two POSTs almost simultaneously; the first destroys the session, so
  // the second races in with a token that no longer matches anything —
  // see middleware/csrf.js for the server-side half of this fix.
  // Disabling the button on first submit stops the second request from
  // ever going out. Delegated so it covers both the server-rendered
  // form (partials/header.ejs) and the one this file injects on static
  // pages (see loadLoginState below).
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (form.getAttribute("action") !== "/logout") return;
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
  });

  var COMMON = {
    en: {
      "nav.home": "Home",
      "nav.books": "Browse Books",
      "nav.programs": "English Programs",
      "nav.events": "Events",
      "nav.visit": "Visit Us",
      "tool.favorites": "Favorites",
      "tool.login": "Log In",
      "tool.logout": "Log Out",
      "tool.members": "Member’s Access",
      "tool.account": "My Account",
      "tool.cart": "Cart",
      "foot.books": "Books",
      "foot.community": "Community",
      "foot.english": "English",
      "foot.creativity": "Creativity",
      "foot.contact": "Contact Us",
      "foot.visit": "Visit Us",
      "foot.membership": "Membership",
      "foot.favorites": "Favorites",
      "foot.privacy": "Privacy Policy",
      "member.kicker": "Join our community",
      "member.t": "Become a Member <br>of Our Association",
      "member.d": "Members vote on the next charity to donate to, <br>volunteer opportunities, special events and more.",
      "member.cta": "Find out how to sign up here"
    },
    fr: {
      "nav.home": "Accueil",
      "nav.books": "Parcourir les livres",
      "nav.programs": "Programmes d’anglais",
      "nav.events": "Événements",
      "nav.visit": "Nous rendre visite",
      "tool.favorites": "Favoris",
      "tool.login": "Connexion",
      "tool.logout": "Déconnexion",
      "tool.members": "Espace membres",
      "tool.account": "Mon compte",
      "tool.cart": "Panier",
      "foot.books": "Livres",
      "foot.community": "Communauté",
      "foot.english": "Anglais",
      "foot.creativity": "Créativité",
      "foot.contact": "Nous contacter",
      "foot.visit": "Nous rendre visite",
      "foot.membership": "Adhésion",
      "foot.favorites": "Favoris",
      "foot.privacy": "Politique de confidentialité",
      "member.kicker": "Rejoignez notre communauté",
      "member.t": "Devenez membre <br>de notre association",
      "member.d": "Les membres votent pour la prochaine association à soutenir, <br>participent au bénévolat, aux événements spéciaux et plus encore.",
      "member.cta": "Découvrir comment adhérer"
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
    // Server-rendered dynamic content (e.g. a book's description/genre —
    // see views/book_detail.ejs) that already has a French version from
    // the database, rather than a fixed dictionary key: the element's own
    // original text is the English fallback, cached once so toggling back
    // and forth doesn't lose it. An empty/missing data-fr-text (a book
    // that hasn't gotten its French version generated yet) just leaves
    // the English text in place.
    document.querySelectorAll("[data-fr-text]").forEach(function (el) {
      if (el.dataset.enCache === undefined) el.dataset.enCache = el.textContent;
      var fr = el.getAttribute("data-fr-text");
      el.textContent = (lang === "fr" && fr) ? fr : el.dataset.enCache;
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
          // A multi-select's .value is only its first selected option —
          // list every option the visitor picked instead.
          if (el.tagName === "SELECT" && el.multiple) {
            var picked = Array.prototype.filter.call(el.options, function (o) { return o.selected; })
              .map(function (o) { return (o.textContent || o.value).trim(); });
            if (picked.length) lines.push(el.getAttribute("data-field") + ": " + picked.join(", "));
            return;
          }
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

  // The header's "Cart (n)". The cart lives in the Members Area app's
  // session, so the count is only available on pages that app itself
  // serves; anywhere else it quietly stays at 0.
  function loadCartCount() {
    var els = document.querySelectorAll("[data-cart-count]");
    if (!els.length || !window.fetch) return;
    fetch("/api/cart/count", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || typeof data.count !== "number") return;
        els.forEach(function (el) { el.textContent = String(data.count); });
      })
      .catch(function () {});
  }

  // Adds the "Admin" and "Member's Access" header links for a logged-in
  // admin/member on pages that can't render them server-side (the
  // marketing site's static HTML — see /api/session). Each is a no-op
  // wherever partials/header.ejs already rendered it (the dynamic app
  // pages, which also load this script via partials/footer.ejs), since
  // the guard below finds that link first. Both insert relative to the
  // language toggle, the one header-tools element every static page
  // always has — never the "Log In" link, since loadLoginState() below
  // may replace that with a "Log Out" form.
  function loadAdminLink() {
    if (!window.fetch || document.querySelector('a.h-tool[href="/admin"]')) return;
    var langToggle = document.querySelector('.h-tools .langtoggle');
    if (!langToggle) return;
    fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.isAdmin) return;
        var a = document.createElement("a");
        a.className = "h-tool";
        a.href = "/admin";
        a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 4 6v6c0 5 3.4 8.4 8 9.5 4.6-1.1 8-4.5 8-9.5V6z"/></svg><span class="label">Admin</span>';
        langToggle.parentNode.insertBefore(a, langToggle);
      })
      .catch(function () {});
  }

  function loadMemberAccessLink() {
    if (!window.fetch || document.querySelector('a.h-tool[href="/dashboard"]')) return;
    var langToggle = document.querySelector('.h-tools .langtoggle');
    if (!langToggle) return;
    fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !(data.isMember || data.isVolunteer || data.isAdmin)) return;
        var a = document.createElement("a");
        a.className = "h-tool";
        a.href = "/dashboard";
        a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg><span class="label">Member’s Access</span>';
        langToggle.parentNode.insertBefore(a, langToggle);
      })
      .catch(function () {});
  }

  // Swaps the static "Log In" icon for a "Log Out" button when a
  // session already exists — the marketing site's static HTML always
  // renders "Log In" (see loadAdminLink's comment above), unlike
  // partials/header.ejs, which already does this swap server-side. A
  // logged-in visitor clicking "Log In" would otherwise get silently
  // redirected away by the server (GET /login sends an existing session
  // to / or /dashboard instead of showing the form) — this makes the
  // icon match what actually happens. A no-op wherever header.ejs
  // already rendered the real logout form (it has no href="/login" to
  // find).
  function loadLoginState() {
    var loginLink = document.querySelector('.h-tools a[href="/login"]');
    if (!window.fetch || !loginLink) return;
    fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.loggedIn) return;
        return fetch("/api/csrf-token", { credentials: "same-origin", headers: { Accept: "application/json" } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (csrf) {
            if (!csrf || !csrf.token) return;
            var form = document.createElement("form");
            form.method = "post";
            form.action = "/logout";
            var hidden = document.createElement("input");
            hidden.type = "hidden";
            hidden.name = "_csrf";
            hidden.value = csrf.token;
            var btn = document.createElement("button");
            btn.type = "submit";
            btn.className = "h-tool";
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4.2"/><path d="M4 21c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5z" stroke-linejoin="round"/></svg><span class="label" data-i18n="tool.logout">Log Out</span>';
            form.appendChild(hidden);
            form.appendChild(btn);
            loginLink.parentNode.replaceChild(form, loginLink);
            apply(document.documentElement.lang);
          });
      })
      .catch(function () {});
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
    loadCartCount();
    loadAdminLink();
    loadMemberAccessLink();
    loadLoginState();
  });
})();
