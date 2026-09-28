function attachUser(pool) {
  return async function (req, res, next) {
    res.locals.user = req.session.user || null;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (!req.session.user.isAdmin) return res.status(403).send("Admins only.");
  next();
}

// Being logged in isn't the same as being a member — the Member's Access
// dashboard (forum, charity vote, meeting scheduling) is a paid
// membership perk. A logged-in visitor who isn't a member (or admin) gets
// sent to the regular site instead, same as a logged-out one; their
// account, cart and favorites stay unaffected since those only need
// requireAuth. Volunteers are a superset of members (see requireVolunteer
// below), so they pass this check too.
function requireMember(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  const u = req.session.user;
  if (!u.isAdmin && !u.isMember && !u.isVolunteer) return res.redirect("/");
  next();
}

// The volunteer shift-signup calendar is narrower than requireMember —
// a plain member doesn't automatically get it, only someone an admin has
// specifically marked as a volunteer (or an admin themselves).
function requireVolunteer(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (!req.session.user.isAdmin && !req.session.user.isVolunteer) return res.redirect("/");
  next();
}

module.exports = { attachUser, requireAuth, requireAdmin, requireMember, requireVolunteer };
