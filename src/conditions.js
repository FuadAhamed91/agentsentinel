// Trigger logic shared by every watch type. Pure functions over a watch's stored
// state and one sample, so they are easy to test and identical for every type.
//
// Definitions (v = sample value, t = threshold, p = percent):
//   above              met while v > t; one trigger each time v goes from not-above to above
//   below              met while v < t; one trigger each time v goes from not-below to below
//   crosses_above      trigger when the previous sample was <= t and this one is > t
//   crosses_below      trigger when the previous sample was >= t and this one is < t
//   changes_by_percent met while |v - ref| / ref * 100 >= p (or only up / only down);
//                      ref is the value at creation and is reset to the current value at each check
//   changes            trigger whenever the exact value differs from the previous sample

const EPSILON = 1e-9;

export const CONDITION_DESCRIPTIONS = {
  above: 'met while value > threshold; a trigger is recorded each time the value moves from not above to above',
  below: 'met while value < threshold; a trigger is recorded each time the value moves from not below to below',
  crosses_above: 'trigger when the previous sample was <= threshold and the next sample is > threshold',
  crosses_below: 'trigger when the previous sample was >= threshold and the next sample is < threshold',
  changes_by_percent:
    'met while the value differs from the reference value by at least percent (direction any, up or down); the reference value is the value at creation and is reset to the current value at each check',
  changes: 'trigger each time the exact balance differs from the previous sample',
};

function percentChange(v, ref) {
  return ((v - ref) / ref) * 100;
}

export function percentMet(pct, percent, direction) {
  if (direction === 'up') return pct >= percent - EPSILON;
  if (direction === 'down') return pct <= -percent + EPSILON;
  return Math.abs(pct) >= percent - EPSILON;
}

// Whether the condition holds for a single value right now.
// Returns null for conditions that describe a movement rather than a level.
export function conditionMetNow(watch, value) {
  if (value === null || value === undefined) return null;
  switch (watch.cond) {
    case 'above': return value > watch.threshold;
    case 'below': return value < watch.threshold;
    case 'changes_by_percent': {
      const ref = watch.reference_value;
      if (ref === null || ref === undefined || ref === 0) return false;
      return percentMet(percentChange(value, ref), watch.percent, watch.direction);
    }
    default: return null;
  }
}

// State to store when a watch is created. `baseline` is the latest known sample or null.
// For above/below a condition that already holds at creation is recorded as a trigger.
export function initialState(watch, baseline) {
  const state = {
    last_value: null,
    last_raw: null,
    last_eval_sample_id: 0,
    in_alert: 0,
    reference_value: null,
    reference_time: null,
  };
  if (!baseline) return { state, event: null };
  state.last_value = baseline.value;
  state.last_raw = baseline.raw;
  state.last_eval_sample_id = baseline.id;
  let event = null;
  if (watch.cond === 'changes_by_percent') {
    state.reference_value = baseline.value;
    state.reference_time = baseline.ts;
  }
  if (watch.cond === 'above' || watch.cond === 'below') {
    const met = conditionMetNow(watch, baseline.value);
    state.in_alert = met ? 1 : 0;
    if (met) {
      event = { kind: 'met_at_creation', value: baseline.value, previous_value: null, reference_value: null };
    }
  }
  return { state, event };
}

// Evaluate one new sample against a watch. Returns the trigger event (or null) and
// the column updates for the watch row, including the since-last-check window.
export function evaluateSample(watch, sample) {
  const v = sample.value;
  const t = watch.threshold;
  const prev = watch.last_value;
  const patch = {};
  let event = null;

  switch (watch.cond) {
    case 'above':
    case 'below': {
      const met = watch.cond === 'above' ? v > t : v < t;
      if (met && !watch.in_alert) {
        event = { kind: watch.cond === 'above' ? 'moved_above' : 'moved_below', value: v, previous_value: prev, reference_value: null };
      }
      patch.in_alert = met ? 1 : 0;
      break;
    }
    case 'crosses_above':
      if (prev !== null && prev !== undefined && prev <= t && v > t) {
        event = { kind: 'crossed_above', value: v, previous_value: prev, reference_value: null };
      }
      break;
    case 'crosses_below':
      if (prev !== null && prev !== undefined && prev >= t && v < t) {
        event = { kind: 'crossed_below', value: v, previous_value: prev, reference_value: null };
      }
      break;
    case 'changes_by_percent': {
      const ref = watch.reference_value;
      if (ref === null || ref === undefined || ref === 0) {
        patch.reference_value = v;
        patch.reference_time = sample.ts;
        patch.in_alert = 0;
        break;
      }
      const met = percentMet(percentChange(v, ref), watch.percent, watch.direction);
      if (met && !watch.in_alert) {
        event = { kind: 'changed_by_percent', value: v, previous_value: prev, reference_value: ref };
      }
      patch.in_alert = met ? 1 : 0;
      break;
    }
    case 'changes':
      if (watch.last_raw !== null && watch.last_raw !== undefined && sample.raw !== watch.last_raw) {
        event = { kind: 'changed', value: v, previous_value: prev, reference_value: null };
      }
      break;
    default:
      throw new Error(`unknown condition ${watch.cond}`);
  }

  patch.last_value = v;
  patch.last_raw = sample.raw;
  patch.last_eval_sample_id = sample.id;
  patch.window_high = watch.window_high === null || watch.window_high === undefined ? v : Math.max(watch.window_high, v);
  patch.window_low = watch.window_low === null || watch.window_low === undefined ? v : Math.min(watch.window_low, v);
  patch.window_count = (watch.window_count || 0) + 1;
  if (event) patch.trigger_count = (watch.trigger_count || 0) + 1;
  return { event, patch };
}

export function changePercent(value, ref) {
  if (value === null || value === undefined || ref === null || ref === undefined || ref === 0) return null;
  return percentChange(value, ref);
}
