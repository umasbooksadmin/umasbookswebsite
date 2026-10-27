// Form fields that are MEANT to arrive more than once (a checkbox list, a row of hidden ids).
//
// src/app.js collapses every other repeated urlencoded field to its first value, so a stray duplicate
// cannot crash a handler that expects a string. A field that a handler reads as a list MUST be named
// here, or only its first value ever reaches the handler: that is how "Approve" on several books of a
// collection saved only one of them. test/unit/multiValueFields.test.js fails when a route reads
// [].concat(req.body.X) and X is missing from this list.
const MULTI_VALUE_BODY_FIELDS = new Set([
  "optionIds", // charity vote (multi-choice)
  "ids", // bulk actions: announcements, blog, collection review (every book shown)
  "itemIds", // order: collect only the ticked items
  "days", "times", // pre-registration form
  "approve", "reject", // collection review: one checkbox per book
  "accept", // Admin > Genres: the AI proposals the admin ticked
]);

// Every repeated field not named above collapses to its first value, and a nested value (multipart bodies parse
// "a[b]=1" into an object) is dropped: handlers read each field as a string. Used for urlencoded bodies (app.js) and,
// after multer, for multipart ones. Mutates and returns `body`.
function collapseRepeatedFields(body) {
  if (!body || typeof body !== "object") return body;
  for (const key of Object.keys(body)) {
    let v = body[key];
    if (Array.isArray(v) && !MULTI_VALUE_BODY_FIELDS.has(key)) v = v[0];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) { delete body[key]; continue; }
    body[key] = v;
  }
  return body;
}

// Limits shared by every multer instance (src/app.js): a hostile multipart request cannot make the server buffer an
// unbounded number of fields or one huge text field in memory. `fieldSize` is per text field (the file size limits
// stay per instance): 64 KB for ordinary text, 256 KB where a rich-text body (a blog post or announcement, in either
// language) is edited.
const MULTIPART_LIMITS = { fields: 200, parts: 210, fieldSize: 64 * 1024 };
const MULTIPART_RICH_TEXT_FIELD_SIZE = 256 * 1024;

module.exports = { MULTI_VALUE_BODY_FIELDS, collapseRepeatedFields, MULTIPART_LIMITS, MULTIPART_RICH_TEXT_FIELD_SIZE };
