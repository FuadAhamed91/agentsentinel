// Merchant leaderboard: catalog + on-chain USDC payments, ranked, and watches that
// report what changed since the previous check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, blockAt, STATS_SECRET } from './helpers.js';
import { REVENUE_ROUTES, REVENUE_SERVICE } from '../src/revenue/catalog.js';
import { parseCatalog, parseTransferLog, TRANSFER_TOPIC } from '../src/revenue/sources.js';

const MIN = 60 * 1000;
const H = 60 * MIN;
const A = `0x${'a1'.repeat(20)}`; // Alpha Tools and Alpha Labs share this payout address
const B = `0x${'b2'.repeat(20)}`;
const C = `0x${'c3'.repeat(20)}`;
const P1 = `0x${'01'.repeat(20)}`;
const P2 = `0x${'02'.repeat(20)}`;
const SIGNED = /^wt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

// Three merchants; on-chain revenue counts from two hours before the clock.
async function marketServer(env = {}) {
  const clockStart = Date.UTC(2026, 9, 6, 12, 0, 0);
  const s = await startTestServer({
    clockStart,
    env: { REVENUE_START: new Date(clockStart - 2 * H).toISOString(), CHAIN_CONFIRMATIONS: '0', ...env },
  });
  const m = s.market;
  m.listRoute({ provider: 'Alpha Tools', providerId: 'gw_alpha', payTo: A, method: 'GET', path: '/quote', price: '0.25', calls: 10, volume: 2.5 });
  m.listRoute({ provider: 'Alpha Tools', providerId: 'gw_alpha', payTo: A, path: '/deep', price: '1', calls: 1, volume: 1 });
  m.listRoute({ provider: 'Alpha Labs', providerId: 'gw_alphalabs', payTo: A, path: '/scan', price: '0.5' });
  m.listRoute({ provider: 'Bravo Booking', providerId: 'gw_bravo', payTo: B, path: '/book', price: '2', calls: 3, volume: 6 });
  m.listRoute({ provider: 'Charlie Data', providerId: 'gw_charlie', payTo: C, method: 'GET', path: '/data', price: '0.05', calls: 40, volume: 2 });
  return s;
}

const result = async (s, token) => {
  const r = await s.post('/revenue/check', { watch_tokens: [token] });
  assert.equal(r.status, 200, r.text);
  return r.json.results[0];
};

test('GET /revenue/leaderboard ranks payout addresses by USDC received on-chain and groups listings that share one', async () => {
  const s = await marketServer();
  try {
    const now = s.clock.now;
    s.market.pay(B, 5, { at: now - 3 * H }); // before REVENUE_START: not counted
    s.market.pay(B, 2, { at: now - 100 * MIN });
    s.market.pay(A, 0.25, { at: now - 90 * MIN });
    s.market.pay(A, 1, { at: now - 30 * MIN });
    s.market.pay(A, 0.5, { at: now - 10 * MIN });

    const early = await s.get('/revenue/leaderboard');
    assert.equal(early.status, 503, 'nothing to rank before the first catalog read (not charged)');
    assert.equal(early.json.error, 'warming_up');

    await s.marketRound();
    assert.equal(s.tracker.status.chain.start_block, blockAt(now - 2 * H));
    const r = await s.get('/revenue/leaderboard');
    assert.equal(r.status, 200);
    const lb = r.json.leaderboard;
    assert.deepEqual(lb.map((e) => [e.rank, e.merchant]), [[1, 'Bravo Booking'], [2, 'Alpha Tools'], [3, 'Charlie Data']]);
    assert.equal(lb[0].onchain_revenue_usdc, 2);
    assert.equal(lb[0].onchain_payments, 1);
    const alpha = lb[1];
    assert.equal(alpha.pay_to, A);
    assert.deepEqual(alpha.other_listings, ['Alpha Labs']);
    assert.equal(alpha.onchain_revenue_usdc, 1.75);
    assert.equal(alpha.onchain_payments, 3);
    assert.equal(alpha.onchain_revenue_24h_usdc, 1.75);
    assert.equal(alpha.onchain_revenue_1h_usdc, 1.5);
    assert.equal(alpha.last_payment_time, new Date(now - 10 * MIN).toISOString());
    assert.equal(alpha.catalog_volume_usdc, 3.5);
    assert.equal(alpha.catalog_calls, 11);
    assert.equal(lb[2].onchain_revenue_usdc, 0);
    assert.equal(lb[2].last_payment_time, null);
    assert.deepEqual(r.json.market, {
      merchants: 3,
      listings: 4,
      routes: 5,
      onchain_revenue_usdc: 3.75,
      onchain_payments: 4,
      onchain_revenue_24h_usdc: 3.75,
      onchain_payments_24h: 4,
      onchain_revenue_1h_usdc: 1.5,
      onchain_payments_1h: 2,
      catalog_volume_usdc: 11.5,
      catalog_calls: 54,
    });
    const d = r.json.data;
    assert.equal(d.onchain_stale, false);
    assert.equal(d.onchain_merchants_still_indexing, 0);
    assert.equal(d.onchain_indexed_through_block, blockAt(now));
    assert.equal(d.onchain_indexed_through_time, new Date(now).toISOString());
    assert.equal(d.onchain_counted_from, new Date(now - 2 * H).toISOString());
    assert.equal(d.catalog_stale, false);

    assert.equal((await s.get('/revenue/leaderboard', { gateway: false })).status, 401, 'paid route');
  } finally {
    await s.close();
  }
});

test('catalog counter increases are recorded per route and listed as the top selling routes', async () => {
  const s = await marketServer();
  try {
    await s.marketRound();
    s.market.bump('gw_bravo', '/book', { calls: 2, volume: 4 });
    s.market.bump('gw_charlie', '/data', { calls: 5, volume: 0.25 });
    await s.marketRound(MIN);
    const r = await s.get('/revenue/leaderboard');
    assert.deepEqual(
      r.json.top_routes_24h.map((x) => [x.listing, x.method, x.path, x.catalog_calls_24h, x.catalog_volume_24h_usdc]),
      [['Bravo Booking', 'POST', '/book', 2, 4], ['Charlie Data', 'GET', '/data', 5, 0.25]],
    );
    assert.equal(r.json.leaderboard.find((e) => e.merchant === 'Bravo Booking').catalog_volume_usdc, 10);
  } finally {
    await s.close();
  }
});

test('POST /revenue/merchant finds a merchant by name, service id, payout address or route URL', async () => {
  const s = await marketServer();
  try {
    const now = s.clock.now;
    s.market.pay(A, 1, { at: now - 20 * MIN, payer: P1 });
    s.market.pay(A, 0.25, { at: now - 10 * MIN, payer: P1 });
    s.market.pay(A, 0.07, { at: now - 5 * MIN, payer: P2 }); // no route has this price
    s.market.pay(B, 2, { at: now - 15 * MIN });
    await s.marketRound();

    for (const merchant of ['Alpha Tools', 'alpha labs', 'gw_alphalabs', A, `xdc${A.slice(2)}`, 'https://api.xdcai.tech/x402/connect/gw_alpha/quote']) {
      const r = await s.post('/revenue/merchant', { merchant });
      assert.equal(r.status, 200, merchant);
      assert.equal(r.json.pay_to, A, merchant);
    }

    const j = (await s.post('/revenue/merchant', { merchant: 'Alpha Tools' })).json;
    assert.equal(j.rank, 2);
    assert.equal(j.merchants_ranked, 3);
    assert.equal(j.onchain_revenue_usdc, 1.32);
    assert.deepEqual(j.rank_above, { rank: 1, merchant: 'Bravo Booking', onchain_revenue_usdc: 2, gap_usdc: 0.68 });
    assert.deepEqual(j.rank_below, { rank: 3, merchant: 'Charlie Data', onchain_revenue_usdc: 0, gap_usdc: 1.32 });
    assert.deepEqual(j.recent_payments.map((p) => [p.amount_usdc, p.route]), [
      [0.07, null],
      [0.25, 'Alpha Tools GET /quote'],
      [1, 'Alpha Tools POST /deep'],
    ]);
    assert.equal(j.recent_payments[0].payer, P2);
    assert.equal(j.recent_payments[0].time, new Date(now - 5 * MIN).toISOString());
    assert.match(j.recent_payments[0].tx_hash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(j.top_payers.map((p) => [p.payer, p.payments, p.amount_usdc]), [[P1, 2, 1.25], [P2, 1, 0.07]]);
    assert.equal(j.distinct_payers, 2);
    assert.deepEqual(j.routes.map((r) => [r.listing, r.path, r.price_usdc]), [
      ['Alpha Tools', '/quote', 0.25], ['Alpha Tools', '/deep', 1], ['Alpha Labs', '/scan', 0.5],
    ]);

    const byQuery = await s.post('/revenue/merchant?merchant=Bravo%20Booking');
    assert.equal(byQuery.json.merchant, 'Bravo Booking');

    const unknown = await s.post('/revenue/merchant', { merchant: 'Alpha Zulu' });
    assert.equal(unknown.status, 404, 'not charged');
    assert.deepEqual(unknown.json.suggestions, ['Alpha Tools', 'Alpha Labs']);
    const missing = await s.post('/revenue/merchant', {});
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.json.merchants, ['Bravo Booking', 'Alpha Tools', 'Charlie Data']);
    assert.equal((await s.post('/revenue/merchant', { merchant: 'Alpha Tools', extra: 1 })).status, 400);
    assert.equal((await s.post('/revenue/merchant', { merchant: 42 })).status, 400);
  } finally {
    await s.close();
  }
});

test('a merchant watch reports each new payment once, with rank changes and overtakes', async () => {
  const s = await marketServer();
  try {
    s.market.pay(B, 2, { at: s.clock.now - 30 * MIN });
    s.market.pay(A, 1, { at: s.clock.now - 20 * MIN });
    await s.marketRound();
    const created = s.clock.now;
    const w = await s.post('/revenue/watch', { merchant: 'Charlie Data' });
    assert.equal(w.status, 200);
    assert.equal(w.json.target, 'merchant');
    assert.equal(w.json.rank, 3);
    assert.match(w.json.watch_token, SIGNED);
    const token = w.json.watch_token;

    // Charlie receives 2.5 USDC and passes both others.
    s.market.pay(C, 0.05, { at: created + 1 * MIN });
    s.market.pay(C, 2.45, { at: created + 2 * MIN });
    s.market.bump('gw_charlie', '/data', { calls: 2, volume: 0.1 });
    await s.marketRound(3 * MIN);
    let c = await result(s, token);
    assert.equal(c.status, 'active');
    assert.equal(c.since, new Date(created).toISOString());
    assert.equal(c.new_payment_count, 2);
    assert.equal(c.new_revenue_usdc, 2.5);
    assert.deepEqual(c.new_payments.map((p) => [p.amount_usdc, p.route]), [[0.05, 'Charlie Data GET /data'], [2.45, null]]);
    assert.equal(c.new_payments_not_listed, 0);
    assert.equal(c.rank_at_last_check, 3);
    assert.equal(c.rank, 1);
    assert.equal(c.rank_change, 2);
    assert.deepEqual([...c.passed].sort(), ['Alpha Tools', 'Bravo Booking']);
    assert.deepEqual(c.passed_by, []);
    assert.equal(c.onchain_revenue_usdc, 2.5);
    assert.equal(c.onchain_revenue_at_last_check_usdc, 0);
    assert.equal(c.rank_above, null);
    assert.deepEqual(c.rank_below, { rank: 2, merchant: 'Bravo Booking', onchain_revenue_usdc: 2, gap_usdc: 0.5 });
    assert.equal(c.catalog_calls_since_last_check, 2);
    assert.equal(c.catalog_volume_since_last_check_usdc, 0.1);
    assert.equal(c.market_new_payment_count, 2);
    assert.deepEqual(c.new_merchants, []);
    assert.equal(c.previous_check_time, null);
    assert.equal(c.seconds_since_last_check, 180);

    // Nothing new.
    s.clock.now += MIN;
    c = (await s.post('/revenue/check', { watch_token: token })).json.results[0];
    assert.equal(c.new_payment_count, 0);
    assert.deepEqual(c.new_payments, []);
    assert.equal(c.rank_change, 0);
    assert.equal(c.previous_check_time, new Date(created + 3 * MIN).toISOString());

    // Bravo passes Charlie back.
    s.market.pay(B, 1, { at: s.clock.now + 30 * 1000 });
    await s.marketRound(MIN);
    c = await result(s, token);
    assert.equal(c.new_payment_count, 0, 'payments to other merchants are not listed');
    assert.equal(c.market_new_payment_count, 1);
    assert.equal(c.market_new_revenue_usdc, 1);
    assert.equal(c.rank, 2);
    assert.equal(c.rank_change, -1);
    assert.deepEqual(c.passed_by, ['Bravo Booking']);
    assert.deepEqual(c.rank_above, { rank: 1, merchant: 'Bravo Booking', onchain_revenue_usdc: 3, gap_usdc: 0.5 });

    assert.equal((await s.post('/revenue/check', { watch_tokens: [token] }, { gateway: false })).status, 401, 'paid route');
  } finally {
    await s.close();
  }
});

test('a payment read late (chain down during the check) is reported by the next check; stale flags show it', async () => {
  const s = await marketServer();
  try {
    await s.marketRound();
    const token = (await s.post('/revenue/watch', { merchant: 'Alpha Tools' })).json.watch_token;
    const paidAt = s.clock.now + MIN;
    s.market.pay(A, 0.25, { at: paidAt });
    s.market.state.fail.chain = true;
    s.market.state.fail.catalog = true;
    await s.marketRound(4 * MIN);
    let c = await result(s, token);
    assert.equal(c.new_payment_count, 0);
    let lb = (await s.get('/revenue/leaderboard')).json;
    assert.equal(lb.data.onchain_stale, true);
    assert.equal(lb.data.catalog_stale, true);
    assert.equal(lb.leaderboard.length, 3, 'last known data is still served');

    s.market.state.fail.chain = false;
    s.market.state.fail.catalog = false;
    await s.marketRound(MIN);
    c = await result(s, token);
    assert.equal(c.new_payment_count, 1);
    assert.equal(c.new_payments[0].time, new Date(paidAt).toISOString(), 'dated before the previous check');
    lb = (await s.get('/revenue/leaderboard')).json;
    assert.equal(lb.data.onchain_stale, false);
    assert.equal(lb.data.catalog_stale, false);
  } finally {
    await s.close();
  }
});

test('a market watch (empty body) reports payments across merchants, rank changes and new merchants', async () => {
  const s = await marketServer();
  try {
    await s.marketRound();
    const created = s.clock.now;
    const w = await s.post('/revenue/watch');
    assert.equal(w.status, 200);
    assert.equal(w.json.target, 'market');
    assert.deepEqual(w.json.leaderboard.map((e) => e.merchant), ['Bravo Booking', 'Alpha Tools', 'Charlie Data'], 'by catalog volume while nobody has on-chain revenue');

    const D = `0x${'d4'.repeat(20)}`;
    s.market.listRoute({ provider: 'Delta New', providerId: 'gw_delta', payTo: D, path: '/new', price: '0.5' });
    s.market.pay(D, 9, { at: created - 30 * MIN }); // before the watch existed
    s.market.pay(D, 0.5, { at: created + MIN });
    s.market.pay(A, 1, { at: created + MIN });
    await s.marketRound(2 * MIN);

    const c = await result(s, w.json.watch_token);
    assert.equal(c.target, 'market');
    assert.equal(c.new_payment_count, 2, 'the payment from before the watch existed is not new');
    assert.equal(c.new_revenue_usdc, 1.5);
    assert.deepEqual(c.new_payments.map((p) => [p.merchant, p.amount_usdc, p.route]).sort(), [
      ['Alpha Tools', 1, 'Alpha Tools POST /deep'],
      ['Delta New', 0.5, 'Delta New POST /new'],
    ]);
    assert.deepEqual(c.new_merchants.map((m) => [m.merchant, m.rank]), [['Delta New', 1]]);
    assert.deepEqual(c.rank_changes, [
      { merchant: 'Bravo Booking', rank: 3, rank_at_last_check: 1 },
      { merchant: 'Charlie Data', rank: 4, rank_at_last_check: 3 },
    ]);
    assert.deepEqual(c.revenue_gains.map((g) => [g.merchant, g.new_revenue_usdc]), [['Alpha Tools', 1], ['Delta New', 0.5]]);
    assert.equal(c.leaderboard_top[0].merchant, 'Delta New');
    assert.equal(c.leaderboard_top[0].onchain_revenue_usdc, 9.5);
    assert.equal(c.market.merchants, 4);
  } finally {
    await s.close();
  }
});

test('the chain reader halves a refused block range and catches up a newly listed payout address', async () => {
  const s = await marketServer();
  try {
    s.market.state.maxRange = 300;
    s.market.pay(A, 1, { at: s.clock.now - 100 * MIN });
    s.market.pay(B, 2, { at: s.clock.now - 5 * MIN });
    await s.marketRound();
    let lb = (await s.get('/revenue/leaderboard')).json;
    assert.equal(lb.data.onchain_merchants_still_indexing, 0);
    assert.deepEqual(lb.leaderboard.map((e) => [e.merchant, e.onchain_revenue_usdc]), [['Bravo Booking', 2], ['Alpha Tools', 1], ['Charlie Data', 0]]);
    const sizes = s.market.state.calls.logRanges.map(([f, t]) => t - f + 1);
    assert.deepEqual(sizes.slice(0, 3), [1000, 500, 250], 'halved until accepted');
    assert.ok(sizes.slice(2).every((n) => n <= 250), 'a refused size is not tried again within the round');
    assert.ok(sizes.length <= 3600 / 250 + 3);

    // A merchant listed later is read from REVENUE_START, not only from now.
    const E = `0x${'e5'.repeat(20)}`;
    s.market.listRoute({ provider: 'Echo Late', providerId: 'gw_echo', payTo: E, path: '/e', price: '0.1' });
    s.market.pay(E, 0.1, { at: s.clock.now - 110 * MIN });
    await s.marketRound(MIN);
    lb = (await s.get('/revenue/leaderboard')).json;
    assert.equal(lb.leaderboard.find((e) => e.merchant === 'Echo Late').onchain_revenue_usdc, 0.1);
    assert.equal(lb.data.onchain_merchants_still_indexing, 0);
  } finally {
    await s.close();
  }
});

test('a leaderboard watch is rebuilt from its token after stored data is lost', async () => {
  const s = await marketServer();
  try {
    s.market.pay(A, 1, { at: s.clock.now - 10 * MIN });
    await s.marketRound();
    const token = (await s.post('/revenue/watch', { merchant: 'Alpha Tools' })).json.watch_token;
    s.market.pay(A, 0.25, { at: s.clock.now + MIN });
    for (const t of ['rev_watches', 'rev_payments', 'rev_index', 'rev_routes', 'rev_route_changes', 'rev_meta']) {
      await s.db.query(`DELETE FROM ${t}`);
    }
    await s.marketRound(2 * MIN);

    const c = await result(s, token);
    assert.equal(c.status, 'active');
    assert.equal(c.pay_to, A);
    assert.ok(c.history_reset_at);
    assert.equal(c.rank_at_last_check, null);
    assert.equal(c.passed, null);
    assert.equal(c.new_payment_count, 1, 'counted from the creation of the watch');
    assert.equal(c.new_revenue_usdc, 0.25);
    assert.equal(c.new_merchants, null, 'the recorded catalog history starts after the watch was created');
    const again = await result(s, token);
    assert.equal(again.new_payment_count, 0);
    assert.equal(again.rank_at_last_check, again.rank);

    // Tokens of the two services are not interchangeable.
    await s.round();
    const priceWatch = await s.createWatch({ type: 'xdc_price', condition: 'above', threshold: 1 });
    assert.equal((await result(s, priceWatch.watch_token)).status, 'unknown_token');
    const asPrice = await s.check(token);
    assert.equal(asPrice.results[0].status, 'unknown_token');
  } finally {
    await s.close();
  }
});

test('cancel ends a leaderboard watch; tokens are reported per item; /revenue/info and /stats', async () => {
  const s = await marketServer();
  try {
    await s.marketRound();
    const token = (await s.post('/revenue/watch', { merchant: B })).json.watch_token;
    const cancel = await s.post('/revenue/cancel', { watch_token: token }, { gateway: false });
    assert.equal(cancel.status, 200, 'free route');
    assert.equal(cancel.json.results[0].status, 'cancelled');
    assert.equal(cancel.json.results[0].cancelled_by_this_request, true);
    const c = await s.post('/revenue/check', { watch_tokens: [token, 'wt_nope', token] });
    assert.deepEqual(c.json.results.map((r) => r.status), ['cancelled', 'unknown_token', 'duplicate_token_in_request']);
    assert.equal((await s.post('/revenue/check', {})).status, 400);

    const info = await s.get('/revenue/info', { gateway: false });
    assert.equal(info.status, 200, 'free route');
    assert.deepEqual(info.json.routes.map((r) => [r.method, r.path, r.price_usdc]), REVENUE_ROUTES.map((r) => [r.method, r.path, r.priceUSDC]));
    assert.equal(info.json.coverage.merchants_tracked, 3);
    assert.deepEqual(info.json.request_examples['POST /revenue/merchant'], { merchant: REVENUE_SERVICE.name }, 'the example names this listing');

    const stats = await s.get(`/stats?key=${STATS_SECRET}`, { gateway: false });
    assert.equal(stats.status, 200);
    assert.match(stats.text, /Merchant leaderboard/);
    assert.match(stats.text, /\/revenue\/watch/);
  } finally {
    await s.close();
  }
});

test('catalog rows and transfer logs are parsed defensively', () => {
  const payTo = `0x${'AB'.repeat(20)}`;
  const rows = parseCatalog({
    services: [
      { id: 'gw_x:/v1/a', providerId: 'gw_x', providerName: '  X   Shop ', url: 'https://api.xdcai.tech/x402/connect/gw_x/v1/a', method: 'get', priceUSDC: '0.1', payTo, calls: 3, volumeUSDC: 0.3 },
      { id: 'gw_x:/v1/a', providerId: 'gw_x', providerName: 'X Shop', url: 'https://api.xdcai.tech/x402/connect/gw_x/v1/a', method: 'POST', priceUSDC: '0.2', payTo, calls: 1 },
      { providerId: 'gw_bad', payTo: 'not-an-address' },
      null,
    ],
  });
  assert.equal(rows.length, 2, 'one path with two methods is two routes; unusable rows are skipped');
  assert.deepEqual(rows[0], {
    routeKey: 'gw_x GET /v1/a',
    providerId: 'gw_x',
    providerName: 'X Shop',
    method: 'GET',
    path: '/v1/a',
    priceUsdc: 0.1,
    payTo: payTo.toLowerCase(),
    calls: 3,
    volumeUsdc: 0.3,
  });
  assert.throws(() => parseCatalog({ nothing: [] }));

  const log = {
    topics: [TRANSFER_TOPIC, `0x${'0'.repeat(24)}${'11'.repeat(20)}`, `0x${'0'.repeat(24)}${'22'.repeat(20)}`],
    data: `0x${(50000).toString(16).padStart(64, '0')}`,
    blockNumber: '0x10',
    transactionHash: '0xABC',
    logIndex: '0x3',
    removed: false,
  };
  assert.deepEqual(parseTransferLog(log), {
    txHash: '0xabc', logIndex: 3, blockNumber: 16, payer: `0x${'11'.repeat(20)}`, payTo: `0x${'22'.repeat(20)}`, amountMicro: 50000, ts: null,
  });
  assert.equal(parseTransferLog({ ...log, blockTimestamp: '0x64' }).ts, 100000);
  assert.equal(parseTransferLog({ ...log, removed: true }), null);
  assert.equal(parseTransferLog({ ...log, topics: [TRANSFER_TOPIC] }), null);
  assert.equal(parseTransferLog({ ...log, data: 'zz' }), null);
});
