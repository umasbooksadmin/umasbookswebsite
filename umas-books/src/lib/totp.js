// Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits —
// what Google Authenticator, Microsoft Authenticator, 1Password, Authy and
// every other authenticator app speak). Hand-rolled on node:crypto so there
// is no extra dependency in the login path.

const crypto = require("crypto");

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // accept the previous and next step too (clock drift)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

function base32Decode(str) {
  let bits = "";
  for (const c of str.replace(/[\s=-]/g, "").toUpperCase()) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error("bad base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretB32, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const n = h.readUInt32BE(off) & 0x7fffffff;
  return String(n % 10 ** DIGITS).padStart(DIGITS, "0");
}

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

// Returns the matched step (a number) or null. lastStep: the newest step
// already accepted for this account — a code at or before it is a replay.
function verifyTotp(secretB32, code, { lastStep = null, now = Date.now() } = {}) {
  const clean = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const step = currentStep(now);
  for (let s = step - WINDOW; s <= step + WINDOW; s++) {
    if (lastStep != null && s <= Number(lastStep)) continue;
    const expected = Buffer.from(hotp(secretB32, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean))) return s;
  }
  return null;
}

function otpauthUri(secretB32, accountEmail) {
  const issuer = "Uma's Books";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}` +
    `?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- secret at rest: AES-256-GCM ----
// Key: TOTP_ENCRYPTION_KEY if set, else derived from SESSION_SECRET. A
// database dump alone (backups!) therefore never contains usable secrets.
// Changing the key makes enrolled accounts re-enrol — set it once.
function key() {
  const material = process.env.TOTP_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!material) throw new Error("TOTP_ENCRYPTION_KEY or SESSION_SECRET is required");
  return crypto.createHash("sha256").update(`umasbooks-totp:${material}`).digest();
}

function encryptSecret(secretB32) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(secretB32, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

function decryptSecret(stored) {
  const [iv, tag, enc] = stored.split(".").map((p) => Buffer.from(p, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ---- recovery codes ----
const RECOVERY_COUNT = 10;
const newRecoveryCode = () => {
  const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
};
const normalizeRecovery = (s) => String(s || "").replace(/[\s-]/g, "").toUpperCase();
const hashRecovery = (s) => crypto.createHash("sha256").update(normalizeRecovery(s)).digest("hex");

module.exports = {
  generateSecret, verifyTotp, otpauthUri, encryptSecret, decryptSecret,
  newRecoveryCode, hashRecovery, base32Encode, normalizeRecovery, RECOVERY_COUNT, hotp, currentStep, base32Decode,
};
