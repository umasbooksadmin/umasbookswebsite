// Benchmark (NOT part of CI): does a burst of failed logins starve unrelated
// requests? Boots the real app on a throwaway database, fires 12 parallel
// failed logins and, meanwhile, polls GET /api/books/new-in every 20 ms.
// Prints that endpoint's latency (idle baseline vs. during the burst).
//
//   PORT=4790 node scripts/bench-login-cpu.js
//
// Needs a local Postgres (createdb) or DATABASE_URL like the integration tests.
// Exits 1 if the during-burst p95 is 50 ms or more.
const { startTestApp } = require("../test/helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../test/helpers/httpClient");

const PARALLEL = 12;
const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

async function timed(url) {
  const t = performance.now();
  const res = await fetch(url);
  await res.arrayBuffer();
  return performance.now() - t;
}

async function failedLogin(base, i) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(base, jar);
  const t = performance.now();
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=nobody${i}%40example.com&password=Wrong-Password-1&_csrf=${token}`,
  });
  await res.arrayBuffer();
  return { status: res.status, ms: performance.now() - t };
}

(async () => {
  const port = Number(process.env.PORT) || 4790;
  const app = await startTestApp({ port });
  try {
    const probe = `${app.base}/api/books/new-in`;
    await timed(probe); // warm up
    const idle = [];
    for (let i = 0; i < 30; i++) { idle.push(await timed(probe)); await new Promise((r) => setTimeout(r, 20)); }

    // Fetch the CSRF tokens first so the burst measures only the login work.
    let stop = false;
    const during = [];
    const poller = (async () => {
      while (!stop) { during.push(await timed(probe)); await new Promise((r) => setTimeout(r, 20)); }
    })();
    const t0 = performance.now();
    const logins = await Promise.all(Array.from({ length: PARALLEL }, (_, i) => failedLogin(app.base, i)));
    const burstMs = performance.now() - t0;
    stop = true;
    await poller;

    const f = (n) => n.toFixed(1);
    console.log(`idle    /api/books/new-in: n=${idle.length} p50=${f(pct(idle, 0.5))} p95=${f(pct(idle, 0.95))} max=${f(Math.max(...idle))} ms`);
    console.log(`burst   /api/books/new-in: n=${during.length} p50=${f(pct(during, 0.5))} p95=${f(pct(during, 0.95))} max=${f(Math.max(...during))} ms`);
    console.log(`${PARALLEL} failed logins: all done in ${f(burstMs)} ms, statuses ${[...new Set(logins.map((l) => l.status))].join(",")}, slowest ${f(Math.max(...logins.map((l) => l.ms)))} ms`);
    process.exitCode = pct(during, 0.95) < 50 ? 0 : 1;
  } finally {
    await app.stop();
  }
})().catch((err) => { console.error(err); process.exit(1); });
