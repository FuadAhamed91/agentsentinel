import { evaluateSample } from '../conditions.js';

const PREFIX = 'wallet_balance:';

// Accepts "xdc" or "0x" prefixed addresses, any letter case. Returns lowercase 0x form or null.
export function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  const m = /^(?:0x|xdc)([0-9a-fA-F]{40})$/i.exec(input.trim());
  return m ? `0x${m[1].toLowerCase()}` : null;
}

export function toXdcAddress(address0x) {
  return `xdc${address0x.slice(2)}`;
}

// Exact wei -> XDC conversion through a decimal string, so large balances keep their digits.
export function weiToXdc(wei) {
  const s = wei.toString().padStart(19, '0');
  const whole = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, '');
  return Number(frac ? `${whole}.${frac}` : whole);
}

export default {
  name: 'wallet_balance',
  description: 'Native XDC balance of one XDC mainnet address (eth_getBalance), in XDC',
  unit: 'XDC',
  conditions: ['above', 'below', 'changes'],
  requiresAddress: true,
  threshold: { min: 0, max: 1e11 },
  shared: false,

  sourceKey({ address }) {
    return PREFIX + address;
  },

  addressFromKey(key) {
    return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
  },

  // All watched wallets are read in one batched RPC request per sample round.
  async fetchSamples(keys, sources) {
    const out = new Map();
    const addresses = keys.map((k) => k.slice(PREFIX.length));
    let balances;
    try {
      balances = await sources.balances(addresses);
    } catch (error) {
      for (const key of keys) out.set(key, { error });
      return out;
    }
    keys.forEach((key, i) => {
      const r = balances.get(addresses[i]);
      if (!r || r.error) out.set(key, { error: (r && r.error) || new Error('no balance returned') });
      else out.set(key, { value: weiToXdc(r.wei), raw: r.wei.toString(), origin: r.origin });
    });
    return out;
  },

  evaluate: evaluateSample,
};
