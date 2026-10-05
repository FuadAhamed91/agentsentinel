// Test harness: a real server on a random local port with in-memory SQLite (or Postgres
// when TEST_DATABASE_URL is set), mocked data sources and a controllable clock.
// The background timer is off; tests call sampler.tick() to take a sample round.

import { loadConfig } from '../src/config.js';
import { startServer } from '../src/bootstrap.js';
import { parseCatalog } from '../src/revenue/sources.js';

export const GATEWAY_SECRET = 'test-gateway-secret';
export const STATS_SECRET = 'test-stats-secret';

// Test chain: block n is produced at GENESIS + n * 2 s.
export const GENESIS = Date.UTC(2026, 9, 1, 0, 0, 0);
export const BLOCK_MS = 2000;
export const blockAt = (ms) => Math.floor((ms - GENESIS) / BLOCK_MS);

// Marketplace catalog and XDC chain for the merchant leaderboard.
// state.rows uses the public catalog's own field names; state.transfers are USDC
// transfers { block, payTo, amount (USDC), payer?, tx? }.
export function createMockMarket(clock) {
  const state = {
    rows: [],
    transfers: [],
    fail: { catalog: false, chain: false },
    maxRange: Infinity, // eth_getLogs block range limit
    calls: { catalog: 0, logs: 0, latest: 0, blockTs: 0, logRanges: [] },
  };
  let seq = 0;
  const catalogSource = async () => {
    state.calls.catalog += 1;
    if (state.fail.catalog) throw new Error('catalog down');
    return parseCatalog({ services: JSON.parse(JSON.stringify(state.rows)) });
  };
  const chain = {
    async latestBlock() {
      state.calls.latest += 1;
      if (state.fail.chain) throw new Error('rpc down');
      return blockAt(clock.now);
    },
    async blockTimestamp(n) {
      state.calls.blockTs += 1;
      if (state.fail.chain) throw new Error('rpc down');
      return GENESIS + n * BLOCK_MS;
    },
    async transfersTo(payTos, from, to) {
      state.calls.logs += 1;
      state.calls.logRanges.push([from, to, payTos.length]);
      if (state.fail.chain) throw new Error('rpc down');
      if (to - from + 1 > state.maxRange) throw new Error('Block range is too large');
      const set = new Set(payTos.map((p) => p.toLowerCase()));
      return state.transfers
        .filter((t) => t.block >= from && t.block <= to && set.has(t.payTo.toLowerCase()))
        .map((t) => ({
          txHash: t.tx,
          logIndex: t.logIndex ?? 0,
          blockNumber: t.block,
          payer: (t.payer || '0x' + '99'.repeat(20)).toLowerCase(),
          payTo: t.payTo.toLowerCase(),
          amountMicro: Math.round(t.amount * 1e6),
          ts: null,
        }));
    },
  };
  return {
    state,
    catalogSource,
    chain,
    // Adds a catalog row the way xdcai.tech/api/catalog lists one.
    listRoute({ provider, providerId, payTo, method = 'POST', path, price = '0.05', calls = 0, volume = 0 }) {
      state.rows.push({
        id: `${providerId}:${path}`,
        providerId,
        providerName: provider,
        url: `https://api.xdcai.tech/x402/connect/${providerId}${path}`,
        method,
        priceUSDC: String(price),
        capability: `${provider} ${path}`,
        tags: [],
        payTo,
        calls,
        volumeUSDC: volume,
      });
    },
    // Records a USDC payment into payTo at the given time (default: now).
    pay(payTo, amount, { at = clock.now, payer } = {}) {
      seq += 1;
      const t = { block: blockAt(at), payTo, amount, payer, tx: `0x${String(seq).padStart(64, '0')}` };
      state.transfers.push(t);
      return t;
    },
    bump(providerId, path, { calls = 1, volume = 0 } = {}) {
      const r = state.rows.find((x) => x.providerId === providerId && x.url.endsWith(path));
      r.calls += calls;
      r.volumeUSDC = Number((r.volumeUSDC + volume).toFixed(6));
    },
  };
}

export function createMockSources() {
  const state = {
    price: 0.05,
    gasWei: 12_500_000_000n,
    balances: new Map(), // 0x address -> wei (bigint)
    fail: { price: false, gas: false, balances: false },
    delayMs: { price: 0, gas: 0, balances: 0 },
    calls: { price: 0, gas: 0, balances: 0, balanceAddresses: [] },
  };
  const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);
  const sources = {
    async price() {
      state.calls.price += 1;
      await wait(state.delayMs.price);
      if (state.fail.price) throw new Error('price source down');
      return { value: state.price, origin: 'mock-price' };
    },
    async gasPrice() {
      state.calls.gas += 1;
      await wait(state.delayMs.gas);
      if (state.fail.gas) throw new Error('rpc down');
      return { wei: state.gasWei, origin: 'mock-rpc' };
    },
    async balances(addresses) {
      state.calls.balances += 1;
      state.calls.balanceAddresses.push([...addresses]);
      await wait(state.delayMs.balances);
      if (state.fail.balances) throw new Error('rpc down');
      return new Map(addresses.map((a) => [a, { wei: state.balances.get(a) ?? 0n, origin: 'mock-rpc' }]));
    },
  };
  return { state, sources };
}

export async function startTestServer({ env = {}, clockStart = Date.UTC(2026, 9, 5, 12, 0, 0) } = {}) {
  const clock = { now: clockStart };
  const config = loadConfig({
    PORT: '0',
    SQLITE_PATH: ':memory:',
    DATABASE_URL: process.env.TEST_DATABASE_URL || '',
    GATEWAY_SECRET,
    STATS_SECRET,
    TRUST_PROXY: 'false',
    ...env,
  });
  const mock = createMockSources();
  const market = createMockMarket(clock);
  const logger = { log() {}, warn() {}, error() {} };
  const srv = await startServer({
    config,
    sources: mock.sources,
    market: { catalogSource: market.catalogSource, chain: market.chain },
    clock: () => clock.now,
    logger,
    startSampler: false,
  });
  if (process.env.TEST_DATABASE_URL) {
    await srv.db.query('DELETE FROM events');
    await srv.db.query('DELETE FROM checks');
    await srv.db.query('DELETE FROM samples');
    await srv.db.query('DELETE FROM watches');
    await srv.db.query("UPDATE sampler_lease SET owner = '', expires_at = 0");
    for (const t of ['rev_routes', 'rev_route_changes', 'rev_payments', 'rev_index', 'rev_meta', 'rev_watches', 'rev_requests']) {
      await srv.db.query(`DELETE FROM ${t}`);
    }
  }
  const base = `http://127.0.0.1:${srv.port}`;

  async function request(method, path, body, { gateway = true, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(gateway ? { authorization: `Bearer ${GATEWAY_SECRET}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or empty */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  return {
    ...srv,
    mock,
    market,
    clock,
    base,
    // Advance the clock and run one catalog round and one chain round.
    async marketRound(ms = 0) {
      clock.now += ms;
      await srv.tracker.catalogTick();
      return srv.tracker.chainTick();
    },
    request,
    post: (path, body, opts) => request('POST', path, body, opts),
    get: (path, opts) => request('GET', path, undefined, opts),
    // Advance the clock by one interval and take one sample round.
    async round(ms = config.sampleIntervalMs) {
      clock.now += ms;
      return srv.sampler.tick();
    },
    async createWatch(body) {
      const r = await this.post('/watch', body);
      if (r.status !== 200) throw new Error(`watch creation failed: ${r.status} ${r.text}`);
      return r.json;
    },
    async check(tokens) {
      const r = await this.post('/check', { watch_tokens: Array.isArray(tokens) ? tokens : [tokens] });
      if (r.status !== 200) throw new Error(`check failed: ${r.status} ${r.text}`);
      return r.json;
    },
    config,
  };
}
