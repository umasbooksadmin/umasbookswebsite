/* Uma's Books & Adventures — loads blog posts from the database (written
   from /admin/blog) instead of a hand-edited file. Sets window.UMAS_POSTS
   (read by assets/blog.js's posts()) and fires "umasposts:updated" once
   the fetch resolves, since it's async and the page has usually already
   drawn an empty state by then — blog.js's carousel()/feed() and this
   page's own bootstrap script listen for that event to redraw. */
(function () {
  window.UMAS_POSTS = window.UMAS_POSTS || [];
  fetch("/api/blog/posts", { headers: { Accept: "application/json" } })
    .then(function (res) { return res.ok ? res.json() : []; })
    .then(function (posts) {
      window.UMAS_POSTS = Array.isArray(posts) ? posts : [];
      window.dispatchEvent(new Event("umasposts:updated"));
    })
    .catch(function () {});
})();
