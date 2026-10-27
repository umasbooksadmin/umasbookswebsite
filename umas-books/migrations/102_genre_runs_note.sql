-- genre_runs.note: why a run is 'failed' when no error was caught (the server stopped mid-run: a crash, a deploy's
-- SIGTERM). lib/genreRun.js reapStaleRuns() marks such a run failed and says so here; Admin > Genres shows it as
-- "failed (interrupted)" and Undo stays available for the books that were already changed. Safe to re-run.
ALTER TABLE genre_runs ADD COLUMN IF NOT EXISTS note TEXT;
