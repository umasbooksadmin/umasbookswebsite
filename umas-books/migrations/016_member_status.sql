-- A logged-in account and being a paying/dues member aren't the same
-- thing (every account already gets "Member's Access" to the dashboard
-- regardless). This flag is set manually by an admin from
-- /admin/members and is what features like a random "recommended book"
-- drawn from members' favorites will key off of.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_member BOOLEAN NOT NULL DEFAULT FALSE;
