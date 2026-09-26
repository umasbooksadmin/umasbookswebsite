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
// dashboard (forum, charity vote, volunteer/meeting scheduling) is a paid
// membership perk. A logged-in visitor who isn't a member (or admin) gets
// sent to the regular site instead, same as a logged-out one; their
// account, cart and favorites stay unaffected since those only need
// requireAuth.
function requireMember(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (!req.session.user.isAdmin && !req.session.user.isMember) return res.redirect("/");
  next();
}

module.exports = { attachUser, requireAuth, requireAdmin, requireMember };
