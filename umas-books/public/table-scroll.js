// Admin pages: a table that is wider than its box scrolls sideways inside it (.table-scroll in admin.css).
// On a phone nobody knows that without a hint, so a line "Swipe sideways to see all columns" is put above each
// such table, only while the table really is wider than its box, and removed for good once it has been scrolled.
// (The soft edge shadow is pure CSS and needs no script.)
(function () {
  var fr = /^fr/i.test(document.documentElement.lang || "");
  var text = fr ? "Faites glisser sur le côté pour voir toutes les colonnes" : "Swipe sideways to see all columns";
  var boxes = document.querySelectorAll(".table-scroll");
  Array.prototype.forEach.call(boxes, function (box) {
    var hint = document.createElement("p");
    hint.className = "table-scroll-hint";
    hint.textContent = text;
    box.parentNode.insertBefore(hint, box);
    var scrolled = false;
    function update() {
      var wide = box.scrollWidth > box.clientWidth + 2;
      hint.classList.toggle("is-needed", wide);
      hint.classList.toggle("is-done", scrolled);
    }
    box.addEventListener("scroll", function () {
      if (box.scrollLeft > 8) { scrolled = true; update(); }
    }, { passive: true });
    update();
    if (window.ResizeObserver) new ResizeObserver(update).observe(box);
    else window.addEventListener("resize", update);
  });
})();
