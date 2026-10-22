/* Uma's Books & Adventures — loads blog posts from the database (written
   from /admin/blog) instead of a hand-edited file. Sets window.UMAS_POSTS
   (read by assets/blog.js's posts()) and fires "umasposts:updated" once
   the fetch resolves, since it's async and the page has usually already
   drawn an empty state by then — blog.js's carousel()/feed() and this
   page's own bootstrap script listen for that event to redraw.
   The feed is light (title, slug, date, excerpt, image: no post bodies) and
   comes one page at a time; window.UMAS_POSTS_MORE says whether another page
   may exist and UmasBlogLive.more() loads it. A post's body is fetched on
   demand by UmasBlogLive.post(slug). */
(function () {
  window.UMAS_POSTS = window.UMAS_POSTS || [];
  window.UMAS_POSTS_MORE = false;
  var PAGE = 24;
  // ?preview=1 on the page (the admin screen's Preview link): ask for drafts and
  // scheduled posts too; the server only honours it for a logged-in admin.
  var adminPreview = /[?&]preview=1(&|$)/.test(location.search);
  var pv = adminPreview ? "preview=1" : "";
  var loading = false;

  function fetchJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      return res.ok ? res.json() : null;
    });
  }
  function loadPage(offset) {
    var q = [pv, offset ? "offset=" + offset : ""].filter(Boolean).join("&");
    return fetchJson("/api/blog/posts" + (q ? "?" + q : "")).then(function (posts) {
      posts = Array.isArray(posts) ? posts : [];
      window.UMAS_POSTS = offset ? window.UMAS_POSTS.concat(posts) : posts;
      window.UMAS_POSTS_MORE = posts.length >= PAGE;
      window.dispatchEvent(new Event("umasposts:updated"));
    });
  }
  var cache = {};
  window.UmasBlogLive = {
    more: function () {
      if (loading || !window.UMAS_POSTS_MORE) return Promise.resolve();
      loading = true;
      return loadPage(window.UMAS_POSTS.length).catch(function () {}).then(function () { loading = false; });
    },
    // One post with its body, or null when there is no such public post.
    post: function (slug) {
      if (cache[slug]) return Promise.resolve(cache[slug]);
      return fetchJson("/api/blog/posts/" + encodeURIComponent(slug) + (pv ? "?" + pv : "")).then(function (p) {
        if (p) cache[slug] = p;
        return p;
      }).catch(function () { return null; });
    }
  };
  loadPage(0).catch(function () {});
})();
