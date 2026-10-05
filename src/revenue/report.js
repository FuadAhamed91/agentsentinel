// Leaderboard, merchant and since-last-check reports built from stored data.
// Every number is either read from XDC mainnet (onchain_*) or copied from the
// marketplace catalog counters (catalog_*). Nothing is estimated.

const H = 3600 * 1000;

export const usdc = (micro) => Number((Number(micro || 0) / 1e6).toFixed(6));
const round6 = (n) => Number(Number(n || 0).toFixed(6));
export const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

// One entry per payout address, ranked by on-chain revenue since startMs.
export async function loadBoard(store, now, { startMs }) {
  const [routes, totals, ch24, ch1] = await Promise.all([
    store.listedRoutes(),
    store.paymentTotals(startMs, now - 24 * H, now - H),
    store.routeChangeTotals(now - 24 * H),
    store.routeChangeTotals(now - H),
  ]);
  const route24 = new Map(ch24.map((c) => [c.route_key, c]));
  const route1 = new Map(ch1.map((c) => [c.route_key, c]));
  const accounts = new Map();
  for (const r of routes) {
    let a = accounts.get(r.pay_to);
    if (!a) {
      a = { payTo: r.pay_to, listingVolume: new Map(), providerIds: new Set(), routes: [], catalogCalls: 0, catalogVolume: 0, catalogCalls24: 0, catalogVolume24: 0, firstSeen: Infinity };
      accounts.set(r.pay_to, a);
    }
    const c24 = route24.get(r.route_key);
    const c1 = route1.get(r.route_key);
    a.routes.push({
      ...r,
      calls_24h: c24 ? c24.calls : 0,
      volume_24h: c24 ? c24.volume : 0,
      calls_1h: c1 ? c1.calls : 0,
      volume_1h: c1 ? c1.volume : 0,
    });
    a.providerIds.add(r.provider_id);
    a.listingVolume.set(r.provider_name, (a.listingVolume.get(r.provider_name) || 0) + r.volume_usdc);
    a.catalogCalls += r.calls;
    a.catalogVolume += r.volume_usdc;
    if (c24) {
      a.catalogCalls24 += c24.calls;
      a.catalogVolume24 += c24.volume;
    }
    a.firstSeen = Math.min(a.firstSeen, r.first_seen_at);
  }
  const tot = new Map(totals.map((t) => [t.pay_to, t]));
  const list = [...accounts.values()].map((a) => {
    const t = tot.get(a.payTo);
    const names = [...a.listingVolume.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([n]) => n);
    return {
      payTo: a.payTo,
      name: names[0],
      names,
      providerIds: [...a.providerIds],
      routes: a.routes,
      revenueMicro: t ? t.total : 0,
      payments: t ? t.n : 0,
      revenue24Micro: t ? t.total_24h : 0,
      payments24: t ? t.n_24h : 0,
      revenue1Micro: t ? t.total_1h : 0,
      payments1: t ? t.n_1h : 0,
      lastPaymentTs: t ? t.last_ts : null,
      payers: t ? t.payers : 0,
      catalogCalls: a.catalogCalls,
      catalogVolume: round6(a.catalogVolume),
      catalogCalls24: a.catalogCalls24,
      catalogVolume24: round6(a.catalogVolume24),
      firstSeen: a.firstSeen,
    };
  });
  list.sort((x, y) => y.revenueMicro - x.revenueMicro
    || y.catalogVolume - x.catalogVolume
    || x.name.localeCompare(y.name)
    || x.payTo.localeCompare(y.payTo));
  list.forEach((a, i) => { a.rank = i + 1; });
  const leaderMicro = list.length ? list[0].revenueMicro : 0;
  for (const a of list) a.behindLeaderMicro = leaderMicro - a.revenueMicro;
  return {
    now,
    startMs,
    list,
    byPayTo: new Map(list.map((a) => [a.payTo, a])),
    ranks: Object.fromEntries(list.map((a) => [a.payTo, a.rank])),
  };
}

export function boardEntry(a) {
  return {
    rank: a.rank,
    merchant: a.name,
    ...(a.names.length > 1 ? { other_listings: a.names.slice(1) } : {}),
    pay_to: a.payTo,
    onchain_revenue_usdc: usdc(a.revenueMicro),
    onchain_payments: a.payments,
    onchain_revenue_24h_usdc: usdc(a.revenue24Micro),
    onchain_revenue_1h_usdc: usdc(a.revenue1Micro),
    behind_leader_usdc: usdc(a.behindLeaderMicro),
    last_payment_time: iso(a.lastPaymentTs),
    catalog_volume_usdc: a.catalogVolume,
    catalog_calls: a.catalogCalls,
  };
}

// Who is ranked first and by how much over the merchant ranked second.
export function leaderSummary(board) {
  const [first, second] = board.list;
  if (!first) return null;
  return {
    merchant: first.name,
    pay_to: first.payTo,
    onchain_revenue_usdc: usdc(first.revenueMicro),
    second: second ? second.name : null,
    second_onchain_revenue_usdc: second ? usdc(second.revenueMicro) : null,
    lead_usdc: second ? usdc(first.revenueMicro - second.revenueMicro) : null,
  };
}

export function marketSummary(board) {
  const sum = (f) => board.list.reduce((acc, a) => acc + f(a), 0);
  return {
    merchants: board.list.length,
    listings: new Set(board.list.flatMap((a) => a.providerIds)).size,
    routes: sum((a) => a.routes.length),
    onchain_revenue_usdc: usdc(sum((a) => a.revenueMicro)),
    onchain_payments: sum((a) => a.payments),
    onchain_revenue_24h_usdc: usdc(sum((a) => a.revenue24Micro)),
    onchain_payments_24h: sum((a) => a.payments24),
    onchain_revenue_1h_usdc: usdc(sum((a) => a.revenue1Micro)),
    onchain_payments_1h: sum((a) => a.payments1),
    catalog_volume_usdc: round6(sum((a) => a.catalogVolume)),
    catalog_calls: sum((a) => a.catalogCalls),
  };
}

// Routes whose catalog counters rose the most in the last 24 hours.
export function topRoutes24h(board, limit = 10) {
  return board.list
    .flatMap((a) => a.routes.map((r) => ({ a, r })))
    .filter(({ r }) => r.volume_24h > 0 || r.calls_24h > 0)
    .sort((x, y) => y.r.volume_24h - x.r.volume_24h || y.r.calls_24h - x.r.calls_24h)
    .slice(0, limit)
    .map(({ a, r }) => ({
      listing: r.provider_name,
      merchant_rank: a.rank,
      method: r.method,
      path: r.path,
      price_usdc: r.price_usdc,
      catalog_calls_24h: r.calls_24h,
      catalog_volume_24h_usdc: r.volume_24h,
    }));
}

export async function dataStatus(store, tracker, config, now) {
  const c = tracker.status.catalog;
  const ch = tracker.status.chain;
  const catalogReadAt = Number(await store.getMeta('catalog_read_at')) || null;
  const historyFrom = Number(await store.getMeta('catalog_history_from')) || null;
  const chainStaleAfter = Math.max(4 * config.chainIntervalMs, 60000);
  return {
    onchain_source: `Transfer events of USDC ${config.usdcAddress} into each payout address, XDC mainnet (chain ID 50)`,
    onchain_counted_from: iso(config.revenueStartMs),
    onchain_indexed_through_block: ch.indexed_through_block,
    onchain_indexed_through_time: iso(ch.indexed_through_time),
    onchain_merchants_still_indexing: ch.merchants_behind,
    onchain_stale: !ch.last_ok_at || now - ch.last_ok_at > chainStaleAfter || ch.failing,
    catalog_source: config.catalogUrl,
    catalog_read_at: iso(catalogReadAt),
    catalog_stale: !catalogReadAt || now - catalogReadAt > 3 * config.catalogIntervalMs || c.failing,
    catalog_changes_recorded_from: iso(historyFrom),
  };
}

const ADDRESS = /^(?:0x|xdc)([0-9a-fA-F]{40})$/;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Finds a merchant by payout address, service id (also inside a route URL) or name.
export function resolveMerchant(board, query) {
  const q = String(query).trim();
  const addr = ADDRESS.exec(q);
  if (addr) {
    const a = board.byPayTo.get(`0x${addr[1].toLowerCase()}`);
    return a ? { account: a, matched: a.payTo } : { account: null, suggestions: [] };
  }
  const gw = /gw_[A-Za-z0-9]+/.exec(q);
  if (gw) {
    const a = board.list.find((x) => x.providerIds.includes(gw[0]));
    if (a) return { account: a, matched: gw[0] };
  }
  const nq = norm(q);
  if (!nq) return { account: null, suggestions: [] };
  const names = board.list.flatMap((a) => a.names.map((n) => ({ a, n, nn: norm(n) })));
  const best = (cands) => cands.sort((x, y) => x.a.rank - y.a.rank)[0];
  let hit = best(names.filter((x) => x.nn === nq));
  if (!hit && nq.length >= 4) hit = best(names.filter((x) => x.nn.includes(nq)));
  if (!hit) hit = best(names.filter((x) => x.nn.length >= 4 && nq.includes(x.nn)));
  if (hit) return { account: hit.a, matched: hit.n };
  const words = nq.split(' ').filter((w) => w.length >= 3);
  const scored = names
    .map((x) => ({ ...x, score: words.filter((w) => x.nn.includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.a.rank - y.a.rank);
  return { account: null, suggestions: [...new Set(scored.map((x) => x.n))].slice(0, 5) };
}

// The route of a merchant whose price equals the amount, when exactly one matches.
function routeFor(account, amountMicro) {
  if (!account) return null;
  const hits = account.routes.filter((r) => Math.round(r.price_usdc * 1e6) === amountMicro);
  return hits.length === 1 ? `${hits[0].provider_name} ${hits[0].method} ${hits[0].path}` : null;
}

export function paymentOut(p, board, { withMerchant = false } = {}) {
  const a = board.byPayTo.get(p.pay_to) || null;
  return {
    time: iso(p.ts),
    amount_usdc: usdc(p.amount_micro),
    ...(withMerchant ? { merchant: a ? a.name : null, pay_to: p.pay_to } : {}),
    payer: p.payer,
    tx_hash: p.tx_hash,
    route: routeFor(a, p.amount_micro),
  };
}

function neighbor(b, revenueMicro) {
  if (!b) return null;
  return {
    rank: b.rank,
    merchant: b.name,
    onchain_revenue_usdc: usdc(b.revenueMicro),
    gap_usdc: usdc(Math.abs(b.revenueMicro - revenueMicro)),
  };
}

export async function merchantReport(store, board, a) {
  const [recent, payers] = await Promise.all([
    store.payments({ payTo: a.payTo, sinceTs: board.startMs }, { limit: 20, newestFirst: true }),
    store.topPayers(a.payTo, board.startMs, 5),
  ]);
  return {
    ...boardEntry(a),
    onchain_payments_24h: a.payments24,
    onchain_payments_1h: a.payments1,
    distinct_payers: a.payers,
    merchants_ranked: board.list.length,
    rank_above: neighbor(board.list[a.rank - 2], a.revenueMicro),
    rank_below: neighbor(board.list[a.rank], a.revenueMicro),
    routes: a.routes
      .slice()
      .sort((x, y) => y.volume_usdc - x.volume_usdc || y.calls - x.calls || x.path.localeCompare(y.path))
      .map((r) => ({
        listing: r.provider_name,
        method: r.method,
        path: r.path,
        price_usdc: r.price_usdc,
        catalog_calls: r.calls,
        catalog_volume_usdc: r.volume_usdc,
        catalog_calls_24h: r.calls_24h,
        catalog_volume_24h_usdc: r.volume_24h,
      })),
    recent_payments: recent.map((p) => paymentOut(p, board)),
    top_payers: payers.map((p) => ({ payer: p.payer, payments: p.n, amount_usdc: usdc(p.total) })),
  };
}

// What changed for one watch since its previous check (or its creation).
// snapshotMaxId bounds the payments read, so a payment stored while this report is
// built is reported by the next check instead of being skipped or repeated.
export async function checkReport(store, board, watch, { now, snapshotMaxId, catalogHistoryFrom, maxListed }) {
  const since = watch.last_check_at ?? watch.created_at;
  const window = { afterId: watch.last_payment_id, upToId: snapshotMaxId, sinceTs: watch.created_at };
  const sums = await store.paymentSums(window);
  const marketCount = sums.reduce((acc, x) => acc + x.n, 0);
  const marketTotal = sums.reduce((acc, x) => acc + x.total, 0);
  const oldRanks = watch.last_ranks;
  const catalogCovered = catalogHistoryFrom !== null && catalogHistoryFrom <= since;
  const newMerchants = catalogCovered
    ? board.list
      .filter((a) => a.firstSeen > since)
      .map((a) => ({ merchant: a.name, pay_to: a.payTo, rank: a.rank, first_seen_time: iso(a.firstSeen) }))
    : null;

  if (watch.target === 'market') {
    const listed = await store.payments(window, { limit: maxListed });
    return {
      target: 'market',
      since: iso(since),
      new_payment_count: marketCount,
      new_revenue_usdc: usdc(marketTotal),
      new_payments: listed.map((p) => paymentOut(p, board, { withMerchant: true })),
      new_payments_not_listed: Math.max(0, marketCount - listed.length),
      revenue_gains: sums
        .slice()
        .sort((x, y) => y.total - x.total || y.n - x.n)
        .slice(0, 10)
        .map((x) => {
          const a = board.byPayTo.get(x.pay_to);
          return { merchant: a ? a.name : null, pay_to: x.pay_to, rank: a ? a.rank : null, new_payment_count: x.n, new_revenue_usdc: usdc(x.total) };
        }),
      rank_changes: oldRanks
        ? board.list
          .filter((b) => oldRanks[b.payTo] !== undefined && oldRanks[b.payTo] !== b.rank)
          .map((b) => ({ merchant: b.name, rank: b.rank, rank_at_last_check: oldRanks[b.payTo] }))
        : null,
      new_merchants: newMerchants,
      leader: leaderSummary(board),
      market: marketSummary(board),
      leaderboard_top: board.list.slice(0, 10).map(boardEntry),
    };
  }

  const a = board.byPayTo.get(watch.target) || null;
  const mine = sums.find((x) => x.pay_to === watch.target) || { n: 0, total: 0 };
  const listed = await store.payments({ ...window, payTo: watch.target }, { limit: maxListed });
  const rankNow = a ? a.rank : null;
  const rankThen = oldRanks && oldRanks[watch.target] !== undefined ? oldRanks[watch.target] : null;
  let passed = null;
  let passedBy = null;
  if (rankThen !== null && rankNow !== null) {
    passed = [];
    passedBy = [];
    for (const b of board.list) {
      const then = oldRanks[b.payTo];
      if (b.payTo === watch.target || then === undefined) continue;
      if (then < rankThen && b.rank > rankNow) passed.push(b.name);
      if (then > rankThen && b.rank < rankNow) passedBy.push(b.name);
    }
  }
  let catalogCalls = null;
  let catalogVolume = null;
  if (catalogCovered) {
    const changes = (await store.routeChangeTotals(since, now)).filter((c) => c.pay_to === watch.target);
    catalogCalls = changes.reduce((acc, c) => acc + c.calls, 0);
    catalogVolume = round6(changes.reduce((acc, c) => acc + c.volume, 0));
  }
  return {
    target: 'merchant',
    merchant: a ? a.name : null,
    pay_to: watch.target,
    listed: Boolean(a),
    since: iso(since),
    new_payment_count: mine.n,
    new_revenue_usdc: usdc(mine.total),
    new_payments: listed.map((p) => paymentOut(p, board)),
    new_payments_not_listed: Math.max(0, mine.n - listed.length),
    rank: rankNow,
    rank_at_last_check: rankThen,
    rank_change: rankThen !== null && rankNow !== null ? rankThen - rankNow : null,
    merchants_ranked: board.list.length,
    onchain_revenue_usdc: a ? usdc(a.revenueMicro) : null,
    onchain_revenue_at_last_check_usdc: watch.last_revenue_micro === null ? null : usdc(watch.last_revenue_micro),
    behind_leader_usdc: a ? usdc(a.behindLeaderMicro) : null,
    leader: leaderSummary(board),
    passed,
    passed_by: passedBy,
    rank_above: a ? neighbor(board.list[a.rank - 2], a.revenueMicro) : null,
    rank_below: a ? neighbor(board.list[a.rank], a.revenueMicro) : null,
    catalog_calls_since_last_check: catalogCalls,
    catalog_volume_since_last_check_usdc: catalogVolume,
    market_new_payment_count: marketCount,
    market_new_revenue_usdc: usdc(marketTotal),
    new_merchants: newMerchants,
  };
}
