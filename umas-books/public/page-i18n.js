// Reads this page's strings, embedded by views/marketing/partials/mkt_footer.ejs as
// <script type="application/json" id="page-i18n-data">, into window.PAGE_I18N
// ({ en: {...}, fr: {...} }) for assets/site.js and the page scripts. A data
// block instead of an inline script lets the marketing CSP drop 'unsafe-inline'.
(function () {
  var el = document.getElementById('page-i18n-data');
  try { window.PAGE_I18N = el ? JSON.parse(el.textContent) : { en: {}, fr: {} }; } catch (e) { window.PAGE_I18N = { en: {}, fr: {} }; }
})();
