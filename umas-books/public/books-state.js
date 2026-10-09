// Browse Books: the search / genre / "new in" state as a query string, and back.
// Pure functions (no DOM), so test/unit/booksState.test.js runs them as they are;
// public/page-books.js, loaded after this file, does the history and the screen.
//
//   /books.html                   nothing chosen
//   /books.html?q=le+petit+prince  a search
//   /books.html?genre=fiction      a genre button (the slug is the button's key without "g.")
//   /books.html?new=1              "See All New In"
//
// One thing at a time, like the screen: a search wins over a genre, a genre over new.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UmasBooksState = api;
})(this, function () {
  var MAX_Q = 100;

  function empty() { return { q: '', genre: '', isNew: false }; }

  // search: "?q=..." (or without the "?"); genres: the slugs the page knows.
  // Anything unknown or malformed is ignored, never an error: the URL is user input.
  function parse(search, genres) {
    var out = empty();
    var params;
    try { params = new URLSearchParams(String(search || '')); } catch (e) { return out; }
    var q = (params.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q);
    var genre = params.get('genre') || '';
    if (q) { out.q = q; return out; }
    if (genre && genres && genres.indexOf(genre) !== -1) { out.genre = genre; return out; }
    if (params.get('new') === '1') out.isNew = true;
    return out;
  }

  // -> '' or '?q=...' : appended to the page path.
  function serialize(state) {
    var s = state || empty();
    var p = new URLSearchParams();
    if (s.q) p.set('q', s.q);
    else if (s.genre) p.set('genre', s.genre);
    else if (s.isNew) p.set('new', '1');
    var str = p.toString();
    return str ? '?' + str : '';
  }

  function same(a, b) { return serialize(a) === serialize(b); }

  return { parse: parse, serialize: serialize, same: same, empty: empty, MAX_Q: MAX_Q };
});
