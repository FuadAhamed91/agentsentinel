import { evaluateSample } from '../conditions.js';

const SOURCE_KEY = 'xdc_price';

export default {
  name: 'xdc_price',
  description: 'XDC/USD spot price',
  unit: 'USD',
  conditions: ['above', 'below', 'crosses_above', 'crosses_below', 'changes_by_percent'],
  requiresAddress: false,
  threshold: { min: 0, max: 1000, exclusiveMin: true },
  shared: true,

  sourceKey() {
    return SOURCE_KEY;
  },

  // One external call per sample, however many watches read it.
  async fetchSamples(keys, sources) {
    const out = new Map();
    try {
      const { value, origin } = await sources.price();
      for (const key of keys) out.set(key, { value, raw: String(value), origin });
    } catch (error) {
      for (const key of keys) out.set(key, { error });
    }
    return out;
  },

  evaluate: evaluateSample,
};
