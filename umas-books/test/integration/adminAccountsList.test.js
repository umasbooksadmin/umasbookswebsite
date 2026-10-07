// Admin accounts list (/admin/members) and Accounts report
// (/admin/reports/accounts): one account of every kind, the role pills and every
// filter, with the same definitions in both places (lib/accountTypes.js).
// Own throwaway database so the global counts are exact.
//
//   admin       Admin (also a member)
//   volunteer   Volunteer
//   paying      member with a future end date
//   granted     member with no end date
//   expired     is_member but the end date has passed -> plain Account
//   holder      confirmed account, nothing else -> Account
//   unconf      never confirmed the email -> Unconfirmed
// plus the signed-in admin ("boss", admin, not a member).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 4210;
const PASSWORD = "Accounts-Test-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;
let jar;
const u = {};

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const hash = await bcrypt.hash(PASSWORD, 4);
  let n = 0;
  const make = async (key, name, o = {}) => {
    const email = `acct-${key}-${Date.now()}-${++n}@example.test`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_volunteer, member_expires_at, email_verified_at, first_verification_pending, last_login_at, is_disabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [email, hash, name, !!o.admin, !!o.member, !!o.volunteer, o.expires || null, o.unconfirmed ? null : new Date(), !!o.unconfirmed, o.login || null, !!o.disabled]
    );
    u[key] = { id: rows[0].id, email, name };
  };
  await make("boss", "Zed Boss", { admin: true });
  await make("admin", "Alice Admin", { admin: true, member: true });
  await make("volunteer", "Vera Volunteer", { volunteer: true });
  await make("paying", "Paul Paying", { member: true, expires: new Date(Date.now() + 90 * 864e5) });
  await make("granted", "Greta Granted", { member: true });
  await make("expired", "Ed Expired", { member: true, expires: new Date(Date.now() - 5 * 864e5) });
  await make("holder", "Hana Holder", { login: new Date("2026-03-04T12:00:00Z"), disabled: true });
  await make("unconf", "Una Unconfirmed", { unconfirmed: true });
  // Hana: one paid order (60) and one refunded order (500) that must not count.
  const ord = (status, total) => pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, total_amount, status, paid_at) VALUES ('x', $1, $2, $3, now())", [u.holder.email.toUpperCase(), total, status]);
  await ord("paid", 60); await ord("refunded", 500); await ord("pending", 7);
  jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": "10.80.0.1" },
    body: new URLSearchParams({ email: u.boss.email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302);
});

after(async () => {
  await pool.end();
  app.stop();
});

async function get(path) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar.header(), "x-forwarded-for": "10.80.0.1" } });
  return { res, text: await res.text() };
}

// The list page's row per account: { name -> pills text }.
function listRows(html) {
  const out = {};
  for (const tr of html.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
    const name = (tr.match(/<strong>([^<]+)<\/strong>/) || [])[1];
    if (!name) continue;
    out[name] = [...tr.matchAll(/class="status-pill (?:trash|draft|category|published|archived)"[^>]*>([^<]+)</g)].map((m) => m[1]).filter((t) => t !== "Active" && t !== "Inactive");
  }
  return out;
}
const names = (html) => Object.keys(listRows(html)).sort();

test("the accounts list shows every kind of account, with the right role pills", async () => {
  const { res, text } = await get("/admin/members");
  assert.equal(res.status, 200);
  assert.match(text, /<title>[^<]*Accounts/);
  assert.match(text, /Everyone with an account: members, volunteers, admins and account holders\./);
  const rows = listRows(text);
  assert.deepEqual(rows["Alice Admin"], ["Admin", "Member"]);
  assert.deepEqual(rows["Zed Boss"], ["Admin"]);
  assert.deepEqual(rows["Vera Volunteer"], ["Volunteer"]);
  assert.deepEqual(rows["Paul Paying"], ["Member"]);
  assert.deepEqual(rows["Greta Granted"], ["Member"]);
  assert.deepEqual(rows["Ed Expired"], ["Account", "Membership expired"]);
  assert.deepEqual(rows["Hana Holder"], ["Account"]);
  assert.deepEqual(rows["Una Unconfirmed"], ["Unconfirmed"]);
  assert.equal(Object.keys(rows).length, 8);
});

test("each role filter lists the right accounts, and the dropdown shows counts", async () => {
  const f = async (role) => names((await get(`/admin/members?role=${role}`)).text);
  assert.deepEqual(await f("admin"), ["Alice Admin", "Zed Boss"]);
  assert.deepEqual(await f("volunteer"), ["Vera Volunteer"]);
  assert.deepEqual(await f("member"), ["Alice Admin", "Greta Granted", "Paul Paying"]);
  assert.deepEqual(await f("account"), ["Ed Expired", "Hana Holder"]);
  assert.deepEqual(await f("unconfirmed"), ["Una Unconfirmed"]);
  assert.equal((await f("")).length, 8);
  assert.equal((await f("bogus")).length, 8, "an unknown role is ignored");
  const { text } = await get("/admin/members");
  for (const re of [/All accounts \(8\)/, /Admin \(2\)/, /Volunteer \(1\)/, /Member \(paying or granted\) \(3\)/, /Account holder \(not a member\) \(2\)/, /Unconfirmed \(1\)/]) assert.match(text, re);
  const members = (await get("/admin/members?role=member")).text;
  assert.match(members, /<title>[^<]*Members/);
});

test("the list footer says accounts, not members", async () => {
  // 11 pages-worth is not needed: make 12 accounts in total so there are 2 pages.
  for (let i = 0; i < 4; i++) {
    await pool.query("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', $2, now())", [`pad${i}-${Date.now()}@example.test`, `Pad ${i}`]);
  }
  const { text } = await get("/admin/members");
  assert.match(text, /of 12 accounts/);
  assert.doesNotMatch(text, /of 12 members/);
  await pool.query("DELETE FROM users WHERE display_name LIKE 'Pad %'");
});

test("the Accounts report: summary counts, one row per account, same types as the list", async () => {
  const { res, text } = await get("/admin/reports/accounts");
  assert.equal(res.status, 200);
  const count = (label) => Number((text.match(new RegExp(`${label}[^<]*</td>\\s*<td[^>]*>(\\d+)</td>`)) || [])[1]);
  assert.equal(count("Total accounts"), 8);
  assert.equal(count("Admins"), 2);
  assert.equal(count("Volunteers"), 1);
  assert.equal(count("Members \\(paying or granted\\)"), 3);
  assert.equal(count("Members whose membership has expired"), 1);
  assert.equal(count("Account holders \\(not a member, admin or volunteer\\)"), 2);
  assert.equal(count("Unconfirmed \\(email never confirmed\\)"), 1);
  assert.equal(count("Created in the last 7 days"), 8);
  assert.equal(count("With at least one paid reservation"), 1);
  const rows = {};
  for (const tr of text.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
    const c = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim());
    if (c.length === 10) rows[c[0]] = c;
  }
  assert.equal(rows["Alice Admin"][2], "Admin");
  assert.equal(rows["Vera Volunteer"][2], "Volunteer");
  assert.equal(rows["Paul Paying"][2], "Member");
  assert.match(rows["Paul Paying"][3], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(rows["Greta Granted"][3], "no end date");
  assert.equal(rows["Ed Expired"][2], "Account");
  assert.equal(rows["Hana Holder"][2], "Account");
  assert.equal(rows["Una Unconfirmed"][2], "Unconfirmed");
  assert.equal(rows["Una Unconfirmed"][4], "no");
  assert.equal(rows["Hana Holder"][4], "yes");
  assert.equal(rows["Hana Holder"][6], "2026-03-04");
  assert.equal(rows["Hana Holder"][7], "1", "refunded and unpaid orders are not counted");
  assert.equal(rows["Hana Holder"][8], "€60.00");
  assert.equal(rows["Hana Holder"][9], "yes");
  assert.equal(rows["Paul Paying"][6], "never");
});

test("Accounts report filters: type, text search, created dates", async () => {
  const rowNames = (html) => (html.match(/<tr>[\s\S]*?<\/tr>/g) || []).map((tr) => (tr.match(/<td[^>]*>([^<]*)<\/td>/) || [])[1]).filter((x) => x && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(x)).sort();
  const g = async (qs) => rowNames((await get(`/admin/reports/accounts?${qs}`)).text);
  assert.deepEqual(await g("type=admin"), ["Alice Admin", "Zed Boss"]);
  assert.deepEqual(await g("type=volunteer"), ["Vera Volunteer"]);
  assert.deepEqual(await g("type=member"), ["Alice Admin", "Greta Granted", "Paul Paying"]);
  assert.deepEqual(await g("type=account"), ["Ed Expired", "Hana Holder"]);
  assert.deepEqual(await g("type=unconfirmed"), ["Una Unconfirmed"]);
  assert.deepEqual(await g("q=granted"), ["Greta Granted"]);
  assert.deepEqual(await g(`q=${encodeURIComponent(u.paying.email)}`), ["Paul Paying"]);
  assert.deepEqual(await g("q=%25"), [], "a % in the search is literal, not a wildcard");
  assert.equal((await g("from=2000-01-01&to=2000-12-31")).length, 0);
  assert.equal((await g("from=2000-01-01")).length, 8);
});

test("Accounts report CSV: BOM, headers, filtered rows, formula-safe, audited, no-store", async () => {
  await pool.query("UPDATE users SET display_name = '=HYPERLINK(\"x\")' WHERE id = $1", [u.holder.id]);
  const res = await fetch(`${app.base}/admin/reports/accounts?format=csv&type=account`, { headers: { cookie: jar.header(), "x-forwarded-for": "10.80.0.1" } });
  // res.text() would strip the BOM, so decode by hand.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /umas-books-accounts-accounts\.csv/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(text.startsWith("﻿\"Name\",\"Email\",\"Type\",\"Member until\",\"Email confirmed\",\"Created\",\"Last login\",\"Paid reservations\",\"Total spent\",\"Disabled\""));
  assert.match(text, /"'=HYPERLINK\(""x""\)"/);
  assert.ok(text.includes(u.holder.email) && text.includes(u.expired.email));
  assert.ok(!text.includes(u.paying.email), "filter applies to the CSV");
  assert.match(text, /,1,60\.00,"yes"/);
  const { rows } = await pool.query("SELECT detail FROM admin_audit_log WHERE action = 'report.csv' AND detail = 'accounts'");
  assert.ok(rows.length >= 1);
  await pool.query("UPDATE users SET display_name = 'Hana Holder' WHERE id = $1", [u.holder.id]);
});

test("the Reports index lists Accounts; non-admins are refused", async () => {
  const { text } = await get("/admin/reports");
  assert.match(text, /href="\/admin\/reports\/accounts"/);
  const anon = await fetch(`${app.base}/admin/reports/accounts`, { redirect: "manual", headers: { "x-forwarded-for": "10.80.0.2" } });
  assert.ok([302, 403].includes(anon.status));
});
