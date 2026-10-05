// Fixed-window in-memory rate limiter (one process, so memory is enough).

export function createRateLimiter({ clock = Date.now, windowMs = 60000 } = {}) {
  const buckets = new Map(); // key -> { start, count }

  const sweep = setInterval(() => {
    const now = clock();
    for (const [k, b] of buckets) if (now - b.start >= windowMs) buckets.delete(k);
  }, windowMs);
  sweep.unref?.();

  return {
    // Counts one hit. Returns { ok, retryAfterSeconds }.
    hit(key, limit) {
      const now = clock();
      let b = buckets.get(key);
      if (!b || now - b.start >= windowMs) {
        b = { start: now, count: 0 };
        buckets.set(key, b);
      }
      b.count += 1;
      if (b.count > limit) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((b.start + windowMs - now) / 1000)) };
      }
      return { ok: true, retryAfterSeconds: 0 };
    },
    stop() {
      clearInterval(sweep);
    },
  };
}
