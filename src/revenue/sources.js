// Data sources for the merchant leaderboard, both public and read-only:
//   1. the XDC AI marketplace catalog (one JSON list of every listed route with its
//      payout address and the marketplace's own call and volume counters);
//   2. XDC mainnet: Transfer events of the USDC token into those payout addresses.
// Nothing here pays, calls a merchant, or calls this service's own routes.

import { fetchJson } from '../sources/http.js';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// One catalog row -> the fields the leaderboard uses, or null when unusable.
// Free text from other listings (capability lines) is not kept: only names and paths
// are passed on to callers.
export function normalizeCatalogRow(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.payTo !== 'string' || !ADDRESS.test(r.payTo)) return null;
  if (typeof r.providerId !== 'string' || !r.providerId) return null;
  const method = clip(r.method || 'GET', 10).toUpperCase();
  let path = '';
  try {
    // https://api.xdcai.tech/x402/connect/<serviceId>/<route path>
    path = new URL(r.url).pathname.split('/').slice(4).join('/');
  } catch {
    path = '';
  }
  path = `/${clip(path, 200)}`;
  const providerId = clip(r.providerId, 100);
  return {
    // The catalog's own id repeats when one path has two methods, so the key adds the method.
    routeKey: `${providerId} ${method} ${path}`,
    providerId,
    providerName: clip(r.providerName || providerId, 80) || providerId,
    method,
    path,
    priceUsdc: Math.max(0, Number(r.priceUSDC) || 0),
    payTo: r.payTo.toLowerCase(),
    calls: Math.max(0, Math.floor(Number(r.calls) || 0)),
    volumeUsdc: Math.max(0, Number(Number(r.volumeUSDC || 0).toFixed(6)) || 0),
  };
}

export function parseCatalog(json) {
  const rows = Array.isArray(json) ? json : json && Array.isArray(json.services) ? json.services : null;
  if (!rows) throw new Error('catalog response has no services array');
  const out = new Map();
  for (const raw of rows) {
    const r = normalizeCatalogRow(raw);
    if (r && !out.has(r.routeKey)) out.set(r.routeKey, r);
  }
  return [...out.values()];
}

export function createCatalogSource({ url, timeoutMs }) {
  return async function fetchCatalog() {
    return parseCatalog(await fetchJson(url, { timeoutMs }));
  };
}

const hex = (n) => `0x${Number(n).toString(16)}`;
const addressTopic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

// eth_getLogs entry for a USDC Transfer -> payment, or null for removed or malformed logs.
export function parseTransferLog(l) {
  if (!l || l.removed) return null;
  if (!Array.isArray(l.topics) || l.topics.length < 3 || String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  let amount;
  try {
    amount = BigInt(!l.data || l.data === '0x' ? 0 : l.data);
  } catch {
    return null;
  }
  return {
    txHash: String(l.transactionHash).toLowerCase(),
    logIndex: parseInt(l.logIndex, 16),
    blockNumber: parseInt(l.blockNumber, 16),
    payer: `0x${String(l.topics[1]).slice(26)}`.toLowerCase(),
    payTo: `0x${String(l.topics[2]).slice(26)}`.toLowerCase(),
    amountMicro: Number(amount),
    // Some endpoints include the block time in the log; otherwise it is looked up.
    ts: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : null,
  };
}

// XDC mainnet JSON-RPC with endpoint failover. A JSON-RPC error (for example a block
// range the endpoint refuses) moves on to the next endpoint like a network error does.
export function createChainClient({ urls, timeoutMs, usdcAddress }) {
  let preferred = 0;

  async function call(method, params) {
    const errors = [];
    for (let i = 0; i < urls.length; i++) {
      const idx = (preferred + i) % urls.length;
      const url = urls[idx];
      try {
        const j = await fetchJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, timeoutMs });
        if (j && j.error) throw new Error(j.error.message || JSON.stringify(j.error).slice(0, 200));
        if (!j || !('result' in j)) throw new Error('no result');
        preferred = idx;
        return j.result;
      } catch (err) {
        errors.push(`${new URL(url).host}: ${err.message}`);
      }
    }
    throw new Error(`${method} failed on every XDC RPC endpoint (${errors.join('; ')})`);
  }

  return {
    async latestBlock() {
      const n = parseInt(await call('eth_blockNumber', []), 16);
      if (!Number.isFinite(n)) throw new Error('invalid block number');
      return n;
    },
    async blockTimestamp(number) {
      const b = await call('eth_getBlockByNumber', [hex(number), false]);
      if (!b || !b.timestamp) throw new Error(`block ${number} not found`);
      return parseInt(b.timestamp, 16) * 1000;
    },
    // USDC Transfer events whose recipient is one of payTos, in [fromBlock, toBlock].
    async transfersTo(payTos, fromBlock, toBlock) {
      const logs = await call('eth_getLogs', [{
        address: usdcAddress,
        fromBlock: hex(fromBlock),
        toBlock: hex(toBlock),
        topics: [TRANSFER_TOPIC, null, payTos.map(addressTopic)],
      }]);
      if (!Array.isArray(logs)) throw new Error('eth_getLogs returned no list');
      return logs.map(parseTransferLog).filter(Boolean);
    },
  };
}

export function createLiveMarket(config) {
  return {
    catalogSource: createCatalogSource({ url: config.catalogUrl, timeoutMs: Math.max(config.sourceTimeoutMs, 10000) }),
    chain: createChainClient({ urls: config.chainRpcUrls, timeoutMs: Math.max(config.sourceTimeoutMs, 10000), usdcAddress: config.usdcAddress }),
  };
}
