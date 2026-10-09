/* Uma's Books & Adventures — loads blog posts from the database (written
   from /admin/blog) instead of a hand-edited file. Sets window.UMAS_POSTS
   (read by assets/blog.js's posts()) and fires "umasposts:updated" once
   the fetch resolves, since it's async and the page has usually already
   drawn an empty state by then — blog.js's carousel()/feed() and this
   page's own bootstrap script listen for that event to redraw. */
(function () {
  window.UMAS_POSTS = window.UMAS_POSTS || [];
  // ?preview=1 on the page (the admin screen's Preview link): ask for drafts and
  // scheduled posts too; the server only honours it for a logged-in admin.
  var adminPreview = /[?&]preview=1(&|$)/.test(location.search);
  fetch("/api/blog/posts" + (adminPreview ? "?preview=1" : ""), { headers: { Accept: "application/json" } })
    .then(function (res) { return res.ok ? res.json() : []; })
    .then(function (posts) {
      window.UMAS_POSTS = Array.isArray(posts) ? posts : [];
      window.dispatchEvent(new Event("umasposts:updated"));
    })
    .catch(function () {});
})();
