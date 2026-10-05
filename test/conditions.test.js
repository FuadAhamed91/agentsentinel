// Unit tests for the trigger logic of every condition.

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSample, initialState, conditionMetNow } from '../src/conditions.js';
import { normalizeAddress, weiToXdc } from '../src/types/wallet_balance.js';
import { weiToGwei } from '../src/types/xdc_gas.js';

// Runs a series of values through a watch; returns the events produced by each sample.
function run(watchSpec, values, { baseline = null } = {}) {
  let watch = { threshold: null, percent: null, direction: null, window_count: 0, window_high: null, window_low: null, trigger_count: 0, ...watchSpec };
  const init = initialState(watch, baseline);
  watch = { ...watch, ...init.state };
  const events = [];
  values.forEach((v, i) => {
    const sample = { id: (baseline ? baseline.id : 0) + i + 1, ts: 1000 * (i + 1), value: v, raw: String(v) };
    const { event, patch } = evaluateSample(watch, sample);
    watch = { ...watch, ...patch };
    events.push(event ? event.kind : null);
  });
  return { events, watch, initialEvent: init.event };
}

test('above: triggers on each move from not-above to above, not while it stays above', () => {
  const { events } = run({ cond: 'above', threshold: 0.08 }, [0.07, 0.081, 0.09, 0.08, 0.085, 0.079]);
  assert.deepEqual(events, [null, 'moved_above', null, null, 'moved_above', null]);
});

test('above: threshold equality is not above', () => {
  const { events } = run({ cond: 'above', threshold: 0.08 }, [0.08]);
  assert.deepEqual(events, [null]);
});

test('above: condition already met at creation is recorded once', () => {
  const r = run({ cond: 'above', threshold: 0.08 }, [0.09, 0.1], { baseline: { id: 5, ts: 0, value: 0.09, raw: '0.09' } });
  assert.equal(r.initialEvent.kind, 'met_at_creation');
  assert.deepEqual(r.events, [null, null]);
});

test('below: triggers on each move into below', () => {
  const { events } = run({ cond: 'below', threshold: 10 }, [12, 9.9, 9, 10, 8]);
  assert.deepEqual(events, [null, 'moved_below', null, null, 'moved_below']);
});

test('crosses_above: needs a previous sample at or below the threshold', () => {
  const { events } = run({ cond: 'crosses_above', threshold: 0.08 }, [0.09, 0.07, 0.08, 0.081, 0.09, 0.079, 0.0801]);
  // first sample has no previous value; 0.08 -> 0.081 crosses; 0.079 -> 0.0801 crosses again
  assert.deepEqual(events, [null, null, null, 'crossed_above', null, null, 'crossed_above']);
});

test('crosses_above: no trigger at creation even if already above', () => {
  const r = run({ cond: 'crosses_above', threshold: 0.08 }, [0.09], { baseline: { id: 1, ts: 0, value: 0.085, raw: '0.085' } });
  assert.equal(r.initialEvent, null);
  assert.deepEqual(r.events, [null]);
});

test('crosses_below: previous at or above, next below', () => {
  const { events } = run({ cond: 'crosses_below', threshold: 0.05 }, [0.06, 0.05, 0.049, 0.048, 0.051, 0.04]);
  assert.deepEqual(events, [null, null, 'crossed_below', null, null, 'crossed_below']);
});

test('changes_by_percent (any): measured from the reference value, one trigger per entry', () => {
  const r = run({ cond: 'changes_by_percent', percent: 5, direction: 'any' }, [0.102, 0.105, 0.11, 0.1, 0.094], {
    baseline: { id: 1, ts: 0, value: 0.1, raw: '0.1' },
  });
  // +2% no, +5% yes (exactly 5), +10% still in alert, 0% leaves alert, -6% triggers again
  assert.deepEqual(r.events, [null, 'changed_by_percent', null, null, 'changed_by_percent']);
  assert.equal(r.watch.reference_value, 0.1);
});

test('changes_by_percent (up / down)', () => {
  const base = { baseline: { id: 1, ts: 0, value: 100, raw: '100' } };
  assert.deepEqual(run({ cond: 'changes_by_percent', percent: 3, direction: 'up' }, [96, 103], base).events, [null, 'changed_by_percent']);
  assert.deepEqual(run({ cond: 'changes_by_percent', percent: 3, direction: 'down' }, [103, 97], base).events, [null, 'changed_by_percent']);
});

test('changes_by_percent without a baseline takes the first sample as reference', () => {
  const r = run({ cond: 'changes_by_percent', percent: 10, direction: 'any' }, [50, 56]);
  assert.deepEqual(r.events, [null, 'changed_by_percent']);
});

test('changes: every exact change is a trigger, including a return to the old value', () => {
  const r = run({ cond: 'changes' }, [100, 100, 101, 101, 100], { baseline: { id: 1, ts: 0, value: 100, raw: '100' } });
  assert.deepEqual(r.events, [null, null, 'changed', null, 'changed']);
});

test('window high, low and count accumulate per sample', () => {
  const r = run({ cond: 'above', threshold: 1 }, [0.5, 0.9, 0.2, 0.7]);
  assert.equal(r.watch.window_high, 0.9);
  assert.equal(r.watch.window_low, 0.2);
  assert.equal(r.watch.window_count, 4);
});

test('conditionMetNow', () => {
  assert.equal(conditionMetNow({ cond: 'above', threshold: 1 }, 2), true);
  assert.equal(conditionMetNow({ cond: 'below', threshold: 1 }, 2), false);
  assert.equal(conditionMetNow({ cond: 'crosses_above', threshold: 1 }, 2), null);
  assert.equal(conditionMetNow({ cond: 'changes' }, 2), null);
  assert.equal(conditionMetNow({ cond: 'changes_by_percent', percent: 5, direction: 'any', reference_value: 100 }, 94), true);
  assert.equal(conditionMetNow({ cond: 'above', threshold: 1 }, null), null);
});

test('address normalization accepts xdc and 0x prefixes', () => {
  const hex = 'AbCdEf0123456789abcdef0123456789ABCDEF01';
  assert.equal(normalizeAddress(`xdc${hex}`), `0x${hex.toLowerCase()}`);
  assert.equal(normalizeAddress(`XDC${hex}`), `0x${hex.toLowerCase()}`);
  assert.equal(normalizeAddress(`0x${hex}`), `0x${hex.toLowerCase()}`);
  assert.equal(normalizeAddress(hex), null);
  assert.equal(normalizeAddress(`0x${hex}00`), null);
  assert.equal(normalizeAddress(`0x${hex.slice(0, -1)}g`), null);
});

test('unit conversions', () => {
  assert.equal(weiToGwei(13_500_000_000n), 13.5);
  assert.equal(weiToXdc(1_500_000_000_000_000_000n), 1.5);
  assert.equal(weiToXdc(0n), 0);
  assert.equal(weiToXdc(1n), 1e-18);
  assert.equal(weiToXdc(3_711_081_544_000_000_000_000_000_000n), 3711081544);
});
