// Runtime configuration from environment variables. Every variable is listed in .env.example.

const DEFAULT_RPC_URLS = [
  'https://rpc.xinfin.network',
  'https://erpc.xinfin.network',
  'https://rpc.ankr.com/xdc',
  'https://xdc.public-rpc.com',
];

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`invalid numeric configuration value: ${value}`);
  }
  return n;
}

function list(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
  const sampleIntervalSeconds = num(env.SAMPLE_INTERVAL_SECONDS, 15, { min: 1, max: 3600 });
  const dbMode = (env.SENTINEL_DB || '').toLowerCase();
  if (dbMode && dbMode !== 'sqlite' && dbMode !== 'postgres') {
    throw new Error('SENTINEL_DB must be "sqlite", "postgres" or empty');
  }
  if (dbMode === 'postgres' && !env.DATABASE_URL) {
    throw new Error('SENTINEL_DB=postgres needs DATABASE_URL');
  }
  return {
    port: num(env.PORT, 8080, { min: 0, max: 65535 }),
    // SENTINEL_DB=sqlite ignores DATABASE_URL (for example the paid production
    // database a host injects) and keeps data in the local SQLite file.
    databaseUrl: dbMode === 'sqlite' ? '' : env.DATABASE_URL || '',
    sqlitePath: env.SQLITE_PATH || './data/agentsentinel.sqlite',

    // Shared secret the XDC AI gateway sends as "Authorization: Bearer <secret>".
    gatewaySecret: env.GATEWAY_SECRET || '',
    // Key that signs watch tokens; derived from GATEWAY_SECRET when not set.
    tokenSecret: env.TOKEN_SECRET || '',
    // Optional: public gateway base URL (https://api.xdcai.tech/x402/connect/gw_...), reported in 401 bodies.
    gatewayPublicUrl: (env.GATEWAY_PUBLIC_URL || '').replace(/\/+$/, ''),
    statsSecret: env.STATS_SECRET || '',

    sampleIntervalMs: sampleIntervalSeconds * 1000,
    staleAfterMs: num(env.STALE_AFTER_SECONDS, 60, { min: 1 }) * 1000,
    sampleRetentionMs: num(env.SAMPLE_RETENTION_HOURS, 48, { min: 1 }) * 3600 * 1000,
    watchTtlMs: num(env.WATCH_TTL_DAYS, 30, { min: 1, max: 3650 }) * 24 * 3600 * 1000,
    sourceTimeoutMs: num(env.SOURCE_TIMEOUT_MS, 6000, { min: 500, max: 60000 }),
    // Longest time POST /watch waits for a first sample of a series nobody samples yet.
    createFetchWaitMs: num(env.CREATE_FETCH_WAIT_MS, 4000, { min: 0, max: 30000 }),

    rpcUrls: list(env.XDC_RPC_URLS, DEFAULT_RPC_URLS),
    priceSources: list(env.PRICE_SOURCES, ['kraken', 'coingecko', 'coinpaprika']),
    coingeckoApiKey: env.COINGECKO_API_KEY || '',

    trustProxy: env.TRUST_PROXY ?? '1',
    rateLimitIpPerMinute: num(env.RATE_LIMIT_IP_PER_MINUTE, 120, { min: 1 }),
    rateLimitTokenPerMinute: num(env.RATE_LIMIT_TOKEN_PER_MINUTE, 60, { min: 1 }),
    maxTokensPerRequest: num(env.MAX_TOKENS_PER_REQUEST, 50, { min: 1, max: 500 }),
    maxActiveWatches: num(env.MAX_ACTIVE_WATCHES, 100000, { min: 1 }),
    maxWalletAddresses: num(env.MAX_WALLET_ADDRESSES, 2000, { min: 1 }),
    maxTriggersPerReport: num(env.MAX_TRIGGERS_PER_REPORT, 20, { min: 1, max: 500 }),
  };
}
