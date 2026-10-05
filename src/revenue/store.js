// Database access for the merchant leaderboard. Statements are plain SQL that runs
// on both SQLite and Postgres, like src/store.js.

import crypto from 'node:crypto';
import { hashToken } from '../store.js';

// Row in sampler_lease used by the leaderboard tracker (the price sampler uses row 1).
const LEASE_ID = 2;

const round6 = (n) => Number(Number(n).toFixed(6));
const newWatchId = () => `rw_${crypto.randomBytes(9).toString('base64url')}`;

function watchRow(r) {
  if (!r) return null;
  return {
    ...r,
    created_at: Number(r.created_at),
    expires_at: Number(r.expires_at),
    ended_at: r.ended_at === null ? null : Number(r.ended_at),
    last_check_at: r.last_check_at === null ? null : Number(r.last_check_at),
    last_payment_id: Number(r.last_payment_id),
    last_revenue_micro: r.last_revenue_micro === null ? null : Number(r.last_revenue_micro),
    last_ranks: r.last_ranks ? JSON.parse(r.last_ranks) : null,
    check_count: Number(r.check_count),
    restored_at: r.restored_at === null ? null : Number(r.restored_at),
  };
}

function paymentRow(r) {
  return {
    id: Number(r.id),
    tx_hash: r.tx_hash,
    log_index: Number(r.log_index),
    block_number: Number(r.block_number),
    ts: Number(r.ts),
    payer: r.payer,
    pay_to: r.pay_to,
    amount_micro: Number(r.amount_micro),
  };
}

// Filter for "payments a watch has not reported yet".
function paymentWindow({ payTo = null, afterId = 0, upToId = null, sinceTs = null }) {
  const where = ['id > ?'];
  const params = [afterId];
  if (upToId !== null) { where.push('id <= ?'); params.push(upToId); }
  if (payTo) { where.push('pay_to = ?'); params.push(payTo); }
  if (sinceTs !== null) { where.push('ts >= ?'); params.push(sinceTs); }
  return { sql: where.join(' AND '), params };
}

export function createRevenueStore(db, { clock = Date.now, watchTtlMs = 30 * 24 * 3600 * 1000, tokenFactory }) {
  async function getMeta(q, k) {
    const rows = await q.query('SELECT v FROM rev_meta WHERE k = ?', [k]);
    return rows[0] ? rows[0].v : null;
  }
  async function setMeta(q, k, v) {
    await q.query('INSERT INTO rev_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, String(v)]);
  }

  return {
    db,

    async init() {
      await db.query("INSERT INTO sampler_lease (id, owner, expires_at) VALUES (?, '', 0) ON CONFLICT (id) DO NOTHING", [LEASE_ID]);
    },

    async acquireLease(owner, ttlMs, now = clock()) {
      const rows = await db.query(
        'UPDATE sampler_lease SET owner = ?, expires_at = ? WHERE id = ? AND (owner = ? OR expires_at < ?) RETURNING id',
        [owner, now + ttlMs, LEASE_ID, owner, now],
      );
      return rows.length > 0;
    },

    async releaseLease(owner) {
      await db.query('UPDATE sampler_lease SET expires_at = 0 WHERE id = ? AND owner = ?', [LEASE_ID, owner]);
    },

    getMeta: (k) => getMeta(db, k),
    setMeta: (k, v) => setMeta(db, k, v),

    // Applies one catalog read: new routes are added, counter increases and price
    // changes are recorded with the time they were seen, routes no longer listed are
    // marked. Returns the payout addresses seen for the first time.
    async applyCatalog(rows, now = clock()) {
      return db.tx(async (q) => {
        const existing = new Map(
          (await q.query('SELECT route_key, pay_to, price_usdc, calls, volume_usdc, listed FROM rev_routes')).map((r) => [r.route_key, r]),
        );
        const knownPayTos = new Set([...existing.values()].map((r) => r.pay_to));
        const newPayTos = new Set();
        const seen = new Set();
        let changes = 0;
        for (const r of rows) {
          seen.add(r.routeKey);
          if (!knownPayTos.has(r.payTo)) {
            knownPayTos.add(r.payTo);
            newPayTos.add(r.payTo);
          }
          const old = existing.get(r.routeKey);
          if (!old) {
            await q.query(
              `INSERT INTO rev_routes (route_key, provider_id, provider_name, method, path, price_usdc, pay_to, calls, volume_usdc, first_seen_at, last_seen_at, listed)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
              [r.routeKey, r.providerId, r.providerName, r.method, r.path, r.priceUsdc, r.payTo, r.calls, r.volumeUsdc, now, now],
            );
            continue;
          }
          const callsDelta = r.calls - Number(old.calls);
          const volumeDelta = round6(r.volumeUsdc - Number(old.volume_usdc));
          const priceChanged = Number(old.price_usdc) !== r.priceUsdc;
          if (callsDelta > 0 || volumeDelta > 0 || priceChanged) {
            await q.query(
              'INSERT INTO rev_route_changes (route_key, pay_to, ts, calls_delta, volume_delta, price_usdc, previous_price_usdc) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [r.routeKey, r.payTo, now, Math.max(0, callsDelta), Math.max(0, volumeDelta), r.priceUsdc, priceChanged ? Number(old.price_usdc) : null],
            );
            changes += 1;
          }
          await q.query(
            `UPDATE rev_routes SET provider_id = ?, provider_name = ?, method = ?, path = ?, price_usdc = ?, pay_to = ?,
             calls = ?, volume_usdc = ?, last_seen_at = ?, listed = 1 WHERE route_key = ?`,
            [r.providerId, r.providerName, r.method, r.path, r.priceUsdc, r.payTo, r.calls, r.volumeUsdc, now, r.routeKey],
          );
        }
        for (const [key, old] of existing) {
          if (!seen.has(key) && Number(old.listed) === 1) await q.query('UPDATE rev_routes SET listed = 0 WHERE route_key = ?', [key]);
        }
        if (!(await getMeta(q, 'catalog_history_from'))) await setMeta(q, 'catalog_history_from', now);
        await setMeta(q, 'catalog_read_at', now);
        return { newPayTos: [...newPayTos], changes, routes: rows.length };
      });
    },

    async listedRoutes() {
      const rows = await db.query(
        'SELECT route_key, provider_id, provider_name, method, path, price_usdc, pay_to, calls, volume_usdc, first_seen_at FROM rev_routes WHERE listed = 1',
      );
      return rows.map((r) => ({
        ...r,
        price_usdc: Number(r.price_usdc),
        calls: Number(r.calls),
        volume_usdc: Number(r.volume_usdc),
        first_seen_at: Number(r.first_seen_at),
      }));
    },

    async listedPayTos() {
      return (await db.query('SELECT DISTINCT pay_to FROM rev_routes WHERE listed = 1')).map((r) => r.pay_to);
    },

    // ---------- chain index ----------

    async ensureIndexRows(payTos, startBlock) {
      for (const p of payTos) {
        await db.query('INSERT INTO rev_index (pay_to, indexed_to) VALUES (?, ?) ON CONFLICT (pay_to) DO NOTHING', [p, startBlock - 1]);
      }
    },

    async indexRows() {
      return (await db.query('SELECT pay_to, indexed_to FROM rev_index')).map((r) => ({ pay_to: r.pay_to, indexed_to: Number(r.indexed_to) }));
    },

    // Stores the payments found in one block range and moves those addresses' cursor.
    async storeTransfers(transfers, payTos, toBlock) {
      return db.tx(async (q) => {
        let inserted = 0;
        for (const t of transfers) {
          const rows = await q.query(
            `INSERT INTO rev_payments (tx_hash, log_index, block_number, ts, payer, pay_to, amount_micro)
             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING id`,
            [t.txHash, t.logIndex, t.blockNumber, t.ts, t.payer, t.payTo, t.amountMicro],
          );
          inserted += rows.length;
        }
        for (const p of payTos) {
          await q.query('UPDATE rev_index SET indexed_to = ? WHERE pay_to = ? AND indexed_to < ?', [toBlock, p, toBlock]);
        }
        return inserted;
      });
    },

    // ---------- reads for reports ----------

    // Per payout address: total since startTs, and the 24h and 1h windows.
    async paymentTotals(startTs, dayStart, hourStart) {
      const rows = await db.query(
        `SELECT pay_to, SUM(amount_micro) AS total, COUNT(*) AS n,
           SUM(CASE WHEN ts >= ? THEN amount_micro ELSE 0 END) AS total_24h,
           SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS n_24h,
           SUM(CASE WHEN ts >= ? THEN amount_micro ELSE 0 END) AS total_1h,
           SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS n_1h,
           MAX(ts) AS last_ts, COUNT(DISTINCT payer) AS payers
         FROM rev_payments WHERE ts >= ? GROUP BY pay_to`,
        [dayStart, dayStart, hourStart, hourStart, startTs],
      );
      return rows.map((r) => ({
        pay_to: r.pay_to,
        total: Number(r.total || 0),
        n: Number(r.n || 0),
        total_24h: Number(r.total_24h || 0),
        n_24h: Number(r.n_24h || 0),
        total_1h: Number(r.total_1h || 0),
        n_1h: Number(r.n_1h || 0),
        last_ts: r.last_ts === null ? null : Number(r.last_ts),
        payers: Number(r.payers || 0),
      }));
    },

    // Catalog counter increases per route recorded after `since` (and up to `until`).
    async routeChangeTotals(since, until = null) {
      const rows = await db.query(
        `SELECT route_key, pay_to, SUM(calls_delta) AS calls, SUM(volume_delta) AS volume FROM rev_route_changes
         WHERE ts > ?${until === null ? '' : ' AND ts <= ?'} GROUP BY route_key, pay_to`,
        until === null ? [since] : [since, until],
      );
      return rows.map((r) => ({ route_key: r.route_key, pay_to: r.pay_to, calls: Number(r.calls || 0), volume: round6(r.volume || 0) }));
    },

    async maxPaymentId() {
      const [r] = await db.query('SELECT MAX(id) AS id FROM rev_payments');
      return Number((r && r.id) || 0);
    },

    // Payments in a window, oldest first unless newestFirst.
    async payments(window, { limit = 20, newestFirst = false } = {}) {
      const w = paymentWindow(window);
      const rows = await db.query(
        `SELECT id, tx_hash, log_index, block_number, ts, payer, pay_to, amount_micro FROM rev_payments WHERE ${w.sql}
         ORDER BY ts ${newestFirst ? 'DESC' : 'ASC'}, id ${newestFirst ? 'DESC' : 'ASC'} LIMIT ?`,
        [...w.params, limit],
      );
      return rows.map(paymentRow);
    },

    // Count and sum of payments in a window, grouped by payout address.
    async paymentSums(window) {
      const w = paymentWindow(window);
      const rows = await db.query(
        `SELECT pay_to, COUNT(*) AS n, SUM(amount_micro) AS total FROM rev_payments WHERE ${w.sql} GROUP BY pay_to`,
        w.params,
      );
      return rows.map((r) => ({ pay_to: r.pay_to, n: Number(r.n), total: Number(r.total || 0) }));
    },

    async topPayers(payTo, startTs, limit = 5) {
      const rows = await db.query(
        `SELECT payer, COUNT(*) AS n, SUM(amount_micro) AS total FROM rev_payments
         WHERE pay_to = ? AND ts >= ? GROUP BY payer ORDER BY total DESC, n DESC LIMIT ?`,
        [payTo, startTs, limit],
      );
      return rows.map((r) => ({ payer: r.payer, n: Number(r.n), total: Number(r.total || 0) }));
    },

    // ---------- watches ----------

    // baseline: { lastPaymentId, ranks, revenueMicro } at creation, so the first check
    // reports what changed after the watch was created.
    async createWatch(target, baseline, { viaGateway = false } = {}) {
      const now = clock();
      // Whole seconds, so the definition signed into the token round-trips exactly.
      const createdAt = Math.floor(now / 1000) * 1000;
      const watch = {
        id: newWatchId(),
        type: 'merchant_revenue',
        cond: 'since_last_check',
        address: target === 'market' ? null : target,
        created_at: createdAt,
        expires_at: createdAt + watchTtlMs,
      };
      const token = tokenFactory(watch);
      const tokenHash = hashToken(token);
      await db.query(
        `INSERT INTO rev_watches (id, token_hash, target, status, created_at, expires_at, last_payment_id, last_ranks, last_revenue_micro, via_gateway)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        [watch.id, tokenHash, target, createdAt, watch.expires_at, baseline.lastPaymentId, JSON.stringify(baseline.ranks), baseline.revenueMicro, viaGateway ? 1 : 0],
      );
      return { watch: await this.findWatch(tokenHash), token };
    },

    // Rebuilds a watch from the definition inside its signed token (stored data lost).
    async restoreWatch(spec, tokenHash) {
      const target = spec.address || 'market';
      await db.query(
        `INSERT INTO rev_watches (id, token_hash, target, status, created_at, expires_at, last_payment_id, restored_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?) ON CONFLICT DO NOTHING`,
        [spec.id, tokenHash, target, spec.created_at, spec.expires_at, clock()],
      );
    },

    async findWatch(tokenHash) {
      const rows = await db.query('SELECT * FROM rev_watches WHERE token_hash = ?', [tokenHash]);
      return watchRow(rows[0]);
    },

    // Records a check unless another check of the same watch got there first; the
    // caller recomputes and retries when this returns false.
    async recordCheck(watch, { checkedAt, lastPaymentId, ranks, revenueMicro }) {
      const rows = await db.query(
        `UPDATE rev_watches SET last_check_at = ?, last_payment_id = ?, last_ranks = ?, last_revenue_micro = ?, check_count = check_count + 1
         WHERE id = ? AND check_count = ? AND status = 'active' RETURNING id`,
        [checkedAt, lastPaymentId, JSON.stringify(ranks), revenueMicro, watch.id, watch.check_count],
      );
      return rows.length > 0;
    },

    async cancel(tokenHash) {
      const w = await this.findWatch(tokenHash);
      if (!w) return { status: 'unknown_token' };
      if (w.status !== 'active') return { status: w.status, watch: w, changed: false };
      const now = clock();
      await db.query("UPDATE rev_watches SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'active'", [now, w.id]);
      return { status: 'cancelled', watch: { ...w, status: 'cancelled', ended_at: now }, changed: true };
    },

    async expireWatches(now = clock()) {
      await db.query("UPDATE rev_watches SET status = 'expired', ended_at = expires_at WHERE status = 'active' AND expires_at <= ?", [now]);
    },

    async logRequest(route, viaGateway, now = clock()) {
      await db.query('INSERT INTO rev_requests (route, ts, via_gateway) VALUES (?, ?, ?)', [route, now, viaGateway ? 1 : 0]);
    },

    async stats(now = clock()) {
      const d = new Date(now);
      const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const byRoute = await db.query(
        'SELECT route, COUNT(*) AS total, SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS today FROM rev_requests GROUP BY route ORDER BY route',
        [dayStart],
      );
      const [active] = await db.query("SELECT COUNT(*) AS n FROM rev_watches WHERE status = 'active' AND expires_at > ?", [now]);
      const [payments] = await db.query('SELECT COUNT(*) AS n FROM rev_payments');
      const [routes] = await db.query('SELECT COUNT(*) AS n, COUNT(DISTINCT pay_to) AS merchants FROM rev_routes WHERE listed = 1');
      return {
        paid_requests_by_route: Object.fromEntries(byRoute.map((r) => [r.route, { today: Number(r.today || 0), total: Number(r.total) }])),
        active_watches: Number(active.n),
        payments_indexed: Number(payments.n),
        routes_listed: Number(routes.n),
        merchants_listed: Number(routes.merchants),
      };
    },
  };
}
