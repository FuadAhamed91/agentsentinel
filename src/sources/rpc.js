// XDC mainnet JSON-RPC (chain ID 50) with endpoint failover.
// eth_gasPrice for gas, eth_getBalance in one batched request for all watched wallets.

import { fetchJson } from './http.js';

const BALANCE_BATCH_SIZE = 50;

function hexToBigInt(hex, what) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`invalid ${what} from rpc`);
  return BigInt(hex);
}

export function createRpcClient({ urls, timeoutMs }) {
  let preferred = 0;

  async function call(payload) {
    const errors = [];
    for (let i = 0; i < urls.length; i++) {
      const idx = (preferred + i) % urls.length;
      const url = urls[idx];
      try {
        const result = await fetchJson(url, { method: 'POST', body: payload, timeoutMs });
        preferred = idx;
        return { result, origin: new URL(url).host };
      } catch (err) {
        errors.push(`${new URL(url).host}: ${err.message}`);
      }
    }
    throw new Error(`all XDC RPC endpoints failed (${errors.join('; ')})`);
  }

  return {
    async gasPrice() {
      const { result, origin } = await call({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] });
      if (result.error) throw new Error(`eth_gasPrice error: ${result.error.message}`);
      return { wei: hexToBigInt(result.result, 'gas price'), origin };
    },

    // addresses: lowercase 0x addresses. Returns Map(address -> { wei, origin } | { error }).
    async balances(addresses) {
      const out = new Map();
      for (let start = 0; start < addresses.length; start += BALANCE_BATCH_SIZE) {
        const chunk = addresses.slice(start, start + BALANCE_BATCH_SIZE);
        const batch = chunk.map((address, i) => ({
          jsonrpc: '2.0', id: i + 1, method: 'eth_getBalance', params: [address, 'latest'],
        }));
        try {
          const { result, origin } = await call(batch);
          if (!Array.isArray(result)) throw new Error('rpc did not return a batch response');
          const byId = new Map(result.map((r) => [r.id, r]));
          chunk.forEach((address, i) => {
            const r = byId.get(i + 1);
            try {
              if (!r || r.error) throw new Error(r && r.error ? r.error.message : 'missing result');
              out.set(address, { wei: hexToBigInt(r.result, 'balance'), origin });
            } catch (err) {
              out.set(address, { error: err });
            }
          });
        } catch (err) {
          chunk.forEach((address) => out.set(address, { error: err }));
        }
      }
      return out;
    },
  };
}
