import { createPriceSource } from './price.js';
import { createRpcClient } from './rpc.js';

// The live data sources used by the watch types: { price, gasPrice, balances }.
export function createLiveSources(config) {
  const rpc = createRpcClient({ urls: config.rpcUrls, timeoutMs: config.sourceTimeoutMs });
  return {
    price: createPriceSource({
      order: config.priceSources,
      timeoutMs: config.sourceTimeoutMs,
      coingeckoApiKey: config.coingeckoApiKey,
    }),
    gasPrice: () => rpc.gasPrice(),
    balances: (addresses) => rpc.balances(addresses),
  };
}
