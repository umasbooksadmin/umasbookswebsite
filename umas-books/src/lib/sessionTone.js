// Color-codes a session by track keyword, matching the age-group cards
// on the marketing immersion page (immersion.html) — shared by the
// public /sessions shop calendar and the /immersion/calendar read-only
// calendar so the two look consistent. Registered as an app.local (see
// src/index.js) so views can call it directly, same as formatTime.
function toneForClassTitle(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("little") || t.includes("explorer")) return "tone-a";
  if (t.includes("veil")) return "tone-b"; // matches "éveil" and "eveil"
  if (t.includes("adventurer")) return "tone-c";
  if (t.includes("reader")) return "tone-d";
  if (t.includes("teen")) return "tone-e";
  if (t.includes("caf") || t.includes("adult")) return "tone-f";
  return "tone-a";
}

module.exports = { toneForClassTitle };
