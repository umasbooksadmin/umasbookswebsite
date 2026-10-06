// Password-guessing lockout for POST /login. Two layers, in memory (one app
// instance; cleared by a restart, which an attacker cannot trigger):
//
//  1. Per (account, IP) PAIR: 5 wrong passwords from one address lock THAT
//     address out of THAT account for 15 minutes. A stranger typing the admin's
//     email can lock only themselves out, never the admin on their own phone
//     (the old rule locked the account for everyone, a cheap denial of service
//     against the one person who can fix things). IPv6 clients are bucketed by
//     /56 (middleware/rateLimits.js ipKey).
//  2. A softer per-ACCOUNT total: 20 wrong passwords from ALL addresses together
//     in 15 minutes (a spread-out guesser using many addresses) refuses further
//     attempts for the rest of that window EXCEPT from an address that logged
//     into this account successfully in the last 30 days (the owner's usual
//     phone and home connection). The trade-off: a botnet can still make the
//     owner log in from a NEW place only after up to 15 minutes; it can never
//     lock out their usual devices. After a restart no address is "known" yet.
//
// A refused attempt answers exactly like a wrong password (the route decides)
// and is not counted, so the lock cannot be extended by hammering it.
// Two-step codes keep their own per-account counter (users.failed_login_attempts):
// guessing a code needs the password first, so a stranger cannot reach it.
const WINDOW_MS = 15 * 60 * 1000;
const PAIR_MAX = 5;
const ACCOUNT_MAX = 20;
const KNOWN_IP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_KEYS = 20000;

function createLoginThrottle({ now = Date.now, pairMax = PAIR_MAX, accountMax = ACCOUNT_MAX } = {}) {
  const pairs = new Map(); // "id|ip" -> { fails, lockedUntil, first }
  const accounts = new Map(); // id -> number[] failure times
  const known = new Map(); // "id|ip" -> last success time

  const prune = () => {
    if (pairs.size + known.size + accounts.size < MAX_KEYS) return;
    const t = now();
    for (const [k, v] of pairs) if ((v.lockedUntil || v.first + WINDOW_MS) < t) pairs.delete(k);
    for (const [k, v] of known) if (v + KNOWN_IP_MS < t) known.delete(k);
    for (const [k, v] of accounts) if (!v.some((x) => x > t - WINDOW_MS)) accounts.delete(k);
  };

  return {
    // Returns null, or why the attempt is refused: "pair" | "account".
    isBlocked(userId, ip) {
      const t = now();
      const p = pairs.get(`${userId}|${ip}`);
      if (p && p.lockedUntil && p.lockedUntil > t) return "pair";
      const list = (accounts.get(userId) || []).filter((x) => x > t - WINDOW_MS);
      if (list.length >= accountMax) {
        const seen = known.get(`${userId}|${ip}`);
        if (!(seen !== undefined && seen + KNOWN_IP_MS > t)) return "account";
      }
      return null;
    },
    recordFailure(userId, ip) {
      const t = now();
      prune();
      const key = `${userId}|${ip}`;
      let p = pairs.get(key);
      if (!p || (p.lockedUntil && p.lockedUntil <= t) || (!p.lockedUntil && p.first + WINDOW_MS <= t)) p = { fails: 0, lockedUntil: 0, first: t };
      p.fails += 1;
      if (p.fails >= pairMax) p.lockedUntil = t + WINDOW_MS;
      pairs.set(key, p);
      const list = (accounts.get(userId) || []).filter((x) => x > t - WINDOW_MS);
      list.push(t);
      accounts.set(userId, list);
    },
    recordSuccess(userId, ip) {
      prune();
      pairs.delete(`${userId}|${ip}`);
      known.set(`${userId}|${ip}`, now());
    },
    clear() { pairs.clear(); accounts.clear(); known.clear(); },
  };
}

module.exports = { createLoginThrottle, loginThrottle: createLoginThrottle(), WINDOW_MS, PAIR_MAX, ACCOUNT_MAX };
