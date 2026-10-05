import { openPostgres } from './postgres.js';
import { openSqlite } from './sqlite.js';
import { revenueSchema } from '../revenue/schema.js';

// Column types are chosen to mean the same thing in Postgres and SQLite.
// Only the auto-increment primary key differs.
function schema(kind) {
  const id = kind === 'postgres' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return `
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  cond TEXT NOT NULL,
  threshold DOUBLE PRECISION,
  percent DOUBLE PRECISION,
  direction TEXT,
  address TEXT,
  source_key TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  ended_at BIGINT,
  last_value DOUBLE PRECISION,
  last_raw TEXT,
  last_eval_sample_id BIGINT NOT NULL DEFAULT 0,
  in_alert INTEGER NOT NULL DEFAULT 0,
  reference_value DOUBLE PRECISION,
  reference_time BIGINT,
  window_high DOUBLE PRECISION,
  window_low DOUBLE PRECISION,
  window_count INTEGER NOT NULL DEFAULT 0,
  last_check_at BIGINT,
  last_check_event_id BIGINT NOT NULL DEFAULT 0,
  check_count INTEGER NOT NULL DEFAULT 0,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  via_gateway INTEGER NOT NULL DEFAULT 0,
  restored_at BIGINT
);
CREATE INDEX IF NOT EXISTS watches_source_status ON watches (source_key, status);
CREATE INDEX IF NOT EXISTS watches_status_expires ON watches (status, expires_at);

CREATE TABLE IF NOT EXISTS samples (
  id ${id},
  source_key TEXT NOT NULL,
  ts BIGINT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  raw TEXT,
  origin TEXT
);
CREATE INDEX IF NOT EXISTS samples_source_id ON samples (source_key, id);
CREATE INDEX IF NOT EXISTS samples_source_ts ON samples (source_key, ts);
CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);

CREATE TABLE IF NOT EXISTS events (
  id ${id},
  watch_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  kind TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  previous_value DOUBLE PRECISION,
  reference_value DOUBLE PRECISION,
  sample_id BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_watch_id ON events (watch_id, id);

CREATE TABLE IF NOT EXISTS checks (
  id ${id},
  watch_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  triggered INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  via_gateway INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS checks_ts ON checks (ts);

CREATE TABLE IF NOT EXISTS sampler_lease (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
`;
}

// Columns added after the first release, for databases created before them.
async function migrate(db) {
  if (db.kind === 'postgres') {
    await db.exec('ALTER TABLE watches ADD COLUMN IF NOT EXISTS restored_at BIGINT');
    return;
  }
  const cols = await db.query('PRAGMA table_info(watches)');
  if (!cols.some((c) => c.name === 'restored_at')) {
    await db.exec('ALTER TABLE watches ADD COLUMN restored_at BIGINT');
  }
}

export async function openDatabase({ databaseUrl, sqlitePath }) {
  const db = databaseUrl ? await openPostgres(databaseUrl) : await openSqlite(sqlitePath);
  await db.exec(schema(db.kind));
  await migrate(db);
  await db.exec(revenueSchema(db.kind));
  return db;
}
