// Shared between the admin charity library/round management (src/routes/
// admin.js) and the public charity-idea submission form (src/routes/
// charity.js), so the two can't drift apart.
const CHARITY_CATEGORIES = ["Animals", "Children & Education", "Environment", "Women & Family", "Community", "Health", "Other"];

module.exports = { CHARITY_CATEGORIES };
