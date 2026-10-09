// Work that must not delay an answer: run it after the response has gone, a few
// at a time, never let it throw. Used by the save of a book (lib/bookFill.js) so the
// scan page is ready for the next book while the cover, description and translation
// are still being fetched.
//
//   runAfterResponse("fill book 12", () => doSlowThing())
//   await settled()      // tests, and a clean shutdown: resolves when nothing is queued or running
//
// At most MAX_CONCURRENT jobs run at once and at most MAX_QUEUED wait; a job that
// does not fit is dropped with a log line (the cover is retried by the 5-minute
// cover job anyway; a missing description can be generated again from the book page).

const MAX_CONCURRENT = 3;
const MAX_QUEUED = 200;

const queue = [];
let running = 0;
let idleWaiters = [];

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running += 1;
    Promise.resolve()
      .then(job.fn)
      .catch((err) => console.warn(`After-response job "${job.label}" failed:`, err && err.message ? err.message : err))
      .finally(() => {
        running -= 1;
        pump();
        if (!running && !queue.length) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const w of waiters) w();
        }
      });
  }
}

function runAfterResponse(label, fn) {
  if (queue.length >= MAX_QUEUED) {
    console.warn(`After-response job "${label}" dropped: ${MAX_QUEUED} jobs already waiting.`);
    return false;
  }
  queue.push({ label, fn });
  // Next tick: the caller's response is written before the job starts.
  setImmediate(pump);
  return true;
}

function settled() {
  if (!running && !queue.length) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

module.exports = { runAfterResponse, settled, MAX_CONCURRENT, MAX_QUEUED };
