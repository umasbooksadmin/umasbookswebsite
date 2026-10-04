// Admin calendar-style content screens against the REAL routers + views
// (in-process): events, sessions (classes), meetings, volunteer shifts, and
// the dashboard/orders pages. For each: the list renders for an admin
// (month and week views), create (valid, and missing/invalid fields write
// nothing), update, delete, signup/RSVP deletion where the screen has it,
// escaping of a <script> title, and one authorization refusal for a
// non-admin member.
//
// Dates are fixed mid-month, mid-day values so the assertions hold in any
// server timezone: only titles, counts, statuses and redirects are checked,
// never a stored instant.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("admincal", ["dashboard", "events", "sessions", "meetings", "volunteerShifts"], { isolated: true });
before(h.start);
after(h.stop);

const MONTH = "2031-05";
const DAY = "2031-05-14";
const location = (r) => r.res.headers.get("location");

async function countWhere(table, col, value) {
  return Number((await h.q(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = $1`, [value]))[0].n);
}

// ---------- authorization ----------

test("a non-admin member is refused (403) and an anonymous visitor is sent to /login on every calendar screen", async () => {
  const title = `Blocked ${h.uniq()}`;
  const screens = [
    ["/admin/events", { title, date: DAY, startTime: "12:00" }, "events", "title"],
    ["/admin/sessions", { title, date: DAY, startTime: "12:00" }, "classes", "title"],
    ["/admin/meetings", { title, date: DAY, time: "12:00" }, "meetings", "title"],
    ["/admin/volunteer-shifts", { role: title, date: DAY, startTime: "12:00", endTime: "13:00" }, "volunteer_shifts", "role"],
  ];
  for (const [path, fields, table, col] of screens) {
    const get = await h.get(path, h.member);
    assert.equal(get.res.status, 403, `GET ${path} as member`);
    const post = await h.post(path, fields, { user: h.member });
    assert.equal(post.res.status, 403, `POST ${path} as member`);
    assert.equal(await countWhere(table, col, title), 0, `${path} wrote nothing for a member`);

    const anon = await h.get(path, null);
    assert.equal(anon.res.status, 302);
    assert.equal(location(anon), "/login");
  }
  assert.equal((await h.get("/admin", h.member)).res.status, 403);
  assert.equal((await h.get("/admin/orders", h.member)).res.status, 403);
});

// ---------- events ----------

test("events: month and week views render; create, update, delete round-trip with the calendar view preserved", async () => {
  const title = `Event ${h.uniq()}`;

  const create = await h.post("/admin/events", {
    title: `  ${title}  `, date: DAY, startTime: "12:00", endTime: "13:30",
    description: "  A reading  ", location: "Back room", capacity: "12", price: "7.5", month: MONTH,
  });
  assert.equal(create.res.status, 302);
  assert.equal(location(create), `/admin/events?month=${MONTH}`);

  const [row] = await h.q("SELECT * FROM events WHERE title = $1", [title]);
  assert.ok(row, "event inserted with the trimmed title");
  assert.equal(row.description, "A reading");
  assert.equal(row.location, "Back room");
  assert.equal(row.capacity, 12);
  assert.equal(Number(row.price), 7.5);
  assert.ok(row.ends_at, "end time stored");

  const month = await h.get(`/admin/events?month=${MONTH}`);
  assert.equal(month.res.status, 200);
  assert.ok(month.text.includes(title), "event shown on its month");
  assert.ok(month.text.includes("May 2031"));

  const week = await h.get(`/admin/events?view=week&week=${DAY}`);
  assert.equal(week.res.status, 200);
  assert.ok(week.text.includes(title), "event shown in its week");

  const otherMonth = await h.get("/admin/events?month=2031-06");
  assert.ok(!otherMonth.text.includes(title), "event not shown in another month");

  const update = await h.post(`/admin/events/${row.id}?view=week&week=${DAY}`, {
    title: `${title} v2`, startsAt: "2031-05-15T10:00", location: "", capacity: "", price: "",
  });
  assert.equal(location(update), `/admin/events?view=week&week=${DAY}`);
  const [after] = await h.q("SELECT * FROM events WHERE id = $1", [row.id]);
  assert.equal(after.title, `${title} v2`);
  assert.equal(after.location, null, "blank optional fields clear");
  assert.equal(after.capacity, null);
  assert.equal(after.price, null);
  assert.equal(after.ends_at, null);
  assert.notEqual(after.starts_at.getTime(), row.starts_at.getTime(), "start moved");

  const del = await h.post(`/admin/events/${row.id}/delete?month=${MONTH}`);
  assert.equal(location(del), `/admin/events?month=${MONTH}`);
  assert.equal((await h.q("SELECT 1 FROM events WHERE id = $1", [row.id])).length, 0);
});

test("events: missing title, date or start time (and a blank title on update) write nothing", async () => {
  const u = h.uniq();
  for (const fields of [
    { title: "", date: DAY, startTime: "12:00" },
    { title: `NoDate ${u}`, startTime: "12:00" },
    { title: `NoTime ${u}`, date: DAY },
    { title: `   `, date: DAY, startTime: "12:00" },
  ]) {
    const r = await h.post("/admin/events", fields);
    assert.equal(r.res.status, 302);
    assert.equal(location(r), "/admin/events");
  }
  assert.equal((await h.q("SELECT 1 FROM events WHERE title LIKE $1", [`%${u}`])).length, 0);

  const title = `Keep ${u}`;
  const [{ id }] = await h.q(
    "INSERT INTO events (title, starts_at) VALUES ($1, '2031-05-14T12:00:00Z') RETURNING id", [title]
  );
  await h.post(`/admin/events/${id}`, { title: "", startsAt: "2031-05-15T10:00" });
  await h.post(`/admin/events/${id}`, { title: "Renamed", startsAt: "" });
  assert.equal((await h.q("SELECT title FROM events WHERE id = $1", [id]))[0].title, title);
});

test("events: a <script> title is escaped in the rendered calendar", async () => {
  const marker = `xss${Date.now()}`;
  const title = `<script>alert('${marker}')</script>`;
  await h.post("/admin/events", { title, date: DAY, startTime: "09:00" });
  const { text } = await h.get(`/admin/events?month=${MONTH}`);
  assert.ok(!text.includes(`<script>alert('${marker}')`), "raw script tag must not appear");
  assert.ok(text.includes(`&lt;script&gt;alert(&#39;${marker}&#39;)&lt;/script&gt;`));
  await h.q("DELETE FROM events WHERE title = $1", [title]);
});

test("events: deleting a signup removes only that signup of that event; the page lists signups", async () => {
  const u = h.uniq();
  const [{ id: e1 }] = await h.q("INSERT INTO events (title, starts_at, capacity) VALUES ($1, '2031-05-20T12:00:00Z', 5) RETURNING id", [`Signups ${u}`]);
  const [{ id: e2 }] = await h.q("INSERT INTO events (title, starts_at) VALUES ($1, '2031-05-20T12:00:00Z') RETURNING id", [`Other ${u}`]);
  const [{ id: s1 }] = await h.q("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'Ann', $2) RETURNING id", [e1, `ann-${u}@example.test`]);
  const [{ id: s2 }] = await h.q("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'Bob', $2) RETURNING id", [e1, `bob-${u}@example.test`]);

  const page = await h.get(`/admin/events?month=${MONTH}`);
  assert.ok(page.text.includes(`ann-${u}@example.test`));
  assert.ok(page.text.includes("2/5 signed up"));

  // Wrong event id in the URL: signup must survive.
  await h.post(`/admin/events/${e2}/signups/${s1}/delete`);
  assert.equal((await h.q("SELECT 1 FROM event_signups WHERE id = $1", [s1])).length, 1);

  const r = await h.post(`/admin/events/${e1}/signups/${s1}/delete?month=${MONTH}`);
  assert.equal(location(r), `/admin/events?month=${MONTH}`);
  assert.equal((await h.q("SELECT 1 FROM event_signups WHERE id = $1", [s1])).length, 0);
  assert.equal((await h.q("SELECT 1 FROM event_signups WHERE id = $1", [s2])).length, 1);

  // Deleting the event cascades its remaining signups away.
  await h.post(`/admin/events/${e1}/delete`);
  assert.equal((await h.q("SELECT 1 FROM event_signups WHERE id = $1", [s2])).length, 0);
  await h.post(`/admin/events/${e2}/delete`);
});

test("events: garbage ids get the 404 page, not a 500", async () => {
  assert.equal((await h.post("/admin/events/abc/delete")).res.status, 404);
  assert.equal((await h.post("/admin/events/1/signups/zzz/delete")).res.status, 404);
});

// ---------- sessions (classes) ----------

test("sessions: create with defaults and program type, week/month render, update, delete", async () => {
  const title = `Class ${h.uniq()}`;
  const create = await h.post("/admin/sessions", {
    title, date: DAY, startTime: "15:00", programType: "Young Readers", dropinPrice: "9", month: MONTH,
  });
  assert.equal(location(create), `/admin/sessions?month=${MONTH}`);
  const [row] = await h.q("SELECT * FROM classes WHERE title = $1", [title]);
  assert.ok(row);
  assert.equal(row.capacity, 5, "capacity defaults to 5 when blank");
  assert.equal(row.program_type, "Young Readers");
  assert.equal(Number(row.dropin_price), 9);
  assert.equal(row.created_by, h.admin.id);

  const month = await h.get(`/admin/sessions?month=${MONTH}`);
  assert.equal(month.res.status, 200);
  assert.ok(month.text.includes(title));
  assert.ok(month.text.includes("drop-in €9.00"));
  const week = await h.get(`/admin/sessions?view=week&week=${DAY}`);
  assert.equal(week.res.status, 200);
  assert.ok(week.text.includes(title));

  const update = await h.post(`/admin/sessions/${row.id}`, {
    title: `${title} v2`, startsAt: "2031-05-16T16:00", capacity: "8", programType: "Not A Program", dropinPrice: "",
  });
  assert.equal(location(update), "/admin/sessions");
  const [after] = await h.q("SELECT * FROM classes WHERE id = $1", [row.id]);
  assert.equal(after.title, `${title} v2`);
  assert.equal(after.capacity, 8);
  assert.equal(after.program_type, null, "unknown program type is dropped");
  assert.equal(after.dropin_price, null);

  const del = await h.post(`/admin/sessions/${row.id}/delete?view=week&week=${DAY}`);
  assert.equal(location(del), `/admin/sessions?view=week&week=${DAY}`);
  assert.equal((await h.q("SELECT 1 FROM classes WHERE id = $1", [row.id])).length, 0);
});

test("sessions: invalid input writes nothing; an unknown program type on create is stored as NULL", async () => {
  const u = h.uniq();
  for (const fields of [
    { title: "", date: DAY, startTime: "15:00" },
    { title: `NoDate ${u}`, startTime: "15:00" },
    { title: `NoTime ${u}`, date: DAY },
  ]) {
    assert.equal((await h.post("/admin/sessions", fields)).res.status, 302);
  }
  assert.equal((await h.q("SELECT 1 FROM classes WHERE title LIKE $1", [`%${u}`])).length, 0);

  const title = `Typeless ${u}`;
  await h.post("/admin/sessions", { title, date: DAY, startTime: "15:00", programType: "Bogus" });
  assert.equal((await h.q("SELECT program_type FROM classes WHERE title = $1", [title]))[0].program_type, null);

  const [{ id }] = await h.q("SELECT id FROM classes WHERE title = $1", [title]);
  await h.post(`/admin/sessions/${id}`, { title: "", startsAt: "2031-05-16T16:00" });
  assert.equal((await h.q("SELECT title FROM classes WHERE id = $1", [id]))[0].title, title);
  await h.post(`/admin/sessions/${id}/delete`);
});

test("sessions: signups and sold drop-in seats are listed, signup deletion is scoped to its class, <script> title is escaped", async () => {
  const u = h.uniq();
  const marker = `cls${Date.now()}`;
  const title = `<script>alert('${marker}')</script> ${u}`;
  const [{ id: c1 }] = await h.q("INSERT INTO classes (title, starts_at, capacity) VALUES ($1, '2031-05-21T12:00:00Z', 4) RETURNING id", [title]);
  const [{ id: c2 }] = await h.q("INSERT INTO classes (title, starts_at, capacity) VALUES ($1, '2031-05-21T12:00:00Z', 4) RETURNING id", [`Other ${u}`]);
  const [{ id: s1 }] = await h.q("INSERT INTO class_signups (class_id, name, email) VALUES ($1, 'Cat', $2) RETURNING id", [c1, `cat-${u}@example.test`]);
  const [{ id: order }] = await h.q(
    "INSERT INTO orders (buyer_name, buyer_email, status, total_amount) VALUES ('Dropin Buyer', $1, 'paid', 9) RETURNING id", [`dropin-${u}@example.test`]
  );
  await h.q("INSERT INTO class_dropin_seats (class_id, status, order_id) VALUES ($1, 'sold', $2)", [c1, order]);

  const page = await h.get(`/admin/sessions?month=${MONTH}`);
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes(`cat-${u}@example.test`), "signup listed");
  assert.ok(page.text.includes(`dropin-${u}@example.test`), "sold drop-in buyer listed");
  assert.ok(page.text.includes("2/4"), "signup + drop-in seat both count against capacity");
  assert.ok(!page.text.includes(`<script>alert('${marker}')`), "raw script tag must not appear");
  assert.ok(page.text.includes(`&lt;script&gt;alert(&#39;${marker}&#39;)&lt;/script&gt;`));

  await h.post(`/admin/sessions/${c2}/signups/${s1}/delete`);
  assert.equal((await h.q("SELECT 1 FROM class_signups WHERE id = $1", [s1])).length, 1, "wrong class id leaves the signup");
  const r = await h.post(`/admin/sessions/${c1}/signups/${s1}/delete?month=${MONTH}`);
  assert.equal(location(r), `/admin/sessions?month=${MONTH}`);
  assert.equal((await h.q("SELECT 1 FROM class_signups WHERE id = $1", [s1])).length, 0);

  await h.post(`/admin/sessions/${c1}/delete`);
  await h.post(`/admin/sessions/${c2}/delete`);
  assert.equal((await h.q("SELECT 1 FROM class_dropin_seats WHERE class_id = $1", [c1])).length, 0, "drop-in seats cascade with the class");
  await h.q("DELETE FROM orders WHERE id = $1", [order]);
});

// ---------- meetings ----------

test("meetings: create, render (month/week), save minutes, delete (RSVPs cascade)", async () => {
  const title = `Meeting ${h.uniq()}`;
  const create = await h.post("/admin/meetings", {
    title, date: DAY, time: "18:00", location: "Shop", agenda: "  Budget  ", month: MONTH,
  });
  assert.equal(location(create), `/admin/meetings?month=${MONTH}`);
  const [row] = await h.q("SELECT * FROM meetings WHERE title = $1", [title]);
  assert.ok(row);
  assert.equal(row.agenda, "Budget");
  assert.equal(row.created_by, h.admin.id);

  await h.q("INSERT INTO meeting_rsvps (meeting_id, user_id) VALUES ($1, $2)", [row.id, h.member.id]);
  const month = await h.get(`/admin/meetings?month=${MONTH}`);
  assert.equal(month.res.status, 200);
  assert.ok(month.text.includes(title));
  const week = await h.get(`/admin/meetings?view=week&week=${DAY}`);
  assert.equal(week.res.status, 200);
  assert.ok(week.text.includes(title));

  const minutes = await h.post(`/admin/meetings/${row.id}/minutes?month=${MONTH}`, { minutes: "  We agreed.  " });
  assert.equal(location(minutes), `/admin/meetings?month=${MONTH}`);
  assert.equal((await h.q("SELECT minutes FROM meetings WHERE id = $1", [row.id]))[0].minutes, "We agreed.");
  await h.post(`/admin/meetings/${row.id}/minutes`, { minutes: "   " });
  assert.equal((await h.q("SELECT minutes FROM meetings WHERE id = $1", [row.id]))[0].minutes, null, "blank minutes clear the field");

  const del = await h.post(`/admin/meetings/${row.id}/delete`);
  assert.equal(location(del), "/admin/meetings");
  assert.equal((await h.q("SELECT 1 FROM meetings WHERE id = $1", [row.id])).length, 0);
  assert.equal((await h.q("SELECT 1 FROM meeting_rsvps WHERE meeting_id = $1", [row.id])).length, 0, "RSVPs cascade");
});

test("meetings: missing title/date/time writes nothing; a <script> title is escaped", async () => {
  const u = h.uniq();
  for (const fields of [
    { title: "", date: DAY, time: "18:00" },
    { title: `NoDate ${u}`, time: "18:00" },
    { title: `NoTime ${u}`, date: DAY },
  ]) {
    assert.equal((await h.post("/admin/meetings", fields)).res.status, 302);
  }
  assert.equal((await h.q("SELECT 1 FROM meetings WHERE title LIKE $1", [`%${u}`])).length, 0);

  const marker = `mtg${Date.now()}`;
  const title = `<script>alert('${marker}')</script>`;
  await h.post("/admin/meetings", { title, date: DAY, time: "18:00" });
  const { text } = await h.get(`/admin/meetings?month=${MONTH}`);
  assert.ok(!text.includes(`<script>alert('${marker}')`));
  assert.ok(text.includes(`&lt;script&gt;alert(&#39;${marker}&#39;)&lt;/script&gt;`));
  await h.q("DELETE FROM meetings WHERE title = $1", [title]);
});

// ---------- volunteer shifts ----------

test("volunteer shifts: create, repeat weekly (clamped), render, delete (signups cascade)", async () => {
  const role = `Shelver ${h.uniq()}`;
  const create = await h.post("/admin/volunteer-shifts", {
    role, date: DAY, startTime: "10:00", endTime: "12:00", notes: "  Bring tea  ", repeatWeeks: "3", month: MONTH,
  });
  assert.equal(location(create), `/admin/volunteer-shifts?month=${MONTH}`);
  const rows = await h.q("SELECT * FROM volunteer_shifts WHERE role = $1 ORDER BY starts_at", [role]);
  assert.equal(rows.length, 3, "one shift per repeat week");
  assert.equal(rows[0].notes, "Bring tea");
  assert.equal(rows[0].capacity, 1);
  assert.equal(rows[0].created_by, h.admin.id);
  const weekMs = 7 * 24 * 3600 * 1000;
  assert.equal(rows[1].starts_at - rows[0].starts_at, weekMs);
  assert.equal(rows[2].starts_at - rows[1].starts_at, weekMs);
  assert.equal(rows[0].ends_at - rows[0].starts_at, 2 * 3600 * 1000, "duration preserved");

  await h.q("INSERT INTO volunteer_signups (shift_id, user_id) VALUES ($1, $2)", [rows[0].id, h.member.id]);
  const month = await h.get(`/admin/volunteer-shifts?month=${MONTH}`);
  assert.equal(month.res.status, 200);
  assert.ok(month.text.includes(role));
  const week = await h.get(`/admin/volunteer-shifts?view=week&week=${DAY}`);
  assert.equal(week.res.status, 200);
  assert.ok(week.text.includes(role));

  const del = await h.post(`/admin/volunteer-shifts/${rows[0].id}/delete?view=week&week=${DAY}`);
  assert.equal(location(del), `/admin/volunteer-shifts?view=week&week=${DAY}`);
  assert.equal((await h.q("SELECT 1 FROM volunteer_shifts WHERE id = $1", [rows[0].id])).length, 0);
  assert.equal((await h.q("SELECT 1 FROM volunteer_signups WHERE shift_id = $1", [rows[0].id])).length, 0);
  assert.equal(await countWhere("volunteer_shifts", "role", role), 2, "other repeats untouched");
  await h.q("DELETE FROM volunteer_shifts WHERE role = $1", [role]);
});

test("volunteer shifts: repeatWeeks is clamped to 1..52 and garbage means one shift", async () => {
  const u = h.uniq();
  const cases = [["99", 52], ["0", 1], ["-4", 1], ["abc", 1], ["", 1]];
  for (const [repeatWeeks, expected] of cases) {
    const role = `Clamp ${repeatWeeks} ${u}`;
    await h.post("/admin/volunteer-shifts", { role, date: DAY, startTime: "10:00", endTime: "11:00", repeatWeeks });
    assert.equal(await countWhere("volunteer_shifts", "role", role), expected, `repeatWeeks=${JSON.stringify(repeatWeeks)}`);
  }
  await h.q("DELETE FROM volunteer_shifts WHERE role LIKE $1", [`Clamp % ${u}`]);
});

test("volunteer shifts: missing role/date/times writes nothing; a <script> role is escaped", async () => {
  const u = h.uniq();
  for (const fields of [
    { role: "", date: DAY, startTime: "10:00", endTime: "11:00" },
    { role: `NoDate ${u}`, startTime: "10:00", endTime: "11:00" },
    { role: `NoStart ${u}`, date: DAY, endTime: "11:00" },
    { role: `NoEnd ${u}`, date: DAY, startTime: "10:00" },
  ]) {
    assert.equal((await h.post("/admin/volunteer-shifts", fields)).res.status, 302);
  }
  assert.equal((await h.q("SELECT 1 FROM volunteer_shifts WHERE role LIKE $1", [`%${u}`])).length, 0);

  const marker = `vol${Date.now()}`;
  const role = `<script>alert('${marker}')</script>`;
  await h.post("/admin/volunteer-shifts", { role, date: DAY, startTime: "10:00", endTime: "11:00" });
  const { text } = await h.get(`/admin/volunteer-shifts?month=${MONTH}`);
  assert.ok(!text.includes(`<script>alert('${marker}')`));
  assert.ok(text.includes(`&lt;script&gt;alert(&#39;${marker}&#39;)&lt;/script&gt;`));
  await h.q("DELETE FROM volunteer_shifts WHERE role = $1", [role]);
});

// ---------- dashboard ----------

const lastMonthSales = async () => Number((await h.q(
  `SELECT COALESCE(SUM(total_amount), 0) AS s FROM orders WHERE status = 'paid'
     AND created_at >= date_trunc('month', now() - interval '1 month') AND created_at < date_trunc('month', now())`
))[0].s);

test("dashboard: /admin renders the welcome heading, stat tiles and links to every admin screen", async () => {
  const { res, text } = await h.get("/admin");
  assert.equal(res.status, 200);
  assert.ok(text.includes("Welcome back, Admin Tester"));
  for (const label of ["Orders Today", "Total Sales", "In-Stock Books", "Total Accounts", "Members"]) {
    assert.ok(text.includes(label), label);
  }
  for (const href of ["/admin/sessions", "/admin/events", "/admin/volunteer-shifts", "/admin/meetings", "/admin/announcements", "/admin/charity"]) {
    assert.ok(text.includes(`href="${href}"`), href);
  }
  // Two real accounts were created by this file, so the account tiles are non-zero.
  const m = text.match(/Total Accounts<\/div>\s*<div class="value">(\d+)</);
  assert.ok(m && Number(m[1]) >= 2);
});

// BUG: pg returns NUMERIC sums as strings, so `!prev` in views/admin/index.ejs's
// pct() is false for "0.00" and the Total Sales tile shows "NaN%" whenever last
// month had no paid sales (a new shop's first month, or any quiet month).
test("dashboard: Total Sales trend never shows NaN% when last month had no sales", {
  todo: "views/admin/index.ejs pct(): salesLastMonth is the string '0.00' (NUMERIC), so !prev is false and (now-prev)/prev = NaN -> renders 'NaN%'",
}, async (t) => {
  if ((await lastMonthSales()) !== 0) return t.skip("another run left paid orders last month");
  const { text } = await h.get("/admin");
  assert.ok(!text.includes("NaN"), "no NaN anywhere on the dashboard");
});

test("dashboard: with last-month paid sales the Total Sales tile shows a real percentage trend", async () => {
  const [{ id }] = await h.q(
    `INSERT INTO orders (buyer_name, buyer_email, status, total_amount, created_at)
     VALUES ('Trend Buyer', 'trend@example.test', 'paid', 40, date_trunc('month', now()) - interval '3 days') RETURNING id`
  );
  try {
    const { text } = await h.get("/admin");
    assert.ok(!text.includes("NaN"));
    assert.match(text, /This Month &euro;\d+<\/span> <span class="trend-(up|down)">/);
  } finally {
    await h.q("DELETE FROM orders WHERE id = $1", [id]);
  }
});

test("orders page: lists a new order and escapes the buyer name", async () => {
  const marker = `ord${Date.now()}`;
  const [{ id }] = await h.q(
    "INSERT INTO orders (buyer_name, buyer_email, status, total_amount) VALUES ($1, $2, 'paid', 12.5) RETURNING id",
    [`<b>${marker}</b>`, `${marker}@example.test`]
  );
  try {
    const orders = await h.get("/admin/orders");
    assert.equal(orders.res.status, 200);
    assert.ok(orders.text.includes(`&lt;b&gt;${marker}&lt;/b&gt;`), "buyer name shown, escaped");
    assert.ok(!orders.text.includes(`<b>${marker}</b>`));
  } finally {
    await h.q("DELETE FROM orders WHERE id = $1", [id]);
  }
});
