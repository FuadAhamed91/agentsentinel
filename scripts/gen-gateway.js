// Writes the gateway listing from src/catalog.js.
//
//   npm run gateway
//     -> gateway.json with PUBLIC_BASE_URL (or a placeholder) and a placeholder secret.
//        Safe to commit.
//   npm run gateway:import
//     -> gateway.import.json with PUBLIC_BASE_URL and the real GATEWAY_SECRET,
//        ready for the dashboard's Import JSON button. Git-ignored; do not commit it.

import fs from 'node:fs';
import { buildGatewayJson, PLACEHOLDER_UPSTREAM } from '../src/gateway-listing.js';

if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const withSecret = process.argv.includes('--with-secret');
const upstreamBaseUrl = process.env.PUBLIC_BASE_URL || PLACEHOLDER_UPSTREAM;

if (withSecret) {
  const missing = [];
  if (!process.env.PUBLIC_BASE_URL) missing.push('PUBLIC_BASE_URL');
  if (!process.env.GATEWAY_SECRET) missing.push('GATEWAY_SECRET');
  if (missing.length) {
    console.error(`Set ${missing.join(' and ')} (environment or .env) first.`);
    process.exit(1);
  }
  if (!/^https:\/\//.test(upstreamBaseUrl)) {
    console.error('PUBLIC_BASE_URL must start with https:// (the gateway requires a public https upstream).');
    process.exit(1);
  }
}

const listing = buildGatewayJson(withSecret ? { upstreamBaseUrl, secret: process.env.GATEWAY_SECRET } : { upstreamBaseUrl });
const file = withSecret ? 'gateway.import.json' : 'gateway.json';
fs.writeFileSync(file, `${JSON.stringify(listing, null, 2)}\n`);
console.log(`wrote ${file} (${listing.routes.length} routes, upstream ${listing.upstreamBaseUrl})`);
