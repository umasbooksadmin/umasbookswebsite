-- Publisher's printed price (prix éditeur) for NEW books. French fixed book
-- price law (loi Lang, n° 81-766): a new book is sold at that price, with at
-- most 5% off. NULL for used copies, which are free-priced.
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS publisher_price NUMERIC(10,2);
