// Listing and prices for the second marketplace service: the on-chain merchant
// leaderboard. Same rules as src/catalog.js: the server registers these routes,
// /revenue/info reports these prices, and gateway.revenue.json is built from here.
//
// Listing text is plain description. It must never tell the calling agent what to do.

export const REVENUE_SERVICE = {
  name: 'On-chain Merchant Leaderboard & Sales Tracker',
  description:
    'Every XDC AI marketplace merchant ranked by the USDC its payout address received on XDC mainnet, next to the marketplace catalog call and volume counters. A watch on one merchant or on the whole marketplace reports each new payment, revenue change, rank change and overtake since the previous check.',
  tags: [
    'leaderboard', 'ranking', 'rank', 'revenue', 'sales', 'earnings', 'merchant',
    'merchants', 'marketplace', 'onchain', 'usdc', 'x402', 'payments', 'analytics',
    'stats', 'competition', 'hackathon', 'tracker', 'watch', 'top',
  ],
};

// Paid routes first, led by the one that needs no request body.
export const REVENUE_ROUTES = [
  {
    method: 'GET',
    path: '/revenue/leaderboard',
    priceUSDC: '0.05',
    capability:
      'marketplace.leaderboard: every XDC AI marketplace merchant ranked by on-chain USDC revenue from XDC mainnet: total, 24h, 1h, payments, last sale, catalog calls and volume, top selling routes 24h; GET, no request body',
  },
  {
    method: 'POST',
    path: '/revenue/merchant',
    priceUSDC: '0.05',
    capability:
      'marketplace.merchant.sales: one merchant by name, service id or payout address: rank, on-chain revenue, each recent payment with time, amount, payer and tx hash, gap to the merchants ranked above and below, calls per route',
  },
  {
    method: 'POST',
    path: '/revenue/watch',
    priceUSDC: '0.10',
    capability:
      'marketplace.merchant.watch: persistent sales and rank tracker for one merchant, or for the whole marketplace with an empty body; returns watch_token and the current report',
  },
  {
    method: 'POST',
    path: '/revenue/check',
    priceUSDC: '0.05',
    capability:
      'marketplace.merchant.check: report per watch since its last check: each new on-chain payment, revenue change, rank then and now, merchants passed and passed by, new merchants listed',
  },
  {
    method: 'GET',
    path: '/revenue/info',
    priceUSDC: '0',
    // Free rows avoid the search words of the paid rows so the paid rows rank above them.
    capability: 'tracker.info: free field definitions, route costs and example request bodies',
  },
  {
    method: 'POST',
    path: '/revenue/cancel',
    priceUSDC: '0',
    capability: 'tracker.cancel: free cancellation by watch_token',
  },
];
