-- Adds acquisition cost tracking and public reservations to book copies.
-- A copy can only be reserved by one person at a time, so the reservation
-- lives directly on the copy row rather than a separate join table.

ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS acquisition_cost NUMERIC(10,2);
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS reserved_by_name TEXT;
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS reserved_by_email TEXT;
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS reserved_by_phone TEXT;
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;
