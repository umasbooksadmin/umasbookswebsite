// Guards the unauthenticated HelloAsso webhook (routes/helloassoWebhook.js).
//
// The webhook has no signature, so anyone can POST "a payment for x@y.z" and every distinct address makes the server
// call HelloAsso's API to re-check it. The per-IP limiter (300 per 5 minutes) is not enough on launch day, when
// HelloAsso's own API rate limit is shared with the real membership payments. Two more limits, both in memory (the
// site is one Node process; a restart only forgets them, which is harmless):
//
//   - PER ADDRESS COOLDOWN (60 s): a second webhook for an address checked less than a minute ago does not call
//     HelloAsso again; it is COALESCED into one check scheduled for the end of the cooldown. A real payment sends
//     several events in a row (Order, then Payment): the last of them is therefore still checked, after the delay,
//     so nothing legitimate is lost. The sync itself is idempotent, running it twice is always safe.
//   - GLOBAL CAP (120 HelloAsso checks per 10 minutes, all addresses together): past it the webhook is acknowledged
//     but not acted on (logged once per window). A payment dropped this way is picked up by the periodic membership
//     backstop (lib/membership.js reconcileRecentMemberships), which asks HelloAsso for the latest orders itself.
//
// Both maps are bounded, so a flood of distinct addresses cannot grow memory.

const COOLDOWN_MS = 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 120;
const MAX_KEYS = 2000;

function createSyncGuard({
  cooldownMs = COOLDOWN_MS, windowMs = WINDOW_MS, maxPerWindow = MAX_PER_WINDOW, maxKeys = MAX_KEYS,
  now = Date.now, schedule = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; }, log = (m) => console.warn(m),
} = {}) {
  const last = new Map(); // address -> time of its last HelloAsso check (insertion order = oldest first)
  const pending = new Map(); // address -> the one scheduled trailing check
  let calls = []; // times of the checks in the current window
  let warnedWindowStart = 0;

  function takeGlobalSlot(t) {
    calls = calls.filter((c) => t - c < windowMs);
    if (calls.length >= maxPerWindow) {
      if (t - warnedWindowStart >= windowMs) {
        warnedWindowStart = t;
        try { log(`HelloAsso webhook: more than ${maxPerWindow} membership checks in ${Math.round(windowMs / 60000)} minutes; the surplus is acknowledged but not checked (the membership backstop will catch real payments).`); } catch { /* ignore */ }
      }
      return false;
    }
    calls.push(t);
    return true;
  }

  async function attempt(key, fn) {
    const t = now();
    if (!takeGlobalSlot(t)) return "dropped";
    last.delete(key);
    last.set(key, t);
    while (last.size > maxKeys) last.delete(last.keys().next().value);
    await fn();
    return "ran";
  }

  // -> "ran" (fn was run and has finished) | "deferred" (one check scheduled for the end of the cooldown) |
  //    "coalesced" (a check is already scheduled) | "dropped" (global cap). Rejects only if fn throws.
  async function request(email, fn) {
    const key = String(email == null ? "" : email).trim().toLowerCase().slice(0, 254);
    if (!key) return "dropped";
    const t = now();
    const prev = last.get(key);
    if (prev !== undefined && t - prev < cooldownMs) {
      if (pending.has(key)) return "coalesced";
      if (pending.size >= maxKeys) return "dropped";
      const timer = schedule(() => {
        pending.delete(key);
        attempt(key, fn).catch((err) => { try { log(`HelloAsso webhook: scheduled check failed: ${String((err && err.message) || err).slice(0, 120)}`); } catch { /* ignore */ } });
      }, cooldownMs - (t - prev) + 1);
      pending.set(key, timer);
      return "deferred";
    }
    return attempt(key, fn);
  }

  return { request, size: () => ({ last: last.size, pending: pending.size, calls: calls.length }) };
}

let current = null;
const getSyncGuard = () => current || (current = createSyncGuard());
const setSyncGuard = (g) => { current = g; };

module.exports = { createSyncGuard, getSyncGuard, setSyncGuard, COOLDOWN_MS, WINDOW_MS, MAX_PER_WINDOW, MAX_KEYS };
