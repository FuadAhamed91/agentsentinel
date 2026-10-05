// The listing (gateway.json), the catalog and the running server must agree.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildGatewayJson, buildRoutesJson } from '../src/gateway-listing.js';
import { ROUTES, SERVICE, isPaid } from '../src/catalog.js';
import { REVENUE_ROUTES, REVENUE_SERVICE } from '../src/revenue/catalog.js';
import { startTestServer } from './helpers.js';

const readJson = (name) => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const onDisk = readJson('gateway.json');
const revenueOnDisk = readJson('gateway.revenue.json');

test('gateway.json on disk matches the catalog (regenerate with npm run gateway)', () => {
  const expected = buildGatewayJson({ upstreamBaseUrl: onDisk.upstreamBaseUrl, secret: onDisk.auth.secret });
  assert.deepEqual(onDisk, expected);
});

test('gateway.revenue.json and both routes files on disk match the catalogs', () => {
  const expected = buildGatewayJson({
    service: REVENUE_SERVICE,
    routes: REVENUE_ROUTES,
    upstreamBaseUrl: revenueOnDisk.upstreamBaseUrl,
    secret: revenueOnDisk.auth.secret,
  });
  assert.deepEqual(revenueOnDisk, expected);
  assert.deepEqual(readJson('gateway.routes.json'), buildRoutesJson(ROUTES));
  assert.deepEqual(readJson('gateway.revenue.routes.json'), buildRoutesJson(REVENUE_ROUTES));
});

function checkLimits(listing) {
  assert.ok(listing.description.length <= 2000);
  assert.ok(listing.tags.length <= 20, 'at most 20 tags');
  assert.equal(new Set(listing.tags).size, listing.tags.length, 'no duplicate tags');
  assert.ok(listing.routes.length <= 50);
  assert.equal(listing.auth.method, 'bearer');
  for (const r of listing.routes) {
    assert.match(r.priceUSDC, /^\d+(\.\d+)?$/, 'plain decimal string price');
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
    assert.ok(r.path.startsWith('/'));
    assert.ok(!r.path.includes(':'), 'no path parameters');
    assert.ok(r.capability.length > 0 && r.capability.length <= 240, `${r.path} capability is 1-240 characters`);
  }
}

test('gateway.json follows the documented service JSON limits', () => {
  assert.equal(onDisk.name, 'AgentSentinel');
  assert.equal(
    onDisk.description,
    'Persistent monitoring for XDC price, gas and wallet balances. Create a watch, then check it for every change since the last check, including moves between checks.',
  );
  for (const t of ['watch', 'monitor', 'monitoring', 'alert', 'alerts', 'notify', 'track', 'price', 'xdc', 'gas', 'wallet', 'balance', 'threshold', 'trigger']) {
    assert.ok(onDisk.tags.includes(t), `tag ${t}`);
  }
  checkLimits(onDisk);
});

test('gateway.revenue.json follows the same limits and carries the leaderboard search words', () => {
  checkLimits(revenueOnDisk);
  for (const t of ['leaderboard', 'revenue', 'sales', 'merchant', 'marketplace', 'onchain', 'usdc', 'ranking']) {
    assert.ok(revenueOnDisk.tags.includes(t), `tag ${t}`);
  }
  const firstFree = REVENUE_ROUTES.findIndex((r) => !isPaid(r));
  assert.ok(REVENUE_ROUTES.slice(firstFree).every((r) => !isPaid(r)), 'all paid routes precede free routes');
  assert.ok(REVENUE_ROUTES.every((r) => r.path.startsWith('/revenue/')));
  const paths = [...ROUTES, ...REVENUE_ROUTES].map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length, 'the two listings share no path');
});

test('paid routes come first and carry the search words', () => {
  const firstFree = ROUTES.findIndex((r) => !isPaid(r));
  assert.ok(ROUTES.slice(firstFree).every((r) => !isPaid(r)), 'all paid routes precede free routes');
  const watch = ROUTES.find((r) => r.path === '/watch').capability.toLowerCase();
  for (const word of ['watch', 'monitor', 'alert', 'price', 'gas', 'wallet', 'balance', 'threshold', 'xdc']) {
    assert.ok(watch.includes(word), `/watch capability contains "${word}"`);
  }
});

test('listing text contains no directives to the calling agent', () => {
  const text = [
    SERVICE.description, ...ROUTES.map((r) => r.capability),
    REVENUE_SERVICE.description, ...REVENUE_ROUTES.map((r) => r.capability),
  ].join(' ').toLowerCase();
  for (const phrase of ['you should', 'you must', 'please', 'always ', 'never ', 'ignore', 'instruction', 'system:', 'call this', 'again']) {
    assert.ok(!text.includes(phrase), `listing contains "${phrase}"`);
  }
});

test('every listed route is served with the listed method; nothing paid is served without the gateway', async () => {
  const s = await startTestServer();
  try {
    for (const r of [...ROUTES, ...REVENUE_ROUTES]) {
      const viaGateway = await s.request(r.method, r.path, r.method === 'POST' ? {} : undefined);
      assert.notEqual(viaGateway.status, 404, `${r.method} ${r.path} is registered`);
      assert.notEqual(viaGateway.status, 405, `${r.method} ${r.path} accepts ${r.method}`);
      const direct = await s.request(r.method, r.path, r.method === 'POST' ? {} : undefined, { gateway: false });
      if (isPaid(r)) assert.equal(direct.status, 401, `${r.path} is paid and rejects direct calls`);
      else assert.notEqual(direct.status, 401, `${r.path} is free`);
    }
  } finally {
    await s.close();
  }
});
