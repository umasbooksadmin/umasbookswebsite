// Display formatting helpers, exposed to every EJS view via app.locals.
// Fixed to en-GB (DD/MM/YYYY, 24-hour clock) rather than relying on the
// server's default locale, since Uma's Books is in France. Values fed to
// <input type="date"> still use ISO (YYYY-MM-DD) elsewhere — that's an
// HTML input requirement, not a display choice, so it's untouched here.

function formatDate(d) {
  return new Date(d).toLocaleDateString("en-GB");
}

function formatDateTime(d) {
  return new Date(d).toLocaleString("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

module.exports = { formatDate, formatDateTime, formatTime };
