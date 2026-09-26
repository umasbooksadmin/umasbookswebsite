// Member's Access dashboard (views/dashboard.ejs) — kept as an external
// file rather than an inline <script> because this app's CSP is
// script-src 'self' with no 'unsafe-inline' (see src/index.js), which
// silently blocks inline scripts in every real browser.
(function () {
  var track = document.getElementById('dash-new-track');
  if (!track) return;
  function page(dir) { track.scrollBy({ left: dir * track.clientWidth * 0.8, behavior: 'smooth' }); }
  var prev = document.getElementById('dash-new-prev');
  var next = document.getElementById('dash-new-next');
  if (prev) prev.addEventListener('click', function () { page(-1); });
  if (next) next.addEventListener('click', function () { page(1); });

  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('cover')) return;
    var ph = document.createElement('div');
    ph.className = 'cover cover-none';
    ph.textContent = 'No cover';
    img.replaceWith(ph);
  }, true);
})();
