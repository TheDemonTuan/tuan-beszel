CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY NOT NULL,
  last_seen INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'error')),
  total INTEGER NOT NULL CHECK (total >= 0),
  up INTEGER NOT NULL CHECK (up >= 0),
  down INTEGER NOT NULL CHECK (down >= 0),
  paused INTEGER NOT NULL CHECK (paused >= 0),
  pending INTEGER NOT NULL CHECK (pending >= 0)
);
