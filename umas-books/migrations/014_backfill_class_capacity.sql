-- Existing sessions created before capacity became required at setup
-- (see src/routes/admin.js) are still NULL, which makes the public
-- calendar fall back to showing "N signed up" instead of "N spots left".
-- Default them to 5, same as the admin form's new default, so the
-- calendar shows spots left for every session going forward.

UPDATE classes SET capacity = 5 WHERE capacity IS NULL;
