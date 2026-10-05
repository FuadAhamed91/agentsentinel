// Watches survive the loss of stored data: each signed token rebuilds its watch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { loadConfig } from '../src/config.js';

test('SENTINEL_DB=sqlite ignores an injected DATABASE_URL', () => {
  const env = { DATABASE_URL: 'postgres://u:p@db.example:5432/x' };
  assert.equal(loadConfig(env).databaseUrl, env.DATABASE_URL);
  assert.equal(loadConfig({ ...env, SENTINEL_DB: 'sqlite' }).databaseUrl, '');
  assert.throws(() => loadConfig({ SENTINEL_DB: 'postgres' }));
  assert.throws(() => loadConfig({ SENTINEL_DB: 'mysql' }));
});

const SIGNED = /^wt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

async function wipe(s) {
  for (const t of ['events', 'checks', 'watches']) await s.db.query(`DELETE FROM ${t}`);
}

test('tokens are signed and carry the watch definition', async () => {
  const s = await startTestServer();
  try {
    await s.round();
    const w = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 0.08 });
    assert.match(w.watch_token, SIGNED);
    const payload = JSON.parse(Buffer.from(w.watch_token.slice(3).split('.')[0], 'base64url').toString());
    assert.equal(payload.i, w.watch_id);
    assert.equal(payload.t, 'xdc_price');
    assert.equal(payload.h, 0.08);
  } finally {
    await s.close();
  }
});

test('after stored data is lost, check rebuilds each watch from its token and keeps monitoring', async () => {
  const s = await startTestServer();
  try {
    const addr = '0x' + '5a'.repeat(20);
    s.mock.state.price = 0.05;
    s.mock.state.balances.set(addr, 10n * 10n ** 18n);
    await s.round();
    const price = await s.createWatch({ type: 'xdc_price', condition: 'crosses_above', threshold: 0.06 });
    const wallet = await s.createWatch({ type: 'wallet_balance', address: `xdc${addr.slice(2)}`, condition: 'below', threshold: 5 });

    await wipe(s);
    const res = await s.check([price.watch_token, wallet.watch_token]);
    const [p, b] = res.results;
    assert.equal(p.status, 'active');
    assert.equal(p.watch_id, price.watch_id);
    assert.equal(p.condition, 'crosses_above');
    assert.equal(p.threshold, 0.06);
    assert.equal(p.created_at, price.created_at);
    assert.equal(p.expires_at, price.expires_at);
    assert.equal(p.history_reset_at, new Date(s.clock.now).toISOString());
    assert.equal(p.current_value, 0.05);
    assert.equal(b.status, 'active');
    assert.equal(b.address, addr);
    assert.equal(b.threshold, 5);

    // Monitoring continues normally after the rebuild.
    s.mock.state.price = 0.065;
    s.mock.state.balances.set(addr, 2n * 10n ** 18n);
    await s.round();
    const after = await s.check([price.watch_token, wallet.watch_token]);
    assert.equal(after.results[0].triggered, true);
    assert.equal(after.results[0].triggers_since_last_check[0].kind, 'crossed_above');
    assert.equal(after.results[1].triggered, true);
    assert.equal(after.results[1].triggers_since_last_check[0].value, 2);
    const [{ n }] = await s.db.query('SELECT COUNT(*) AS n FROM watches');
    assert.equal(Number(n), 2, 'rebuilt once, not duplicated');
  } finally {
    await s.close();
  }
});

test('a restarted server with an empty database and the same secret rebuilds watches', async () => {
  const first = await startTestServer();
  let token;
  let watchId;
  try {
    await first.round();
    const w = await first.createWatch({ type: 'xdc_gas', condition: 'above', threshold: 30 });
    token = w.watch_token;
    watchId = w.watch_id;
  } finally {
    await first.close();
  }
  const second = await startTestServer(); // fresh in-memory database, same GATEWAY_SECRET
  try {
    await second.round();
    const st = await second.post('/watches', { watch_token: token });
    assert.equal(st.json.results[0].status, 'active');
    assert.equal(st.json.results[0].watch_id, watchId);
    assert.ok(st.json.results[0].history_reset_at);
    const ev = await second.post('/events', { watch_token: token });
    assert.equal(ev.json.results[0].status, 'active');
  } finally {
    await second.close();
  }
});

test('tokens that were altered or signed with another key are not accepted', async () => {
  const s = await startTestServer();
  const other = await startTestServer({ env: { GATEWAY_SECRET: 'a-different-gateway-secret' } });
  try {
    await s.round();
    const w = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 0.08 });
    const [payload, sig] = w.watch_token.slice(3).split('.');
    const spec = JSON.parse(Buffer.from(payload, 'base64url').toString());
    spec.h = 0.01;
    const edited = `wt_${Buffer.from(JSON.stringify(spec)).toString('base64url')}.${sig}`;
    await wipe(s);
    const r = await s.post('/check', { watch_tokens: [edited] });
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].status, 'unknown_token');

    await other.round();
    const elsewhere = await other.post('/check', { watch_tokens: [w.watch_token] }, {
      gateway: false,
      headers: { authorization: 'Bearer a-different-gateway-secret' },
    });
    assert.equal(elsewhere.status, 200);
    assert.equal(elsewhere.json.results[0].status, 'unknown_token');
    const [{ n }] = await other.db.query('SELECT COUNT(*) AS n FROM watches');
    assert.equal(Number(n), 0);
  } finally {
    await s.close();
    await other.close();
  }
});

test('an expired token is rebuilt as expired; a rebuilt watch can be cancelled', async () => {
  const s = await startTestServer();
  try {
    await s.round();
    const old = await s.createWatch({ type: 'xdc_price', condition: 'below', threshold: 0.01 });
    const live = await s.createWatch({ type: 'xdc_price', condition: 'below', threshold: 0.02 });
    await wipe(s);
    s.clock.now += s.config.watchTtlMs + 1000;
    const r = await s.check([old.watch_token]);
    assert.equal(r.results[0].status, 'expired');

    const fresh = await s.createWatch({ type: 'xdc_price', condition: 'below', threshold: 0.03 });
    await wipe(s);
    const c = await s.post('/cancel', { watch_token: fresh.watch_token });
    assert.equal(c.json.results[0].status, 'cancelled');
    assert.equal(c.json.results[0].watch_id, fresh.watch_id);
    assert.equal((await s.check([live.watch_token])).results[0].status, 'expired');
  } finally {
    await s.close();
  }
});
