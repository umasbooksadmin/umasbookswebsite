// Blog page (views/marketing/blog.ejs): list and single post. Needs assets/blog.js (UmasBlog). Was an inline <script>.
(function () {
  var root = document.getElementById('blog-root');
  var B = window.UmasBlog;
  var shown = null, pending = {}, loaded = {}; // the single-post view: its body is fetched on demand
  function draw() {
    var l = B.lang(), slug = new URLSearchParams(location.search).get('post');
    if (slug) {
      var Live = window.UmasBlogLive;
      var cached = B.posts().filter(function (x) { return x.slug === slug && x.body != null; })[0];
      if (!cached && Live) {
        if (shown !== slug) {
          root.innerHTML = '<div class="blog-post"><a class="back" href="blog.html">&larr; ' + B.esc(B.ui('back')) + '</a></div>';
        }
        shown = slug;
        if (!pending[slug]) {
          pending[slug] = Live.post(slug).then(function (p) { loaded[slug] = p || false; draw(); });
        }
        if (loaded[slug] === undefined) return;
      }
      var p = cached || loaded[slug];
      if (!p) {
        root.innerHTML = '<div class="blog-post"><a class="back" href="blog.html">&larr; ' + B.esc(B.ui('back')) + '</a><p>' + B.esc(B.ui('notFound')) + '</p></div>';
        return;
      }
      var title = B.pick(p.title, l);
      document.title = title + ' — Uma\'s Books and Adventures';
      var body = B.pick(p.body, l) || [];
      var bodyHtml = Array.isArray(body) ? body.map(function (para) { return '<p>' + B.esc(para) + '</p>'; }).join('') : body;
      var note = p.live === false
        ? '<p class="blog-empty" role="status"><strong>Admin preview:</strong> this post is not public yet (' + B.esc(p.status) + ').</p>' : '';
      root.innerHTML = '<article class="blog-post">' + note +
        '<a class="back" href="blog.html">&larr; ' + B.esc(B.ui('back')) + '</a>' +
        '<div class="blog-date">' + B.esc(B.fmtDate(p.date, l)) + '</div>' +
        '<h1>' + B.esc(title) + '</h1>' +
        B.image(p, 'blog-post-img') +
        bodyHtml +
      '</article>';
      return;
    }
    document.title = "Blog — Uma's Books and Adventures";
    var list = B.posts();
    root.innerHTML = '<h1 class="blog-page-title" data-i18n="blog.title">Blog</h1>' +
      (list.length
        ? '<div class="blog-grid">' + list.map(function (p) { return B.card(p, l); }).join('') + '</div>' +
          (window.UMAS_POSTS_MORE ? '<p class="blog-more-wrap"><button type="button" class="h-btn blog-load-more">' + B.esc(B.ui('more')) + '</button></p>' : '')
        : '<p class="blog-empty">' + B.esc(B.ui('empty')) + '</p>');
  }
  root.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.blog-load-more') && window.UmasBlogLive) window.UmasBlogLive.more();
  });
  draw();
  document.querySelectorAll('.langtoggle button').forEach(function (b) {
    b.addEventListener('click', function () { setTimeout(draw, 0); });
  });
  window.addEventListener('umasposts:updated', draw);
})();
