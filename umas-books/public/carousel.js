// A side-arrow carousel over a row of equal items: the New In, Browse by Collection and Browse by Genre rows of
// Browse Books (public/page-books.js). A plain script, loaded after ui.js; it sets window.UmasCarousel.
//
//   UmasCarousel.make(track, prevBtn, nextBtn, itemSel [, more]) -> { layout(), reveal(i) }
//
(function (root, factory) {
  var api = factory();
  if (typeof window !== 'undefined') window.UmasCarousel = api;
  else if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UmasCarousel = api;
})(this, function () {
  // One component for every carousel on Browse Books (New In, Browse by Collection, Browse by Genre). The track
  // (assets/books.css) shows a whole number of items (--per) and every item is a snap point. Arrows and arrow keys scroll to the left edge of a real item (its measured position, never "80% of
  // the width", which drifted off the item edges), counted from where the previous click is heading, so quick repeated
  // clicks add up.
  //
  // Optional `more` = { hasMore(): bool, load(done) } for a list that arrives in batches (only New In): load(done) appends
  // the next batch to the track and calls done(true), or done(false) if it failed (hasMore() stays true, the next arrow
  // click tries again). While more remains the Next arrow is never disabled: the next batch is asked for when the guest
  // comes within NEAR_END cards of the last loaded one (scroll, swipe, arrow or arrow key), the arrow pulses while it
  // loads, and a click that has nowhere to go yet carries on by itself once the batch is in. Cards are only ever added
  // after the last one, so the scroll position and the whole-card stops do not move.
  var NEAR_END = 3;

  // The pure parts of the maths (no DOM), so test/unit/carouselMath.test.js can run them as they are.
  // The first card of the last page: pages hold `per` cards each, the last one may be short.
  function lastStartIndex(count, per) { return Math.floor((count - 1) / per) * per; }
  // Is the card at `index` (the first one in view, or the one a click is heading to) close enough to the last loaded card
  // that the next batch should be asked for?
  function wantsMoreAt(index, per, count) { return index + per + NEAR_END >= count; }

  function makeCarousel(track, prevBtn, nextBtn, itemSel, more) {
    var heading = null;   // index the track is scrolling to after a click (null = at rest)
    var headingTimer = 0;
    var loading = false;
    var pendingTarget = null; // a click wanted to go to this card index, which is not loaded yet

    function hasMore() { return !!(more && more.hasMore()); }
    function ensureMore() {
      if (loading || !hasMore()) return;
      loading = true;
      nextBtn.classList.add('is-loading');
      nextBtn.setAttribute('aria-busy', 'true');
      more.load(function (ok) {
        loading = false;
        nextBtn.classList.remove('is-loading');
        nextBtn.removeAttribute('aria-busy');
        layout();
        var want = pendingTarget;
        pendingTarget = null;
        if (ok && want != null) goTo(want);
      });
    }

    function cardList() { return Array.prototype.slice.call(track.querySelectorAll(itemSel)); }
    function padLeft() { return parseFloat(getComputedStyle(track).paddingLeft) || 0; }
    // where scrollLeft must be for card i to sit at the left edge
    function stopAt(cards, i) {
      return Math.max(0, cards[i].getBoundingClientRect().left - track.getBoundingClientRect().left + track.scrollLeft - padLeft());
    }
    function perView(cards) {
      var n = parseInt(getComputedStyle(cards[0]).getPropertyValue('--per'), 10);
      return n > 0 ? n : 1;
    }
    function lastStart(cards) { return lastStartIndex(cards.length, perView(cards)); }
    function nearest(cards) {
      var best = 0, bd = Infinity;
      for (var i = 0; i < cards.length; i++) {
        var d = Math.abs(stopAt(cards, i) - track.scrollLeft);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    // Leave room after the last card so the last page can start at the left edge (no half-cut card at the end).
    function layout() {
      var cards = cardList();
      if (!cards.length || !track.clientWidth) { prevBtn.disabled = nextBtn.disabled = true; return; }
      track.style.setProperty('--bk-end', '0px');
      var content = stopAt(cards, cards.length - 1) + cards[cards.length - 1].getBoundingClientRect().width + 2 * padLeft();
      var need = stopAt(cards, lastStart(cards)) + track.clientWidth;
      track.style.setProperty('--bk-end', Math.max(0, Math.ceil(need - content)) + 'px');
      updateArrows();
    }
    function updateArrows() {
      var cards = cardList();
      if (!cards.length) { prevBtn.disabled = nextBtn.disabled = true; return; }
      prevBtn.disabled = track.scrollLeft <= 1;
      // more batches to come: never "the end" (a pending batch or a failed one is retried by the next click)
      nextBtn.disabled = hasMore() ? false : track.scrollLeft >= stopAt(cards, lastStart(cards)) - 1;
      if (hasMore() && !loading && wantsMoreAt(nearest(cards), perView(cards), cards.length)) ensureMore();
    }
    function goTo(i, cards, instant) {
      cards = cards || cardList();
      i = Math.max(0, Math.min(i, lastStart(cards)));
      heading = i;
      clearTimeout(headingTimer);
      headingTimer = setTimeout(function () { heading = null; }, 700);
      track.scrollTo({ left: stopAt(cards, i), behavior: instant ? 'instant' : UmasUI.reducedMotion() ? 'auto' : 'smooth' });
    }
    function step(dir, count) {
      var cards = cardList();
      if (!cards.length) return;
      var from = heading != null ? heading : nearest(cards);
      var target = from + dir * (count || perView(cards));
      if (dir > 0 && hasMore()) {
        // the card to stop at may not be loaded yet: go as far as there is, ask for the next batch, finish when it is in
        if (target > lastStart(cards)) pendingTarget = Math.max(pendingTarget == null ? 0 : pendingTarget, target);
        if (wantsMoreAt(target, perView(cards), cards.length)) ensureMore();
      }
      goTo(target, cards);
    }
    // Bring item i into view (a selected genre on a direct load or Back): the page of items that holds it, no animation.
    function reveal(i) {
      var cards = cardList();
      if (!cards.length || !track.clientWidth || !cards[i]) return;
      layout();
      var per = perView(cards), first = nearest(cards);
      if (i >= first && i < first + per) return;
      goTo(Math.floor(i / per) * per, cards, true);
    }
    prevBtn.addEventListener('click', function () { step(-1); });
    nextBtn.addEventListener('click', function () { step(1); });
    track.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      step(e.key === 'ArrowRight' ? 1 : -1, 1);
    });
    var scrollTick = 0;
    track.addEventListener('scroll', function () {
      if (scrollTick) return;
      scrollTick = requestAnimationFrame(function () { scrollTick = 0; updateArrows(); });
    }, { passive: true });
    if (window.ResizeObserver) {
      var lastWidth = 0;
      new ResizeObserver(function () {
        // A resize or a browser zoom changes the card width: recompute the end room and sit on a card edge again.
        var w = track.clientWidth;
        if (!w || w === lastWidth) return;
        lastWidth = w;
        var cards = cardList();
        var at = cards.length ? nearest(cards) : 0;
        layout();
        if (cards.length) track.scrollTo({ left: stopAt(cards, Math.min(at, lastStart(cards))), behavior: 'auto' });
      }).observe(track);
    }
    window.addEventListener('resize', layout);
    return { layout: layout, reveal: reveal };
  }

  return { make: makeCarousel, lastStartIndex: lastStartIndex, wantsMoreAt: wantsMoreAt, NEAR_END: NEAR_END };
});
