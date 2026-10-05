// How buyer agents find the listing. Agents run `xdcai marketplace list --search <terms>`
// (or the MCP tool marketplace_list), which scores each catalog row with the function
// below (copied from xdcai@0.1.33, core/dist/search.js) and can filter by --max-price.

import test from 'node:test';
import assert from 'node:assert/strict';
import { REVENUE_SERVICE, REVENUE_ROUTES } from '../src/revenue/catalog.js';
import { isPaid } from '../src/catalog.js';

const tokens = (s) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
function scoreService(service, terms) {
  const tagList = service.tags.map((t) => t.toLowerCase());
  const cap = service.capability.toLowerCase();
  const capTokens = tokens(cap);
  const name = service.providerName.toLowerCase();
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const tag of tagList) {
      if (tag === term) best = Math.max(best, 5);
      else if (tag.includes(term) || term.includes(tag)) best = Math.max(best, 3);
    }
    if (cap === term) best = Math.max(best, 5);
    else if (capTokens.includes(term)) best = Math.max(best, 4);
    else if (cap.includes(term)) best = Math.max(best, 3);
    if (name === term) best = Math.max(best, 3);
    else if (name.includes(term)) best = Math.max(best, 2);
    total += best;
  }
  return total;
}

const paidRows = REVENUE_ROUTES.filter(isPaid).map((r) => ({
  providerName: REVENUE_SERVICE.name,
  tags: REVENUE_SERVICE.tags,
  capability: r.capability,
  priceUSDC: r.priceUSDC,
  path: r.path,
}));

test('a paid row scores 5 (exact tag) for the core search words', () => {
  for (const term of ['revenue', 'sales', 'earnings', 'leaderboard', 'ranking', 'rank', 'stats', 'analytics', 'merchant', 'payments', 'usdc', 'onchain', 'hackathon', 'competition']) {
    const best = Math.max(...paidRows.map((r) => scoreService(r, [term])));
    assert.equal(best, 5, `"${term}"`);
  }
});

test('a paid row matches the other ways an agent may phrase the request (capability words)', () => {
  for (const term of [
    'income', 'earned', 'winners', 'standings', 'competitors', 'buyer', 'buyers', 'trending', 'popular', 'selling', 'volume', 'report',
    'leading', 'leaders', 'margin', 'ahead', 'behind', 'much',
  ]) {
    const best = Math.max(...paidRows.map((r) => scoreService(r, [term])));
    assert.ok(best >= 4, `"${term}" scores ${best}`);
  }
});

test('the question "who is leading" as one search term lands on the leaderboard row', () => {
  const lb = paidRows.find((r) => r.path === '/revenue/leaderboard');
  assert.ok(scoreService(lb, ['who is leading']) >= 3);
  assert.ok(scoreService(lb, ['by how much']) >= 3);
});

test('every paid route passes a --max-price 0.05 filter', () => {
  for (const r of paidRows) assert.ok(Number(r.priceUSDC) <= 0.05, `${r.path} costs ${r.priceUSDC}`);
});
