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

  // COMMON (EN + FR texts shared by every page) is assets/i18n-common.js, loaded before this file (window.UMAS_COMMON).
  var COMMON = window.UMAS_COMMON || { en: {}, fr: {} };

  var STORE_KEY = "umasbooks.lang";
  var COOKIE_KEY = "umasbooks_lang";

  // The server reads the language from this cookie (see
  // src/middleware/lang.js), so pages it renders match the toggle.
  function readLangCookie() {
    var m = document.cookie.match(new RegExp("(?:^|;\\s*)" + COOKIE_KEY + "=([^;]*)"));
    return m ? m[1] : null;
  }
  function writeLangCookie(lang) {
    try {
      document.cookie = COOKIE_KEY + "=" + lang + "; Path=/; Max-Age=31536000; SameSite=Lax" +
        (location.protocol === "https:" ? "; Secure" : "");
    } catch { /* cookies blocked: the server keeps the language it last saw */ }
  }

  // The French site lives under /fr/ (src/lib/frUrls.js): the same public pages, always French.
  // FR_PUBLIC mirrors isPublicPath() there (test/unit/frUrls.test.js keeps them in step); it decides
  // which links written in the browser (dictionary text, book and event cards) gain the /fr prefix.
  var FR_PUBLIC = /^\/(?:|(?:about|blog|books|events|programs|immersion|pre-registration|membership|membership-terms|visit|privacy-policy|terms-of-sale|mentions-legales)(?:\.html)?|volunteer\.html|contact|sessions|request-a-book(?:\/sent)?|books\/\d+|collections\/[a-z0-9]+(?:-[a-z0-9]+)*|blog\/[a-z0-9][a-z0-9-]*)\/?$/;
  function isFrPath(p) { return p === "/fr" || String(p || "").indexOf("/fr/") === 0; }
  function frHref(href) {
    var h = String(href || "");
    // This site's own absolute address (the events API sends them) counts as a local path.
    if (typeof location !== "undefined" && location.origin && h.indexOf(location.origin + "/") === 0) h = h.slice(location.origin.length);
    var m = /^([^?#]*)(.*)$/.exec(h);
    if (!m || m[1].charAt(0) !== "/" || m[1].charAt(1) === "/" || isFrPath(m[1]) || !FR_PUBLIC.test(m[1])) return href;
    return (m[1] === "/" ? "/fr/" : "/fr" + m[1]) + m[2];
  }
  // On a /fr/ page every link to a public page stays under /fr/ (the toggle, which points at the other
  // language on purpose, is left alone). Called after each dictionary swap and by the scripts that draw cards.
  function prefixFrLinks(root) {
    if (!isFrPath(location.pathname)) return;
    (root || document).querySelectorAll("a[href^='/']").forEach(function (a) {
      if (a.hasAttribute("data-lang")) return;
      var h = a.getAttribute("href"), f = frHref(h);
      if (f !== h) a.setAttribute("href", f);
    });
  }
  window.UmasFrHref = function (href) { return isFrPath(location.pathname) ? frHref(href) : href; };
  // The same one /api/session request, for public/cart-add.js (which books are in the cart).
  window.UmasSession = function () { return getSession(); };
  window.UmasPrefixFrLinks = prefixFrLinks;
  // Test hook (test/unit/frUrls.test.js).
  if (typeof window !== "undefined") window.__umasFrHref = frHref;

  // Which language to start in. A choice the person made (localStorage) wins;
  // then the cookie the server read; then the language the server already
  // rendered into <html lang>; the browser's language is the last resort.
  // Never flip a server-rendered page to the browser's language.
  // A /fr/ address is French whatever was stored earlier (src/lib/frUrls.js).
  function resolveInitialLang(stored, cookie, htmlLang, navLang, pathname) {
    if (isFrPath(pathname)) return "fr";
    var picks = [stored, cookie, htmlLang];
    for (var i = 0; i < picks.length; i++) {
      var l = String(picks[i] || "").toLowerCase().slice(0, 2);
      if (l === "fr" || l === "en") return l;
    }
    return /^fr\b/i.test(navLang || "") ? "fr" : "en";
  }
  // Test hook (test/unit/siteLang.test.js evaluates this file in a vm).
  if (typeof window !== "undefined") window.__umasResolveInitialLang = resolveInitialLang;

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
    document.querySelectorAll(".langtoggle [data-lang]").forEach(function (b) {
      var on = b.getAttribute("data-lang") === lang;
      b.classList.toggle("is-active", on);
      if (b.tagName === "A") { if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); }
      else b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    prefixFrLinks();
    try { localStorage.setItem(STORE_KEY, lang); } catch { /* storage unavailable (private mode): the choice is just not remembered */ }
    writeLangCookie(lang);
  }

  // One shared /api/session request per page view (cart count, admin
  // link, member link and login state all read it) instead of one each —
  // every call is a session-backed request, so this is 1 instead of 4.
  // Resolves to the parsed JSON, or null on any failure. Created lazily
  // so a page that needs none of them makes no request at all.
  var sessionPromise = null;
  function getSession() {
    if (!sessionPromise) {
      sessionPromise = fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; });
    }
    return sessionPromise;
  }

  // The header's "Cart (n)". The cart lives in the Members Area app's
  // session, so the count is only available on pages that app itself
  // serves; anywhere else it quietly stays at 0. (/api/session carries
  // cartCount; /api/cart/count remains for other callers.)
  function loadCartCount() {
    var els = document.querySelectorAll("[data-cart-count]");
    if (!els.length || !window.fetch) return;
    getSession().then(function (data) {
      if (!data || typeof data.cartCount !== "number") return;
      els.forEach(function (el) { el.textContent = String(data.cartCount); });
    });
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
    getSession()
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
    getSession()
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
  // logged-in user clicking "Log In" would otherwise get silently
  // redirected away by the server (GET /login sends an existing session
  // to / or /dashboard instead of showing the form) — this makes the
  // icon match what actually happens. A no-op wherever header.ejs
  // already rendered the real logout form (it has no href="/login" to
  // find).
  function loadLoginState() {
    var loginLink = document.querySelector('.h-tools a[href="/login"]');
    if (!window.fetch || !loginLink) return;
    getSession()
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
    try { stored = localStorage.getItem(STORE_KEY); } catch { /* storage unavailable (private mode): the choice is just not remembered */ }
    // A language chosen earlier (localStorage) must reach the server too:
    // fix a missing or differing cookie so the next request matches.
    if ((stored === "fr" || stored === "en") && readLangCookie() !== stored) writeLangCookie(stored);
    var initial = resolveInitialLang(stored, readLangCookie(), document.documentElement.lang, navigator.language, location.pathname);

    document.querySelectorAll(".langtoggle [data-lang]").forEach(function (b) {
      b.addEventListener("click", function (ev) {
        var lang = b.getAttribute("data-lang") === "fr" ? "fr" : "en";
        // A link to the page's other-language address: remember the choice, then let the browser go there
        // (the address itself says which language it is, so nothing is swapped here). Clicking the language
        // already shown just stays.
        if (b.tagName === "A") {
          try { localStorage.setItem(STORE_KEY, lang); } catch { /* storage unavailable (private mode): the choice is just not remembered */ }
          writeLangCookie(lang);
          if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button) return;
          if (b.getAttribute("href") === location.pathname + location.search || b.classList.contains("is-active")) {
            ev.preventDefault(); // same address: reload only if the language really changes (server-rendered text)
            if (lang !== document.documentElement.lang) location.reload();
          }
          return;
        }
        // Pages without a client-side dictionary (book page, cart, login,
        // forms: server-rendered through tr()) can only change language by
        // asking the server again: remember the choice, then reload.
        if (!window.PAGE_I18N) {
          var changed = lang !== document.documentElement.lang;
          try { localStorage.setItem(STORE_KEY, lang); } catch { /* storage unavailable (private mode): the choice is just not remembered */ }
          writeLangCookie(lang);
          if (changed) { location.reload(); return; }
        }
        apply(lang);
      });
    });

    apply(initial);
    loadCartCount();
    loadAdminLink();
    loadMemberAccessLink();
    loadLoginState();
  });
})();
