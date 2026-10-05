// XDC/USD price from free public APIs, tried in order until one answers.
// Identifiers verified with live requests on 2026-10-05:
//   Kraken pair XDCUSD (real USD pair, last trade price)
//   CoinGecko id "xdce-crowd-sale" (name "XDC Network", symbol XDC)
//   Coinpaprika id "xdc-xdc-network"

import { fetchJson } from './http.js';

function positive(n, name) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} returned no valid price`);
  return v;
}

const PROVIDERS = {
  async kraken({ timeoutMs }) {
    const j = await fetchJson('https://api.kraken.com/0/public/Ticker?pair=XDCUSD', { timeoutMs });
    if (Array.isArray(j.error) && j.error.length) throw new Error(`kraken: ${j.error[0]}`);
    const ticker = j.result && (j.result.XDCUSD || Object.values(j.result)[0]);
    return positive(ticker && ticker.c && ticker.c[0], 'kraken');
  },
  async coingecko({ timeoutMs, coingeckoApiKey }) {
    const headers = coingeckoApiKey ? { 'x-cg-demo-api-key': coingeckoApiKey } : {};
    const j = await fetchJson(
      'https://api.coingecko.com/api/v3/simple/price?ids=xdce-crowd-sale&vs_currencies=usd',
      { timeoutMs, headers },
    );
    return positive(j['xdce-crowd-sale'] && j['xdce-crowd-sale'].usd, 'coingecko');
  },
  async coinpaprika({ timeoutMs }) {
    const j = await fetchJson('https://api.coinpaprika.com/v1/tickers/xdc-xdc-network', { timeoutMs });
    return positive(j.quotes && j.quotes.USD && j.quotes.USD.price, 'coinpaprika');
  },
};

export const PRICE_PROVIDER_NAMES = Object.keys(PROVIDERS);

export function createPriceSource({ order, timeoutMs, coingeckoApiKey }) {
  for (const name of order) {
    if (!PROVIDERS[name]) throw new Error(`unknown price source: ${name}`);
  }
  // A provider that fails is skipped for a short cool-down so a rate-limited
  // source is not hit every 15 seconds.
  const coolDownUntil = {};
  return async function fetchXdcUsd() {
    const errors = [];
    const now = Date.now();
    const candidates = order.filter((n) => !(coolDownUntil[n] > now));
    for (const name of candidates.length ? candidates : order) {
      try {
        const value = await PROVIDERS[name]({ timeoutMs, coingeckoApiKey });
        return { value, origin: name };
      } catch (err) {
        coolDownUntil[name] = Date.now() + 60_000;
        errors.push(`${name}: ${err.message}`);
      }
    }
    throw new Error(`all price sources failed (${errors.join('; ')})`);
  };
}
