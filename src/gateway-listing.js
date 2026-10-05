// Builds the XDC AI Gateway service JSON (docs.xdcai.tech/gateway/service-json)
// from src/catalog.js, the same file the server registers its routes from.

import { SERVICE, ROUTES } from './catalog.js';

export const PLACEHOLDER_UPSTREAM = 'https://YOUR-APP.replit.app';
export const PLACEHOLDER_SECRET = 'REPLACE_WITH_GATEWAY_SECRET';

export function buildGatewayJson({ upstreamBaseUrl = PLACEHOLDER_UPSTREAM, secret = PLACEHOLDER_SECRET } = {}) {
  return {
    name: SERVICE.name,
    upstreamBaseUrl: upstreamBaseUrl.replace(/\/+$/, ''),
    description: SERVICE.description,
    tags: SERVICE.tags,
    paymentType: 'x402',
    enabled: true,
    isPublic: true,
    auth: { method: 'bearer', secret },
    routes: ROUTES.map((r) => ({
      method: r.method,
      path: r.path,
      priceUSDC: r.priceUSDC,
      capability: r.capability,
      enabled: true,
    })),
  };
}
