// Server-side marketing forms (pre-registration, volunteer): after a refused
// submission the page is re-rendered with an error summary (role="alert");
// move focus to it so keyboard and screen-reader users land on the problem
// instead of at the top of the page. After a successful one, focus the thank-you
// message. No inline script: the pages' CSP allows this file ('self').
(function () {
  document.addEventListener("DOMContentLoaded", function () {
    var target = document.querySelector("[data-form-errors]") || document.querySelector("[data-form-sent]");
    if (!target) return;
    try { target.focus({ preventScroll: false }); } catch (e) { target.focus(); }
  });
})();
