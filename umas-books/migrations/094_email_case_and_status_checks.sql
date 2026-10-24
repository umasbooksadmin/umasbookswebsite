-- Small database safeguards (Review C, L2 and L3). Written so the deploy can NEVER fail on them:
-- every step first looks at the existing data and, if it would not fit, skips itself with a NOTICE.
--
-- L2. users.email has a case-sensitive UNIQUE, but login, reset and signup look accounts up with
--     lower(email), so "A@x.org" and "a@x.org" could both exist and one could never log in. A UNIQUE
--     index on lower(email) makes that impossible. Created only when no two existing accounts already
--     collide once lower-cased (otherwise: NOTICE, no index; an admin merges the accounts, redeploys).
--
-- L3. CHECK constraints on four status / method columns, with EXACTLY the values the code writes today
--     (test/unit/statusCheckSets.test.js scans the code and compares):
--       orders.status            pending reserved paid cancelled expired refunded
--       orders.payment_method    NULL, or cash card cheque other (orderActions.PAYMENT_METHODS)
--                                plus helloasso online (old online orders, see lib/accounting.js)
--       book_copies.status       in_stock reserved sold donated damaged in_cart
--       class_dropin_seats.status in_cart reserved sold released
--     Each is added NOT VALID (new and changed rows are checked at once, existing rows are not scanned
--     under a heavy lock) and then VALIDATEd. If an existing row has another value the constraint is
--     skipped (NOTICE), and if one slipped in between the two steps the constraint stays NOT VALID,
--     which still guards every new write. Re-runnable: an existing constraint is left alone.

DO $$
DECLARE
  dup_count integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_users_email_lower_unique') THEN
    RETURN;
  END IF;
  SELECT count(*) INTO dup_count FROM (
    SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE NOTICE 'Skipping idx_users_email_lower_unique: % e-mail address(es) exist more than once when lower-cased. Merge those accounts, then create the index by hand: CREATE UNIQUE INDEX idx_users_email_lower_unique ON users (lower(email));', dup_count;
    RETURN;
  END IF;
  BEGIN
    CREATE UNIQUE INDEX idx_users_email_lower_unique ON users (lower(email));
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'Skipping idx_users_email_lower_unique: a duplicate appeared while it was being built.';
  END;
END $$;

DO $$
DECLARE
  spec record;
  bad integer;
  list text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('orders',             'status',         'orders_status_check',             ARRAY['pending','reserved','paid','cancelled','expired','refunded']),
      ('orders',             'payment_method', 'orders_payment_method_check',     ARRAY['cash','card','cheque','other','helloasso','online']),
      ('book_copies',        'status',         'book_copies_status_check',        ARRAY['in_stock','reserved','sold','donated','damaged','in_cart']),
      ('class_dropin_seats', 'status',         'class_dropin_seats_status_check', ARRAY['in_cart','reserved','sold','released'])
    ) AS t(tbl, col, cname, vals)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = spec.cname AND conrelid = ('public.' || spec.tbl)::regclass) THEN
      CONTINUE;
    END IF;
    -- NULL passes a CHECK, so only a real, different value counts as a violation.
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IS NOT NULL AND NOT (%I = ANY ($1))', spec.tbl, spec.col, spec.col)
      INTO bad USING spec.vals;
    IF bad > 0 THEN
      RAISE NOTICE 'Skipping %: % row(s) of %.% hold a value outside (%).', spec.cname, bad, spec.tbl, spec.col, array_to_string(spec.vals, ', ');
      CONTINUE;
    END IF;
    SELECT string_agg(quote_literal(v), ', ') INTO list FROM unnest(spec.vals) AS v;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IN (%s)) NOT VALID', spec.tbl, spec.cname, spec.col, list);
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', spec.tbl, spec.cname);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE '%: left NOT VALID (it guards new rows; an old row does not fit).', spec.cname;
    END;
  END LOOP;
END $$;
