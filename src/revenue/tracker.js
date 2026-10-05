// Background reader for the merchant leaderboard.
//   Catalog round (every CATALOG_INTERVAL_SECONDS): one request for the whole
//   marketplace catalog; new routes, counter increases and price changes are stored.
//   Chain round (every CHAIN_INTERVAL_SECONDS): eth_getLogs for USDC transfers into
//   every listed payout address, one block range per request, so the number of calls
//   does not grow with the number of watches or callers.
// A payout address seen for the first time is read from REVENUE_START onward.
// Only public data is read. Nothing here pays or calls a merchant.

import crypto from 'node:crypto';

const MIN_SPAN = 25;
// Wording RPC endpoints use when an eth_getLogs block range is too wide.
const RANGE_ERROR = /range|limit|too large|too many|exceed|max/i;

export function createRevenueTracker({ store, catalogSource, chain, clock = Date.now, config, logger = console }) {
  const instanceId = crypto.randomBytes(8).toString('hex');
  const status = {
    catalog: { last_ok_at: null, last_error_at: null, last_error: null, failing: false, routes: 0, rounds: 0 },
    chain: {
      last_ok_at: null, last_error_at: null, last_error: null, failing: false, rounds: 0,
      head_block: null, indexed_through_block: null, indexed_through_time: null, merchants_behind: null,
      start_block: null, block_range: config.logsBlockRange, log_requests: 0, payments_stored: 0,
    },
  };
  const tsCache = new Map(); // block number -> ms
  let startBlock = null;
  let span = config.logsBlockRange;
  let catalogRunning = false;
  let chainRunning = false;
  let timers = [];

  const errText = (err) => String(err && err.message ? err.message : err).slice(0, 300);

  async function blockTs(n) {
    if (tsCache.has(n)) return tsCache.get(n);
    const ts = await chain.blockTimestamp(n);
    if (tsCache.size > 20000) tsCache.clear();
    tsCache.set(n, ts);
    return ts;
  }

  // First block at or after REVENUE_START (binary search, about 20 requests, once).
  async function findStartBlock(latest) {
    const target = config.revenueStartMs;
    const cached = await store.getMeta('start_block');
    if (cached && cached.startsWith(`${target}:`)) return Number(cached.split(':')[1]);
    let result;
    if ((await blockTs(latest)) < target) {
      result = latest + 1;
    } else if ((await blockTs(0)) >= target) {
      result = 0;
    } else {
      // Narrow with the ~2 s block time first, then bisect: ts(lo) < target <= ts(hi).
      let lo = 0;
      let hi = latest;
      const guess = latest - Math.ceil(((await blockTs(latest)) - target) / 2000);
      const near = Math.max(0, guess - 5000);
      if (near > 0 && (await blockTs(near)) < target) lo = near;
      const nearHi = Math.min(latest, Math.max(lo + 1, guess + 5000));
      if ((await blockTs(nearHi)) >= target) hi = nearHi;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await blockTs(mid)) >= target) hi = mid;
        else lo = mid;
      }
      result = hi;
    }
    await store.setMeta('start_block', `${target}:${result}`);
    return result;
  }

  async function catalogTick() {
    if (catalogRunning) return false;
    catalogRunning = true;
    const s = status.catalog;
    try {
      const rows = await catalogSource();
      const now = clock();
      const r = await store.applyCatalog(rows, now);
      if (r.newPayTos.length && startBlock !== null) await store.ensureIndexRows(r.newPayTos, startBlock);
      Object.assign(s, { last_ok_at: now, failing: false, routes: r.routes, rounds: s.rounds + 1 });
      return true;
    } catch (err) {
      Object.assign(s, { last_error_at: clock(), last_error: errText(err), failing: true });
      logger.error(`[revenue] catalog read failed: ${errText(err)}`);
      return false;
    } finally {
      catalogRunning = false;
    }
  }

  async function chainTick() {
    if (chainRunning) return false;
    chainRunning = true;
    const s = status.chain;
    try {
      const payTos = await store.listedPayTos();
      if (!payTos.length) return false; // catalog not read yet
      const latest = (await chain.latestBlock()) - config.chainConfirmations;
      if (startBlock === null) startBlock = await findStartBlock(latest);
      s.start_block = startBlock;
      await store.ensureIndexRows(payTos, startBlock);
      const listed = new Set(payTos);

      let requests = 0;
      // Largest range not refused in this round; a refused range is not tried again
      // until the next round.
      let ceiling = config.logsBlockRange;
      while (requests < config.maxLogRequestsPerRound) {
        const rows = (await store.indexRows()).filter((r) => listed.has(r.pay_to) && r.indexed_to < latest);
        if (!rows.length) break;
        // Addresses at the same cursor are read together; a new address catches up
        // on its own until it reaches the others, then they merge.
        const low = Math.min(...rows.map((r) => r.indexed_to));
        const group = rows.filter((r) => r.indexed_to === low).map((r) => r.pay_to);
        const from = low + 1;
        const to = Math.min(from + span - 1, latest);
        let transfers;
        requests += 1;
        s.log_requests += 1;
        try {
          transfers = await chain.transfersTo(group, from, to);
        } catch (err) {
          // A block range the endpoint refuses: halve it and retry. Other errors end the round.
          if (RANGE_ERROR.test(errText(err)) && to - from + 1 > MIN_SPAN) {
            ceiling = Math.max(MIN_SPAN, Math.floor((to - from + 1) / 2));
            span = ceiling;
            continue;
          }
          throw err;
        }
        for (const t of transfers) {
          if (t.ts === null) t.ts = await blockTs(t.blockNumber);
        }
        s.payments_stored += await store.storeTransfers(transfers, group, to);
        if (to - from + 1 >= span) span = Math.min(ceiling, span * 2);
      }

      const rows = (await store.indexRows()).filter((r) => listed.has(r.pay_to));
      const through = rows.length ? Math.min(...rows.map((r) => r.indexed_to)) : null;
      const behind = rows.filter((r) => r.indexed_to < latest).length;
      Object.assign(s, {
        head_block: latest,
        indexed_through_block: through,
        indexed_through_time: through !== null && through >= startBlock ? await blockTs(through) : null,
        merchants_behind: behind,
        block_range: span,
        last_ok_at: clock(),
        failing: false,
        rounds: s.rounds + 1,
      });
      return true;
    } catch (err) {
      Object.assign(s, { last_error_at: clock(), last_error: errText(err), failing: true, block_range: span });
      logger.error(`[revenue] chain read failed: ${errText(err)}`);
      return false;
    } finally {
      chainRunning = false;
    }
  }

  async function asLeader(fn) {
    if (!(await store.acquireLease(instanceId, config.chainIntervalMs * 4, clock()))) return false;
    await store.expireWatches(clock());
    return fn();
  }

  return {
    status,
    catalogTick,
    chainTick,
    async tick() {
      await catalogTick();
      return chainTick();
    },
    start() {
      if (timers.length) return;
      const run = (fn) => () => asLeader(fn).catch((err) => logger.error(`[revenue] ${errText(err)}`));
      run(async () => { await catalogTick(); await chainTick(); })();
      timers = [
        setInterval(run(catalogTick), config.catalogIntervalMs),
        setInterval(run(chainTick), config.chainIntervalMs),
      ];
      for (const t of timers) t.unref?.();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
    },
    async releaseLease() {
      try {
        await store.releaseLease(instanceId);
      } catch (err) {
        logger.error(`[revenue] releasing lease failed: ${errText(err)}`);
      }
    },
  };
}
