-- Privacy tidy-up. price_reprice_runs used to store the admin's EMAIL in
-- actor_label forever. From now on a run records the admin account (actor_user_id,
-- set to NULL if the account is erased) and a non-personal role label.
-- Existing labels older than 12 months are erased here; the daily retention
-- purge (lib/privacy.js, step "repriceActors") erases the rest at 12 months.
ALTER TABLE price_reprice_runs ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'admin';

UPDATE price_reprice_runs SET actor_user_id = NULL
WHERE actor_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = price_reprice_runs.actor_user_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_reprice_runs_actor_user_fk') THEN
    ALTER TABLE price_reprice_runs
      ADD CONSTRAINT price_reprice_runs_actor_user_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE price_reprice_runs SET actor_label = NULL
WHERE actor_label IS NOT NULL AND created_at < now() - interval '12 months';
