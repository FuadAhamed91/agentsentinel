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
      'marketplace.leaderboard: who is leading and by how much: all XDC AI merchants ranked by on-chain USDC revenue, income, earnings; leaders, standings, winners, margin; 24h, 1h, volume; top selling, popular, trending routes; GET, no body',
  },
  {
    method: 'POST',
    path: '/revenue/merchant',
    priceUSDC: '0.05',
    capability:
      'marketplace.merchant.sales: one merchant by name, service id or payout address: rank, on-chain revenue, USDC earned, each recent payment with time, amount, buyer address and tx hash, gap to competitors ahead and behind',
  },
  {
    method: 'POST',
    path: '/revenue/watch',
    // Every paid route costs 0.05 so a "--max-price 0.05" search (the docs' example) lists all of them.
    priceUSDC: '0.05',
    capability:
      'marketplace.merchant.watch: persistent sales, revenue and rank tracker for one merchant, or for the whole marketplace with an empty body; returns watch_token and the current report',
  },
  {
    method: 'POST',
    path: '/revenue/check',
    priceUSDC: '0.05',
    capability:
      'marketplace.merchant.check: report per watch since its last check: new on-chain payments and buyers, revenue change, rank then and now, competitors passed and passed by, new merchants listed',
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
