import { evaluateSample } from '../conditions.js';

const SOURCE_KEY = 'xdc_gas';

export function weiToGwei(wei) {
  return Number(wei) / 1e9;
}

export default {
  name: 'xdc_gas',
  description: 'XDC network gas price from eth_gasPrice on XDC mainnet (chain ID 50)',
  unit: 'gwei',
  conditions: ['above', 'below'],
  requiresAddress: false,
  threshold: { min: 0, max: 1_000_000 },
  shared: true,

  sourceKey() {
    return SOURCE_KEY;
  },

  async fetchSamples(keys, sources) {
    const out = new Map();
    try {
      const { wei, origin } = await sources.gasPrice();
      for (const key of keys) out.set(key, { value: weiToGwei(wei), raw: wei.toString(), origin });
    } catch (error) {
      for (const key of keys) out.set(key, { error });
    }
    return out;
  },

  evaluate: evaluateSample,
};
