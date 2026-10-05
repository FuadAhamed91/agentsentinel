// Wires database, store, sampler and HTTP app together. Used by src/server.js and the tests.

import { openDatabase } from './db/index.js';
import { createStore } from './store.js';
import { createSampler } from './sampler.js';
import { createApp } from './app.js';
import { tokenKey, createSignedToken } from './tokens.js';
import { createRevenueStore } from './revenue/store.js';
import { createRevenueTracker } from './revenue/tracker.js';

// market: { catalogSource, chain } for the merchant leaderboard (src/revenue/sources.js).
export async function startServer({ config, sources, market, clock = Date.now, logger = console, startSampler = true }) {
  const db = await openDatabase(config);
  const key = tokenKey(config);
  const tokenFactory = (watch) => createSignedToken(key, watch);
  const store = createStore(db, { clock, watchTtlMs: config.watchTtlMs, tokenFactory });
  await store.init();
  const sampler = createSampler({
    store,
    sources,
    clock,
    intervalMs: config.sampleIntervalMs,
    staleAfterMs: config.staleAfterMs,
    retentionMs: config.sampleRetentionMs,
    logger,
  });
  const revenueStore = createRevenueStore(db, { clock, watchTtlMs: config.watchTtlMs, tokenFactory });
  await revenueStore.init();
  const tracker = createRevenueTracker({
    store: revenueStore,
    catalogSource: market.catalogSource,
    chain: market.chain,
    clock,
    config,
    logger,
  });
  const app = createApp({ config, store, sampler, revenue: { store: revenueStore, tracker }, clock, logger, tokenKey: key });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(config.port, () => resolve(s));
    s.on('error', reject);
  });
  if (startSampler) {
    sampler.start();
    if (config.revenueTracker) tracker.start();
  }

  async function close() {
    sampler.stop();
    tracker.stop();
    app.locals.limiter.stop();
    await new Promise((resolve) => server.close(() => resolve()));
    await sampler.releaseLease();
    await tracker.releaseLease();
    await db.close();
  }

  return { app, server, store, sampler, revenueStore, tracker, db, close, port: server.address().port };
}
