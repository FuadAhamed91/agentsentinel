// Live check of every external data source (no server, no gateway, no payments).
// Usage: npm run live-check [-- <xdc-or-0x-address>]

import { loadConfig } from '../src/config.js';
import { createPriceSource, PRICE_PROVIDER_NAMES } from '../src/sources/price.js';
import { createRpcClient } from '../src/sources/rpc.js';
import { outboundCounter } from '../src/sources/http.js';
import { normalizeAddress, weiToXdc } from '../src/types/wallet_balance.js';
import { weiToGwei } from '../src/types/xdc_gas.js';

const config = loadConfig();
const address = process.argv[2] || 'xdc0000000000000000000000000000000000000088';
let failures = 0;

async function step(label, fn) {
  try {
    const out = await fn();
    console.log(`OK    ${label}: ${out}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}: ${err.message}`);
  }
}

for (const name of PRICE_PROVIDER_NAMES) {
  await step(`price ${name}`, async () => {
    const r = await createPriceSource({ order: [name], timeoutMs: config.sourceTimeoutMs, coingeckoApiKey: config.coingeckoApiKey })();
    return `XDC/USD ${r.value}`;
  });
}

for (const url of config.rpcUrls) {
  const rpc = createRpcClient({ urls: [url], timeoutMs: config.sourceTimeoutMs });
  await step(`gas ${url}`, async () => {
    const g = await rpc.gasPrice();
    return `${weiToGwei(g.wei)} gwei`;
  });
}

const rpc = createRpcClient({ urls: config.rpcUrls, timeoutMs: config.sourceTimeoutMs });
const a0x = normalizeAddress(address);
const aXdc = `xdc${a0x.slice(2)}`;
await step(`balance ${aXdc} (xdc prefix, normalized to ${a0x})`, async () => {
  const m = await rpc.balances([normalizeAddress(aXdc)]);
  const r = m.get(a0x);
  if (r.error) throw r.error;
  return `${weiToXdc(r.wei)} XDC (${r.wei} wei) via ${r.origin}`;
});
await step('batched balances for 3 addresses in one request', async () => {
  const before = outboundCounter.total;
  const list = [a0x, '0x0000000000000000000000000000000000000088', '0xfa2958cb79b0491cc627c1557f441ef849ca8eb1'];
  const m = await rpc.balances(list);
  const calls = outboundCounter.total - before;
  return list.map((x) => `${x.slice(0, 8)}…=${m.get(x).error ? 'error' : weiToXdc(m.get(x).wei)}`).join(', ') + ` | HTTP requests: ${calls}`;
});

console.log(failures ? `\n${failures} source(s) failed` : '\nall sources answered');
process.exit(failures ? 1 : 0);
