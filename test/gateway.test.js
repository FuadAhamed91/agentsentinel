// The listing (gateway.json), the catalog and the running server must agree.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildGatewayJson } from '../src/gateway-listing.js';
import { ROUTES, SERVICE, isPaid } from '../src/catalog.js';
import { startTestServer } from './helpers.js';

const onDisk = JSON.parse(fs.readFileSync(new URL('../gateway.json', import.meta.url), 'utf8'));

test('gateway.json on disk matches the catalog (regenerate with npm run gateway)', () => {
  const expected = buildGatewayJson({ upstreamBaseUrl: onDisk.upstreamBaseUrl, secret: onDisk.auth.secret });
  assert.deepEqual(onDisk, expected);
});

test('gateway.json follows the documented service JSON limits', () => {
  assert.equal(onDisk.name, 'AgentSentinel');
  assert.equal(
    onDisk.description,
    'Persistent monitoring for XDC price, gas and wallet balances. Create a watch, then check it for every change since the last check, including moves between checks.',
  );
  assert.ok(onDisk.description.length <= 2000);
  assert.ok(onDisk.tags.length <= 20, 'at most 20 tags');
  assert.equal(new Set(onDisk.tags).size, onDisk.tags.length, 'no duplicate tags');
  for (const t of ['watch', 'monitor', 'monitoring', 'alert', 'alerts', 'notify', 'track', 'price', 'xdc', 'gas', 'wallet', 'balance', 'threshold', 'trigger']) {
    assert.ok(onDisk.tags.includes(t), `tag ${t}`);
  }
  assert.ok(onDisk.routes.length <= 50);
  assert.equal(onDisk.auth.method, 'bearer');
  for (const r of onDisk.routes) {
    assert.match(r.priceUSDC, /^\d+(\.\d+)?$/, 'plain decimal string price');
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
    assert.ok(r.path.startsWith('/'));
    assert.ok(!r.path.includes(':'), 'no path parameters');
    assert.ok(r.capability.length > 0 && r.capability.length <= 240);
  }
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
  const text = [SERVICE.description, ...ROUTES.map((r) => r.capability)].join(' ').toLowerCase();
  for (const phrase of ['you should', 'you must', 'please', 'always ', 'never ', 'ignore', 'instruction', 'system:', 'call this', 'again']) {
    assert.ok(!text.includes(phrase), `listing contains "${phrase}"`);
  }
});

test('every listed route is served with the listed method; nothing paid is served without the gateway', async () => {
  const s = await startTestServer();
  try {
    for (const r of ROUTES) {
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
