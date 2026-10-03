// Append-only log of sensitive admin actions (table admin_audit_log).
// Stores who (admin id + email at the time), what, and the numeric id of the
// thing acted on. Never put a member's email, name or message text in
// `detail`. Retention: 12 months (lib/privacy.js).
//
// audit() never throws and never holds up a response for more than a moment:
// a logging problem must not stop an admin action.

const AUDIT_TIMEOUT_MS = 2000;

function isReq(x) {
  return Boolean(x && (x.session || x.headers));
}

// audit(req, {...}) uses the logged-in admin and req.ip.
// audit(pool, {actorUserId, actorLabel, ...}) is for code without a request.
async function audit(poolOrReq, { action, targetType = null, targetId = null, detail = null, actorUserId, actorLabel, ip } = {}) {
  try {
    let pool = poolOrReq;
    let actor = { id: actorUserId ?? null, label: actorLabel ?? null };
    let addr = ip ?? null;
    if (isReq(poolOrReq)) {
      pool = require("../db").pool;
      const user = poolOrReq.session && poolOrReq.session.user;
      actor = { id: user ? user.id : null, label: user ? user.email : null };
      addr = poolOrReq.ip || null;
    }
    const numericTarget = targetId === null || targetId === undefined ? null : Number(targetId);
    const safeTarget = Number.isInteger(numericTarget) ? numericTarget : null;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), AUDIT_TIMEOUT_MS);
    });
    const write = pool.query(
      `INSERT INTO admin_audit_log (actor_user_id, actor_label, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actor.id, actor.label, action, targetType, safeTarget, detail ? String(detail).slice(0, 200) : null, addr]
    );
    write.catch(() => {}); // a failure after the timeout must not become an unhandled rejection
    try {
      const result = await Promise.race([write, timeout]);
      if (result === "timeout") console.error("Audit log write timed out");
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error("Audit log write failed:", err.message);
  }
}

module.exports = { audit };
