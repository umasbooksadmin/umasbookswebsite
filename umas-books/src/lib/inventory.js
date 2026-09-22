// Shared vocab for book-copy condition/status, used by both the admin
// routes (to validate/default incoming values) and the views (to build
// the <select> dropdowns) so the two never drift apart.

const CONDITIONS = [
  { value: "new", label: "New" },
  { value: "like_new", label: "Like New" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "poor", label: "Poor" },
];

const STATUSES = [
  { value: "in_stock", label: "In Store" },
  { value: "reserved", label: "Reserved" },
  { value: "sold", label: "Sold" },
  { value: "donated", label: "Donated" },
  { value: "damaged", label: "Damaged / withdrawn" },
];

const CONDITION_VALUES = new Set(CONDITIONS.map((c) => c.value));
const STATUS_VALUES = new Set(STATUSES.map((s) => s.value));

function normalizeCondition(value) {
  return CONDITION_VALUES.has(value) ? value : "good";
}

function normalizeStatus(value) {
  return STATUS_VALUES.has(value) ? value : "in_stock";
}

module.exports = { CONDITIONS, STATUSES, normalizeCondition, normalizeStatus };
