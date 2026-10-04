// Buttons marked data-print open the browser's print dialog (the CSP forbids inline handlers).
(function () {
  Array.prototype.forEach.call(document.querySelectorAll("[data-print]"), function (b) {
    b.addEventListener("click", function () { window.print(); });
  });
})();
