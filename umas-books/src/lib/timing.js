// Lightweight per-request step timing for the Add-a-book path (lookup and save).
//
//   router.get(path, serverTiming("scan.lookup"), handler)
//   const x = await req.timing.time("lookup", () => lookupByIsbn(isbn));
//
// What it does: sums the time spent in each named step, answers it in a
// Server-Timing response header (browser dev tools show it under Network >
// Timing; durations only, nothing personal, admin-only routes) and logs one line
// when the whole request was slow (SCAN_SLOW_LOG_MS, default 1500 ms; 0 = log
// every request, "off" = never). Nothing here can fail a request.

const DEFAULT_SLOW_MS = 1500;

function slowThreshold(env = process.env) {
  const raw = env.SCAN_SLOW_LOG_MS;
  if (raw === undefined || raw === "") return DEFAULT_SLOW_MS;
  if (String(raw).toLowerCase() === "off") return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SLOW_MS;
}

function createTimings(now = () => performance.now()) {
  const steps = new Map();
  const add = (name, ms) => steps.set(name, (steps.get(name) || 0) + ms);
  return {
    add,
    async time(name, fn) {
      const t0 = now();
      try {
        return await fn();
      } finally {
        add(name, now() - t0);
      }
    },
    steps: () => new Map(steps),
    header(totalMs) {
      const parts = [];
      for (const [name, ms] of steps) parts.push(`${name};dur=${ms.toFixed(1)}`);
      if (totalMs !== undefined) parts.push(`total;dur=${totalMs.toFixed(1)}`);
      return parts.join(", ");
    },
  };
}

function serverTiming(label, { log = console.warn, env = process.env } = {}) {
  return function (req, res, next) {
    const started = performance.now();
    const timing = createTimings();
    req.timing = timing;
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (!res.headersSent) {
        try { res.setHeader("Server-Timing", timing.header(performance.now() - started)); } catch { /* never fail a request over timing */ }
      }
      return writeHead.apply(this, args);
    };
    res.on("finish", () => {
      const total = performance.now() - started;
      if (total >= slowThreshold(env)) log(`[slow ${label}] ${total.toFixed(0)} ms (${timing.header()})`);
    });
    next();
  };
}

// For code that may run without a request (tests, background work): a no-op timer.
const noTiming = { time: (name, fn) => fn(), add() {} };

module.exports = { serverTiming, createTimings, noTiming, slowThreshold };
