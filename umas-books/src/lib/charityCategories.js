// Shared between the admin charity library/round management (src/routes/
// admin.js) and the public charity-idea submission form (src/routes/
// charity.js), so the two can't drift apart.
const CHARITY_CATEGORIES = ["Animals", "Children & Education", "Environment", "Women & Family", "Community", "Health", "Other"];

// French labels for the public pages (the stored value stays English).
const CHARITY_CATEGORIES_FR = {
  Animals: "Animaux",
  "Children & Education": "Enfance et éducation",
  Environment: "Environnement",
  "Women & Family": "Femmes et famille",
  Community: "Vie locale",
  Health: "Santé",
  Other: "Autre",
};

module.exports = { CHARITY_CATEGORIES, CHARITY_CATEGORIES_FR };
