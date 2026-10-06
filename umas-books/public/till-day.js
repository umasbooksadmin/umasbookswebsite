// End of day: shows over/short while the counted cash is being typed.
(function () {
  var input = document.getElementById("counted");
  var out = document.getElementById("diff-live");
  if (!input || !out) return;
  input.addEventListener("input", function () {
    var t = input.value.trim().replace(",", ".");
    if (!/^\d+(\.\d{0,2})?$/.test(t)) { out.textContent = ""; return; }
    var p = t.split(".");
    var counted = Number(p[0]) * 100 + Number(((p[1] || "") + "00").slice(0, 2));
    var d = counted - Number(input.getAttribute("data-expected"));
    out.textContent = d === 0 ? "The drawer is right." : (d > 0 ? "Over by €" : "Short by €") + (Math.abs(d) / 100).toFixed(2);
  });
})();
