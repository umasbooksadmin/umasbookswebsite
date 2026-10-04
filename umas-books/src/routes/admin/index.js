const express = require("express");

const router = express.Router();

// Split by domain rather than kept as one file — each of these owns a
// distinct area of the admin panel and shares no routes or state with the
// others. Order doesn't matter: paths don't overlap across domains.
router.use(require("./dashboard"));
router.use(require("./members"));
router.use(require("./announcements"));
router.use(require("./blog"));
router.use(require("./volunteerShifts"));
router.use(require("./meetings"));
router.use(require("./events"));
router.use(require("./sessions"));
router.use(require("./charity"));
router.use(require("./inventory"));
router.use(require("./reports"));
router.use(require("./audit"));
router.use(require("./requests"));

module.exports = router;
