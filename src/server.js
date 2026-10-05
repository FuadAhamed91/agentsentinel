// Entry point: npm start. One process: HTTP server + background sampler.

import fs from 'node:fs';
import { loadConfig } from './config.js';
import { startServer } from './bootstrap.js';
import { createLiveSources } from './sources/index.js';
import { createLiveMarket } from './revenue/sources.js';

if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const config = loadConfig();
const srv = await startServer({ config, sources: createLiveSources(config), market: createLiveMarket(config) });

console.log(`[agentsentinel] listening on port ${srv.port}, database: ${srv.db.kind}, sample interval ${config.sampleIntervalMs / 1000}s`);
console.log(`[agentsentinel] merchant leaderboard ${config.revenueTracker ? `on: catalog every ${config.catalogIntervalMs / 1000}s, chain every ${config.chainIntervalMs / 1000}s, revenue from ${new Date(config.revenueStartMs).toISOString()}` : 'reader off (REVENUE_TRACKER=off)'}`);
if (!config.gatewaySecret) {
  console.warn('[agentsentinel] WARNING: GATEWAY_SECRET is not set. Paid routes accept direct calls without payment.');
}
if (!config.databaseUrl) {
  console.log(`[agentsentinel] using SQLite file ${config.sqlitePath}. If the file is lost, each watch is rebuilt from its signed token on its next use.`);
  if (!config.gatewaySecret && !config.tokenSecret) {
    console.warn('[agentsentinel] WARNING: no GATEWAY_SECRET or TOKEN_SECRET, so watch tokens cannot be rebuilt after a restart.');
  }
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[agentsentinel] ${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  try {
    await srv.close();
  } catch (err) {
    console.error(err.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
