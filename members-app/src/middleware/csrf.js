const crypto = require("crypto");

function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (req.method === "POST") {
    const token = req.body && req.body._csrf;
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).send("Your session expired or this form is out of date. Please go back and try again.");
    }
  }
  next();
}

module.exports = { csrfProtection };
