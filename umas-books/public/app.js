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

document.addEventListener("change", function (e) {
  var input = e.target.closest("input[type=file][data-file-name-target]");
  if (!input) return;
  var target = document.getElementById(input.getAttribute("data-file-name-target"));
  if (!target) return;
  var file = input.files && input.files[0];
  target.textContent = file ? file.name : "No photo selected";
});
