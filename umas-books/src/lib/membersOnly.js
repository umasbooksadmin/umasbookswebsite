// What a person who may not open a members-only page is told. Until this
// existed, an account holder who was not a member was silently sent to the home
// page ("did the link break?") and a guest to the log-in page with no reason.
//
//   - A guest opening a page (GET) is sent to log in, with returnTo so the
//     login lands back here; the log-in page explains why (views/partials/return_note.ejs).
//   - A logged-in account that is not a member (volunteers: not a volunteer)
//     gets a short page, HTTP 403, with the button that fits (membership page;
//     for the volunteer calendar, the volunteer sign-up form).
//   - Anything that is not a GET (a form post, which only a crafted request can
//     send here) keeps the old quiet redirect: nothing to explain, nothing done.
const { safeReturnTo } = require("./returnTo");

const isRead = (req) => req.method === "GET" || req.method === "HEAD";

function refuseMembersOnly(req, res, { area = "members" } = {}) {
  const user = req.session && req.session.user;
  if (!isRead(req)) return res.redirect(user ? "/" : "/login");
  if (!user) {
    const back = safeReturnTo(req.originalUrl);
    return res.redirect(back ? `/login?returnTo=${encodeURIComponent(back)}` : "/login");
  }
  res.set("Cache-Control", "private, no-store");
  return res.status(403).render("members_only", { area });
}

module.exports = { refuseMembersOnly };
