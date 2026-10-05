// GET /xdc snapshot and the default watch for an empty POST /watch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const MIN = 60 * 1000;

test('GET /xdc reports current price and gas with 1h and 24h ranges from stored samples', async () => {
  const s = await startTestServer();
  try {
    // One sample every 10 minutes for 2 hours.
    const prices = [0.030, 0.031, 0.029, 0.033, 0.032, 0.035, 0.034, 0.036, 0.031, 0.030, 0.037, 0.036, 0.038];
    const gas = [12, 12, 13, 13, 14, 14, 15, 15, 16, 16, 15, 14, 13];
    for (let i = 0; i < prices.length; i++) {
      s.mock.state.price = prices[i];
      s.mock.state.gasWei = BigInt(gas[i]) * 1_000_000_000n;
      await s.round(10 * MIN);
    }
    const r = await s.get('/xdc');
    assert.equal(r.status, 200);
    const j = r.json;
    assert.equal(j.xdc_usd, 0.038);
    assert.equal(j.xdc_usd_stale, false);
    assert.equal(j.xdc_usd_source, 'mock-price');
    // The sample exactly one hour earlier is prices[6] = 0.034.
    assert.equal(j.xdc_usd_change_1h_percent, Number((((0.038 - 0.034) / 0.034) * 100).toFixed(4)));
    assert.equal(j.xdc_usd_high_1h, 0.038);
    assert.equal(j.xdc_usd_low_1h, 0.030);
    // History is two hours long, so there is no sample 24h back.
    assert.equal(j.xdc_usd_change_24h_percent, null);
    assert.equal(j.xdc_usd_high_24h, 0.038);
    assert.equal(j.xdc_usd_low_24h, 0.029);
    assert.equal(j.xdc_usd_samples_24h, prices.length);
    assert.equal(j.xdc_usd_history_from, new Date(s.clock.now - 120 * MIN).toISOString());
    assert.equal(j.gas_price_gwei, 13);
    assert.equal(j.gas_price_high_24h_gwei, 16);
    assert.equal(j.gas_price_low_24h_gwei, 12);
    assert.equal(j.sample_interval_seconds, 15);

    const direct = await s.get('/xdc', { gateway: false });
    assert.equal(direct.status, 401, 'paid route');
  } finally {
    await s.close();
  }
});

test('GET /xdc on a fresh server fetches a first value instead of returning nothing', async () => {
  const s = await startTestServer();
  try {
    s.mock.state.price = 0.0331;
    const r = await s.get('/xdc');
    assert.equal(r.status, 200);
    assert.equal(r.json.xdc_usd, 0.0331);
    assert.equal(r.json.gas_price_gwei, 12.5);
    assert.equal(r.json.xdc_usd_change_1h_percent, null);
    assert.equal(r.json.xdc_usd_samples_24h, 1);
  } finally {
    await s.close();
  }
});

test('GET /xdc with every source down still answers 200 with null values and stale flags', async () => {
  const s = await startTestServer();
  try {
    s.mock.state.fail.price = true;
    s.mock.state.fail.gas = true;
    const r = await s.get('/xdc');
    assert.equal(r.status, 200);
    assert.equal(r.json.xdc_usd, null);
    assert.equal(r.json.xdc_usd_stale, true);
    assert.equal(r.json.gas_price_gwei, null);
    assert.equal(r.json.gas_price_stale, true);
  } finally {
    await s.close();
  }
});

test('POST /watch with no body or {} creates the default watch; partial bodies are still rejected', async () => {
  const s = await startTestServer();
  try {
    s.mock.state.price = 0.05;
    await s.round();
    for (const body of [undefined, {}]) {
      const r = await s.post('/watch', body);
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.equal(r.json.type, 'xdc_price');
      assert.equal(r.json.condition, 'changes_by_percent');
      assert.equal(r.json.percent, 1);
      assert.equal(r.json.direction, 'any');
      assert.equal(r.json.default_watch, true);
      assert.equal(r.json.current_value, 0.05);
    }
    const partial = await s.post('/watch', { type: 'xdc_price' });
    assert.equal(partial.status, 400);
    assert.equal(partial.json.field, 'condition');
    const normal = await s.post('/watch', { type: 'xdc_price', condition: 'above', threshold: 1 });
    assert.equal(normal.json.default_watch, undefined);

    // The default watch triggers on a 1% move.
    const def = await s.post('/watch', {});
    s.mock.state.price = 0.0506;
    await s.round();
    const c = await s.check(def.json.watch_token);
    assert.equal(c.results[0].triggered, true);
    assert.equal(c.results[0].triggers_since_last_check[0].kind, 'changed_by_percent');
  } finally {
    await s.close();
  }
});
