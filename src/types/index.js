// Registry of watch types. Each module exposes the same interface:
//   name, description, unit, conditions, requiresAddress, threshold {min,max},
//   shared (true when every watch of the type reads one series),
//   sourceKey(params), fetchSamples(keys, sources), evaluate(watch, sample).
// Add a new type by writing a module with that interface and listing it here.

import xdcPrice from './xdc_price.js';
import xdcGas from './xdc_gas.js';
import walletBalance from './wallet_balance.js';

export const TYPES = {
  [xdcPrice.name]: xdcPrice,
  [xdcGas.name]: xdcGas,
  [walletBalance.name]: walletBalance,
};

export function typeForSourceKey(key) {
  return TYPES[key.split(':')[0]];
}
