// HTTP handlers for the merchant leaderboard routes (/revenue/...). Registered by
// src/app.js from REVENUE_ROUTES, with the same gateway check, rate limits and error
// handling as the price-watch routes. Responses are data only.

import { REVENUE_SERVICE, REVENUE_ROUTES } from './catalog.js';
import { ValidationError, validateTokenBody } from '../validate.js';
import { hashToken } from '../store.js';
import { TOKEN_PATTERN, readSignedToken } from '../tokens.js';
import {
  loadBoard, boardEntry, marketSummary, topRoutes24h, dataStatus, resolveMerchant,
  merchantReport, checkReport, iso,
} from './report.js';

const MERCHANT_FIELDS = ['merchant', 'name', 'provider', 'provider_name', 'provider_id', 'service_id', 'pay_to', 'payTo', 'address', 'url'];
const MERCHANT_EXAMPLE = { merchant: 'AgentSentinel' };
const MERCHANT_FORMS = 'a listing name, a service id (gw_...), a payout address (0x... or xdc...) or a route URL';

// The merchant identifier from the JSON body (or the query string). null when absent.
function readMerchant(req) {
  const body = req.body;
  const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
  if (body !== undefined && body !== null && !isObject) {
    throw new ValidationError('request body must be a JSON object', { details: { example: MERCHANT_EXAMPLE } });
  }
  const src = isObject ? body : {};
  const unknown = Object.keys(src).filter((k) => !MERCHANT_FIELDS.includes(k));
  if (unknown.length) {
    throw new ValidationError(`unknown field(s): ${unknown.join(', ')}; accepted field: merchant (${MERCHANT_FORMS})`, {
      field: unknown[0],
      details: { example: MERCHANT_EXAMPLE },
    });
  }
  const query = req.query || {};
  for (const f of MERCHANT_FIELDS) {
    const v = src[f] !== undefined ? src[f] : query[f];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') throw new ValidationError(`${f} must be a string (${MERCHANT_FORMS})`, { field: f, details: { example: MERCHANT_EXAMPLE } });
    const value = v.trim().slice(0, 300);
    if (value) return value;
  }
  return null;
}

export function createRevenueHandlers({ config, store, tracker, clock, tokenKey, limitTokens, diagnostics }) {
  const startMs = config.revenueStartMs;
  const maxListed = config.maxTriggersPerReport;

  const board = (now) => loadBoard(store, now, { startMs });
  const data = (now) => dataStatus(store, tracker, config, now);

  // Before the first catalog read there is nothing to rank; 503 is not charged.
  function warmingUp(res) {
    res.set('Retry-After', '30');
    return res.status(503).json({
      error: 'warming_up',
      message: 'the marketplace catalog has not been read since the server started',
      retry_after_seconds: 30,
    });
  }

  function unknownMerchant(res, query, suggestions) {
    return res.status(404).json({
      error: 'unknown_merchant',
      message: `no listed merchant matches "${query}"`,
      accepted_forms: MERCHANT_FORMS,
      suggestions,
    });
  }

  async function restoreIfMissing(token, hash) {
    if (!tokenKey || !token.includes('.')) return;
    if (await store.findWatch(hash)) return;
    const spec = readSignedToken(tokenKey, token);
    if (!spec || spec.type !== 'merchant_revenue' || spec.cond !== 'since_last_check') return;
    await store.restoreWatch(spec, hash);
    diagnostics.restoredWatches += 1;
  }

  async function perToken(tokens, fn) {
    const seen = new Set();
    const results = [];
    for (let index = 0; index < tokens.length; index++) {
      const t = tokens[index];
      if (seen.has(t)) {
        results.push({ index, status: 'duplicate_token_in_request' });
        continue;
      }
      seen.add(t);
      if (!TOKEN_PATTERN.test(t)) {
        results.push({ index, status: 'unknown_token' });
        continue;
      }
      const hash = hashToken(t);
      await restoreIfMissing(t, hash);
      results.push({ index, ...(await fn(hash)) });
    }
    return results;
  }

  const statusOf = (w, now) => (w.status === 'active' && w.expires_at <= now ? 'expired' : w.status);

  async function infoDocument() {
    const now = clock();
    const b = await board(now);
    return {
      service: REVENUE_SERVICE.name,
      description: REVENUE_SERVICE.description,
      routes: REVENUE_ROUTES.map((r) => ({ method: r.method, path: r.path, price_usdc: r.priceUSDC, capability: r.capability })),
      merchant_identifier: `field "merchant": ${MERCHANT_FORMS}`,
      definitions: {
        merchant: 'one payout address (payTo); listings that share a payout address are counted together, the others appear in other_listings',
        onchain_revenue_usdc: `USDC received by the payout address on XDC mainnet since ${iso(startMs)}, summed from Transfer events of USDC ${config.usdcAddress}`,
        onchain_payments: 'number of those transfers',
        rank: 'position by onchain_revenue_usdc, then catalog_volume_usdc',
        catalog_volume_usdc: 'volume counter published by the marketplace catalog for the merchant routes; it can differ from onchain_revenue_usdc',
        catalog_calls: 'call counter published by the marketplace catalog',
        route: 'listing, method and path whose price equals the payment amount; null when no single route of that merchant has that price',
        payer: 'sender of the USDC transfer',
        since: 'start of the reported window: the previous check, or the creation of the watch for its first check',
        new_payments: `on-chain payments recorded since the previous check, oldest first; at most ${maxListed} listed`,
        rank_at_last_check: 'rank at the previous check, or at creation for the first check',
        rank_change: 'rank_at_last_check minus rank; positive when the merchant moved up',
        passed: 'merchants ranked above this merchant at the previous check and below it now',
        passed_by: 'merchants ranked below this merchant at the previous check and above it now',
        new_merchants: 'payout addresses first seen in the catalog after the previous check; null when the recorded catalog history starts later',
        catalog_calls_since_last_check: 'increase of the catalog call counters of the merchant routes; null when the recorded catalog history starts later',
        history_reset_at: 'present when the watch was rebuilt from its token after a server data reset; rank_at_last_check is then null and new_payments counts from the creation of the watch',
        data: 'freshness of both sources: chain block and time read through, catalog read time, stale flags',
      },
      request_examples: {
        'GET /revenue/leaderboard': 'no request body',
        'POST /revenue/merchant': MERCHANT_EXAMPLE,
        'POST /revenue/watch': [MERCHANT_EXAMPLE, {}],
        'POST /revenue/check': { watch_tokens: ['wt_...'] },
        'POST /revenue/cancel': { watch_token: 'wt_...' },
      },
      coverage: {
        merchants_tracked: b.list.length,
        onchain_payments_indexed: b.list.reduce((acc, a) => acc + a.payments, 0),
      },
      limits: {
        max_watch_tokens_per_request: config.maxTokensPerRequest,
        requests_per_minute_per_watch_token_on_check: config.rateLimitTokenPerMinute,
        watch_lifetime_days: Math.round(config.watchTtlMs / 86400000),
      },
      data: await data(now),
    };
  }

  return {
    '/revenue/info': async (req, res) => {
      res.json(await infoDocument());
    },

    '/revenue/leaderboard': async (req, res) => {
      const now = clock();
      const b = await board(now);
      if (!b.list.length) return warmingUp(res);
      await store.logRequest('/revenue/leaderboard', req.viaGateway, now);
      res.json({
        time: iso(now),
        ranked_by: 'onchain_revenue_usdc, then catalog_volume_usdc',
        market: marketSummary(b),
        leaderboard: b.list.map(boardEntry),
        top_routes_24h: topRoutes24h(b),
        data: await data(now),
      });
    },

    '/revenue/merchant': async (req, res) => {
      const query = readMerchant(req);
      const now = clock();
      const b = await board(now);
      if (!b.list.length) return warmingUp(res);
      if (!query) {
        throw new ValidationError(`merchant is required: ${MERCHANT_FORMS}`, {
          field: 'merchant',
          details: { example: MERCHANT_EXAMPLE, merchants: b.list.map((a) => a.name) },
        });
      }
      const found = resolveMerchant(b, query);
      if (!found.account) return unknownMerchant(res, query, found.suggestions);
      await store.logRequest('/revenue/merchant', req.viaGateway, now);
      res.json({
        time: iso(now),
        matched: found.matched,
        ...(await merchantReport(store, b, found.account)),
        data: await data(now),
      });
    },

    '/revenue/watch': async (req, res) => {
      const query = readMerchant(req);
      const now = clock();
      const b = await board(now);
      if (!b.list.length) return warmingUp(res);
      let account = null;
      if (query) {
        const found = resolveMerchant(b, query);
        if (!found.account) return unknownMerchant(res, query, found.suggestions);
        account = found.account;
      }
      const lastPaymentId = await store.maxPaymentId();
      const { watch, token } = await store.createWatch(
        account ? account.payTo : 'market',
        { lastPaymentId, ranks: b.ranks, revenueMicro: account ? account.revenueMicro : null },
        { viaGateway: req.viaGateway },
      );
      await store.logRequest('/revenue/watch', req.viaGateway, now);
      const current = account
        ? await merchantReport(store, b, account)
        : { market: marketSummary(b), leaderboard: b.list.map(boardEntry) };
      res.status(200).json({
        watch_token: token,
        watch_id: watch.id,
        status: 'active',
        target: account ? 'merchant' : 'market',
        created_at: iso(watch.created_at),
        expires_at: iso(watch.expires_at),
        ...current,
        data: await data(now),
      });
    },

    '/revenue/check': async (req, res) => {
      const tokens = validateTokenBody(req.body, { maxTokens: config.maxTokensPerRequest });
      if (!limitTokens(tokens, config.rateLimitTokenPerMinute, res)) return;
      const now = clock();
      let b = await board(now);
      if (!b.list.length) return warmingUp(res);
      const catalogHistoryFrom = Number(await store.getMeta('catalog_history_from')) || null;
      const results = await perToken(tokens, async (hash) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const w = await store.findWatch(hash);
          if (!w) return { status: 'unknown_token' };
          const status = statusOf(w, now);
          if (status !== 'active') {
            return { status, watch_id: w.id, target: w.target === 'market' ? 'market' : 'merchant', ended_at: iso(w.ended_at ?? w.expires_at) };
          }
          const snapshotMaxId = await store.maxPaymentId();
          const report = await checkReport(store, b, w, { now, snapshotMaxId, catalogHistoryFrom, maxListed });
          const a = w.target === 'market' ? null : b.byPayTo.get(w.target);
          const recorded = await store.recordCheck(w, {
            checkedAt: now,
            lastPaymentId: snapshotMaxId,
            ranks: b.ranks,
            revenueMicro: a ? a.revenueMicro : null,
          });
          if (!recorded) {
            b = await board(clock());
            continue;
          }
          const since = w.last_check_at ?? w.created_at;
          return {
            status: 'active',
            watch_id: w.id,
            ...report,
            previous_check_time: iso(w.last_check_at),
            seconds_since_last_check: Math.max(0, Math.round((now - since) / 1000)),
            ...(w.restored_at ? { history_reset_at: iso(w.restored_at) } : {}),
            created_at: iso(w.created_at),
            expires_at: iso(w.expires_at),
          };
        }
        return { status: 'busy', message: 'the watch was checked by another request at the same moment' };
      });
      await store.logRequest('/revenue/check', req.viaGateway, now);
      res.json({ checked_at: iso(now), result_count: results.length, results, data: await data(now) });
    },

    '/revenue/cancel': async (req, res) => {
      const tokens = validateTokenBody(req.body, { maxTokens: config.maxTokensPerRequest });
      if (!limitTokens(tokens, config.rateLimitTokenPerMinute * 2, res)) return;
      const results = await perToken(tokens, async (hash) => {
        const r = await store.cancel(hash);
        if (r.status === 'unknown_token') return { status: 'unknown_token' };
        return { status: r.status, watch_id: r.watch.id, cancelled_by_this_request: r.changed, ended_at: iso(r.watch.ended_at) };
      });
      res.json({ result_count: results.length, results });
    },
  };
}
