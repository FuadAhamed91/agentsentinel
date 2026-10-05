// Watch tokens.
//
// A signed token carries the watch's own definition: wt_<payload>.<signature>
// where payload is base64url JSON and signature is HMAC-SHA256 over it. If the
// server's stored data is ever lost (a fresh disk after a restart or redeploy),
// the watch is rebuilt from the token the next time the agent uses it. Only the
// trigger history from before the reset is lost.
//
// Only the server can sign, so a token cannot be forged or edited.

import crypto from 'node:crypto';

const PREFIX = 'wt_';
const SIG_CONTEXT = 'agentsentinel-watch-token-v1';

// Signed: wt_<payload>.<43-char signature>. Legacy random tokens (wt_ + 43 chars) stay valid.
export const TOKEN_PATTERN = /^wt_(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{16,800}\.[A-Za-z0-9_-]{43})$/;

export function tokenKey({ tokenSecret, gatewaySecret }) {
  if (tokenSecret) return Buffer.from(tokenSecret, 'utf8');
  if (gatewaySecret) return crypto.createHmac('sha256', gatewaySecret).update(SIG_CONTEXT).digest();
  // No secret configured (local development): tokens still work, but cannot be
  // rebuilt after a restart because the key changes.
  return crypto.randomBytes(32);
}

function sign(key, payload) {
  return crypto.createHmac('sha256', key).update(`${SIG_CONTEXT}.${payload}`).digest('base64url');
}

const SPEC_KEYS = {
  i: 'id', t: 'type', c: 'cond', h: 'threshold', p: 'percent', d: 'direction', a: 'address', s: 'created_at', e: 'expires_at',
};

export function createSignedToken(key, watch) {
  const compact = { v: 1 };
  for (const [short, long] of Object.entries(SPEC_KEYS)) {
    const value = watch[long];
    if (value === null || value === undefined) continue;
    compact[short] = short === 's' || short === 'e' ? Math.floor(value / 1000) : value;
  }
  const payload = Buffer.from(JSON.stringify(compact)).toString('base64url');
  return `${PREFIX}${payload}.${sign(key, payload)}`;
}

// Returns the watch definition from a signed token, or null when the token is not
// signed, malformed, or carries a signature this server did not make.
export function readSignedToken(key, token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  const body = token.slice(PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = body.slice(0, dot);
  const given = Buffer.from(body.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(key, payload), 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let compact;
  try {
    compact = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!compact || compact.v !== 1 || typeof compact.i !== 'string' || typeof compact.t !== 'string' || typeof compact.c !== 'string') return null;
  const spec = {};
  for (const [short, long] of Object.entries(SPEC_KEYS)) {
    const value = compact[short];
    spec[long] = value === undefined ? null : (short === 's' || short === 'e' ? value * 1000 : value);
  }
  return spec;
}
