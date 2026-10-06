-- Accounting export: which accounts (comptes) each category and payment method
-- goes to, edited by an admin at /admin/reports/accounting/mapping. The defaults
-- are a starting point to be confirmed with the treasurer.
CREATE TABLE IF NOT EXISTS accounting_map (
  category       TEXT NOT NULL,
  method         TEXT NOT NULL,
  debit_account  TEXT NOT NULL CHECK (char_length(debit_account) BETWEEN 1 AND 20),
  credit_account TEXT NOT NULL CHECK (char_length(credit_account) BETWEEN 1 AND 20),
  journal        TEXT NOT NULL DEFAULT 'VT' CHECK (char_length(journal) BETWEEN 1 AND 10),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (category, method)
);
