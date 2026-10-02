// Wraps a periodic job so a slow run is never overlapped by the next tick:
// while one run is in flight, later ticks are skipped (one log line each)
// instead of stacking more work on a database/API that is already slow.
function guardJob(name, job) {
  let running = false;
  return async function guarded() {
    if (running) {
      console.warn(`${name}: previous run still in progress - skipping this tick.`);
      return;
    }
    running = true;
    try {
      await job();
    } catch (err) {
      console.error(`${name} failed:`, err);
    } finally {
      running = false;
    }
  };
}

module.exports = { guardJob };
