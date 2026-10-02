// withTransaction attaches an 'error' listener to the checked-out client for
// the length of the transaction (a dropped connection mid-transaction would
// otherwise be an unhandled 'error' event and crash the process), and removes
// it afterwards so listeners don't pile up on pooled clients.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/unused_never_connected";
const { withTransaction } = require("../../src/db");

function fakePool() {
  const client = new EventEmitter();
  client.queries = [];
  client.released = [];
  client.query = async (sql) => { client.queries.push(sql); };
  client.release = (err) => client.released.push(err);
  return { client, pool: { connect: async () => client } };
}

test("an 'error' on the client during the transaction is logged, not thrown", async () => {
  const { client, pool } = fakePool();
  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const result = await withTransaction(pool, async () => {
      assert.doesNotThrow(() => client.emit("error", new Error("connection terminated unexpectedly")));
      return "done";
    });
    assert.equal(result, "done");
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /connection terminated unexpectedly/);
});

test("the listener is removed afterwards, on commit and on rollback", async () => {
  const { client, pool } = fakePool();
  await withTransaction(pool, async () => {
    assert.equal(client.listenerCount("error"), 1);
  });
  assert.equal(client.listenerCount("error"), 0);
  await assert.rejects(withTransaction(pool, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(client.listenerCount("error"), 0);
  assert.deepEqual(client.queries.filter((q) => q === "ROLLBACK").length, 1);
});
