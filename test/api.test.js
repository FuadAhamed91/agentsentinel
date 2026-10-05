// Integration tests against the local HTTP server (no gateway involved).
// External sources are mocked; the clock is controlled; sample rounds are driven by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, STATS_SECRET } from './helpers.js';

async function withServer(fn, opts) {
  const s = await startTestServer(opts);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const one = (checkResponse) => checkResponse.results[0];

test('a trigger between two checks is reported even after the value moved back', () => withServer(async (s) => {
  s.mock.state.price = 0.07;
  await s.round();
  const w = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 0.08 });
  assert.equal(w.current_value, 0.07);
  assert.equal(w.condition_met_now, false);

  for (const p of [0.075, 0.085, 0.07]) {
    s.mock.state.price = p;
    await s.round();
  }
  const r1 = one(await s.check(w.watch_token));
  assert.equal(r1.status, 'active');
  assert.equal(r1.current_value, 0.07);
  assert.equal(r1.condition_met_now, false);
  assert.equal(r1.triggered, true);
  assert.equal(r1.trigger_count_since_last_check, 1);
  assert.equal(r1.triggers_since_last_check.length, 1);
  assert.equal(r1.triggers_since_last_check[0].kind, 'moved_above');
  assert.equal(r1.triggers_since_last_check[0].value, 0.085);
  assert.equal(r1.triggers_since_last_check[0].previous_value, 0.075);
  assert.equal(r1.triggers_since_last_check[0].time, new Date(s.clock.now - 15000).toISOString());
  assert.equal(r1.high_since_last_check, 0.085);
  assert.equal(r1.low_since_last_check, 0.07);
  assert.equal(r1.sample_count_since_last_check, 3);
  assert.equal(r1.seconds_since_last_check, 45);
  assert.equal(r1.previous_check_time, null);
  assert.equal(r1.sample_interval_seconds, 15);

  // Next check: nothing new happened, window starts after the previous check.
  s.mock.state.price = 0.071;
  await s.round();
  const r2 = one(await s.check(w.watch_token));
  assert.equal(r2.triggered, false);
  assert.equal(r2.trigger_count_since_last_check, 0);
  assert.deepEqual(r2.triggers_since_last_check, []);
  assert.equal(r2.high_since_last_check, 0.071);
  assert.equal(r2.low_since_last_check, 0.071);
  assert.equal(r2.sample_count_since_last_check, 1);
  assert.equal(r2.seconds_since_last_check, 15);
  assert.ok(r2.previous_check_time);

  // Check again with no new sample: empty window, plain nulls.
  const r3 = one(await s.check(w.watch_token));
  assert.equal(r3.sample_count_since_last_check, 0);
  assert.equal(r3.high_since_last_check, null);
  assert.equal(r3.low_since_last_check, null);
  assert.equal(r3.current_value, 0.071);
}));

test('a level condition already met at creation is one trigger, timed at creation', () => withServer(async (s) => {
  s.mock.state.price = 0.09;
  await s.round();
  s.clock.now += 5000;
  const w = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 0.08 });
  assert.equal(w.condition_met_now, true);
  s.mock.state.price = 0.095;
  await s.round();
  const r = one(await s.check(w.watch_token));
  assert.equal(r.triggered, true);
  assert.equal(r.trigger_count_since_last_check, 1);
  assert.equal(r.triggers_since_last_check[0].kind, 'met_at_creation');
  assert.equal(r.triggers_since_last_check[0].time, w.created_at);
  assert.equal(r.triggers_since_last_check[0].value, 0.09);
  // Still above at the next check: triggered (condition holds) but no new trigger.
  await s.round();
  const r2 = one(await s.check(w.watch_token));
  assert.equal(r2.triggered, true);
  assert.equal(r2.condition_met_now, true);
  assert.equal(r2.trigger_count_since_last_check, 0);
}));

test('POST /watch does not wait longer than the cap for a slow source; the value arrives later', () => withServer(async (s) => {
  const addr = '0x' + 'ef'.repeat(20);
  s.mock.state.balances.set(addr, 3n * 10n ** 18n);
  s.mock.state.delayMs.balances = 400;
  const started = Date.now();
  const w = await s.createWatch({ type: 'wallet_balance', address: addr, condition: 'changes' });
  assert.ok(Date.now() - started < 350, 'response not held for the slow fetch');
  assert.equal(w.current_value, null);
  assert.equal(w.stale, true);
  await new Promise((r) => setTimeout(r, 500));
  const r = one(await s.check(w.watch_token));
  assert.equal(r.current_value, 3);
  assert.equal(r.stale, false);
  assert.equal(r.sample_count_since_last_check, 1);
}, { env: { CREATE_FETCH_WAIT_MS: '100' } }));

test('crosses_below between checks, then back above', () => withServer(async (s) => {
  s.mock.state.price = 0.05;
  await s.round();
  const w = await s.createWatch({ type: 'xdc_price', condition: 'crosses_below', threshold: 0.045 });
  for (const p of [0.046, 0.044, 0.043, 0.047]) {
    s.mock.state.price = p;
    await s.round();
  }
  const r = one(await s.check(w.watch_token));
  assert.equal(r.triggered, true);
  assert.equal(r.condition_met_now, null);
  assert.equal(r.current_value, 0.047);
  assert.deepEqual(r.triggers_since_last_check.map((t) => [t.kind, t.value, t.previous_value]), [['crossed_below', 0.044, 0.046]]);
  assert.equal(r.low_since_last_check, 0.043);
}));

test('every condition of every watch type triggers through the API', () => withServer(async (s) => {
  const A = '0x00000000000000000000000000000000000000aa';
  const B = '0x00000000000000000000000000000000000000bb';
  s.mock.state.price = 0.05;
  s.mock.state.gasWei = 12_500_000_000n; // 12.5 gwei
  s.mock.state.balances.set(A, 1000n * 10n ** 18n);
  s.mock.state.balances.set(B, 5n * 10n ** 18n);
  await s.round();

  const specs = {
    price_above: { type: 'xdc_price', condition: 'above', threshold: 0.06 },
    price_below: { type: 'xdc_price', condition: 'below', threshold: 0.04 },
    price_crosses_above: { type: 'xdc_price', condition: 'crosses_above', threshold: 0.055 },
    price_crosses_below: { type: 'xdc_price', condition: 'crosses_below', threshold: 0.045 },
    price_percent: { type: 'xdc_price', condition: 'changes_by_percent', percent: 10 },
    gas_above: { type: 'xdc_gas', condition: 'above', threshold: 20 },
    gas_below: { type: 'xdc_gas', condition: 'below', threshold: 10 },
    wallet_above: { type: 'wallet_balance', address: `xdc${A.slice(2)}`, condition: 'above', threshold: 1500 },
    wallet_below: { type: 'wallet_balance', address: B, condition: 'below', threshold: 1 },
    wallet_changes: { type: 'wallet_balance', address: A, condition: 'changes' },
  };
  const tokens = {};
  for (const [name, body] of Object.entries(specs)) tokens[name] = (await s.createWatch(body)).watch_token;

  // Nothing met yet.
  let res = await s.check(Object.values(tokens));
  for (const r of res.results) assert.equal(r.triggered, false, `${r.type} ${r.condition} should not be triggered yet`);

  // Move everything, then move back, all between two checks.
  s.mock.state.price = 0.065;
  s.mock.state.gasWei = 25_000_000_000n;
  s.mock.state.balances.set(A, 2000n * 10n ** 18n);
  s.mock.state.balances.set(B, 5n * 10n ** 17n); // 0.5 XDC
  await s.round();
  s.mock.state.price = 0.035;
  s.mock.state.gasWei = 9_000_000_000n;
  await s.round();
  s.mock.state.price = 0.05;
  s.mock.state.gasWei = 12_500_000_000n;
  s.mock.state.balances.set(A, 1000n * 10n ** 18n);
  s.mock.state.balances.set(B, 5n * 10n ** 18n);
  await s.round();

  res = await s.check(Object.values(tokens));
  const byName = Object.fromEntries(Object.keys(tokens).map((name, i) => [name, res.results[i]]));
  for (const [name, r] of Object.entries(byName)) {
    assert.equal(r.triggered, true, `${name} should report a trigger between checks`);
    assert.ok(r.trigger_count_since_last_check >= 1, `${name} trigger count`);
  }
  assert.equal(byName.price_above.triggers_since_last_check[0].value, 0.065);
  assert.equal(byName.price_below.triggers_since_last_check[0].value, 0.035);
  assert.equal(byName.price_crosses_above.triggers_since_last_check[0].kind, 'crossed_above');
  assert.equal(byName.price_crosses_below.triggers_since_last_check[0].kind, 'crossed_below');
  assert.equal(byName.price_percent.triggers_since_last_check[0].kind, 'changed_by_percent');
  assert.equal(byName.price_percent.triggers_since_last_check[0].reference_value, 0.05);
  assert.equal(byName.gas_above.triggers_since_last_check[0].value, 25);
  assert.equal(byName.gas_below.triggers_since_last_check[0].value, 9);
  assert.equal(byName.wallet_above.triggers_since_last_check[0].value, 2000);
  assert.equal(byName.wallet_below.triggers_since_last_check[0].value, 0.5);
  assert.deepEqual(byName.wallet_changes.triggers_since_last_check.map((t) => t.value), [2000, 1000]);
  assert.equal(byName.wallet_above.address_xdc, `xdc${A.slice(2)}`);
  assert.equal(byName.gas_above.unit, 'gwei');
  assert.equal(byName.wallet_above.unit, 'XDC');
}));

test('changes_by_percent reference resets to the current value at each check', () => withServer(async (s) => {
  s.mock.state.price = 0.1;
  await s.round();
  const w = await s.createWatch({ type: 'xdc_price', condition: 'changes_by_percent', percent: 5, direction: 'up' });
  s.mock.state.price = 0.104;
  await s.round();
  let r = one(await s.check(w.watch_token));
  assert.equal(r.triggered, false);
  assert.equal(r.reference_value, 0.1);
  assert.equal(r.change_percent_from_reference, 4);
  // Reference is now 0.104; +5% from there is 0.1092.
  s.mock.state.price = 0.108;
  await s.round();
  r = one(await s.check(w.watch_token));
  assert.equal(r.triggered, false);
  assert.equal(r.reference_value, 0.104);
  s.mock.state.price = 0.1135;
  await s.round();
  r = one(await s.check(w.watch_token));
  assert.equal(r.triggered, true);
  assert.equal(r.condition_met_now, true);
  assert.equal(r.reference_value, 0.108);
}));

test('many watches share one external call per sample round', () => withServer(async (s) => {
  await s.round();
  for (let i = 0; i < 30; i++) await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 0.01 + i / 1000 });
  for (let i = 0; i < 5; i++) await s.createWatch({ type: 'xdc_gas', condition: 'above', threshold: 20 + i });
  const wallets = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40), '0x' + '3'.repeat(40)];
  for (let i = 0; i < 12; i++) await s.createWatch({ type: 'wallet_balance', address: wallets[i % 3], condition: 'changes' });

  const before = { ...s.mock.state.calls, balanceAddresses: s.mock.state.calls.balanceAddresses.length };
  await s.round();
  await s.round();
  assert.equal(s.mock.state.calls.price - before.price, 2, 'one price call per round for 30 watches');
  assert.equal(s.mock.state.calls.gas - before.gas, 2, 'one gas call per round for 5 watches');
  assert.equal(s.mock.state.calls.balances - before.balances, 2, 'one batched balance call per round for 12 wallet watches');
  const lastBatch = s.mock.state.calls.balanceAddresses.at(-1);
  assert.deepEqual([...lastBatch].sort(), [...wallets].sort(), 'each address once per batch');

  // Every one of the 30 price watches evaluated both samples.
  const [row] = await s.db.query("SELECT MIN(window_count) AS mn, MAX(window_count) AS mx, COUNT(*) AS n FROM watches WHERE type = 'xdc_price'");
  assert.equal(Number(row.n), 30);
  assert.equal(Number(row.mn), 2);
  assert.equal(Number(row.mx), 2);
  const [samples] = await s.db.query("SELECT COUNT(*) AS n FROM samples WHERE source_key = 'xdc_price'");
  assert.equal(Number(samples.n), 3, 'one stored sample per round, not one per watch');
}));

test('concurrent checks during sample rounds report every sample and every trigger exactly once', () => withServer(async (s) => {
  s.mock.state.price = 0.04;
  await s.round();
  const watches = [];
  for (let i = 0; i < 20; i++) watches.push(await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 0.05 }));
  const tokens = watches.map((w) => w.watch_token);
  const reportedSamples = new Map(tokens.map((t) => [t, 0]));
  const reportedTriggers = new Map(tokens.map((t) => [t, 0]));
  const tally = (res) => res.results.forEach((r, i) => {
    reportedSamples.set(tokens[i], reportedSamples.get(tokens[i]) + r.sample_count_since_last_check);
    reportedTriggers.set(tokens[i], reportedTriggers.get(tokens[i]) + r.trigger_count_since_last_check);
  });

  const ROUNDS = 40;
  let done = false;
  const writer = (async () => {
    for (let i = 0; i < ROUNDS; i++) {
      s.mock.state.price = i % 2 === 0 ? 0.06 : 0.04; // 20 moves above
      await s.round();
    }
    done = true;
  })();
  const checkers = Array.from({ length: 5 }, async () => {
    while (!done) {
      tally(await s.check(tokens));
      await new Promise((r) => setTimeout(r, Math.random() * 5));
    }
  });
  await Promise.all([writer, ...checkers]);
  tally(await s.check(tokens));

  for (const t of tokens) {
    assert.equal(reportedSamples.get(t), ROUNDS, 'each sample reported once');
    assert.equal(reportedTriggers.get(t), ROUNDS / 2, 'each trigger reported once');
  }
}, { env: { RATE_LIMIT_TOKEN_PER_MINUTE: '1000000' } }));

test('only one sampler samples at a time; a released lease is taken over at once', () => withServer(async (s) => {
  const { createSampler } = await import('../src/sampler.js');
  const other = createSampler({ store: s.store, sources: s.mock.sources, clock: () => s.clock.now, logger: { error() {} } });
  assert.equal(await s.sampler.tick(), true, 'first sampler takes the lease');
  const calls = s.mock.state.calls.price;
  assert.equal(await other.tick(), false, 'second sampler skips while the lease is held');
  assert.equal(s.mock.state.calls.price, calls, 'skipped round makes no external call');
  await s.sampler.releaseLease();
  assert.equal(await other.tick(), true, 'released lease is taken over immediately');
  assert.equal(await s.sampler.tick(), false);
  s.clock.now += 46_000; // lease not renewed for longer than 3 intervals
  assert.equal(await s.sampler.tick(), true, 'expired lease is taken over');
}));

test('creating watches on a series that is already fresh makes no extra external call', () => withServer(async (s) => {
  await s.round();
  const before = s.mock.state.calls.price;
  for (let i = 0; i < 10; i++) await s.createWatch({ type: 'xdc_price', condition: 'below', threshold: 1 });
  assert.equal(s.mock.state.calls.price, before);
}));

test('stale data: last known value with its timestamp and stale true, still 200', () => withServer(async (s) => {
  s.mock.state.price = 0.06;
  await s.round();
  const sampledAt = new Date(s.clock.now).toISOString();
  const w = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 0.1 });
  assert.equal(w.stale, false);

  s.mock.state.fail.price = true;
  await s.round();
  const r = await s.post('/check', { watch_tokens: [w.watch_token] });
  assert.equal(r.status, 200);
  const res = one(r.json);
  assert.equal(res.current_value, 0.06);
  assert.equal(res.current_value_time, sampledAt);
  assert.equal(res.stale, true);
  assert.equal(res.sample_count_since_last_check, 0);

  // Source recovers: fresh again.
  s.mock.state.fail.price = false;
  await s.round();
  const ok = one(await s.check(w.watch_token));
  assert.equal(ok.stale, false);

  // No round for longer than the stale limit: stale by age alone.
  s.clock.now += 61_000;
  const aged = one(await s.check(w.watch_token));
  assert.equal(aged.stale, true);
  assert.equal(aged.current_value, 0.06);

  const health = await s.get('/health', { gateway: false });
  assert.equal(health.status, 200);
  assert.equal(health.json.sources.xdc_price.stale, true);
}));

test('stale data: a source that never answered gives null value, stale true, and the watch is still created', () => withServer(async (s) => {
  s.mock.state.fail.gas = true;
  await s.round();
  const w = await s.post('/watch', { type: 'xdc_gas', condition: 'above', threshold: 50 });
  assert.equal(w.status, 200);
  assert.equal(w.json.current_value, null);
  assert.equal(w.json.current_value_time, null);
  assert.equal(w.json.stale, true);
  assert.equal(w.json.condition_met_now, null);
  const r = one(await s.check(w.json.watch_token));
  assert.equal(r.current_value, null);
  assert.equal(r.stale, true);
  assert.equal(r.triggered, false);

  // Once the source answers, the watch evaluates normally.
  s.mock.state.fail.gas = false;
  s.mock.state.gasWei = 60_000_000_000n;
  await s.round();
  const r2 = one(await s.check(w.json.watch_token));
  assert.equal(r2.current_value, 60);
  assert.equal(r2.triggered, true);
  assert.equal(r2.triggers_since_last_check[0].kind, 'moved_above');
}));

test('wallet balance failure on one round keeps the last value and marks it stale', () => withServer(async (s) => {
  const addr = '0x' + 'ab'.repeat(20);
  s.mock.state.balances.set(addr, 7n * 10n ** 18n);
  const w = await s.createWatch({ type: 'wallet_balance', address: addr, condition: 'below', threshold: 1 });
  assert.equal(w.current_value, 7);
  s.mock.state.fail.balances = true;
  await s.round();
  const r = one(await s.check(w.watch_token));
  assert.equal(r.current_value, 7);
  assert.equal(r.stale, true);
}));

test('unknown, malformed and duplicate tokens are reported per item inside a 200', () => withServer(async (s) => {
  await s.round();
  const w = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 1 });
  const wellFormedUnknown = 'wt_' + 'A'.repeat(43);
  const r = await s.post('/check', { watch_tokens: [wellFormedUnknown, w.watch_token, 'garbage', w.watch_token] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x) => x.status), ['unknown_token', 'active', 'unknown_token', 'duplicate_token_in_request']);
  assert.deepEqual(r.json.results.map((x) => x.index), [0, 1, 2, 3]);

  const all = await s.post('/check', { watch_tokens: [wellFormedUnknown] });
  assert.equal(all.status, 200);
  assert.equal(all.json.results[0].status, 'unknown_token');

  for (const path of ['/watches', '/events', '/cancel']) {
    const x = await s.post(path, { watch_token: wellFormedUnknown });
    assert.equal(x.status, 200, path);
    assert.equal(x.json.results[0].status, 'unknown_token', path);
  }
}));

test('cancel: watch stops, check reports cancelled, wallet no longer sampled', () => withServer(async (s) => {
  const addr = '0x' + 'cd'.repeat(20);
  s.mock.state.balances.set(addr, 10n ** 18n);
  const w = await s.createWatch({ type: 'wallet_balance', address: addr, condition: 'changes' });
  await s.round();
  assert.ok(s.mock.state.calls.balanceAddresses.at(-1).includes(addr));

  const c = await s.post('/cancel', { watch_token: w.watch_token });
  assert.equal(c.status, 200);
  assert.equal(c.json.results[0].status, 'cancelled');
  assert.equal(c.json.results[0].cancelled_by_this_request, true);
  assert.equal(c.json.results[0].watch_id, w.watch_id);

  const again = await s.post('/cancel', { watch_tokens: [w.watch_token] });
  assert.equal(again.json.results[0].status, 'cancelled');
  assert.equal(again.json.results[0].cancelled_by_this_request, false);

  const r = await s.post('/check', { watch_tokens: [w.watch_token] });
  assert.equal(r.status, 200);
  assert.equal(r.json.results[0].status, 'cancelled');
  assert.equal(r.json.results[0].watch_id, w.watch_id);
  assert.ok(r.json.results[0].ended_at);
  assert.equal(r.json.results[0].triggered, undefined);

  const callsBefore = s.mock.state.calls.balances;
  await s.round();
  assert.equal(s.mock.state.calls.balances, callsBefore, 'no balance request once no wallet watch is active');

  const st = await s.post('/watches', { watch_tokens: [w.watch_token] });
  assert.equal(st.json.results[0].status, 'cancelled');
}));

test('expired watches report expired', () => withServer(async (s) => {
  await s.round();
  const w = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 1 });
  s.clock.now += s.config.watchTtlMs + 1000;
  const r = one(await s.check(w.watch_token));
  assert.equal(r.status, 'expired');
}));

test('/watches returns configuration and lifecycle only; /events returns only triggers already reported by /check', () => withServer(async (s) => {
  s.mock.state.price = 0.05;
  await s.round();
  const w = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 0.06 });
  s.mock.state.price = 0.07;
  await s.round();

  const st = await s.post('/watches', { watch_tokens: [w.watch_token] });
  assert.equal(st.status, 200);
  const item = st.json.results[0];
  assert.equal(item.status, 'active');
  assert.equal(item.threshold, 0.06);
  assert.equal(item.check_count, 0);
  assert.equal(item.current_value, undefined);
  assert.equal(item.triggered, undefined);

  let ev = await s.post('/events', { watch_tokens: [w.watch_token] });
  assert.equal(ev.json.results[0].reported_trigger_count, 0, 'unreported triggers are not in /events');

  await s.check(w.watch_token);
  ev = await s.post('/events', { watch_tokens: [w.watch_token] });
  assert.equal(ev.json.results[0].reported_trigger_count, 1);
  assert.equal(ev.json.results[0].reported_triggers[0].value, 0.07);
  assert.equal(ev.json.results[0].reported_triggers[0].kind, 'moved_above');
}));

test('input validation returns 400 with a reason and the caller is not charged', () => withServer(async (s) => {
  const bad = [
    [{ type: 'xdc_price', condition: 'above', threshold: 0.08, extra: 1 }, 'extra'],
    [{ type: 'btc_price', condition: 'above', threshold: 1 }, 'type'],
    [{ type: 'xdc_gas', condition: 'changes_by_percent', percent: 5 }, 'condition'],
    [{ type: 'xdc_price', condition: 'above' }, 'threshold'],
    [{ type: 'xdc_price', condition: 'above', threshold: 'abc' }, 'threshold'],
    [{ type: 'xdc_price', condition: 'above', threshold: -1 }, 'threshold'],
    [{ type: 'xdc_price', condition: 'above', threshold: 0 }, 'threshold'],
    [{ type: 'xdc_price', condition: 'changes_by_percent' }, 'percent'],
    [{ type: 'xdc_price', condition: 'changes_by_percent', percent: 5, threshold: 1 }, 'threshold'],
    [{ type: 'xdc_price', condition: 'changes_by_percent', percent: 5, direction: 'sideways' }, 'direction'],
    [{ type: 'xdc_price', condition: 'above', threshold: 1, address: '0x' + '1'.repeat(40) }, 'address'],
    [{ type: 'wallet_balance', condition: 'changes' }, 'address'],
    [{ type: 'wallet_balance', condition: 'changes', address: '0x123' }, 'address'],
    [{ type: 'wallet_balance', condition: 'crosses_above', address: '0x' + '1'.repeat(40), threshold: 1 }, 'condition'],
  ];
  for (const [body, field] of bad) {
    const r = await s.post('/watch', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'invalid_request');
    assert.equal(r.json.field, field, JSON.stringify(body));
    assert.equal(typeof r.json.message, 'string');
  }
  const [count] = await s.db.query('SELECT COUNT(*) AS n FROM watches');
  assert.equal(Number(count.n), 0);

  const notJson = await s.post('/watch', '{"type": "xdc_price",');
  assert.equal(notJson.status, 400);
  assert.equal(notJson.json.error, 'invalid_json');

  const arr = await s.post('/watch', [1, 2]);
  assert.equal(arr.status, 400);

  const empty = await s.post('/check', {});
  assert.equal(empty.status, 400);
  assert.equal(empty.json.field, 'watch_tokens');
  const notArray = await s.post('/check', { watch_tokens: 'wt_x' });
  assert.equal(notArray.status, 400);
  const nonString = await s.post('/check', { watch_tokens: [123] });
  assert.equal(nonString.status, 400);
  const tooMany = await s.post('/check', { watch_tokens: Array.from({ length: 51 }, (_, i) => `wt_${i}`) });
  assert.equal(tooMany.status, 400);

  // Numeric strings are accepted for numbers, and a body without content-type is still read.
  const okString = await s.request('POST', '/watch', JSON.stringify({ type: 'xdc_price', condition: 'below', threshold: '0.5' }), {
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(okString.status, 200);
  assert.equal(okString.json.threshold, 0.5);

  const wrongMethod = await s.get('/check');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.allowed_method, 'POST');
  const missing = await s.get('/nope');
  assert.equal(missing.status, 404);
}));

test('paid routes accept only the gateway secret; free routes are open', () => withServer(async (s) => {
  await s.round();
  const body = { type: 'xdc_price', condition: 'above', threshold: 1 };
  const direct = await s.post('/watch', body, { gateway: false });
  assert.equal(direct.status, 401);
  assert.equal(direct.json.error, 'unauthorized');
  const wrong = await s.post('/watch', body, { gateway: false, headers: { authorization: 'Bearer wrong' } });
  assert.equal(wrong.status, 401);
  const check = await s.post('/check', { watch_tokens: ['wt_' + 'A'.repeat(43)] }, { gateway: false });
  assert.equal(check.status, 401);
  const viaGateway = await s.post('/watch', body);
  assert.equal(viaGateway.status, 200);

  for (const [method, path, b] of [['GET', '/info'], ['GET', '/health'], ['POST', '/watches', { watch_token: viaGateway.json.watch_token }],
    ['POST', '/events', { watch_token: viaGateway.json.watch_token }]]) {
    const r = await s.request(method, path, b, { gateway: false });
    assert.equal(r.status, 200, `${method} ${path}`);
  }
}));

test('without GATEWAY_SECRET the paid routes are open (local development)', () => withServer(async (s) => {
  await s.round();
  const r = await s.post('/watch', { type: 'xdc_price', condition: 'above', threshold: 1 }, { gateway: false });
  assert.equal(r.status, 200);
}, { env: { GATEWAY_SECRET: '' } }));

test('rate limits: per watch token on /check and per IP on direct traffic', () => withServer(async (s) => {
  await s.round();
  const w = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 1 });
  for (let i = 0; i < 3; i++) assert.equal((await s.post('/check', { watch_tokens: [w.watch_token] })).status, 200);
  const limited = await s.post('/check', { watch_tokens: [w.watch_token] });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  s.clock.now += 60_000;
  assert.equal((await s.post('/check', { watch_tokens: [w.watch_token] })).status, 200, 'window resets');

  for (let i = 0; i < 5; i++) assert.equal((await s.get('/info', { gateway: false })).status, 200);
  const ipLimited = await s.get('/info', { gateway: false });
  assert.equal(ipLimited.status, 429);
  // Gateway traffic shares one address, so it is not limited per IP.
  assert.equal((await s.get('/info')).status, 200);
}, { env: { RATE_LIMIT_TOKEN_PER_MINUTE: '3', RATE_LIMIT_IP_PER_MINUTE: '5' } }));

test('internal errors return a plain 500 without stack traces', () => withServer(async (s) => {
  s.store.findByTokenHash = async () => { throw new Error('secret internal detail at /srv/app.js:1'); };
  const r = await s.post('/watches', { watch_token: 'wt_' + 'A'.repeat(43) });
  assert.equal(r.status, 500);
  assert.deepEqual(Object.keys(r.json).sort(), ['error', 'message']);
  assert.equal(r.json.error, 'internal_error');
  assert.ok(!r.text.includes('secret internal detail'));
  assert.ok(!r.text.includes('.js'));
}));

test('/stats requires the secret and reports counts', () => withServer(async (s) => {
  await s.round();
  const w1 = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 1 });
  const w2 = await s.createWatch({ type: 'xdc_gas', condition: 'above', threshold: 100 });
  await s.check([w1.watch_token, w2.watch_token]);
  await s.check([w1.watch_token]);

  assert.equal((await s.get('/stats', { gateway: false })).status, 401);
  assert.equal((await s.get('/stats?key=wrong', { gateway: false })).status, 401);
  const r = await s.get(`/stats?key=${STATS_SECRET}`, { gateway: false });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const stats = await s.store.stats(s.clock.now);
  assert.equal(stats.active_watches, 2);
  assert.equal(stats.checks_today, 3);
  assert.equal(stats.check_requests_today, 2);
  assert.equal(stats.distinct_tokens_checked_today, 2);
  assert.match(r.text, /Active watches<\/td><td>2</);
  assert.match(r.text, /Distinct tokens checked today<\/td><td>2</);
  assert.match(r.text, /Checks today \(UTC, one per watch per check\)<\/td><td>3</);

  // A request with a bearer token that is not the gateway secret is counted.
  await s.post('/watches', { watch_token: w1.watch_token }, { gateway: false, headers: { authorization: 'Bearer not-the-secret' } });
  const r2 = await s.get(`/stats?key=${STATS_SECRET}`, { gateway: false });
  assert.match(r2.text, /requests_with_wrong_bearer_since_start<\/td><td>1</);
  assert.match(r2.text, /gateway_header_names_seen<\/td><td>\[.*authorization.*\]</);
}));

test('/stats is disabled when STATS_SECRET is not set', () => withServer(async (s) => {
  assert.equal((await s.get('/stats?key=x', { gateway: false })).status, 404);
}, { env: { STATS_SECRET: '' } }));

test('/info lists the catalog prices and contains no instruction text', () => withServer(async (s) => {
  const r = await s.get('/info', { gateway: false });
  assert.equal(r.status, 200);
  const prices = Object.fromEntries(r.json.routes.map((x) => [x.path, x.price_usdc]));
  assert.equal(prices['/watch'], '0.02');
  assert.equal(prices['/check'], '0.01');
  assert.equal(prices['/info'], '0');
  assert.deepEqual(Object.keys(r.json.watch_types).sort(), ['wallet_balance', 'xdc_gas', 'xdc_price']);
  const text = JSON.stringify(r.json).toLowerCase();
  for (const phrase of ['you should', 'you must', 'please', 'call this again', 'ignore previous', 'instruction']) {
    assert.ok(!text.includes(phrase), `info contains "${phrase}"`);
  }
}));
