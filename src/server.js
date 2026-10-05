// Entry point: npm start. One process: HTTP server + background sampler.

import fs from 'node:fs';
import { loadConfig } from './config.js';
import { startServer } from './bootstrap.js';
import { createLiveSources } from './sources/index.js';

if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const config = loadConfig();
const srv = await startServer({ config, sources: createLiveSources(config) });

console.log(`[agentsentinel] listening on port ${srv.port}, database: ${srv.db.kind}, sample interval ${config.sampleIntervalMs / 1000}s`);
if (!config.gatewaySecret) {
  console.warn('[agentsentinel] WARNING: GATEWAY_SECRET is not set. Paid routes accept direct calls without payment.');
}
if (!config.databaseUrl) {
  console.warn(`[agentsentinel] DATABASE_URL not set; using local SQLite file ${config.sqlitePath}. Use Postgres in production.`);
  if (process.env.REPLIT_DEPLOYMENT) {
    console.warn('[agentsentinel] WARNING: running as a Replit deployment without DATABASE_URL. Watches will be lost on every redeploy or restart.');
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
