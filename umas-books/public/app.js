document.addEventListener("click", function (e) {
  var btn = e.target.closest("[data-toggle-password]");
  if (!btn) return;
  var input = document.getElementById(btn.getAttribute("data-toggle-password"));
  if (!input) return;
  var showing = input.type === "text";
  input.type = showing ? "password" : "text";
  btn.textContent = showing ? "Show" : "Hide";
  btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
});
