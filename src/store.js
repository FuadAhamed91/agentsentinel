// All database access. Every multi-step change runs in one transaction, and rows
// that both the sampler and /check modify are locked (FOR UPDATE on Postgres;
// SQLite is serialized by its adapter).

import crypto from 'node:crypto';
import { initialState, conditionMetNow, changePercent } from './conditions.js';
import { typeForSourceKey } from './types/index.js';

export function newWatchToken() {
  return `wt_${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newWatchId() {
  return `w_${crypto.randomBytes(9).toString('base64url')}`;
}

function setClause(patch) {
  const cols = Object.keys(patch);
  return { sql: cols.map((c) => `${c} = ?`).join(', '), params: cols.map((c) => patch[c]) };
}

async function latestSample(q, key) {
  const rows = await q.query(
    'SELECT id, source_key, ts, value, raw, origin FROM samples WHERE source_key = ? ORDER BY id DESC LIMIT 1',
    [key],
  );
  return rows[0] || null;
}

async function insertEvent(q, watchId, sample, event, now) {
  await q.query(
    'INSERT INTO events (watch_id, ts, kind, value, previous_value, reference_value, sample_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [watchId, sample.ts, event.kind, event.value, event.previous_value ?? null, event.reference_value ?? null, sample.id, now],
  );
}

// tokenFactory(watchRow) returns the token handed to the caller; the default is a random
// token. The app passes a factory that signs the watch definition into the token.
export function createStore(db, { clock = Date.now, watchTtlMs = 30 * 24 * 3600 * 1000, tokenFactory = () => newWatchToken() } = {}) {
  return {
    db,

    async init() {
      await db.query("INSERT INTO sampler_lease (id, owner, expires_at) VALUES (1, '', 0) ON CONFLICT (id) DO NOTHING");
    },

    latestSample(key) {
      return latestSample(db, key);
    },

    // Store one sample and evaluate every active watch that reads this series.
    async insertSampleAndEvaluate(key, ts, s) {
      const type = typeForSourceKey(key);
      return db.tx(async (q) => {
        const [row] = await q.query(
          'INSERT INTO samples (source_key, ts, value, raw, origin) VALUES (?, ?, ?, ?, ?) RETURNING id',
          [key, ts, s.value, s.raw, s.origin ?? null],
        );
        const sample = { id: row.id, source_key: key, ts, value: s.value, raw: s.raw, origin: s.origin ?? null };
        const watches = await q.query(
          `SELECT * FROM watches WHERE source_key = ? AND status = 'active' AND expires_at > ? ORDER BY id${db.forUpdate}`,
          [key, ts],
        );
        let triggers = 0;
        for (const w of watches) {
          if (w.last_eval_sample_id >= sample.id) continue;
          const { event, patch } = type.evaluate(w, sample);
          if (event) {
            await insertEvent(q, w.id, sample, event, ts);
            triggers += 1;
          }
          const u = setClause(patch);
          await q.query(`UPDATE watches SET ${u.sql} WHERE id = ?`, [...u.params, w.id]);
        }
        return { sample, evaluated: watches.length, triggers };
      });
    },

    async countActiveWatches(now = clock()) {
      const [r] = await db.query("SELECT COUNT(*) AS n FROM watches WHERE status = 'active' AND expires_at > ?", [now]);
      return Number(r.n);
    },

    async activeSourceKeys(typeName, now = clock()) {
      const rows = await db.query(
        "SELECT DISTINCT source_key FROM watches WHERE type = ? AND status = 'active' AND expires_at > ? ORDER BY source_key",
        [typeName, now],
      );
      return rows.map((r) => r.source_key);
    },

    async createWatch(params, { viaGateway = false } = {}) {
      // Whole seconds, so a watch rebuilt from its token has identical timestamps.
      const now = Math.floor(clock() / 1000) * 1000;
      const watch = {
        id: newWatchId(),
        token_hash: null,
        type: params.type,
        cond: params.condition,
        threshold: params.threshold ?? null,
        percent: params.percent ?? null,
        direction: params.direction ?? null,
        address: params.address ?? null,
        source_key: params.sourceKey,
        status: 'active',
        created_at: now,
        expires_at: now + watchTtlMs,
        via_gateway: viaGateway ? 1 : 0,
      };
      const token = tokenFactory(watch);
      watch.token_hash = hashToken(token);
      return db.tx(async (q) => {
        const baseline = await latestSample(q, watch.source_key);
        const { state, event } = initialState(watch, baseline);
        const row = { ...watch, ...state, trigger_count: event ? 1 : 0 };
        const cols = Object.keys(row);
        await q.query(
          `INSERT INTO watches (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          cols.map((c) => row[c]),
        );
        // A condition already met at creation is timed at creation, with the value of
        // the latest sample at that moment.
        if (event) await insertEvent(q, watch.id, { ...baseline, ts: now }, event, now);
        return { watch: row, token, baseline };
      });
    },

    // Rebuilds a watch from the definition carried in its signed token, after stored
    // data was lost. Monitoring restarts from the latest sample; the trigger history
    // from before the loss is gone, which restored_at reports.
    async restoreWatch(spec, tokenHash, sourceKey) {
      const now = clock();
      const watch = {
        id: spec.id,
        token_hash: tokenHash,
        type: spec.type,
        cond: spec.cond,
        threshold: spec.threshold,
        percent: spec.percent,
        direction: spec.direction,
        address: spec.address,
        source_key: sourceKey,
        status: spec.expires_at <= now ? 'expired' : 'active',
        created_at: spec.created_at,
        expires_at: spec.expires_at,
        ended_at: spec.expires_at <= now ? spec.expires_at : null,
        restored_at: now,
        via_gateway: 0,
      };
      return db.tx(async (q) => {
        const baseline = await latestSample(q, sourceKey);
        // No met_at_creation trigger on restore: condition_met_now already reports a held condition.
        const { state } = initialState(watch, baseline);
        const row = { ...watch, ...state, trigger_count: 0 };
        const cols = Object.keys(row);
        await q.query(
          `INSERT INTO watches (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`,
          cols.map((c) => row[c]),
        );
        const [stored] = await q.query('SELECT * FROM watches WHERE token_hash = ?', [tokenHash]);
        return stored || null;
      });
    },

    async findByTokenHash(tokenHash) {
      const rows = await db.query('SELECT * FROM watches WHERE token_hash = ?', [tokenHash]);
      return rows[0] || null;
    },

    // The paid check. Reads the window since the previous check, then resets it, atomically.
    async checkWatch(tokenHash, { requestId, viaGateway = false, maxTriggers = 20 }) {
      const now = clock();
      return db.tx(async (q) => {
        const [w] = await q.query(`SELECT * FROM watches WHERE token_hash = ?${db.forUpdate}`, [tokenHash]);
        if (!w) return { status: 'unknown_token' };
        if (w.status === 'active' && w.expires_at <= now) {
          await q.query("UPDATE watches SET status = 'expired', ended_at = ? WHERE id = ?", [w.expires_at, w.id]);
          w.status = 'expired';
          w.ended_at = w.expires_at;
        }
        if (w.status !== 'active') return { status: w.status, watch: w };

        const current = await latestSample(q, w.source_key);
        const [agg] = await q.query(
          'SELECT COUNT(*) AS n, MAX(id) AS max_id FROM events WHERE watch_id = ? AND id > ?',
          [w.id, w.last_check_event_id],
        );
        const recent = await q.query(
          'SELECT id, ts, kind, value, previous_value, reference_value FROM events WHERE watch_id = ? AND id > ? ORDER BY id DESC LIMIT ?',
          [w.id, w.last_check_event_id, maxTriggers],
        );
        const triggers = recent.reverse();
        const triggerCount = Number(agg.n);
        const currentValue = current ? current.value : null;
        const metNow = conditionMetNow(w, currentValue);
        const triggered = triggerCount > 0 || metNow === true;

        const report = {
          watch: w,
          current,
          condition_met_now: metNow,
          triggered,
          trigger_count: triggerCount,
          triggers,
          reference_value: w.cond === 'changes_by_percent' ? w.reference_value : null,
          change_percent: w.cond === 'changes_by_percent' ? changePercent(currentValue, w.reference_value) : null,
          previous_check_at: w.last_check_at,
          checked_at: now,
        };

        const patch = {
          last_check_at: now,
          last_check_event_id: agg.max_id ?? w.last_check_event_id,
          window_high: null,
          window_low: null,
          window_count: 0,
          check_count: w.check_count + 1,
        };
        if (w.cond === 'changes_by_percent' && current) {
          patch.reference_value = current.value;
          patch.reference_time = current.ts;
          patch.in_alert = 0;
        }
        const u = setClause(patch);
        await q.query(`UPDATE watches SET ${u.sql} WHERE id = ?`, [...u.params, w.id]);
        await q.query(
          'INSERT INTO checks (watch_id, request_id, ts, triggered, trigger_count, via_gateway) VALUES (?, ?, ?, ?, ?, ?)',
          [w.id, requestId, now, triggered ? 1 : 0, triggerCount, viaGateway ? 1 : 0],
        );
        return { status: 'active', report };
      });
    },

    // Triggers already delivered by /check (id <= last_check_event_id), newest first.
    async reportedEvents(watch, limit = 100) {
      return db.query(
        'SELECT id, ts, kind, value, previous_value, reference_value FROM events WHERE watch_id = ? AND id <= ? ORDER BY id DESC LIMIT ?',
        [watch.id, watch.last_check_event_id, limit],
      );
    },

    async cancel(tokenHash) {
      const now = clock();
      return db.tx(async (q) => {
        const [w] = await q.query(`SELECT * FROM watches WHERE token_hash = ?${db.forUpdate}`, [tokenHash]);
        if (!w) return { status: 'unknown_token' };
        if (w.status !== 'active') return { status: w.status, watch: w, changed: false };
        await q.query("UPDATE watches SET status = 'cancelled', ended_at = ? WHERE id = ?", [now, w.id]);
        return { status: 'cancelled', watch: { ...w, status: 'cancelled', ended_at: now }, changed: true };
      });
    },

    async expireWatches(now = clock()) {
      await db.query(
        "UPDATE watches SET status = 'expired', ended_at = expires_at WHERE status = 'active' AND expires_at <= ?",
        [now],
      );
    },

    // Deletes samples older than the retention window, keeping the newest sample of
    // every series so a last known value always exists.
    async pruneSamples(olderThan) {
      await db.query(
        'DELETE FROM samples WHERE ts < ? AND id NOT IN (SELECT MAX(id) FROM samples GROUP BY source_key)',
        [olderThan],
      );
    },

    // Leader lease so only one process samples, even if more than one instance runs.
    async acquireLease(owner, ttlMs, now = clock()) {
      const rows = await db.query(
        'UPDATE sampler_lease SET owner = ?, expires_at = ? WHERE id = 1 AND (owner = ? OR expires_at < ?) RETURNING id',
        [owner, now + ttlMs, owner, now],
      );
      return rows.length > 0;
    },

    // Lets a replacement process take over sampling immediately after a restart.
    async releaseLease(owner) {
      await db.query('UPDATE sampler_lease SET expires_at = 0 WHERE id = 1 AND owner = ?', [owner]);
    },

    async stats(now = clock()) {
      const d = new Date(now);
      const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const one = async (sql, params) => (await db.query(sql, params))[0];
      const activeByType = await db.query(
        "SELECT type, COUNT(*) AS n FROM watches WHERE status = 'active' AND expires_at > ? GROUP BY type ORDER BY type",
        [now],
      );
      const checksToday = await one(
        'SELECT COUNT(*) AS n, COUNT(DISTINCT watch_id) AS tokens, COUNT(DISTINCT request_id) AS requests FROM checks WHERE ts >= ?',
        [dayStart],
      );
      const createdToday = await one('SELECT COUNT(*) AS n FROM watches WHERE created_at >= ?', [dayStart]);
      const totals = await one('SELECT COUNT(*) AS n FROM watches', []);
      const everChecked = await one('SELECT COUNT(DISTINCT watch_id) AS n FROM checks', []);
      const triggersToday = await one('SELECT COUNT(*) AS n FROM events WHERE created_at >= ?', [dayStart]);
      const samples = await one('SELECT COUNT(*) AS n FROM samples', []);
      return {
        day_start: dayStart,
        active_watches: activeByType.reduce((a, r) => a + Number(r.n), 0),
        active_by_type: Object.fromEntries(activeByType.map((r) => [r.type, Number(r.n)])),
        checks_today: Number(checksToday.n),
        check_requests_today: Number(checksToday.requests),
        distinct_tokens_checked_today: Number(checksToday.tokens),
        distinct_tokens_ever_checked: Number(everChecked.n),
        watches_created_today: Number(createdToday.n),
        watches_created_total: Number(totals.n),
        triggers_today: Number(triggersToday.n),
        samples_stored: Number(samples.n),
      };
    },
  };
}
