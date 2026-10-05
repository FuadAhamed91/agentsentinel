// Strict input validation. Errors carry the field name and a plain description of
// what is accepted; the HTTP layer turns them into 400 responses.

import { TYPES } from './types/index.js';
import { normalizeAddress } from './types/wallet_balance.js';

export class ValidationError extends Error {
  constructor(message, { field = null, details = undefined } = {}) {
    super(message);
    this.field = field;
    this.details = details;
  }
}

export const WATCH_EXAMPLES = [
  { type: 'xdc_price', condition: 'above', threshold: 0.08 },
  { type: 'xdc_price', condition: 'crosses_below', threshold: 0.03 },
  { type: 'xdc_price', condition: 'changes_by_percent', percent: 5, direction: 'any' },
  { type: 'xdc_gas', condition: 'above', threshold: 20 },
  { type: 'wallet_balance', address: 'xdc0000000000000000000000000000000000000001', condition: 'below', threshold: 1000 },
  { type: 'wallet_balance', address: '0x0000000000000000000000000000000000000001', condition: 'changes' },
];

const WATCH_FIELDS = ['type', 'condition', 'threshold', 'percent', 'direction', 'address'];
const THRESHOLD_CONDITIONS = new Set(['above', 'below', 'crosses_above', 'crosses_below']);
const DIRECTIONS = ['any', 'up', 'down'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Numbers, or decimal strings such as "0.08". Nothing else.
function toNumber(v, field) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(v)) return Number(v);
  throw new ValidationError(`${field} must be a number`, { field });
}

// Created when POST /watch arrives with no body or an empty object.
export const DEFAULT_WATCH = { type: 'xdc_price', condition: 'changes_by_percent', percent: 1, direction: 'any' };

export function validateWatchBody(body) {
  if (body === undefined || body === null || (isPlainObject(body) && Object.keys(body).length === 0)) {
    const out = { ...DEFAULT_WATCH, defaulted: true };
    out.sourceKey = TYPES[out.type].sourceKey(out);
    return out;
  }
  if (!isPlainObject(body)) {
    throw new ValidationError('request body must be a JSON object', { details: { examples: WATCH_EXAMPLES } });
  }
  const unknown = Object.keys(body).filter((k) => !WATCH_FIELDS.includes(k));
  if (unknown.length) {
    throw new ValidationError(`unknown field(s): ${unknown.join(', ')}; accepted fields: ${WATCH_FIELDS.join(', ')}`, {
      field: unknown[0],
      details: { examples: WATCH_EXAMPLES },
    });
  }

  const typeName = body.type;
  if (typeof typeName !== 'string' || !TYPES[typeName]) {
    throw new ValidationError(`type must be one of: ${Object.keys(TYPES).join(', ')}`, {
      field: 'type',
      details: { examples: WATCH_EXAMPLES },
    });
  }
  const type = TYPES[typeName];

  const condition = body.condition;
  if (typeof condition !== 'string' || !type.conditions.includes(condition)) {
    throw new ValidationError(`condition for ${typeName} must be one of: ${type.conditions.join(', ')}`, {
      field: 'condition',
      details: { examples: WATCH_EXAMPLES.filter((e) => e.type === typeName) },
    });
  }

  const out = { type: typeName, condition };

  if (type.requiresAddress) {
    if (body.address === undefined) {
      throw new ValidationError('address is required for wallet_balance (xdc... or 0x... form, 40 hex characters)', { field: 'address' });
    }
    const address = normalizeAddress(body.address);
    if (!address) {
      throw new ValidationError('address must be an XDC address: "xdc" or "0x" followed by 40 hex characters', { field: 'address' });
    }
    out.address = address;
  } else if (body.address !== undefined) {
    throw new ValidationError(`address is only accepted for wallet_balance, not ${typeName}`, { field: 'address' });
  }

  if (THRESHOLD_CONDITIONS.has(condition)) {
    if (body.threshold === undefined || body.threshold === null) {
      throw new ValidationError(`threshold is required for condition ${condition} (unit: ${type.unit})`, { field: 'threshold' });
    }
    const t = toNumber(body.threshold, 'threshold');
    const { min, max, exclusiveMin } = type.threshold;
    if ((exclusiveMin ? t <= min : t < min) || t > max) {
      throw new ValidationError(
        `threshold for ${typeName} must be ${exclusiveMin ? 'greater than' : 'at least'} ${min} and at most ${max} (unit: ${type.unit})`,
        { field: 'threshold' },
      );
    }
    out.threshold = t;
  } else if (body.threshold !== undefined) {
    throw new ValidationError(`threshold is not used by condition ${condition}`, { field: 'threshold' });
  }

  if (condition === 'changes_by_percent') {
    if (body.percent === undefined || body.percent === null) {
      throw new ValidationError('percent is required for changes_by_percent (number greater than 0, at most 1000)', { field: 'percent' });
    }
    const p = toNumber(body.percent, 'percent');
    if (p <= 0 || p > 1000) throw new ValidationError('percent must be greater than 0 and at most 1000', { field: 'percent' });
    out.percent = p;
    const direction = body.direction === undefined ? 'any' : body.direction;
    if (!DIRECTIONS.includes(direction)) {
      throw new ValidationError(`direction must be one of: ${DIRECTIONS.join(', ')}`, { field: 'direction' });
    }
    out.direction = direction;
  } else {
    if (body.percent !== undefined) throw new ValidationError(`percent is only used by changes_by_percent`, { field: 'percent' });
    if (body.direction !== undefined) throw new ValidationError(`direction is only used by changes_by_percent`, { field: 'direction' });
  }

  out.sourceKey = type.sourceKey(out);
  return out;
}

// Accepts { "watch_tokens": ["..."] } and/or { "watch_token": "..." }.
// Unknown or malformed token strings are reported per item, not rejected here.
export function validateTokenBody(body, { maxTokens }) {
  const example = { watch_tokens: ['wt_...'] };
  if (!isPlainObject(body)) {
    throw new ValidationError('request body must be a JSON object with watch_tokens (array of strings)', { details: { example } });
  }
  const tokens = [];
  if (body.watch_tokens !== undefined) {
    if (!Array.isArray(body.watch_tokens)) {
      throw new ValidationError('watch_tokens must be an array of strings', { field: 'watch_tokens', details: { example } });
    }
    for (const t of body.watch_tokens) {
      if (typeof t !== 'string') {
        throw new ValidationError('watch_tokens must contain only strings', { field: 'watch_tokens', details: { example } });
      }
      tokens.push(t);
    }
  }
  if (body.watch_token !== undefined) {
    if (typeof body.watch_token !== 'string') {
      throw new ValidationError('watch_token must be a string', { field: 'watch_token', details: { example } });
    }
    tokens.push(body.watch_token);
  }
  if (tokens.length === 0) {
    throw new ValidationError('watch_tokens is required (array of 1 or more watch tokens)', { field: 'watch_tokens', details: { example } });
  }
  if (tokens.length > maxTokens) {
    throw new ValidationError(`at most ${maxTokens} watch tokens per request`, { field: 'watch_tokens' });
  }
  return tokens.map((t) => t.trim());
}
