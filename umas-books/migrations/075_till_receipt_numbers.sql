-- Receipts (tickets de caisse) carry a chronological number without gaps, per
-- Paris year. till_sales.id is a serial: it skips numbers after a rolled-back
-- sale, so it cannot be the receipt number. The number is taken inside the
-- sale's own transaction from a counter row that the transaction locks until
-- it commits (UPDATE ... RETURNING on the year's row), so two sales never get
-- the same number and a rolled-back sale gives its number back.
CREATE TABLE IF NOT EXISTS till_receipt_counters (
  year    INTEGER PRIMARY KEY,
  last_no INTEGER NOT NULL CHECK (last_no >= 0)
);

ALTER TABLE till_sales ADD COLUMN IF NOT EXISTS receipt_year INTEGER;
ALTER TABLE till_sales ADD COLUMN IF NOT EXISTS receipt_no INTEGER;

-- Sales made before this migration are numbered in the order they were recorded (id), per Paris year.
UPDATE till_sales s SET receipt_year = n.y, receipt_no = n.rn
FROM (
  SELECT id, EXTRACT(YEAR FROM created_at AT TIME ZONE 'Europe/Paris')::int AS y,
         ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM created_at AT TIME ZONE 'Europe/Paris') ORDER BY id)::int AS rn
  FROM till_sales
) n
WHERE s.id = n.id AND s.receipt_no IS NULL;

INSERT INTO till_receipt_counters (year, last_no)
SELECT receipt_year, MAX(receipt_no) FROM till_sales WHERE receipt_no IS NOT NULL GROUP BY receipt_year
ON CONFLICT (year) DO UPDATE SET last_no = GREATEST(till_receipt_counters.last_no, EXCLUDED.last_no);

CREATE UNIQUE INDEX IF NOT EXISTS uq_till_sales_receipt ON till_sales (receipt_year, receipt_no) WHERE receipt_no IS NOT NULL;
