/* Uma's Books & Adventures — loads the newest blog posts from the database (written from /admin/blog) for the home
   page's "What's New" slider. Sets window.UMAS_POSTS (read by assets/blog.js's posts()) and fires "umasposts:updated"
   once the fetch resolves, since it's async and the slider has usually already drawn an empty state by then.
   The feed is light (title, slug, date, excerpt, image: no post bodies). It is asked for in the language of the page
   (?lang=fr gives the French text where a post has one; each post says which language its text is in, so the slider
   can mark an English fallback). The blog pages themselves are rendered by the server (src/routes/blogPages.js). */
(function () {
  window.UMAS_POSTS = window.UMAS_POSTS || [];
  // True until the feed has answered (or failed): the slider (assets/blog.js carousel) shows its placeholder, not "No posts yet", meanwhile.
  window.UMAS_POSTS_LOADING = true;
  // ?preview=1 on the page: ask for drafts and scheduled posts too; the server only honours it for a logged-in admin.
  var adminPreview = /[?&]preview=1(&|$)/.test(location.search);
  var query = ["lang=" + (document.documentElement.lang === "fr" ? "fr" : "en"), adminPreview ? "preview=1" : ""].filter(Boolean).join("&");
  fetch("/api/blog/posts?" + query, { headers: { Accept: "application/json" } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (posts) {
      window.UMAS_POSTS = Array.isArray(posts) ? posts : [];
    })
    .catch(function () {})
    .then(function () {
      window.UMAS_POSTS_LOADING = false;
      window.dispatchEvent(new Event("umasposts:updated"));
    });
})();
