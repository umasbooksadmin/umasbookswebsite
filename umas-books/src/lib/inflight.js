// "One at a time per key": concurrent callers that ask for the same thing (the same ISBN, the same prompt) share ONE
// running promise instead of each making the outside call. The entry is removed in `finally`, so a failure or a
// result is never kept (this is not a cache). Bounded: when `max` keys are already running, a new key simply runs on
// its own without being shared (nothing is refused, nothing grows).
function createInflight(max = 500) {
  const running = new Map();
  function run(key, fn) {
    const existing = running.get(key);
    if (existing) return existing;
    if (running.size >= max) return Promise.resolve().then(fn);
    const p = Promise.resolve().then(fn).finally(() => { if (running.get(key) === p) running.delete(key); });
    running.set(key, p);
    return p;
  }
  return { run, get size() { return running.size; } };
}

module.exports = { createInflight };
