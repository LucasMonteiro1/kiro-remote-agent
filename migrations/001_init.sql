-- Optional durability backup for the hub's in-memory event log (see
-- src/hub.ts's flushToPostgres). Only needed if you set DATABASE_URL in
-- the daemon's .env; if unset, the hub runs fully in-memory and this
-- table is never touched.
--
-- Unlike the old kiro-remote-relay design, this is a write-behind cache,
-- not a read path: nothing ever queries this table on a hot path. Its
-- only purpose is letting the daemon reload recent history after a
-- restart, if you choose to wire that up (not implemented by default —
-- the hub starts with an empty in-memory log on every restart).
CREATE TABLE IF NOT EXISTS events (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  session_id TEXT NULL,
  created_at BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_created ON events (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at);
