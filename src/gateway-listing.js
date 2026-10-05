// Builds the XDC AI Gateway service JSON (docs.xdcai.tech/gateway/service-json)
// from the catalogs the server registers its routes from. One server, two listings:
// AgentSentinel (src/catalog.js) and the merchant leaderboard (src/revenue/catalog.js).

import { SERVICE, ROUTES } from './catalog.js';
import { REVENUE_SERVICE, REVENUE_ROUTES } from './revenue/catalog.js';

export const PLACEHOLDER_UPSTREAM = 'https://YOUR-APP.replit.app';
export const PLACEHOLDER_SECRET = 'REPLACE_WITH_GATEWAY_SECRET';

export const LISTINGS = [
  { key: 'agentsentinel', service: SERVICE, routes: ROUTES, file: 'gateway.json', importFile: 'gateway.import.json', routesFile: 'gateway.routes.json' },
  { key: 'revenue', service: REVENUE_SERVICE, routes: REVENUE_ROUTES, file: 'gateway.revenue.json', importFile: 'gateway.revenue.import.json', routesFile: 'gateway.revenue.routes.json' },
];

// The routes array as the dashboard's "Edit all (JSON)" endpoint editor takes it.
export function buildRoutesJson(routes = ROUTES) {
  return routes.map((r) => ({
    method: r.method,
    path: r.path,
    priceUSDC: r.priceUSDC,
    capability: r.capability,
    enabled: true,
  }));
}

export function buildGatewayJson({ service = SERVICE, routes = ROUTES, upstreamBaseUrl = PLACEHOLDER_UPSTREAM, secret = PLACEHOLDER_SECRET } = {}) {
  return {
    name: service.name,
    upstreamBaseUrl: upstreamBaseUrl.replace(/\/+$/, ''),
    description: service.description,
    tags: service.tags,
    paymentType: 'x402',
    enabled: true,
    isPublic: true,
    auth: { method: 'bearer', secret },
    routes: buildRoutesJson(routes),
  };
}
