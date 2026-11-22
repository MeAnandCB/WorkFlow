// Reports: progress, pending work, workload, time tracking, burndown, exports
import { state, get, qs, esc, icon, avatar, opts, issueRow, fmtDate, hrs, pct, todayStr, addDays, on, errToast, lsGet, lsSet, loadProjects, progressBar, prio, typeChip, statusPill, dueLabel } from './lib.js';

const CAT_COLOR = { todo: '#a7b8ad', in_progress: '#2dd4bf', done: '#16a34a' };
const CAT_LABEL = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
const PRIO_COLOR = { critical: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#2563eb' };
const TYPE_COLOR = { task: '#3b82f6', bug: '#ef4444', story: '#22c55e', epic: '#8b5cf6', subtask: '#64748b' };

function barRows(rows, { color = 'var(--primary)', fmt = (v) => v, max } = {}) {
  const m = max ?? Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return '<p class="muted small">No data yet.</p>';
  return `<div class="bars">${rows.map((r) => `<div class="bar-row"><span class="trunc" title="${esc(r.label)}">${esc(r.label)}</span><div class="bar-track"><i style="width:${Math.round((r.value / m) * 100)}%;background:${r.color || color}"></i></div><span class="right small">${fmt(r.value)}</span></div>`).join('')}</div>`;
}

function dayChart(days) {
  const W = 720, H = 190, L = 34, B = 24, T = 10;
  const max = Math.max(1, ...days.map((d) => d.hours));
  const top = Math.ceil(max);
  const bw = (W - L) / days.length;
  const bars = days.map((d, i) => {
    const h = ((H - B - T) * d.hours) / top;
    return `<rect x="${(L + i * bw + bw * 0.15).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="2" style="fill:var(--primary)"><title>${fmtDate(d.date)}: ${hrs(d.hours)}</title></rect>`;
  }).join('');
  const every = Math.ceil(days.length / 10);
  const labels = days.map((d, i) => (i % every === 0 ? `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${fmtDate(d.date).replace(/, \d{4}/, '')}</text>` : '')).join('');
  const grid = [0, 0.5, 1].map((f) => { const y = H - B - (H - B - T) * f; return `<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" style="stroke:var(--border)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${Math.round(top * f * 10) / 10}</text>`; }).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hours logged per day">${grid}${bars}${labels}</svg></div>`;
}

function burndownChart(b) {
  const W = 720, H = 220, L = 34, B = 26, T = 10, pts = b.points;
  const max = Math.max(1, b.total);
  const x = (i) => L + ((W - L - 10) * i) / Math.max(1, pts.length - 1);
  const y = (v) => H - B - ((H - B - T) * v) / max;
  const ideal = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.ideal).toFixed(1)}`).join(' ');
  const actualPts = pts.map((p, i) => (p.remaining == null ? null : [x(i), y(p.remaining), p])).filter(Boolean);
  const actual = actualPts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const every = Math.ceil(pts.length / 8);
  const labels = pts.map((p, i) => (i % every === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtDate(p.date).replace(/, \d{4}/, '')}</text>` : '')).join('');
  const grid = [0, 0.5, 1].map((f) => { const yy = y(max * f); return `<line x1="${L}" x2="${W}" y1="${yy}" y2="${yy}" style="stroke:var(--border)"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${Math.round(max * f * 10) / 10}</text>`; }).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sprint burndown">${grid}${labels}
    <polyline points="${ideal}" fill="none" style="stroke:var(--muted)" stroke-width="2" stroke-dasharray="5 4"/>
    <polyline points="${actual}" fill="none" style="stroke:var(--primary)" stroke-width="2.5"/>
    ${actualPts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" style="fill:var(--primary)"><title>${fmtDate(p[2].date)}: ${p[2].remaining} issues left (${hrs(p[2].remaining_h)} estimated)</title></circle>`).join('')}</svg>
    <div class="legend"><span><i style="background:var(--muted)"></i>Ideal</span><span><i style="background:var(--primary)"></i>Remaining issues</span></div></div>`;
}

function velocityChart(v) {
  const max = Math.max(1, ...v.map((s) => Math.max(s.committed || 0, s.completed)));
  return `<div class="bars">${v.map((s) => `<div class="bar-row" style="grid-template-columns:110px 1fr 70px"><span class="trunc">${esc(s.name)}</span><div class="bar-track" title="Committed ${s.committed ?? '?'}, completed ${s.completed}"><i style="width:${(s.completed / max) * 100}%;background:var(--ok)"></i></div><span class="right small">${s.completed}/${s.committed ?? '?'}</span></div>`).join('')}</div>`;
}

export async function reportsPage(view) {
  view.innerHTML = '<div class="page-head"><h1>Reports</h1><span class="sub">Progress, workload and time across your projects</span></div><div id="rep"></div>';
  return renderReports(view.querySelector('#rep'), { project: null, standalone: true });
}

export async function renderReports(host, { project = null, standalone = false } = {}) {
  await loadProjects();
  const to = todayStr();
  const f = { project: project || '', from: addDays(to, -29), to };
  host.innerHTML = '<div id="rf"></div><div id="rb"><div class="spinner"></div></div>';
  const rf = host.querySelector('#rf'), rb = host.querySelector('#rb');

  const drawFilters = () => {
    rf.innerHTML = `<div class="filters">
      ${standalone ? `<select data-r="project"><option value="">All my projects</option>${opts(state.projects, f.project)}</select>` : ''}
      <span class="muted small">Time range</span>
      <input type="date" data-r="from" value="${f.from}" max="${f.to}"><span class="muted">–</span><input type="date" data-r="to" value="${f.to}" max="${to}">
      <button class="btn sm" data-range="7">7 days</button><button class="btn sm" data-range="30">30 days</button><button class="btn sm" data-range="90">90 days</button>
      <span class="right row"><a class="btn sm" id="csv1" href="#">${icon('download')} Timesheet CSV</a><a class="btn sm" id="csv2" href="#">${icon('download')} Issues CSV</a></span></div>`;
    const q = { project: f.project, from: f.from, to: f.to };
    rf.querySelector('#csv1').href = '/api/reports/timesheet.csv' + qs(q);
    rf.querySelector('#csv2').href = '/api/reports/issues.csv' + qs({ project: f.project });
  };
  on(rf, 'change', '[data-r]', (el) => {
    f[el.dataset.r] = el.value;
    if (!f.from || !f.to) return;
    if (f.from > f.to) { if (el.dataset.r === 'from') f.to = f.from; else f.from = f.to; }
    drawFilters(); load();
  });
  on(rf, 'click', '[data-range]', (el) => { f.to = to; f.from = addDays(to, -(Number(el.dataset.range) - 1)); drawFilters(); load(); });

  async function load() {
    try {
      const [r, ts] = await Promise.all([get('/api/reports/summary' + qs(f)), get('/api/reports/timesheet' + qs(f))]);
      draw(r, ts);
    } catch (e) { rb.innerHTML = ''; errToast(e); }
  }

  function draw(r, ts) {
    const t = r.totals;
    const kpi = (v, l, cls = '') => `<div class="card stat ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    const cats = ['done', 'in_progress', 'todo'].map((c) => ({ c, n: (r.by_category.find((x) => x.name === c) || { count: 0 }).count }));
    const timeTotal = r.time_by_user.reduce((a, u) => a + u.hours, 0);
    const maxUser = Math.max(1, ...r.time_by_user.map((u) => u.hours));
    rb.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px">
      ${kpi(t.total, 'Total issues')}${kpi(`${t.done} <span class="small muted">(${t.completion}%)</span>`, 'Completed', 'good')}${kpi(t.open, 'Pending (open)')}${kpi(t.overdue, 'Overdue', t.overdue ? 'bad' : '')}
      ${kpi(t.unassigned, 'Open & unassigned')}${kpi(hrs(t.estimate_h), 'Total estimated')}${kpi(hrs(t.logged_h), 'Total time logged')}${kpi(hrs(t.remaining_h), 'Estimated remaining')}</div>

    <div class="grid g2" style="margin-bottom:16px">
      <div class="card"><div class="card-h">Overall progress</div><div class="card-b col">
        <div class="stack">${cats.map((c) => (t.total ? `<i style="width:${pct(c.n, t.total)}%;background:${CAT_COLOR[c.c]}" title="${CAT_LABEL[c.c]}: ${c.n}"></i>` : '')).join('')}</div>
        <div class="legend">${cats.map((c) => `<span><i style="background:${CAT_COLOR[c.c]}"></i>${CAT_LABEL[c.c]} ${c.n}</span>`).join('')}</div>
        ${r.by_column.length ? barRows(r.by_column.map((c) => ({ label: c.name, value: c.count, color: CAT_COLOR[c.category] })), {}) : ''}
        ${!f.project ? `<div class="sec-title" style="margin:8px 0 0">By project</div><div class="col">${r.by_project.map((p) => `<div><div class="row small"><a href="#/p/${p.id}/board"><b>${esc(p.key)}</b> ${esc(p.name)}</a><span class="right muted">${p.done}/${p.total} · ${hrs(p.logged_h)} logged${p.overdue ? ` · <span style="color:var(--danger)">${p.overdue} overdue</span>` : ''}</span></div>${progressBar(p.done, p.total, p.total && p.done === p.total ? 'ok' : '')}</div>`).join('') || '<p class="muted small">No projects.</p>'}</div>` : ''}</div></div>
      <div class="card"><div class="card-h">Workload by person</div><div class="scroll-x"><table class="t"><thead><tr><th>Person</th><th>Open</th><th>Done</th><th>Overdue</th><th>Est.</th><th>Logged</th></tr></thead><tbody>
        ${r.by_assignee.map((a) => `<tr><td><span class="row">${a.id ? avatar(a.name, a.color, 'xs') : ''} ${esc(a.name)}</span></td><td><b>${a.open}</b></td><td>${a.done}</td><td style="${a.overdue ? 'color:var(--danger);font-weight:600' : ''}">${a.overdue}</td><td>${hrs(a.estimate_h)}</td><td>${hrs(a.logged_h)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No issues yet.</td></tr>'}</tbody></table></div></div></div>

    <div class="grid g-main" style="margin-bottom:16px">
      <div class="card"><div class="card-h">Time logged per day <span class="muted small right" style="font-weight:400">${fmtDate(r.range.from)} – ${fmtDate(r.range.to)} · total ${hrs(timeTotal)}</span></div><div class="card-b">${timeTotal ? dayChart(r.time_by_day) : '<p class="muted">No time logged in this period. Use “Start timer” or “Log time” on an issue.</p>'}</div></div>
      <div class="card"><div class="card-h">Time by person</div><div class="card-b">${barRows(r.time_by_user.map((u) => ({ label: u.name, value: u.hours, color: u.color || 'var(--primary)' })), { fmt: hrs, max: maxUser })}
        ${!f.project && r.time_by_project.length ? `<div class="sec-title">By project</div>${barRows(r.time_by_project.map((p) => ({ label: p.key + ' ' + p.name, value: p.hours })), { fmt: hrs })}` : ''}</div></div></div>

    <div class="grid g2" style="margin-bottom:16px">
      <div class="card"><div class="card-h">Priority breakdown</div><div class="card-b">${barRows(['critical', 'high', 'medium', 'low'].map((p) => { const x = r.by_priority.find((y) => y.name === p) || { count: 0, open: 0 }; return { label: p, value: x.count, color: PRIO_COLOR[p], extra: x.open }; }), { fmt: (v) => v })}</div></div>
      <div class="card"><div class="card-h">Issue types</div><div class="card-b">${barRows(['task', 'bug', 'story', 'epic', 'subtask'].map((p) => { const x = r.by_type.find((y) => y.name === p) || { count: 0 }; return { label: p, value: x.count, color: TYPE_COLOR[p] }; }), {})}</div></div></div>

    ${f.project ? `<div class="grid g2" style="margin-bottom:16px">
      <div class="card"><div class="card-h">Sprint burndown ${r.burndown ? `<span class="muted small" style="font-weight:400">${esc(r.burndown.sprint.name)}</span>` : ''}</div><div class="card-b">${r.burndown ? burndownChart(r.burndown) : '<p class="muted">Start a sprint with start and end dates in <b>Backlog &amp; sprints</b> to see its burndown.</p>'}</div></div>
      <div class="card"><div class="card-h">Sprint velocity <span class="muted small right" style="font-weight:400">completed / committed</span></div><div class="card-b">${r.velocity.length ? velocityChart(r.velocity) : '<p class="muted">Complete a sprint to see velocity.</p>'}</div></div></div>` : ''}

    <div class="card" style="margin-bottom:16px"><div class="card-h" style="color:${r.overdue.length ? 'var(--danger)' : 'inherit'}">Overdue work (${r.overdue.length})</div>${issueList(r.overdue)}</div>
    <div class="card" style="margin-bottom:16px"><div class="card-h">Pending work (${t.open})${t.open > 100 ? ' <span class="muted small" style="font-weight:400">showing first 100</span>' : ''}</div>${issueList(r.pending)}</div>

    <div class="card"><div class="card-h">Timesheet <span class="muted small right" style="font-weight:400">${ts.length} entries · ${hrs(ts.reduce((a, x) => a + x.hours, 0))}</span></div><div class="scroll-x"><table class="t"><thead><tr><th>Date</th><th>Person</th><th>Issue</th><th>Hours</th><th>Note</th></tr></thead><tbody>
      ${ts.slice(0, 200).map((x) => `<tr><td class="nowrap">${fmtDate(x.date)}</td><td>${esc(x.user)}</td><td><span class="key">${esc(x.issue)}</span> ${esc(x.title)}</td><td><b>${hrs(x.hours)}</b></td><td class="muted">${esc(x.note || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No time entries in this period.</td></tr>'}</tbody></table></div>${ts.length > 200 ? '<div class="card-b muted small">Showing the latest 200 entries. Export CSV for the full list.</div>' : ''}</div>`;
  }
  const issueList = (rows) => (rows.length ? rows.map((i) => `<div class="irow" data-open-issue="${i.id}">${typeChip(i.type)}<span class="key">${esc(i.key)}</span><span class="title">${esc(i.title)}</span>${statusPill(i.status, i.category)}<span class="hide-sm">${prio(i.priority)}</span>${dueLabel({ due_date: i.due_date, status_category: i.category })}<span class="small muted nowrap" style="width:110px;text-align:right">${esc(i.assignee || 'Unassigned')}</span></div>`).join('') : '<div class="empty small">Nothing here 🎉</div>');

  drawFilters();
  await load();
  return { refresh: () => load() };
}
