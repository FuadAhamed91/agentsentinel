// Test harness: a real server on a random local port with in-memory SQLite (or Postgres
// when TEST_DATABASE_URL is set), mocked data sources and a controllable clock.
// The background timer is off; tests call sampler.tick() to take a sample round.

import { loadConfig } from '../src/config.js';
import { startServer } from '../src/bootstrap.js';

export const GATEWAY_SECRET = 'test-gateway-secret';
export const STATS_SECRET = 'test-stats-secret';

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
  const logger = { log() {}, warn() {}, error() {} };
  const srv = await startServer({ config, sources: mock.sources, clock: () => clock.now, logger, startSampler: false });
  if (process.env.TEST_DATABASE_URL) {
    await srv.db.query('DELETE FROM events');
    await srv.db.query('DELETE FROM checks');
    await srv.db.query('DELETE FROM samples');
    await srv.db.query('DELETE FROM watches');
    await srv.db.query("UPDATE sampler_lease SET owner = '', expires_at = 0");
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
    clock,
    base,
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
