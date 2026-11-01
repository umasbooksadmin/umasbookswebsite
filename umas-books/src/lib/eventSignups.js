// Public event sign-ups (routes/events.js, POST /events/:id/signup), reviews 6A L3 and 6B M4.
//
// Anyone can sign up with a name and an email, no account and no confirmation step: the place counts at once (the
// owner's choice). Because anyone can type anyone's address, every new sign-up is told to that address: the
// "you're signed up" email carries a CANCEL link (one random 32-byte token, only its SHA-256 stored in
// event_signups.cancel_token_hash, migration 112). The GET of the link shows a button and its POST deletes the
// sign-up (a mail scanner that opens links must not cancel), so the seat count, a COUNT(*) of the rows, is right at
// once; a second click finds nothing and says so.
//
// Refused: an event that has started (starts_at <= now(), so also every past event), a full one, an address already
// signed up for it. The email is a THROTTLED kind with its own budget (lib/outbox.js, event_signup); when it is
// refused the sign-up is rolled back with it (no sign-up without its email), and the person is asked to try later.
// The per-IP limit of the route (eventSignupLimiter) applies first.

const { withTransaction } = require("../db");
const { generateToken, hashToken } = require("./resetTokens");
const { enqueueThrottled, deliverNow } = require("./outbox");
const { localize } = require("./frenchText");
const { emailTr, normLang } = require("./lang");
const { emailSafeName } = require("./validation");
const { forLocale, LOCALES } = require("./dates");
const { formatEuro } = require("./money");
const legal = require("./legal");

const TOKEN_RE = /^[a-f0-9]{64}$/;

const cancelUrl = (base, token) => `${base}/events/cancel/${token}`;
const shopAddress = () => `Uma's Books\n${legal.shopStreet("en")}, 81000 Albi`;

// The "you're signed up" email in the person's language (the page language at sign-up). `event` is the events row.
function buildSignupEmail({ event, name, lang, base, token }) {
  const l = normLang(lang) || "en";
  const tr = emailTr(l);
  const e = localize("event", event, l);
  const fmt = forLocale(LOCALES[l]);
  const title = emailSafeName(e.title);
  const n = emailSafeName(name);
  const place = emailSafeName(e.location || "");
  const day = fmt.formatDateLong(e.starts_at);
  const time = fmt.formatTime(e.starts_at);
  const price = e.price != null ? formatEuro(Number(e.price), l) : null;
  const when = tr(`on ${day} at ${time}`, `le ${day} à ${time}`);
  const where = place ? ` (${place})` : "";
  const priceLine = price ? tr(`\nPrice: ${price}, paid on the day.`, `\nPrix : ${price}, à régler sur place.`) : "";
  const link = cancelUrl(base, token);
  const ics = `${base}/events/${event.id}/ics`;
  return {
    subject: tr(`You're signed up: ${title}`, `Inscription enregistrée : ${title}`),
    text: tr(
      `${n ? `Hi ${n},` : "Hi,"}\n\nYou're signed up for "${title}" ${when}${where} at Uma's Books.${priceLine}\n\nAdd it to your calendar:\n${ics}\n\nCan't come after all, or didn't sign up yourself? Cancel this sign-up here, and we'll delete your name and email from it:\n${link}\n\nWe use your name and email only to manage attendance at this event.\n\n${shopAddress()}`,
      `${n ? `Bonjour ${n},` : "Bonjour,"}\n\nVotre inscription à « ${title} » ${when}${where} chez Uma's Books est bien enregistrée.${priceLine}\n\nAjoutez-la à votre agenda :\n${ics}\n\nVous ne pouvez plus venir, ou ce n'est pas vous qui avez fait cette inscription ? Annulez-la ici, et nous supprimerons votre nom et votre adresse e-mail :\n${link}\n\nVotre nom et votre e-mail servent uniquement à gérer la participation à cet événement.\n\n${shopAddress()}`
    ),
  };
}

// One sign-up, in one transaction. Resolves { outcome, event } where outcome is
//   'signed_up' | 'already' | 'full' | 'past' | 'busy' (the email was throttled: nothing stored) | 'not_found'
// and `event` is the events row (null when not found).
async function signUp(pool, { eventId, name, email, lang, base }) {
  const result = await withTransaction(pool, async (client) => {
    // Lock the event row so two sign-ups arriving at the same moment can't both read the same "places left" and both
    // squeeze in: the second one blocks here until the first commits, then re-reads the count. Same pattern as the
    // drop-in seat checkout in lib/cart.js.
    const { rows } = await client.query("SELECT *, starts_at <= now() AS started FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    const event = rows[0];
    if (!event) return { outcome: "not_found", event: null };
    if (event.started) return { outcome: "past", event };
    // Before the capacity check: the person who took the last place is told they are signed up, not that it is full.
    const { rows: mine } = await client.query("SELECT 1 FROM event_signups WHERE event_id = $1 AND email = $2", [eventId, email]);
    if (mine.length) return { outcome: "already", event };
    if (event.capacity != null) {
      const { rows: [c] } = await client.query("SELECT COUNT(*)::int AS n FROM event_signups WHERE event_id = $1", [eventId]);
      if (c.n >= event.capacity) return { outcome: "full", event };
    }
    const token = generateToken();
    const ins = await client.query(
      `INSERT INTO event_signups (event_id, name, email, cancel_token_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, email) DO NOTHING RETURNING id`,
      [eventId, name, email, hashToken(token)]
    );
    if (!ins.rows.length) return { outcome: "already", event };
    const mail = buildSignupEmail({ event, name, lang, base, token });
    const r = await enqueueThrottled(client, { kind: "event_signup", lang: normLang(lang) || "en", to: email, ...mail }, { mode: "skipInterval" });
    // No sign-up without its email: undo the insert (the transaction commits nothing else).
    if (r.throttled) throw Object.assign(new Error("EVENT_MAIL_THROTTLED"), { event });
    return { outcome: "signed_up", event, mailId: r.id };
  }).catch((err) => {
    if (err.message === "EVENT_MAIL_THROTTLED") return { outcome: "busy", event: err.event };
    throw err;
  });
  if (result.mailId) await deliverNow(pool, result.mailId);
  return result;
}

// The sign-up behind a cancel link (with its event), or null: unknown token, already cancelled, purged.
async function findByCancelToken(db, raw) {
  if (!TOKEN_RE.test(String(raw || ""))) return null;
  const { rows } = await db.query(
    `SELECT s.id, s.event_id, e.title, e.title_fr, e.description, e.description_fr, e.location, e.location_fr, e.starts_at
     FROM event_signups s JOIN events e ON e.id = s.event_id WHERE s.cancel_token_hash = $1`,
    [hashToken(raw)]
  );
  return rows[0] || null;
}

// The POST of the cancel page: deletes the sign-up. Resolves the deleted sign-up's event row fields, or null when
// there was nothing to cancel (already cancelled, or not a valid link). Of two concurrent clicks exactly one deletes.
async function cancelByToken(db, raw) {
  if (!TOKEN_RE.test(String(raw || ""))) return null;
  const { rows } = await db.query(
    `DELETE FROM event_signups s USING events e
     WHERE s.cancel_token_hash = $1 AND e.id = s.event_id
     RETURNING s.event_id, e.title, e.title_fr, e.description, e.description_fr, e.location, e.location_fr, e.starts_at`,
    [hashToken(raw)]
  );
  return rows[0] || null;
}

module.exports = { signUp, findByCancelToken, cancelByToken, buildSignupEmail, cancelUrl, TOKEN_RE };
