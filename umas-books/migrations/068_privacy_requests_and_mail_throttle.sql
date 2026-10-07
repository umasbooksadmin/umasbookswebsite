-- Second security/privacy review.
--
-- 1. email_outbox.subject_email: the address of the PERSON a stored message is
--    about, when that is not the recipient. Form mail (kind 'contact': the
--    pre-registration with a child's name and date of birth, the volunteer
--    sign-up, the contact form) is addressed to the shop inbox, so matching on
--    to_email alone could never find it when a submitter asks for erasure.
--    Set by lib/outbox.js for kind 'contact' (the form's Reply-To address) and
--    matched by eraseOutboxFor and the admin "Privacy requests" tool.
--    Back-filled below from the stored Reply-To of rows not yet purged.
-- 2. email_outbox.status 'expired': a pending mail carrying a one-time link
--    (password reset 1 h, confirmation 24 h) whose link has lapsed. It is not
--    sent any more and its body is blanked (lib/outbox.js expireStaleTokenMail).
-- 3. Indexes for the per-recipient mail throttle and the address lookups.

ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS subject_email TEXT;

UPDATE email_outbox
SET subject_email = lower(headers -> 'replyTo' ->> 'address')
WHERE kind = 'contact' AND subject_email IS NULL AND purged_at IS NULL
  AND headers -> 'replyTo' ->> 'address' IS NOT NULL;

ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_status_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'handled', 'expired'));

CREATE INDEX IF NOT EXISTS idx_email_outbox_subject_email ON email_outbox (lower(subject_email)) WHERE subject_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_outbox_recipient ON email_outbox (lower(to_email), kind, created_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_kind_created ON email_outbox (kind, created_at);
