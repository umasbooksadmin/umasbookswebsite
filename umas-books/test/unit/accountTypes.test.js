const { test } = require("node:test");
const assert = require("node:assert/strict");
const { accountType, accountBadges, parseTypeFilter, typeFilterSql, FILTER_LABELS } = require("../../src/lib/accountTypes");

const NOW = new Date("2026-06-01T12:00:00Z");
const confirmed = new Date("2026-01-01T00:00:00Z");

test("primary type: admin > volunteer > member > account; unconfirmed has none of them", () => {
  assert.equal(accountType({ is_admin: true, is_member: true, email_verified_at: confirmed }, NOW), "admin");
  assert.equal(accountType({ is_volunteer: true, is_member: true, email_verified_at: confirmed }, NOW), "volunteer");
  assert.equal(accountType({ is_member: true, email_verified_at: confirmed }, NOW), "member");
  assert.equal(accountType({ is_member: true, member_expires_at: "2026-07-01T00:00:00Z", email_verified_at: confirmed }, NOW), "member");
  assert.equal(accountType({ is_member: true, member_expires_at: "2026-05-01T00:00:00Z", email_verified_at: confirmed }, NOW), "account");
  assert.equal(accountType({ email_verified_at: confirmed }, NOW), "account");
  assert.equal(accountType({ email_verified_at: null }, NOW), "unconfirmed");
});

test("badges list everything that applies", () => {
  assert.deepEqual(accountBadges({ is_admin: true, is_member: true, email_verified_at: confirmed }, NOW).labels, ["Admin", "Member"]);
  assert.deepEqual(accountBadges({ is_member: true, member_expires_at: "2026-05-01T00:00:00Z", email_verified_at: confirmed }, NOW).labels, ["Account", "Membership expired"]);
  assert.deepEqual(accountBadges({ is_volunteer: true, email_verified_at: null }, NOW).labels, ["Volunteer", "Not confirmed"]);
});

test("Till access is a pill and a filter on top of the primary type, never a primary type", () => {
  assert.equal(accountType({ is_till: true, email_verified_at: confirmed }, NOW), "account");
  assert.deepEqual(accountBadges({ is_till: true, email_verified_at: confirmed }, NOW).labels, ["Account", "Till"]);
  assert.deepEqual(accountBadges({ is_volunteer: true, is_member: true, is_till: true, email_verified_at: confirmed }, NOW).labels, ["Volunteer", "Member", "Till"]);
  assert.equal(parseTypeFilter("till"), "till");
  assert.equal(typeFilterSql("till", "u"), "u.is_till");
  assert.equal(FILTER_LABELS.till, "Till access");
});

test("unknown filters are ignored and every real one has SQL", () => {
  assert.equal(parseTypeFilter("nope"), "");
  assert.equal(typeFilterSql("", "u"), null);
  for (const t of ["admin", "volunteer", "member", "account", "unconfirmed", "till"]) assert.ok(typeFilterSql(t, "u"));
});
