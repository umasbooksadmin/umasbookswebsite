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

module.exports = { attachUser, requireAuth, requireAdmin };
