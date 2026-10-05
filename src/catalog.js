// Single source of truth for the marketplace listing and route prices.
// The server registers its routes from ROUTES, /info reports prices from ROUTES,
// and scripts/gen-gateway.js builds gateway.json from SERVICE + ROUTES.
// Change a price here and nowhere else.
//
// Listing text is plain description. It must never tell the calling agent what to do.

export const SERVICE = {
  name: 'AgentSentinel',
  description:
    'Persistent monitoring for XDC price, gas and wallet balances. Create a watch, then check it for every change since the last check, including moves between checks.',
  tags: [
    'watch', 'monitor', 'monitoring', 'alert', 'alerts', 'notify', 'track',
    'price', 'xdc', 'gas', 'wallet', 'balance', 'threshold', 'trigger',
    'crypto', 'notification', 'tracker', 'change', 'usd', 'market',
  ],
};

// Order matters: rows with equal search score appear in catalog order,
// so the paid routes come first, led by the one that needs no request body.
export const ROUTES = [
  {
    method: 'GET',
    path: '/xdc',
    priceUSDC: '0.02',
    capability:
      'xdc.price.snapshot: current XDC/USD price and XDC gas price with 1h and 24h high, low and percent change from 15 second sampling; GET, no request body',
  },
  {
    method: 'POST',
    path: '/watch',
    priceUSDC: '0.05',
    capability:
      'xdc.monitor.watch.create: persistent watch, monitor and alert on XDC/USD price, XDC gas price or XDC wallet balance with threshold triggers (above, below, crosses, percent change); returns watch_token and current value',
  },
  {
    method: 'POST',
    path: '/check',
    priceUSDC: '0.02',
    capability:
      'xdc.monitor.watch.check: report per watch since its last check: current price, gas or balance value, triggered flag, every alert trigger between checks with time and value, high, low, sample count',
  },
  {
    method: 'GET',
    path: '/info',
    priceUSDC: '0',
    // Free rows avoid the search words of the paid rows so the paid rows rank above them.
    capability: 'xdc.monitor.info: free description of watch types, conditions, route costs and example request bodies',
  },
  {
    method: 'POST',
    path: '/watches',
    priceUSDC: '0',
    capability: 'xdc.monitor.watches.status: free configuration and lifecycle status of watches by watch_token',
  },
  {
    method: 'POST',
    path: '/events',
    priceUSDC: '0',
    capability: 'xdc.monitor.events.history: free history of triggers already reported by check',
  },
  {
    method: 'POST',
    path: '/cancel',
    priceUSDC: '0',
    capability: 'xdc.monitor.watch.cancel: free cancellation of watches by watch_token',
  },
  {
    method: 'GET',
    path: '/health',
    priceUSDC: '0',
    capability: 'xdc.monitor.health: free service health',
  },
];

export function routePrice(path) {
  const route = ROUTES.find((r) => r.path === path);
  if (!route) throw new Error(`no catalog route for ${path}`);
  return route.priceUSDC;
}

export function isPaid(route) {
  return Number(route.priceUSDC) > 0;
}
