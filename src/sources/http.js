// Small JSON-over-HTTP helper with a timeout. Counts every outbound request so the
// "one external call per sample" property can be observed in /stats and in tests.

export const outboundCounter = { total: 0, byHost: {} };

export async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 6000 } = {}) {
  const host = new URL(url).host;
  outboundCounter.total += 1;
  outboundCounter.byHost[host] = (outboundCounter.byHost[host] || 0) + 1;
  const res = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      'user-agent': 'AgentSentinel/1.0',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${host} responded ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${host} returned non-JSON`);
  }
}
