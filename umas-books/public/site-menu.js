/* The phone "Menu" button of the public header (partials/mkt_chrome_header.ejs).
   The markup is a <details>, so it opens and closes without this script; this
   adds what <details> lacks: aria-expanded, Esc to close (focus goes back to the
   button), a click or Tab outside to close, and keeping the links open and
   visible from 641px up, where the button is hidden. Loaded right after the
   header so the closed state is set before the page below paints. */
(function () {
  var menu = document.querySelector("details.h-menu");
  if (!menu) return;
  var button = menu.querySelector("summary");
  var phone = window.matchMedia("(max-width: 640px)");

  function describe() {
    if (phone.matches) button.setAttribute("aria-expanded", menu.open ? "true" : "false");
    else button.removeAttribute("aria-expanded");
  }
  function layout() {
    menu.open = !phone.matches;
    describe();
  }
  function close(focusButton) {
    if (!phone.matches || !menu.open) return;
    menu.open = false;
    describe();
    if (focusButton) button.focus();
  }

  layout();
  if (phone.addEventListener) phone.addEventListener("change", layout);
  else if (phone.addListener) phone.addListener(layout);
  menu.addEventListener("toggle", describe);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close(menu.contains(document.activeElement));
  });
  document.addEventListener("click", function (e) {
    if (!menu.contains(e.target)) close(false);
  });
  menu.addEventListener("focusout", function (e) {
    if (e.relatedTarget && !menu.contains(e.relatedTarget)) close(false);
  });
})();
