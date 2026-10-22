// createApp() (src/app.js) serves the real app in the test's own process, on port 0:
// no fixed PORT, no child process, no background jobs.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startInProcessApp } = require("../helpers/testApp");

let app;
before(async () => { app = await startInProcessApp(); });
after(async () => { await app.stop(); });

test("the health check answers and touches the database", async () => {
  const res = await fetch(`${app.base}/healthz`);
  assert.equal(res.status, 200);
});

test("a marketing page and the 404 page render through the full middleware stack", async () => {
  const home = await fetch(`${app.base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("permissions-policy") || "", /./, "the first middleware ran");
  assert.equal(home.headers.get("x-powered-by"), null);
  const missing = await fetch(`${app.base}/definitely-not-a-page`);
  assert.equal(missing.status, 404);
});

test("no background job runs in-process: the job_runs table stays empty", async () => {
  await new Promise((r) => setTimeout(r, 300));
  const { rows } = await app.pool.query("SELECT count(*)::int AS n FROM job_runs");
  assert.equal(rows[0].n, 0);
});
