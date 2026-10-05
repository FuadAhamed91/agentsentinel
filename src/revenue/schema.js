// Tables for the merchant leaderboard. Same column conventions as src/db/index.js:
// millisecond timestamps in BIGINT, USDC amounts on-chain in micro-USDC (6 decimals).

export function revenueSchema(kind) {
  const id = kind === 'postgres' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return `
CREATE TABLE IF NOT EXISTS rev_routes (
  route_key TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  price_usdc DOUBLE PRECISION NOT NULL,
  pay_to TEXT NOT NULL,
  calls BIGINT NOT NULL,
  volume_usdc DOUBLE PRECISION NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  listed INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS rev_routes_pay_to ON rev_routes (pay_to);

CREATE TABLE IF NOT EXISTS rev_route_changes (
  id ${id},
  route_key TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  ts BIGINT NOT NULL,
  calls_delta BIGINT NOT NULL,
  volume_delta DOUBLE PRECISION NOT NULL,
  price_usdc DOUBLE PRECISION NOT NULL,
  previous_price_usdc DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS rev_route_changes_ts ON rev_route_changes (ts);

CREATE TABLE IF NOT EXISTS rev_payments (
  id ${id},
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  ts BIGINT NOT NULL,
  payer TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  amount_micro BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rev_payments_tx_log ON rev_payments (tx_hash, log_index);
CREATE INDEX IF NOT EXISTS rev_payments_pay_to_ts ON rev_payments (pay_to, ts);
CREATE INDEX IF NOT EXISTS rev_payments_ts ON rev_payments (ts);

CREATE TABLE IF NOT EXISTS rev_index (
  pay_to TEXT PRIMARY KEY,
  indexed_to BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rev_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS rev_watches (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  ended_at BIGINT,
  last_check_at BIGINT,
  last_payment_id BIGINT NOT NULL DEFAULT 0,
  last_ranks TEXT,
  last_revenue_micro BIGINT,
  check_count INTEGER NOT NULL DEFAULT 0,
  restored_at BIGINT,
  via_gateway INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rev_requests (
  id ${id},
  route TEXT NOT NULL,
  ts BIGINT NOT NULL,
  via_gateway INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rev_requests_ts ON rev_requests (ts);
`;
}
