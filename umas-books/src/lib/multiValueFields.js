// The form fields that are genuinely meant to arrive more than once (a checkbox list, a multi-select). Everything else
// that a form repeats collapses to its FIRST value in app.js (a repeated "email" would otherwise be an array that every
// handler's .trim() chokes on). A route that reads a repeated field must have its name here AND defend itself with
// [].concat(req.body.name || []); test/unit/multiValueFields.test.js reads the views and fails when a repeated field
// name is missing from this list.
//   optionIds     charity vote options        ids, itemIds   bulk-action checkbox lists
//   days, times   the pre-registration form   accept        Admin > Genres: the AI suggestions the admin ticked
const MULTI_VALUE_BODY_FIELDS = new Set(["optionIds", "ids", "days", "times", "itemIds", "accept"]);

module.exports = { MULTI_VALUE_BODY_FIELDS };
