-- One-time correction: every date/time typed into an admin form was read as
-- UTC (Render's server timezone) instead of France time, so "18:00" was
-- stored as 18:00Z — which is 20:00 in Paris in summer, 19:00 in winter.
-- From this release on, typed times are read as Europe/Paris (see
-- src/lib/tz.js); this shifts the rows already stored so they mean what was
-- typed. `x AT TIME ZONE 'UTC'` turns the stored instant back into the
-- wall-clock text that was typed (18:00); `AT TIME ZONE 'Europe/Paris'` then
-- reads that wall-clock as Paris time. Runs exactly once (tracked migrations).
--
-- Only values that were TYPED are shifted. Columns filled by the server with
-- now() (created_at, charity opens_at default, the published_at of an
-- already-published announcement) are real instants and are left alone.

UPDATE events
   SET starts_at = (starts_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris',
       ends_at   = (ends_at   AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris';

UPDATE classes
   SET starts_at = (starts_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris',
       ends_at   = (ends_at   AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris';

UPDATE volunteer_shifts
   SET starts_at = (starts_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris',
       ends_at   = (ends_at   AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris';

UPDATE meetings
   SET scheduled_at = (scheduled_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris';

-- A scheduled announcement's publish time was typed; a published one's is
-- the real moment it went out.
UPDATE announcements
   SET published_at = (published_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris'
 WHERE status = 'scheduled';

-- An open round's close time was typed; a closed round's may be the real
-- moment an admin ended it.
UPDATE charity_rounds
   SET closes_at = (closes_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris'
 WHERE is_active AND closes_at IS NOT NULL;
