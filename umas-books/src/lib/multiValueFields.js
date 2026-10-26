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
]);

module.exports = { MULTI_VALUE_BODY_FIELDS };
