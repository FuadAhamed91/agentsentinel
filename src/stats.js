// Plain HTML stats page for the operator. No styling on purpose.

function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function row(k, v) {
  return `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)}</td></tr>`;
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : '-');

export function renderStats({ stats, sources, sampler, diagnostics, now }) {
  const main = [
    row('Active watches', stats.active_watches),
    row('Active watches by type', stats.active_by_type),
    row('Checks today (UTC, one per watch per check)', stats.checks_today),
    row('Check requests today (paid /check calls)', stats.check_requests_today),
    row('Distinct tokens checked today', stats.distinct_tokens_checked_today),
    row('Distinct tokens ever checked', stats.distinct_tokens_ever_checked),
    row('Watches created today (paid /watch calls)', stats.watches_created_today),
    row('Watches created total', stats.watches_created_total),
    row('Triggers recorded today', stats.triggers_today),
    row('Samples stored', stats.samples_stored),
  ].join('');

  const src = Object.entries(sources)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, s]) => row(k, `ok ${iso(s.last_ok_at)} via ${s.origin || '-'}${s.last_failed ? ` | FAILING since ${iso(s.last_error_at)}: ${s.last_error}` : ''}`))
    .join('');

  const diag = Object.entries(diagnostics).map(([k, v]) => row(k, v)).join('');
  const samp = [
    row('rounds completed', sampler.ticks),
    row('last round', iso(sampler.last_tick_at)),
    row('last round duration ms', sampler.last_tick_ms),
    row('external fetch calls by type', sampler.fetch_calls),
    row('rounds skipped (another instance holds the sampler lease)', sampler.skipped_not_leader),
  ].join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>AgentSentinel stats</title></head><body>
<h1>AgentSentinel stats</h1>
<p>${esc(new Date(now).toISOString())}</p>
<table border="1" cellpadding="4">${main}</table>
<h2>Sources</h2><table border="1" cellpadding="4">${src || row('none yet', '-')}</table>
<h2>Sampler</h2><table border="1" cellpadding="4">${samp}</table>
<h2>Gateway</h2><table border="1" cellpadding="4">${diag}</table>
</body></html>`;
}
