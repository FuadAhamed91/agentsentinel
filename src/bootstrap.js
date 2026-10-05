// Wires database, store, sampler and HTTP app together. Used by src/server.js and the tests.

import { openDatabase } from './db/index.js';
import { createStore } from './store.js';
import { createSampler } from './sampler.js';
import { createApp } from './app.js';

export async function startServer({ config, sources, clock = Date.now, logger = console, startSampler = true }) {
  const db = await openDatabase(config);
  const store = createStore(db, { clock, watchTtlMs: config.watchTtlMs });
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
  const app = createApp({ config, store, sampler, clock, logger });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(config.port, () => resolve(s));
    s.on('error', reject);
  });
  if (startSampler) sampler.start();

  async function close() {
    sampler.stop();
    app.locals.limiter.stop();
    await new Promise((resolve) => server.close(() => resolve()));
    await sampler.releaseLease();
    await db.close();
  }

  return { app, server, store, sampler, db, close, port: server.address().port };
}
