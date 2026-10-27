// Review F, F3: "N days later" for a deadline means N calendar days in PARIS, whatever time zone the database
// session is in. `timestamptz + make_interval(days => 7)` is evaluated in the session zone (UTC on Render), so a
// hold extended across a clock change ended an hour early or late in Paris wall time. lib/tz.js parisPlusDaysSql
// converts to Paris wall-clock time, adds the days there and converts back. These tests run the SAME statements
// under SET timezone = 'UTC' and 'Europe/Paris' (and 'America/New_York' for good measure) and across both 2026-27
// clock changes (2026-10-25 and 2027-03-28), and check the real extension path keeps the Paris time of day.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase } = require("../helpers/testDatabase");
const { makeOrder } = require("../helpers/orderFixtures");

const db = prepareDatabase("paris_days", { isolated: true });
const { pool } = require("../../src/db");
const { parisPlusDaysSql, parisInstant } = require("../../src/lib/tz");
const { extendReservation, RESERVATION_EXTENSION_DAYS } = require("../../src/lib/reservations");

before(() => { db.create(); });
after(async () => { await pool.end(); db.drop(); });

const ZONES = ["UTC", "Europe/Paris", "America/New_York"];

async function plusDays(zone, instantIso, days) {
  const client = await pool.connect();
  try {
    await client.query(`SET timezone = '${zone}'`);
    const { rows } = await client.query(`SELECT ${parisPlusDaysSql("$1::timestamptz", "$2::int")} AS t`, [instantIso, days]);
    return rows[0].t;
  } finally {
    client.release();
  }
}

// [Paris start-of-day, days, expected Paris start-of-day]
const CASES = [
  ["2026-10-23", 7, "2026-10-30"],   // across the autumn change (2026-10-25): the review's example, 00:00 stays 00:00
  ["2026-10-20", 14, "2026-11-03"],
  ["2027-03-25", 7, "2027-04-01"],   // across the spring change (2027-03-28)
  ["2027-03-20", 14, "2027-04-03"],
  ["2027-04-01", -7, "2027-03-25"],  // subtracting across the change
  ["2026-11-03", -14, "2026-10-20"],
  ["2026-06-01", 7, "2026-06-08"],   // no change in between
];

for (const zone of ZONES) {
  for (const [from, days, to] of CASES) {
    test(`session zone ${zone}: ${from} ${days > 0 ? "+" : ""}${days} days = ${to} (Paris 00:00)`, async () => {
      const got = await plusDays(zone, parisInstant(from).toISOString(), days);
      assert.equal(got.toISOString(), parisInstant(to).toISOString());
    });
  }
}

test("the review's example: 2026-10-23 00:00 Paris + 7 days is 2026-10-30 00:00 Paris (the old SQL gave 2026-10-29 23:00)", async () => {
  const client = await pool.connect();
  try {
    await client.query("SET timezone = 'UTC'");
    const old = (await client.query("SELECT ($1::timestamptz + make_interval(days => 7)) AS t", [parisInstant("2026-10-23").toISOString()])).rows[0].t;
    assert.equal(old.toISOString(), "2026-10-29T22:00:00.000Z", "(the plain interval ends at Paris 2026-10-29 23:00)");
    assert.notEqual(old.toISOString(), parisInstant("2026-10-30").toISOString());
  } finally {
    client.release();
  }
  assert.equal((await plusDays("UTC", parisInstant("2026-10-23").toISOString(), 7)).toISOString(), parisInstant("2026-10-30").toISOString());
});

test("the app's pool pins its session zone to UTC (src/db.js), so nothing depends on the machine's setting", async () => {
  const { rows } = await pool.query("SHOW timezone");
  assert.equal(rows[0].TimeZone, "UTC");
});

test("extendReservation keeps the Paris time of day (midnight) and the 7-day length in Paris days", async () => {
  // A reservation whose deadline is the Paris midnight 3 days ahead, as /cart/reserve sets it.
  const { order } = await makeOrder(pool, { status: "reserved", books: 1 });
  await pool.query(
    `UPDATE orders SET reserved_until = (((now() AT TIME ZONE 'Europe/Paris')::date + 3)::timestamp AT TIME ZONE 'Europe/Paris') WHERE id = $1`, [order.id]);
  const [before] = (await pool.query("SELECT reserved_until FROM orders WHERE id = $1", [order.id])).rows;
  const r = await extendReservation(pool, order.id);
  assert.equal(r.outcome, "extended");
  const { rows } = await pool.query(
    `SELECT (reserved_until AT TIME ZONE 'Europe/Paris')::time::text AS t,
            ((reserved_until AT TIME ZONE 'Europe/Paris')::date - ($2::timestamptz AT TIME ZONE 'Europe/Paris')::date) AS days
     FROM orders WHERE id = $1`, [order.id, before.reserved_until]);
  assert.equal(rows[0].t, "00:00:00");
  assert.equal(Number(rows[0].days), RESERVATION_EXTENSION_DAYS);
});

test("an already-lapsed deadline is extended from now, in Paris days", async () => {
  const { order } = await makeOrder(pool, { status: "reserved", books: 1, reservedDays: -2 });
  const r = await extendReservation(pool, order.id);
  assert.equal(r.outcome, "extended");
  const { rows } = await pool.query(
    `SELECT ((reserved_until AT TIME ZONE 'Europe/Paris')::date - (now() AT TIME ZONE 'Europe/Paris')::date) AS days FROM orders WHERE id = $1`, [order.id]);
  assert.equal(Number(rows[0].days), RESERVATION_EXTENSION_DAYS);
});

// The next Paris clock change after today, found from the zone rules (so this test never goes stale):
// the first date whose Paris midnight has a different UTC offset than the day before.
function nextClockChangeDay() {
  const offsetMin = (ymd) => {
    const inst = parisInstant(ymd);
    const asParis = new Date(inst.toLocaleString("en-US", { timeZone: "Europe/Paris" }));
    return Math.round((asParis - new Date(inst.toLocaleString("en-US", { timeZone: "UTC" }))) / 60000);
  };
  const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
  for (let n = 5; n < 400; n++) {
    if (offsetMin(day(n)) !== offsetMin(day(n - 1))) return day(n);
  }
  throw new Error("no clock change found");
}
const addDays = (ymd, n) => new Date(Date.UTC(...ymd.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), 0) + n * 86400000).toISOString().slice(0, 10);

test("extendReservation across the NEXT clock change: the hold still ends at Paris midnight (the old SQL ended an hour off)", async () => {
  const change = nextClockChangeDay();
  const start = addDays(change, -3); // a Paris-midnight deadline 3 days before the change; +7 days crosses it
  const { order } = await makeOrder(pool, { status: "reserved", books: 1 });
  await pool.query("UPDATE orders SET reserved_until = $2 WHERE id = $1", [order.id, parisInstant(start).toISOString()]);
  const r = await extendReservation(pool, order.id);
  assert.equal(r.outcome, "extended");
  const [row] = (await pool.query("SELECT reserved_until FROM orders WHERE id = $1", [order.id])).rows;
  assert.equal(row.reserved_until.toISOString(), parisInstant(addDays(start, RESERVATION_EXTENSION_DAYS)).toISOString(), `from ${start} across the change on ${change}`);
});
