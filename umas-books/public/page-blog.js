// Blog list (views/marketing/blog.ejs). The posts are already in the page, rendered by the server, and the pager at the
// bottom is made of real links (?page=2 ...), so the page works without this file. This only improves it: pressing
// "Show older posts" loads the next page in place instead of navigating. The next page is fetched as the ordinary HTML
// page and its cards are copied in, so there is exactly one template for a card (views/marketing/partials/blog_card.ejs).
// If anything goes wrong the link is simply followed.
(function () {
  var root = document.getElementById('blog-root');
  if (!root || !window.fetch || !window.DOMParser) return;

  root.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('.blog-pager-next');
    if (!link || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (link.getAttribute('aria-busy')) return;
    link.setAttribute('aria-busy', 'true');
    var url = link.href;
    fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' } })
      .then(function (res) { if (!res.ok) throw new Error('status ' + res.status); return res.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var grid = root.querySelector('.blog-grid');
        var incoming = doc.querySelectorAll('#blog-root .blog-card');
        if (!grid || !incoming.length) throw new Error('no cards');
        var first = null;
        incoming.forEach(function (card) {
          var node = document.importNode(card, true);
          grid.appendChild(node);
          if (!first) first = node;
        });
        var nextLink = doc.querySelector('#blog-root .blog-pager-next');
        if (nextLink) {
          link.setAttribute('href', nextLink.getAttribute('href'));
          link.removeAttribute('aria-busy');
          // The "Newer posts" link and the page counter no longer describe what is on screen.
          var pager = link.closest('.blog-pager');
          pager.querySelectorAll('.blog-pager-status, [rel=prev]').forEach(function (n) { n.remove(); });
        } else {
          var nav = link.closest('.blog-pager');
          if (nav) nav.remove();
        }
        var a = first.querySelector('a');
        if (a) a.focus({ preventScroll: false });
      })
      .catch(function () { window.location.href = url; });
  });
})();
