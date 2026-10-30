// Home page, phone layout shift (2026-10-27 review H3, CLS about 0.38): the "What's New" box (#home-wn) used to be empty until
// the posts feed answered, then grew to the height of a slide and pushed everything under it down. Now the box is marked
// aria-busy in the page, assets/blog.css gives it the height of a slide while it is busy, and assets/blog.js leaves it empty
// (no "No posts yet" flash) until assets/blog-live.js says the feed has answered. The measured layout shift is in the PR.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadSheet } = require("../helpers/css");

const APP = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(APP, ...p), "utf8");
const blogCss = loadSheet("assets/blog.css");

test("the home page ships the slider box already marked busy, and drops the reserved space without JavaScript", () => {
  const ejs = read("views", "marketing", "index.ejs");
  assert.match(ejs, /<div class="wn-carousel" id="home-wn" aria-roledescription="carousel" aria-busy="true"><\/div>/);
  assert.match(ejs, /<noscript><style>\.wn-carousel \{ min-height: 0 !important; \}/, "nothing will ever fill it without JavaScript");
});

test("while busy the box holds the height of a slide (two columns, and stacked on phones) and shows a placeholder", () => {
  assert.ok(blogCss.getDecl('.wn-carousel[aria-busy="true"]', "min-height"), "desktop reserve");
  const phone = blogCss.getDecl('.wn-carousel[aria-busy="true"]', "min-height", { at: "@media (max-width: 820px)" });
  assert.match(phone, /^calc\(\(100vw - 32px\) \* 0\.7143 \+ \d+px\)$/, "phone reserve: the 7:5 picture at full width plus the text");
  assert.equal(blogCss.getDecl('.wn-carousel[aria-busy="true"]::before', "aspect-ratio"), "7 / 5", "the placeholder has the picture's shape");
  assert.equal(blogCss.getDecl(".wn-img", "aspect-ratio"), "7 / 5", "and the real picture is still 7:5");
});

// assets/blog.js as the home page runs it, with a fake box.
function runCarousel({ loading, posts }) {
  const attrs = {};
  const el = { innerHTML: "", setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, querySelector: () => null, querySelectorAll: () => [] };
  const listeners = {};
  const window = {
    UMAS_POSTS: posts, UMAS_POSTS_LOADING: loading,
    UmasUI: { esc: (s) => String(s == null ? "" : s) },
    addEventListener: (name, fn) => { listeners[name] = fn; },
  };
  const document = { documentElement: { lang: "en" }, querySelectorAll: () => [] };
  vm.runInNewContext(read("..", "assets", "blog.js"), { window, document, Date, isNaN, encodeURIComponent });
  window.UmasBlog.carousel(el, 5);
  return { el, attrs, window, redraw: () => listeners["umasposts:updated"]() };
}

test("until the feed has answered the box stays empty and busy (no 'No posts yet'); then it draws and is no longer busy", () => {
  const post = { slug: "a", date: "2026-10-01", title: "Hello", excerpt: "x", category: "News" };
  const r = runCarousel({ loading: true, posts: [] });
  assert.equal(r.el.innerHTML, "");
  assert.equal(r.attrs["aria-busy"], "true");
  r.window.UMAS_POSTS = [post];
  r.window.UMAS_POSTS_LOADING = false;
  r.redraw();
  assert.match(r.el.innerHTML, /wn-slide/);
  assert.equal(r.attrs["aria-busy"], undefined);
});

test("an answered feed with no posts shows the empty message, and is not busy", () => {
  const r = runCarousel({ loading: false, posts: [] });
  assert.match(r.el.innerHTML, /No posts yet/);
  assert.equal(r.attrs["aria-busy"], undefined);
});

test("blog-live.js clears the loading flag whether the feed answers or fails", () => {
  const src = read("..", "assets", "blog-live.js");
  const run = (fetchImpl) => new Promise((resolve) => {
    const events = [];
    const window = { dispatchEvent: (e) => events.push(e.type) };
    vm.runInNewContext(src, { window, location: { search: "" }, document: { documentElement: { lang: "en" } }, fetch: fetchImpl, Event: class { constructor(t) { this.type = t; } }, Array, RegExp });
    assert.equal(window.UMAS_POSTS_LOADING, true, "loading from the start");
    setTimeout(() => resolve({ window, events }), 20);
  });
  return Promise.all([
    run(() => Promise.resolve({ ok: true, json: () => Promise.resolve([{ slug: "a" }]) })),
    run(() => Promise.reject(new Error("offline"))),
    run(() => Promise.resolve({ ok: false })),
  ]).then(([ok, offline, bad]) => {
    assert.equal(ok.window.UMAS_POSTS.length, 1);
    for (const r of [ok, offline, bad]) {
      assert.equal(r.window.UMAS_POSTS_LOADING, false);
      assert.deepEqual(r.events, ["umasposts:updated"]);
    }
    assert.equal(offline.window.UMAS_POSTS.length, 0);
  });
});
