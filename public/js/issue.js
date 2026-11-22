// Issue detail dialog, create-issue dialog, reminder dialog, timer actions
import {
  state, get, post, patch, del, esc, rich, icon, avatar, typeChip, statusPill, prio, opts, fmtDate, fmtDateTime, timeAgo, hrs, pct, todayStr,
  openModal, confirmDialog, toast, errToast, guarded, formValues, bus, nullIfEmpty, progressBar, labels as labelHtml, toLocalInput, loadProjects,
} from './lib.js';

const TYPES = ['task', 'bug', 'story', 'epic', 'subtask'];
const PRIOS = ['critical', 'high', 'medium', 'low'];
const typeOpts = (sel) => TYPES.map((t) => `<option value="${t}"${t === sel ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('');
const prioOpts = (sel) => PRIOS.map((t) => `<option value="${t}"${t === sel ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('');

// ---------- timer ----------
export async function startTimer(issueId) {
  try { const r = await post('/api/timer/start', { issue_id: issueId }); state.timer = r.timer; bus.emit('timer'); toast('Timer started', 'ok', 2000); } catch (e) { errToast(e); }
}
export async function stopTimer() {
  try {
    const r = await post('/api/timer/stop');
    state.timer = null; bus.emit('timer');
    if (r.worklog) toast(`Logged ${hrs(r.worklog.hours)}`, 'ok', 3000);
  } catch (e) { errToast(e); }
}

// ---------- reminder dialog ----------
export function openReminderForm({ issue_id = null, title = '', onSaved } = {}) {
  const def = new Date(Date.now() + 3600000); def.setMinutes(0, 0, 0);
  const m = openModal({
    title: 'New reminder',
    body: `<form class="col" style="gap:12px" id="remf">
      <label class="f">What should we remind you about?<input type="text" name="title" maxlength="200" required value="${esc(title)}"></label>
      <div class="form-grid">
        <label class="f">When<input type="datetime-local" name="remind_at" required value="${toLocalInput(def)}"></label>
        <label class="f">Repeat<select name="repeat"><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
      </div>
      <label class="f">Note (optional)<textarea name="note" maxlength="1000" rows="2"></textarea></label></form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="remsave">Save reminder</button>',
  });
  const save = () => guarded(m.$('#remsave'), async () => {
    const f = m.$('#remf');
    if (!f.reportValidity()) return;
    const v = formValues(f);
    await post('/api/reminders', { title: v.title, note: v.note, repeat: v.repeat, issue_id, remind_at: new Date(v.remind_at).toISOString() });
    m.close(); toast('Reminder saved', 'ok', 2500);
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
    if (onSaved) onSaved();
  });
  m.$('#remsave').addEventListener('click', save);
  m.$('#remf').addEventListener('submit', (e) => { e.preventDefault(); save(); });
}

// ---------- create issue ----------
export async function openCreateIssue({ projectId = null, sprintId = null, columnId = null, parentId = null, type = 'task' } = {}) {
  if (!state.projects.length) await loadProjects();
  const list = state.projects.filter((p) => p.status === 'active' && p.role !== 'viewer');
  if (!list.length) { toast('Create a project first (or ask a manager to add you to one).', 'error'); location.hash = '#/projects'; return; }
  let pid = list.find((p) => p.id === projectId) ? projectId : list[0].id;
  let proj = null;
  const m = openModal({ title: 'Create issue', size: 'mid', body: '<div class="spinner"></div>' });
  async function loadProj() { proj = await get(`/api/projects/${pid}`); draw(); }
  function draw(keep = {}) {
    const sprintOpts = '<option value="">Backlog</option>' + proj.sprints.filter((s) => s.status !== 'completed').map((s) => `<option value="${s.id}"${String(s.id) === String(keep.sprint_id ?? sprintId ?? '') ? ' selected' : ''}>${esc(s.name)}${s.status === 'active' ? ' (active)' : ''}</option>`).join('');
    m.$('.modal-b').innerHTML = `<form id="cf" class="col" style="gap:12px">
      <div class="form-grid">
        <label class="f ${projectId ? 'hidden' : ''}">Project<select name="project" id="cproj">${list.map((p) => `<option value="${p.id}"${p.id === pid ? ' selected' : ''}>${esc(p.name)} (${esc(p.key)})</option>`).join('')}</select></label>
        <label class="f">Type<select name="type">${typeOpts(keep.type || type)}</select></label>
        <label class="f full">Title<input type="text" name="title" maxlength="200" required autofocus placeholder="What needs to be done?" value="${esc(keep.title || '')}"></label>
        <label class="f full">Description<textarea name="description" rows="3" maxlength="20000" placeholder="Add details, acceptance criteria, links...">${esc(keep.description || '')}</textarea></label>
        <label class="f">Priority<select name="priority">${prioOpts(keep.priority || 'medium')}</select></label>
        <label class="f">Assignee<select name="assignee_id"><option value="">Unassigned</option>${opts(proj.assignable, keep.assignee_id ?? (proj.assignable.some((u) => u.id === state.user.id) ? '' : ''))}</select></label>
        <label class="f">Status<select name="column_id">${opts(proj.columns, keep.column_id ?? columnId ?? proj.columns[0].id)}</select></label>
        <label class="f">Sprint<select name="sprint_id">${sprintOpts}</select></label>
        <label class="f">Due date<input type="date" name="due_date" value="${esc(keep.due_date || '')}"></label>
        <label class="f">Estimate (hours)<input type="number" name="estimate_h" min="0" max="10000" step="any" value="${esc(keep.estimate_h || '')}"></label>
        <label class="f full">Labels (comma separated)<input type="text" name="labels" value="${esc(keep.labels || '')}" placeholder="frontend, urgent"></label>
      </div></form>`;
    m.$('.modal-b').insertAdjacentHTML('afterend', `<div class="modal-f" id="cfoot"><label class="check right small"><input type="checkbox" id="another"> Create another</label><button class="btn" data-close>Cancel</button><button class="btn primary" id="csave">Create</button></div>`);
    const old = m.$$('#cfoot'); if (old.length > 1) old[0].remove();
    m.$('input[name=title]').focus();
    m.$('#cproj')?.addEventListener('change', (e) => { pid = Number(e.target.value); loadProj().catch(errToast); });
    m.$('#cf').addEventListener('submit', (e) => { e.preventDefault(); m.$('#csave').click(); });
    m.$('#csave').addEventListener('click', () => guarded(m.$('#csave'), async () => {
      const f = m.$('#cf');
      if (!f.reportValidity()) return;
      const v = formValues(f);
      const body = {
        title: v.title, type: v.type, description: v.description, priority: v.priority,
        assignee_id: nullIfEmpty(v.assignee_id) && Number(v.assignee_id), column_id: Number(v.column_id), sprint_id: nullIfEmpty(v.sprint_id) && Number(v.sprint_id),
        due_date: nullIfEmpty(v.due_date), estimate_h: nullIfEmpty(v.estimate_h) && Number(v.estimate_h), labels: v.labels, parent_id: parentId,
      };
      const issue = await post(`/api/projects/${pid}/issues`, body);
      toast(`Created ${issue.key}`, 'ok', 3500, `#/issue/${issue.id}`);
      if (m.$('#another').checked) { draw({ type: v.type, priority: v.priority, assignee_id: v.assignee_id, column_id: v.column_id, sprint_id: v.sprint_id }); m.$('input[name=title]').focus(); } else m.close();
    }));
  }
  loadProj().catch((e) => { m.close(); errToast(e); });
}

// ---------- issue detail ----------
export async function openIssue(id) {
  let issue, proj, epics = [], tab = 'comments', draft = '', editingDesc = false, gone = false;
  const modal = openModal({ size: 'wide', body: '<div class="spinner"></div>', onClose: () => { gone = true; off(); } });
  const box = modal.box;
  const body = () => box.querySelector('.modal-b');

  const off = bus.on('project-event', (e) => {
    if (gone || !issue || e.project_id !== issue.project_id) return;
    if (e.kind === 'deleted') { modal.close(); return; }
    if (e.issue_id && e.issue_id !== id) return;
    const a = document.activeElement;
    if (editingDesc || (a && box.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    reload();
  });

  async function load() {
    const fresh = await get(`/api/issues/${id}`);
    if (!proj || proj.id !== fresh.project_id) {
      proj = await get(`/api/projects/${fresh.project_id}`);
      epics = (await get(`/api/projects/${proj.id}/issues?type=epic`)).filter((e) => e.id !== id);
    }
    issue = fresh;
  }
  async function reload() {
    try { await load(); if (!gone) render(); } catch (e) { if (!gone) { modal.close(); errToast(e); } }
  }
  const capture = () => { const t = box.querySelector('#cmt'); if (t) draft = t.value; };
  async function save(changes) {
    capture();
    try { await patch(`/api/issues/${id}`, changes); } catch (e) { errToast(e); }
    await reload();
  }

  function render() {
    capture();
    const canEdit = proj.role !== 'viewer';
    const dis = canEdit ? '' : 'disabled';
    const running = state.timer && state.timer.issue_id === issue.id;
    const sprintsOpen = proj.sprints.filter((s) => s.status !== 'completed' || s.id === issue.sprint_id);
    const logged = issue.logged_h, est = issue.estimate_h;
    const remaining = est != null ? Math.max(est - logged, 0) : null;
    const parentOpts = '<option value="">None</option>' + epics.map((e) => `<option value="${e.id}"${e.id === issue.parent_id ? ' selected' : ''}>${esc(e.key)} ${esc(e.title.slice(0, 40))}</option>`).join('')
      + (issue.parent_id && !epics.some((e) => e.id === issue.parent_id) ? `<option value="${issue.parent_id}" selected>${esc(issue.parent_key)} ${esc((issue.parent_title || '').slice(0, 40))}</option>` : '');
    const fld = (l, h) => `<div class="field"><span>${l}</span><div>${h}</div></div>`;

    const comments = issue.comments.map((c) => `<div class="cmt">${avatar(c.user_name, c.user_color)}<div class="body"><div class="meta"><b style="color:var(--text)">${esc(c.user_name || 'Former member')}</b> · ${timeAgo(c.created_at)}
        ${(c.user_id === state.user.id || proj.role === 'manager') ? `<button class="btn ghost sm" data-act="del-comment" data-id="${c.id}" title="Delete comment">${icon('trash')}</button>` : ''}</div>
        <div class="rich">${rich(c.body)}</div></div></div>`).join('') || '<p class="muted">No comments yet.</p>';
    const works = issue.worklogs.map((w) => `<tr><td>${fmtDate(w.date)}</td><td>${esc(w.user_name || 'Former member')}</td><td><b>${hrs(w.hours)}</b></td><td>${esc(w.note || '')}</td>
        <td>${(w.user_id === state.user.id || proj.role === 'manager') ? `<button class="btn ghost sm" data-act="del-work" data-id="${w.id}" title="Delete entry">${icon('trash')}</button>` : ''}</td></tr>`).join('');
    const hist = issue.activity.map((a) => `<div class="small" style="padding:5px 0;border-bottom:1px solid var(--border)"><b>${esc(a.user_name || 'Someone')}</b> ${esc(a.detail || a.action)} <span class="muted">· ${timeAgo(a.created_at)}</span></div>`).join('') || '<p class="muted">No history yet.</p>';
    const subs = issue.children.map((c) => `<div class="irow" data-open-issue="${c.id}">${typeChip(c.type)}<span class="key">${esc(c.key)}</span><span class="title">${esc(c.title)}</span>${statusPill(c.status_name, c.status_category)}${avatar(c.assignee_name, c.assignee_color, 'xs')}</div>`).join('');

    body().innerHTML = `
    <div class="idetail">
      <div class="main-col">
        <div class="row small muted" style="margin-bottom:6px">${typeChip(issue.type)} <b>${esc(issue.key)}</b> <span>in ${esc(issue.project_name)}</span>
          ${issue.parent_id ? `<span>· parent <a href="#/issue/${issue.parent_id}">${esc(issue.parent_key)}</a></span>` : ''}
          ${issue.overdue ? '<span class="pill bad">Overdue</span>' : ''}
          <button class="icon-btn right" data-close aria-label="Close">${icon('x')}</button></div>
        <input type="text" class="title-input" id="ititle" value="${esc(issue.title)}" maxlength="200" ${dis} aria-label="Title">
        <div class="sec-title">Description</div>
        ${editingDesc
    ? `<textarea id="descta" rows="6" maxlength="20000" data-no-esc>${esc(issue.description || '')}</textarea><div class="row" style="margin-top:6px"><button class="btn primary sm" data-act="desc-save">Save</button><button class="btn sm" data-act="desc-cancel">Cancel</button></div>`
    : `<div class="desc rich" ${canEdit ? 'data-act="desc-edit" title="Click to edit"' : ''}>${issue.description ? rich(issue.description) : `<span class="muted">${canEdit ? 'Click to add a description…' : 'No description.'}</span>`}</div>`}
        <div class="sec-title">${issue.type === 'epic' ? 'Issues in this epic' : 'Subtasks'} ${issue.sub_total ? `(${issue.sub_done}/${issue.sub_total})` : ''}</div>
        ${issue.sub_total ? `<div style="margin-bottom:8px">${progressBar(issue.sub_done, issue.sub_total, 'ok')}</div><div class="card" style="margin-bottom:8px">${subs}</div>` : ''}
        ${canEdit ? `<input type="text" id="subadd" placeholder="+ Add a ${issue.type === 'epic' ? 'child issue' : 'subtask'} and press Enter" maxlength="200">` : ''}
        <div class="tabs" style="margin-top:22px">
          <button class="${tab === 'comments' ? 'active' : ''}" data-tab="comments">Comments (${issue.comments.length})</button>
          <button class="${tab === 'time' ? 'active' : ''}" data-tab="time">Time tracking (${hrs(logged)})</button>
          <button class="${tab === 'history' ? 'active' : ''}" data-tab="history">History</button></div>
        ${tab === 'comments' ? `${comments}${canEdit ? `<textarea id="cmt" rows="3" maxlength="5000" placeholder="Write a comment… use @name to mention a teammate (Ctrl+Enter to send)" data-no-esc>${esc(draft)}</textarea><div style="margin-top:6px"><button class="btn primary sm" data-act="add-comment">Comment</button></div>` : ''}` : ''}
        ${tab === 'time' ? `
          <div class="row wrap gap-lg" style="margin-bottom:10px"><div><div class="small muted">Estimated</div><b>${est != null ? hrs(est) : '—'}</b></div><div><div class="small muted">Logged</div><b>${hrs(logged)}</b></div><div><div class="small muted">Remaining</div><b>${remaining != null ? hrs(remaining) : '—'}</b></div></div>
          ${est ? `<div style="margin-bottom:12px">${progressBar(Math.min(logged, est), est, logged > est ? 'bad' : '')}${logged > est ? `<div class="small" style="color:var(--danger)">Over estimate by ${hrs(logged - est)}</div>` : ''}</div>` : ''}
          ${canEdit ? `<form id="wlf" class="row wrap" style="margin-bottom:12px;align-items:flex-end"><label class="f" style="width:100px">Hours<input type="number" name="hours" min="0.01" max="200" step="any" required placeholder="1.5"></label>
            <label class="f" style="width:150px">Date<input type="date" name="date" value="${todayStr()}" required></label><label class="f grow">Note<input type="text" name="note" maxlength="500" placeholder="What did you work on?"></label><button class="btn primary">Log time</button></form>` : ''}
          ${works ? `<table class="t"><thead><tr><th>Date</th><th>Who</th><th>Time</th><th>Note</th><th></th></tr></thead><tbody>${works}</tbody></table>` : '<p class="muted">No time logged yet.</p>'}` : ''}
        ${tab === 'history' ? hist : ''}
      </div>
      <div class="side">
        ${canEdit ? `<div class="row wrap">
          <button class="btn ${running ? 'danger' : ''} sm" data-act="timer">${icon(running ? 'stop' : 'play')} ${running ? 'Stop timer' : 'Start timer'}</button>
          <button class="btn sm" data-act="remind">${icon('bell')} Remind me</button></div>` : ''}
        <div class="card"><div class="card-b col" style="gap:10px">
          ${fld('Status', `<select data-f="column_id" ${dis}>${opts(proj.columns, issue.column_id)}</select>`)}
          ${fld('Assignee', `<select data-f="assignee_id" ${dis}><option value="">Unassigned</option>${opts(proj.assignable, issue.assignee_id)}</select>`)}
          ${fld('Priority', `<select data-f="priority" ${dis}>${prioOpts(issue.priority)}</select>`)}
          ${fld('Type', `<select data-f="type" ${dis}>${typeOpts(issue.type)}</select>`)}
          ${fld('Sprint', `<select data-f="sprint_id" ${dis}><option value="">Backlog</option>${opts(sprintsOpen, issue.sprint_id)}</select>`)}
          ${fld('Parent', `<select data-f="parent_id" ${dis}>${parentOpts}</select>`)}
          ${fld('Estimate (h)', `<input type="number" data-f="estimate_h" min="0" max="10000" step="any" value="${issue.estimate_h ?? ''}" ${dis}>`)}
          ${fld('Start date', `<input type="date" data-f="start_date" value="${esc(issue.start_date || '')}" ${dis}>`)}
          ${fld('Due date', `<input type="date" data-f="due_date" value="${esc(issue.due_date || '')}" ${dis}>`)}
          ${fld('Labels', `<input type="text" data-f="labels" value="${esc(issue.labels.join(', '))}" placeholder="a, b" ${dis}>`)}
        </div></div>
        <div class="small muted">Reporter: ${esc(issue.reporter_name || '—')}<br>Created ${fmtDateTime(issue.created_at)}<br>Updated ${timeAgo(issue.updated_at)}
          ${issue.resolved_at ? `<br>Resolved ${fmtDateTime(issue.resolved_at)}` : ''}</div>
        ${(proj.role === 'manager' || issue.reporter_id === state.user.id) ? `<button class="btn danger sm" data-act="delete">${icon('trash')} Delete issue</button>` : ''}
      </div>
    </div>`;
    if (editingDesc) body().querySelector('#descta').focus();
  }

  // ---- events (delegated, attached once) ----
  box.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { capture(); tab = tabBtn.dataset.tab; render(); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'desc-edit') { editingDesc = true; render(); }
    else if (act === 'desc-cancel') { editingDesc = false; render(); }
    else if (act === 'desc-save') { const v = box.querySelector('#descta').value; editingDesc = false; await save({ description: v }); }
    else if (act === 'add-comment') { await submitComment(el); }
    else if (act === 'del-comment') { await guarded(el, async () => { await del(`/api/comments/${el.dataset.id}`); await reload(); }); }
    else if (act === 'del-work') { await guarded(el, async () => { await del(`/api/worklogs/${el.dataset.id}`); await reload(); }); }
    else if (act === 'timer') { if (state.timer && state.timer.issue_id === issue.id) await stopTimer(); else await startTimer(issue.id); await reload(); }
    else if (act === 'remind') openReminderForm({ issue_id: issue.id, title: `Follow up on ${issue.key}: ${issue.title}`.slice(0, 200) });
    else if (act === 'delete') {
      if (await confirmDialog(`Delete ${issue.key} and its comments and time entries? This cannot be undone.`)) {
        try { await del(`/api/issues/${id}`); modal.close(); toast(`Deleted ${issue.key}`, 'ok'); } catch (err) { errToast(err); }
      }
    }
  });
  async function submitComment(btn) {
    const t = box.querySelector('#cmt');
    if (!t || !t.value.trim()) return;
    await guarded(btn, async () => { await post(`/api/issues/${id}/comments`, { body: t.value }); draft = ''; await reload(); });
  }
  box.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'ititle') { const v = t.value.trim(); if (!v) { t.value = issue.title; return; } if (v !== issue.title) await save({ title: v }); return; }
    const f = t.dataset && t.dataset.f;
    if (!f) return;
    let v = t.value;
    if (['assignee_id', 'sprint_id', 'parent_id'].includes(f)) v = v === '' ? null : Number(v);
    else if (f === 'column_id') v = Number(v);
    else if (f === 'estimate_h') v = v === '' ? null : Number(v);
    else if (f === 'start_date' || f === 'due_date') v = v || null;
    await save({ [f]: v });
  });
  box.addEventListener('keydown', async (e) => {
    if (e.target.id === 'subadd' && e.key === 'Enter') {
      e.preventDefault();
      const title = e.target.value.trim();
      if (!title) return;
      e.target.disabled = true;
      try { await post(`/api/projects/${issue.project_id}/issues`, { title, type: issue.type === 'epic' ? 'task' : 'subtask', parent_id: issue.id, sprint_id: issue.sprint_id }); } catch (err) { errToast(err); }
      await reload();
    } else if (e.target.id === 'cmt' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); submitComment(box.querySelector('[data-act=add-comment]'));
    } else if (e.target.id === 'ititle' && e.key === 'Enter') e.target.blur();
    else if (e.target.id === 'ititle' && e.key === 'Escape') { e.target.value = issue.title; e.target.blur(); e.stopPropagation(); }
  });
  box.addEventListener('submit', async (e) => {
    if (e.target.id !== 'wlf') return;
    e.preventDefault();
    const v = formValues(e.target);
    await guarded(e.target.querySelector('button'), async () => {
      await post(`/api/issues/${id}/worklogs`, { hours: Number(v.hours), date: v.date, note: v.note });
      toast('Time logged', 'ok', 2000);
      await reload();
    });
  });

  await reload();
}
