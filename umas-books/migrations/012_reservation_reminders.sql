-- Tracks whether the "3 days left to pick up" reminder email has been
-- sent for a reservation, so the periodic check (every ~6h) doesn't
-- send it more than once.

ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
