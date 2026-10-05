// HTTP API. Plain JSON over HTTPS; the XDC AI gateway in front of it handles the
// 402 challenge, payment verification and settlement. A 2xx response settles the
// payment for paid routes; any other status means the caller is not charged.
// Responses are data only: values, timestamps, flags and definitions.

import crypto from 'node:crypto';
import express from 'express';
import { SERVICE, ROUTES, isPaid } from './catalog.js';
import { CONDITION_DESCRIPTIONS, conditionMetNow } from './conditions.js';
import { TYPES } from './types/index.js';
import { toXdcAddress } from './types/wallet_balance.js';
import { hashToken } from './store.js';
import { ValidationError, validateWatchBody, validateTokenBody, TOKEN_PATTERN, WATCH_EXAMPLES } from './validate.js';
import { createRateLimiter } from './ratelimit.js';
import { renderStats } from './stats.js';

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

function parseTrustProxy(v) {
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(String(v))) return Number(v);
  return v;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearer(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function watchConfig(w) {
  const type = TYPES[w.type];
  const out = {
    watch_id: w.id,
    type: w.type,
    condition: w.cond,
    threshold: w.threshold,
    unit: type ? type.unit : null,
  };
  if (w.cond === 'changes_by_percent') {
    out.percent = w.percent;
    out.direction = w.direction;
  }
  if (w.address) {
    out.address = w.address;
    out.address_xdc = toXdcAddress(w.address);
  }
  return out;
}

function eventOut(e) {
  return {
    time: iso(e.ts),
    kind: e.kind,
    value: e.value,
    previous_value: e.previous_value,
    ...(e.reference_value !== null && e.reference_value !== undefined ? { reference_value: e.reference_value } : {}),
  };
}

export function createApp({ config, store, sampler, clock = Date.now, logger = console }) {
  const app = express();
  const limiter = createRateLimiter({ clock });
  const diagnostics = {
    gatewayHeaderNames: new Set(),
    gatewayRequests: 0,
    wrongBearerRequests: 0,
    directPaidRejected: 0,
  };
  const intervalSeconds = Math.round(config.sampleIntervalMs / 1000);

  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(config.trustProxy));
  app.set('json spaces', 0);

  // Identify gateway traffic by the shared secret the gateway injects.
  app.use((req, res, next) => {
    const token = bearer(req);
    req.viaGateway = Boolean(config.gatewaySecret && token && safeEqual(token, config.gatewaySecret));
    if (req.viaGateway) {
      diagnostics.gatewayRequests += 1;
      // Header names only (never values), to see what the gateway forwards.
      for (const name of Object.keys(req.headers)) {
        if (diagnostics.gatewayHeaderNames.size < 80) diagnostics.gatewayHeaderNames.add(name);
      }
    } else if (token && config.gatewaySecret) {
      // A bearer token that does not match usually means the secret in the gateway
      // service differs from GATEWAY_SECRET.
      diagnostics.wrongBearerRequests += 1;
    }
    next();
  });

  // Per-IP limit for direct traffic. Gateway traffic all arrives from the gateway's
  // address, so it is limited per watch token instead.
  app.use((req, res, next) => {
    if (req.viaGateway) return next();
    const r = limiter.hit(`ip:${req.ip}`, config.rateLimitIpPerMinute);
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterSeconds));
      return res.status(429).json({ error: 'rate_limited', message: 'too many requests from this address', retry_after_seconds: r.retryAfterSeconds });
    }
    next();
  });

  // Bodies are parsed as JSON whatever the declared content type.
  app.use(express.json({ limit: '32kb', type: () => true, strict: false }));

  function requireGateway(req, res, next) {
    if (!config.gatewaySecret || req.viaGateway) return next();
    diagnostics.directPaidRejected += 1;
    const body = { error: 'unauthorized', message: 'paid route; served only through the XDC AI gateway' };
    if (config.gatewayPublicUrl) body.paid_endpoint = `${config.gatewayPublicUrl}${req.path}`;
    return res.status(401).json(body);
  }

  function limitTokens(tokens, perMinute, res) {
    for (const t of new Set(tokens)) {
      const r = limiter.hit(`tok:${hashToken(t)}`, perMinute);
      if (!r.ok) {
        res.set('Retry-After', String(r.retryAfterSeconds));
        res.status(429).json({ error: 'rate_limited', message: `more than ${perMinute} requests per minute for one watch token`, retry_after_seconds: r.retryAfterSeconds });
        return false;
      }
    }
    return true;
  }

  // Runs fn once per distinct token, in request order. Duplicates and malformed tokens
  // are reported per item.
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
      results.push({ index, ...(await fn(hashToken(t))) });
    }
    return results;
  }

  function currentFields(w, sample, now) {
    const info = sampler.sourceInfo(w.source_key, sample, now);
    return {
      current_value: sample ? sample.value : null,
      current_value_time: sample ? iso(sample.ts) : null,
      current_value_source: sample ? sample.origin : null,
      stale: info.stale,
    };
  }

  // ---------- handlers ----------

  const handlers = {};

  handlers['/info'] = (req, res) => {
    res.json(infoDocument());
  };

  handlers['/health'] = async (req, res) => {
    const now = clock();
    const sources = {};
    for (const key of ['xdc_price', 'xdc_gas']) {
      const s = await store.latestSample(key);
      const info = sampler.sourceInfo(key, s, now);
      sources[key] = { value: s ? s.value : null, time: s ? iso(s.ts) : null, stale: info.stale };
    }
    res.json({
      ok: true,
      time: iso(now),
      database: store.db.kind,
      sampler_last_round: iso(sampler.stats.last_tick_at),
      sample_interval_seconds: intervalSeconds,
      sources,
    });
  };

  handlers['/watch'] = async (req, res) => {
    const params = validateWatchBody(req.body);
    const now = clock();
    if ((await store.countActiveWatches(now)) >= config.maxActiveWatches) {
      return res.status(503).json({ error: 'capacity', message: 'active watch limit reached' });
    }
    if (params.type === 'wallet_balance') {
      const keys = await store.activeSourceKeys('wallet_balance', now);
      if (!keys.includes(params.sourceKey) && keys.length >= config.maxWalletAddresses) {
        return res.status(503).json({ error: 'capacity', message: 'watched wallet limit reached' });
      }
    }
    // Make sure a recent value exists (first watch on a wallet, or right after startup).
    // The wait is capped so a slow source cannot hold the paid request open; a fetch
    // still running afterwards stores its sample when it completes.
    await Promise.race([
      sampler.ensureSample(params.sourceKey).catch(() => null),
      new Promise((resolve) => { setTimeout(resolve, config.createFetchWaitMs).unref?.(); }),
    ]);
    const { watch, token, baseline } = await store.createWatch(params, { viaGateway: req.viaGateway });
    // 200 rather than 201: the gateway settles on success, and 200 is the plainest success.
    res.status(200).json({
      ...watchConfig(watch),
      watch_token: token,
      status: 'active',
      created_at: iso(watch.created_at),
      expires_at: iso(watch.expires_at),
      ...currentFields(watch, baseline, now),
      condition_met_now: baseline ? conditionMetNow(watch, baseline.value) : null,
      sample_interval_seconds: intervalSeconds,
    });
  };

  handlers['/check'] = async (req, res) => {
    const tokens = validateTokenBody(req.body, { maxTokens: config.maxTokensPerRequest });
    if (!limitTokens(tokens, config.rateLimitTokenPerMinute, res)) return;
    const requestId = crypto.randomUUID();
    const now = clock();
    const results = await perToken(tokens, async (hash) => {
      const r = await store.checkWatch(hash, { requestId, viaGateway: req.viaGateway, maxTriggers: config.maxTriggersPerReport });
      if (r.status === 'unknown_token') return { status: 'unknown_token' };
      if (r.status !== 'active') {
        return { status: r.status, ...watchConfig(r.watch), ended_at: iso(r.watch.ended_at) };
      }
      const rep = r.report;
      const w = rep.watch;
      const since = rep.previous_check_at ?? w.created_at;
      const out = {
        status: 'active',
        ...watchConfig(w),
        ...currentFields(w, rep.current, now),
        triggered: rep.triggered,
        condition_met_now: rep.condition_met_now,
        trigger_count_since_last_check: rep.trigger_count,
        triggers_since_last_check: rep.triggers.map(eventOut),
        triggers_not_listed: Math.max(0, rep.trigger_count - rep.triggers.length),
        high_since_last_check: w.window_count > 0 ? w.window_high : null,
        low_since_last_check: w.window_count > 0 ? w.window_low : null,
        sample_count_since_last_check: w.window_count,
      };
      if (w.cond === 'changes_by_percent') {
        out.reference_value = rep.reference_value;
        out.change_percent_from_reference = rep.change_percent === null ? null : Number(rep.change_percent.toFixed(4));
      }
      out.previous_check_time = iso(rep.previous_check_at);
      out.seconds_since_last_check = Math.max(0, Math.round((rep.checked_at - since) / 1000));
      out.sample_interval_seconds = intervalSeconds;
      out.created_at = iso(w.created_at);
      out.expires_at = iso(w.expires_at);
      return out;
    });
    res.json({ checked_at: iso(now), sample_interval_seconds: intervalSeconds, result_count: results.length, results });
  };

  handlers['/watches'] = async (req, res) => {
    const tokens = validateTokenBody(req.body, { maxTokens: config.maxTokensPerRequest });
    if (!limitTokens(tokens, config.rateLimitTokenPerMinute * 2, res)) return;
    const results = await perToken(tokens, async (hash) => {
      const w = await store.findByTokenHash(hash);
      if (!w) return { status: 'unknown_token' };
      const status = w.status === 'active' && w.expires_at <= clock() ? 'expired' : w.status;
      return {
        status,
        ...watchConfig(w),
        created_at: iso(w.created_at),
        expires_at: iso(w.expires_at),
        ended_at: iso(w.ended_at),
        check_count: w.check_count,
        last_check_time: iso(w.last_check_at),
      };
    });
    res.json({ result_count: results.length, results });
  };

  handlers['/events'] = async (req, res) => {
    const tokens = validateTokenBody(req.body, { maxTokens: config.maxTokensPerRequest });
    if (!limitTokens(tokens, config.rateLimitTokenPerMinute * 2, res)) return;
    const results = await perToken(tokens, async (hash) => {
      const w = await store.findByTokenHash(hash);
      if (!w) return { status: 'unknown_token' };
      const events = await store.reportedEvents(w, 100);
      return {
        status: w.status === 'active' && w.expires_at <= clock() ? 'expired' : w.status,
        watch_id: w.id,
        last_check_time: iso(w.last_check_at),
        reported_trigger_count: events.length,
        reported_triggers: events.map(eventOut),
      };
    });
    res.json({ result_count: results.length, results });
  };

  handlers['/cancel'] = async (req, res) => {
    const tokens = validateTokenBody(req.body, { maxTokens: config.maxTokensPerRequest });
    if (!limitTokens(tokens, config.rateLimitTokenPerMinute * 2, res)) return;
    const results = await perToken(tokens, async (hash) => {
      const r = await store.cancel(hash);
      if (r.status === 'unknown_token') return { status: 'unknown_token' };
      return {
        status: r.status,
        watch_id: r.watch.id,
        cancelled_by_this_request: r.changed,
        ended_at: iso(r.watch.ended_at),
      };
    });
    res.json({ result_count: results.length, results });
  };

  // ---------- routes from the catalog ----------

  for (const route of ROUTES) {
    const handler = handlers[route.path];
    if (!handler) throw new Error(`catalog route ${route.method} ${route.path} has no handler`);
    const method = route.method.toLowerCase();
    const chain = isPaid(route) ? [requireGateway, handler] : [handler];
    app[method](route.path, ...chain);
    app.all(route.path, (req, res) => {
      res.set('Allow', route.method);
      res.status(405).json({ error: 'method_not_allowed', message: `${req.method} ${route.path} is not supported`, allowed_method: route.method });
    });
  }

  app.get('/', handlers['/info']);

  app.get('/stats', async (req, res) => {
    if (!config.statsSecret) return res.status(404).json({ error: 'not_found' });
    const key = typeof req.query.key === 'string' ? req.query.key : bearer(req);
    if (!key || !safeEqual(key, config.statsSecret)) return res.status(401).json({ error: 'unauthorized' });
    const s = await store.stats(clock());
    const sources = {};
    for (const [k, v] of sampler.status) sources[k] = v;
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderStats({
      stats: s,
      sources,
      sampler: sampler.stats,
      diagnostics: {
        database: store.db.kind === 'postgres' ? 'postgres' : 'sqlite (local file; not persistent on Replit deployments)',
        gateway_auth: config.gatewaySecret ? 'enabled' : 'disabled (GATEWAY_SECRET not set)',
        gateway_requests_since_start: diagnostics.gatewayRequests,
        requests_with_wrong_bearer_since_start: diagnostics.wrongBearerRequests,
        direct_paid_requests_rejected_since_start: diagnostics.directPaidRejected,
        gateway_header_names_seen: [...diagnostics.gatewayHeaderNames].sort(),
      },
      now: clock(),
    }));
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `no route ${req.method} ${req.path}`, routes: ROUTES.map((r) => `${r.method} ${r.path}`) });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'invalid_request', message: err.message, field: err.field, ...(err.details || {}) });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'request body is not valid JSON' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'body_too_large', message: 'request body is larger than 32kb' });
    }
    if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: 'bad_request', message: 'request could not be read' });
    }
    logger.error(`[http] ${req.method} ${req.path} failed: ${err && err.stack ? err.stack : err}`);
    return res.status(500).json({ error: 'internal_error', message: 'the request could not be completed' });
  });

  function infoDocument() {
    return {
      service: SERVICE.name,
      description: SERVICE.description,
      routes: ROUTES.map((r) => ({ method: r.method, path: r.path, price_usdc: r.priceUSDC, capability: r.capability })),
      watch_types: Object.fromEntries(Object.values(TYPES).map((t) => [t.name, {
        description: t.description,
        unit: t.unit,
        conditions: t.conditions,
        address_required: t.requiresAddress,
        threshold_range: { min: t.threshold.min, max: t.threshold.max, min_exclusive: Boolean(t.threshold.exclusiveMin) },
      }])),
      conditions: CONDITION_DESCRIPTIONS,
      parameters: {
        type: 'xdc_price | xdc_gas | wallet_balance',
        condition: 'one of the conditions listed for the type',
        threshold: 'number in the unit of the type; used by above, below, crosses_above, crosses_below',
        percent: 'number > 0 and <= 1000; used by changes_by_percent',
        direction: 'any | up | down; optional for changes_by_percent; default any',
        address: 'wallet_balance only; "xdc" or "0x" followed by 40 hex characters',
        watch_tokens: 'array of watch tokens (strings starting with wt_); /check, /watches, /events and /cancel also accept a single watch_token string',
      },
      request_examples: {
        'POST /watch': WATCH_EXAMPLES,
        'POST /check': { watch_tokens: ['wt_...', 'wt_...'] },
        'POST /watches': { watch_tokens: ['wt_...'] },
        'POST /events': { watch_tokens: ['wt_...'] },
        'POST /cancel': { watch_token: 'wt_...' },
      },
      response_fields: {
        watch_token: 'secret string returned only by POST /watch; identifies the watch in every other route',
        current_value: 'latest stored sample for the watched series',
        current_value_time: 'time of that sample (ISO 8601, UTC)',
        stale: `true when the latest sample is older than ${Math.round(config.staleAfterMs / 1000)} seconds or the last attempt to read the source failed; current_value is then the last known value`,
        triggered: 'true when at least one trigger was recorded since the previous check, or when an above, below or changes_by_percent condition holds for the current value',
        condition_met_now: 'whether the current value satisfies an above, below or changes_by_percent condition; null for crosses and changes conditions',
        triggers_since_last_check: `triggers recorded since the previous check, oldest first, each with time and value, including moves that later reversed; at most ${config.maxTriggersPerReport} listed`,
        trigger_count_since_last_check: 'number of triggers recorded since the previous check',
        high_since_last_check: 'highest sample since the previous check (since creation for the first check); null when no sample was taken yet',
        low_since_last_check: 'lowest sample since the previous check (since creation for the first check); null when no sample was taken yet',
        sample_count_since_last_check: 'number of samples evaluated since the previous check',
        seconds_since_last_check: 'seconds since the previous check, or since creation for the first check',
        sample_interval_seconds: 'seconds between background samples',
        status: 'active | cancelled | expired | unknown_token | duplicate_token_in_request',
        reported_triggers: 'POST /events lists triggers already reported by POST /check',
      },
      sampling: {
        sample_interval_seconds: intervalSeconds,
        stale_after_seconds: Math.round(config.staleAfterMs / 1000),
        sample_retention_hours: Math.round(config.sampleRetentionMs / 3600000),
        watch_lifetime_days: Math.round(config.watchTtlMs / 86400000),
        data_sources: {
          xdc_price: `XDC/USD from ${config.priceSources.join(', then ')} (first source that answers)`,
          xdc_gas: 'eth_gasPrice on XDC mainnet RPC, chain ID 50',
          wallet_balance: 'eth_getBalance on XDC mainnet RPC, chain ID 50',
        },
      },
      limits: {
        max_watch_tokens_per_request: config.maxTokensPerRequest,
        requests_per_minute_per_watch_token_on_check: config.rateLimitTokenPerMinute,
      },
    };
  }

  app.locals.diagnostics = diagnostics;
  app.locals.limiter = limiter;
  return app;
}
