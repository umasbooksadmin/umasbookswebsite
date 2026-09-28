-- Volunteers are a new account tier, a superset of members: anything a
-- member can access, a volunteer can access too, plus the volunteer
-- shift-signup calendar (see middleware/auth.js requireMember and the
-- new requireVolunteer). Independent of is_member — an admin grants it
-- by hand in Admin > Accounts, not through HelloAsso like membership.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_volunteer BOOLEAN NOT NULL DEFAULT false;
