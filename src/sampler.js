// Shared background sampler.
// Every interval: one XDC/USD price request, one gas price request, and one batched
// balance request covering every wallet that has an active watch. Each sample is
// stored once and evaluated against every watch that reads that series, so the
// number of external calls does not grow with the number of watches.
// The sampler only reads public data sources. It never calls this service's own
// routes and never creates payments.

import crypto from 'node:crypto';
import { TYPES, typeForSourceKey } from './types/index.js';

export function createSampler({
  store,
  sources,
  clock = Date.now,
  intervalMs = 15000,
  staleAfterMs = 60000,
  retentionMs = 48 * 3600 * 1000,
  logger = console,
}) {
  const instanceId = crypto.randomBytes(8).toString('hex');
  const status = new Map(); // source_key -> { last_ok_at, last_error_at, last_error, last_failed, origin }
  const stats = { ticks: 0, last_tick_at: null, last_tick_ms: null, skipped_not_leader: 0, fetch_calls: {} };
  let timer = null;
  let running = false;
  let lastPrune = 0;
  const inFlight = new Map(); // source_key -> Promise, collapses concurrent on-demand fetches

  function markOk(key, origin, at) {
    const s = status.get(key) || {};
    status.set(key, { ...s, last_ok_at: at, last_failed: false, origin });
  }

  function markFail(key, err, at) {
    const s = status.get(key) || {};
    status.set(key, { ...s, last_error_at: at, last_error: String(err && err.message ? err.message : err).slice(0, 300), last_failed: true });
  }

  async function sampleKeys(typeName, keys) {
    const type = TYPES[typeName];
    stats.fetch_calls[typeName] = (stats.fetch_calls[typeName] || 0) + 1;
    let results;
    try {
      results = await type.fetchSamples(keys, sources);
    } catch (err) {
      results = new Map(keys.map((k) => [k, { error: err }]));
    }
    const out = new Map();
    for (const key of keys) {
      const r = results.get(key) || { error: new Error('no result') };
      const at = clock();
      if (r.error) {
        markFail(key, r.error, at);
        continue;
      }
      try {
        const { sample } = await store.insertSampleAndEvaluate(key, at, r);
        markOk(key, r.origin, at);
        out.set(key, sample);
      } catch (err) {
        markFail(key, err, at);
        logger.error(`[sampler] storing ${key} failed: ${err.message}`);
      }
    }
    return out;
  }

  async function tick() {
    if (running) return false;
    running = true;
    const started = Date.now();
    try {
      const now = clock();
      if (!(await store.acquireLease(instanceId, intervalMs * 3, now))) {
        stats.skipped_not_leader += 1;
        return false;
      }
      await store.expireWatches(now);
      const plan = { xdc_price: ['xdc_price'], xdc_gas: ['xdc_gas'] };
      plan.wallet_balance = await store.activeSourceKeys('wallet_balance', now);
      await Promise.all(
        Object.entries(plan)
          .filter(([, keys]) => keys.length > 0)
          .map(([typeName, keys]) => sampleKeys(typeName, keys)),
      );
      if (now - lastPrune > 3600 * 1000) {
        lastPrune = now;
        await store.pruneSamples(now - retentionMs);
      }
      stats.ticks += 1;
      stats.last_tick_at = now;
      return true;
    } catch (err) {
      logger.error(`[sampler] tick failed: ${err.message}`);
      return false;
    } finally {
      stats.last_tick_ms = Date.now() - started;
      running = false;
    }
  }

  // Latest stored sample for a series, fetching once now if there is none recent enough.
  // Used when a watch is created on a series nobody is sampling yet (a new wallet),
  // or before the first background round has finished.
  async function ensureSample(key, maxAgeMs = staleAfterMs) {
    const existing = await store.latestSample(key);
    if (existing && clock() - existing.ts <= maxAgeMs) return existing;
    if (!inFlight.has(key)) {
      const type = typeForSourceKey(key);
      const p = sampleKeys(type.name, [key]).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    const fetched = await inFlight.get(key);
    return fetched.get(key) || existing || null;
  }

  function sourceInfo(key, sample, now = clock()) {
    const s = status.get(key);
    const age = sample ? now - sample.ts : null;
    const stale = !sample || age > staleAfterMs || Boolean(s && s.last_failed);
    return { stale, age_ms: age, last_error: s && s.last_failed ? s.last_error : null };
  }

  return {
    instanceId,
    status,
    stats,
    tick,
    ensureSample,
    sourceInfo,
    intervalMs,
    staleAfterMs,
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async releaseLease() {
      try {
        await store.releaseLease(instanceId);
      } catch (err) {
        logger.error(`[sampler] releasing lease failed: ${err.message}`);
      }
    },
    isRunning: () => Boolean(timer),
  };
}
