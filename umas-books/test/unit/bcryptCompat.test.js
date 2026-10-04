// Guards the bcryptjs 2 -> 3 upgrade: password hashes already stored in the
// users table (written by bcryptjs 2, "$2a$" prefix) must keep verifying, and
// hashes in the other standard prefixes must verify too. The fixtures below
// are fixed strings, not generated at test time, so they really are "old".
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const PASSWORD = "Correct-Horse-1";
const FIXTURES = {
  // Produced by bcryptjs 2.4.3 (what production hashes were written with).
  "bcryptjs 2 ($2a$, cost 12)": "$2a$12$hQzgVK3VeEwqyleGoSBDrek0x7FY49kALikGOLxSWKpJTraieESnu",
  // Produced by an independent implementation (Apache htpasswd / libc crypt).
  "htpasswd ($2y$, cost 12)": "$2y$12$8oscd4j3VVu6mwOER8Iq9uozq.ml8hAzHXbLCFSSRaYmmy6HNlt8y",
  // Same hash as above with the $2b$ prefix (identical algorithm for ASCII).
  "modern prefix ($2b$, cost 12)": "$2b$12$8oscd4j3VVu6mwOER8Iq9uozq.ml8hAzHXbLCFSSRaYmmy6HNlt8y",
};

for (const [name, hash] of Object.entries(FIXTURES)) {
  test(`existing hash still verifies: ${name}`, async () => {
    assert.equal(await bcrypt.compare(PASSWORD, hash), true);
    assert.equal(bcrypt.compareSync(PASSWORD, hash), true);
    assert.equal(await bcrypt.compare("wrong-password", hash), false);
  });
}

test("a non-ASCII password written by bcryptjs 2 still verifies", async () => {
  const hash = "$2a$10$EhtfsibAi92udYWL9/kb5OJmupzQtzpc5ZO7yFy1bc7a5e87UWQ.G";
  assert.equal(await bcrypt.compare("pässwörd-ünï", hash), true);
  assert.equal(await bcrypt.compare("passwurd-unï", hash), false);
});

test("new hashes use cost 12 and verify (also the timing-equaliser shape in auth.js)", async () => {
  const hash = await bcrypt.hash(PASSWORD, 12);
  assert.match(hash, /^\$2[ab]\$12\$[./A-Za-z0-9]{53}$/);
  assert.equal(await bcrypt.compare(PASSWORD, hash), true);
  // auth.js DUMMY_HASH: a sync hash at cost 12 that a compare must run against
  // and report false for any real password.
  const dummy = bcrypt.hashSync("no-such-account-timing-equalizer", 12);
  assert.equal(bcrypt.getRounds(dummy), 12);
  assert.equal(await bcrypt.compare(PASSWORD, dummy), false);
});
