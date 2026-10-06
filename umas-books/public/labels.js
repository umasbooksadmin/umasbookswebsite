// "Tick all" on the copy labels page.
(function () {
  var all = document.querySelector("[data-tick-all]");
  if (!all) return;
  all.addEventListener("change", function () {
    Array.prototype.forEach.call(document.querySelectorAll('input[name="id"]'), function (b) { b.checked = all.checked; });
  });
})();
