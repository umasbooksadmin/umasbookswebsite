// Public contact form (src/routes/contact.js): happy path, validation,
// honeypot, mail failure, the Reply-To shape, and the rate-limit handler.
//
// In-process so sendMail can be stubbed (routes/contact.js destructures it
// at require time, so the override is installed before the route loads).
// The route's limiter is module-level state (5 POSTs per 15 min), so every
// test loads a FRESH copy of the router and gets its own counter.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("contact", { isolated: true });

const mailer = require("../../src/mailer");
const sent = [];
let sendImpl;
mailer.sendMail = async (opts) => sendImpl(opts);

const { pool } = require("../../src/db");

const CONTACT_ROUTE = path.join(__dirname, "..", "..", "src", "routes", "contact.js");
const EXPECTED_TO = process.env.CONTACT_TO || "admin@umasbooks.org";

before(() => db.create());
after(async () => {
  await pool.end();
  db.drop();
});
beforeEach(() => {
  sent.length = 0;
  sendImpl = async (opts) => { sent.push(opts); };
});

async function withContactApp(fn) {
  delete require.cache[CONTACT_ROUTE];
  const server = await listen(buildApp([require(CONTACT_ROUTE)]));
  try {
    const post = async (fields) => {
      const res = await fetch(`${server.base}/contact`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
      return { res, text: await res.text() };
    };
    await fn({ base: server.base, post });
  } finally {
    await server.close();
  }
}

const valid = { name: "Jean Dupont", email: "jean@example.test", topic: "Events", message: "Do you host readings?" };

test("GET /contact renders the form; ?sent=1 shows the thank-you state", async () => {
  await withContactApp(async ({ base }) => {
    const form = await fetch(`${base}/contact`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /<form/);
    const sentPage = await fetch(`${base}/contact?sent=1`);
    assert.equal(sentPage.status, 200);
    assert.notEqual(await sentPage.text(), await (await fetch(`${base}/contact`)).text());
  });
});

test("valid submission sends one email to the contact address with a structured Reply-To, then redirects", async () => {
  await withContactApp(async ({ post }) => {
    const { res } = await post(valid);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/contact?sent=1");
    assert.equal(sent.length, 1);
    const mail = sent[0];
    assert.equal(mail.to, EXPECTED_TO);
    assert.deepEqual(mail.replyTo, { name: "Jean Dupont", address: "jean@example.test" });
    assert.equal(mail.subject, "Website contact: Events — Jean Dupont");
    assert.match(mail.text, /Name: Jean Dupont/);
    assert.match(mail.text, /Email: jean@example\.test/);
    assert.match(mail.text, /Topic: Events/);
    assert.match(mail.text, /Do you host readings\?/);
  });
});

test("Reply-To name can't smuggle extra recipients (angle brackets, quotes, commas, CR/LF are stripped)", async () => {
  await withContactApp(async ({ post }) => {
    const { res } = await post({ ...valid, name: 'Eve <boss@victim.test>, "x"; y' });
    assert.equal(res.status, 302);
    assert.equal(sent.length, 1);
    assert.equal(typeof sent[0].replyTo, "object", "object form, not a hand-built 'Name <addr>' string");
    assert.equal(sent[0].replyTo.address, "jean@example.test");
    assert.doesNotMatch(sent[0].replyTo.name, /[<>",;\r\n]/);
    assert.ok(sent[0].replyTo.name.includes("boss@victim.test"), "the text survives, just defanged");
  });
});

test("URLs and control characters in the name never reach the email subject or body", async () => {
  await withContactApp(async ({ post }) => {
    const { res } = await post({ ...valid, name: "Eve https://evil.example/x www.evil.example\u0007<b>" });
    assert.equal(res.status, 302);
    assert.equal(sent.length, 1);
    for (const field of [sent[0].subject, sent[0].text.split("\n")[2]]) {
      // The \u0007 (bell) is deliberate: control characters must be stripped.
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(field, /evil\.example|https?:|[<>\u0007]/);
      assert.match(field, /Eve/);
    }
  });
});

test("an unknown topic falls back to 'General question'; an over-long message is truncated to 5000 chars", async () => {
  await withContactApp(async ({ post }) => {
    await post({ ...valid, topic: "Free money", message: "m".repeat(6000) });
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /Website contact: General question —/);
    const body = sent[0].text.split("Topic: General question\n\n")[1];
    assert.equal(body.trim().length, 5000);
  });
});

test("validation failures return 400 with an error, echo the values, and send nothing", async () => {
  const cases = [
    { ...valid, name: "" },
    { ...valid, name: "   " },
    { ...valid, email: "" },
    { ...valid, email: "not-an-email" },
    { ...valid, message: "" },
    { ...valid, message: "  \n " },
  ];
  // One fresh app per case: the 5-per-window limiter counts failed attempts too.
  for (const fields of cases) {
    await withContactApp(async ({ post }) => {
      const { res, text } = await post(fields);
      assert.equal(res.status, 400, JSON.stringify(fields));
      assert.match(text, /Please fill in your name, a valid email address and your message/);
      // Whatever was entered is preserved for the visitor to correct.
      for (const v of [fields.name.trim(), fields.email.trim()].filter(Boolean)) assert.ok(text.includes(v), `echoes ${v}`);
    });
  }
  assert.equal(sent.length, 0);
});

test("honeypot: a filled hidden field looks like success to the bot but sends nothing", async () => {
  await withContactApp(async ({ post }) => {
    const { res } = await post({ ...valid, website: "http://spam.example" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/contact?sent=1");
    assert.equal(sent.length, 0);
  });
});

test("when the mail transport fails the visitor sees a 500 page with the fallback address, and the app keeps serving", async () => {
  await withContactApp(async ({ base, post }) => {
    sendImpl = async () => { throw new Error("SMTP down"); };
    const realError = console.error;
    console.error = () => {};
    let result;
    try {
      result = await post(valid);
    } finally {
      console.error = realError;
    }
    assert.equal(result.res.status, 500);
    assert.match(result.text, /couldn(?:'|&#39;)t be sent just now/);
    assert.ok(result.text.includes("admin@umasbooks.org"));
    assert.ok(result.text.includes("Jean Dupont"), "entered values preserved");
    assert.equal((await fetch(`${base}/contact`)).status, 200);
  });
});

test("rate limit: the 6th submission from one client gets the 429 handler page and sends nothing more", async () => {
  await withContactApp(async ({ post }) => {
    for (let i = 1; i <= 5; i++) {
      const { res } = await post(valid);
      assert.equal(res.status, 302, `submission ${i} should be accepted`);
    }
    assert.equal(sent.length, 5);
    const { res, text } = await post({ ...valid, message: "sixth" });
    assert.equal(res.status, 429);
    assert.match(text, /Too many messages from this connection/);
    assert.ok(text.includes("sixth"), "the visitor's message is echoed back so it isn't lost");
    assert.equal(sent.length, 5);
    assert.ok(res.headers.get("ratelimit-limit") || res.headers.get("ratelimit"), "standard RateLimit headers present");
  });
});

test("invalid submissions count toward the rate limit too (bots can't probe validation for free)", async () => {
  await withContactApp(async ({ post }) => {
    for (let i = 0; i < 5; i++) await post({ ...valid, email: "bad" });
    const { res } = await post(valid);
    assert.equal(res.status, 429);
    assert.equal(sent.length, 0);
  });
});
