// Projects list + project workspace (board, backlog/sprints, list, reports, activity, settings)
import {
  state, get, post, patch, del, qs, esc, icon, avatar, typeChip, statusPill, prio, dueLabel, opts, issueRow, labels as labelHtml, progressBar,
  fmtDate, hrs, pct, timeAgo, openModal, confirmDialog, toast, errToast, guarded, formValues, on, debounce, nullIfEmpty, loadProjects, loadUsers, bus, lsGet, lsSet, todayStr, addDays,
} from './lib.js';
import { openCreateIssue, openIssue } from './issue.js';
import { renderReports } from './reports.js';

const TABS = [['board', 'Board'], ['backlog', 'Backlog & sprints'], ['list', 'All issues'], ['reports', 'Reports'], ['activity', 'Activity'], ['settings', 'Team & settings']];

// =============== projects list ===============
export async function projectsPage(view) {
  async function draw() {
    await loadProjects();
    const showArchived = lsGet('showArchived') === '1';
    const list = state.projects.filter((p) => showArchived || p.status === 'active');
    view.innerHTML = `<div class="page-head"><h1>Projects</h1><span class="sub">${list.length} project${list.length === 1 ? '' : 's'}</span>
      <label class="check small right"><input type="checkbox" id="arch" ${showArchived ? 'checked' : ''}> Show archived</label>
      <button class="btn primary" data-act="new">${icon('plus')} New project</button></div>
      ${list.length ? `<div class="grid g3">${list.map(card).join('')}</div>` : `<div class="card empty"><h3>No projects yet</h3><p>Create your first project to start planning work.</p><button class="btn primary" data-act="new">${icon('plus')} Create project</button></div>`}`;
  }
  const card = (p) => `<a class="card card-b col" style="color:inherit;text-decoration:none;gap:10px" href="#/p/${p.id}/board">
      <div class="row"><span class="pkey">${esc(p.key)}</span><h2 class="trunc grow">${esc(p.name)}</h2>${p.status === 'archived' ? '<span class="pill">Archived</span>' : ''}</div>
      <div class="muted small" style="min-height:36px;overflow:hidden">${esc((p.description || 'No description').slice(0, 110))}</div>
      ${progressBar(p.done, p.total, p.total && p.done === p.total ? 'ok' : '')}
      <div class="row small muted"><span>${p.done}/${p.total} done (${pct(p.done, p.total)}%)</span>${p.overdue ? `<span class="pill bad">${p.overdue} overdue</span>` : ''}<span class="right">${hrs(p.logged_h)} logged</span></div>
      <div class="row small muted"><span>${icon('users').replace('class="ic"', 'class="ic" style="width:14px;height:14px"')} ${p.member_count}</span><span class="right">${esc(p.role)}</span></div></a>`;
  on(view, 'click', '[data-act=new]', () => openNewProject(async (id) => { location.hash = `#/p/${id}/board`; }));
  on(view, 'change', '#arch', (el) => { lsSet('showArchived', el.checked ? '1' : '0'); draw(); });
  await draw();
  return { onProject: (e) => { if (e.kind === 'project' || e.kind === 'deleted') draw(); } };
}

export async function openNewProject(done) {
  await loadUsers();
  const others = state.users.filter((u) => u.active && u.id !== state.user.id);
  const m = openModal({
    title: 'New project', size: 'mid',
    body: `<form id="pf" class="col" style="gap:12px"><div class="form-grid">
      <label class="f">Project name<input type="text" name="name" maxlength="100" required autofocus placeholder="Website redesign"></label>
      <label class="f">Key (used in issue ids)<input type="text" name="key" maxlength="10" required pattern="[A-Za-z][A-Za-z0-9]{1,9}" placeholder="WEB" style="text-transform:uppercase"></label>
      <label class="f full">Description<textarea name="description" rows="2" maxlength="5000"></textarea></label>
      <label class="f">Start date<input type="date" name="start_date"></label><label class="f">Target end date<input type="date" name="end_date"></label></div>
      ${others.length ? `<div><div class="sec-title" style="margin-top:4px">Team members</div><div class="col" style="max-height:170px;overflow:auto;gap:6px">${others.map((u) => `<div class="row">
        <label class="check grow"><input type="checkbox" name="m_${u.id}"> ${avatar(u.name, u.color, 'xs')} ${esc(u.name)}</label>
        <select name="r_${u.id}" style="width:110px"><option value="member">Member</option><option value="manager">Manager</option><option value="viewer">Viewer</option></select></div>`).join('')}</div></div>` : '<p class="muted small">You can add teammates later from the project settings. Ask an administrator to create user accounts in Team.</p>'}
    </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="psave">Create project</button>',
  });
  const nameEl = m.$('[name=name]'), keyEl = m.$('[name=key]');
  let keyTouched = false;
  keyEl.addEventListener('input', () => { keyTouched = true; });
  nameEl.addEventListener('input', () => {
    if (!keyTouched) keyEl.value = nameEl.value.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 4).toUpperCase() || '';
  });
  const submit = () => guarded(m.$('#psave'), async () => {
    const f = m.$('#pf');
    if (!f.reportValidity()) return;
    const v = formValues(f);
    const members = others.filter((u) => v['m_' + u.id]).map((u) => ({ user_id: u.id, role: v['r_' + u.id] }));
    const p = await post('/api/projects', { name: v.name, key: v.key, description: v.description, start_date: nullIfEmpty(v.start_date), end_date: nullIfEmpty(v.end_date), members });
    m.close(); toast(`Project ${p.name} created`, 'ok');
    await loadProjects();
    if (done) done(p.id);
  });
  m.$('#psave').addEventListener('click', submit);
  m.$('#pf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

// =============== project workspace ===============
export async function projectPage(view, { id, tab = 'board' }) {
  const pid = Number(id);
  let proj;
  try { proj = await get(`/api/projects/${pid}`); } catch (e) { view.innerHTML = `<div class="card empty"><h3>Project not found</h3><p>${esc(e.message)}</p><a class="btn" href="#/projects">Back to projects</a></div>`; return; }
  if (!TABS.some(([k]) => k === tab)) tab = 'board';
  const canEdit = proj.role !== 'viewer';
  const canManage = proj.role === 'manager';

  view.innerHTML = `<div class="page-head"><span class="pkey" style="font-size:12px">${esc(proj.key)}</span><h1>${esc(proj.name)}</h1>
      ${proj.status === 'archived' ? '<span class="pill warn">Archived</span>' : ''}<span class="pill">${esc(proj.role)}</span>
      <span class="right row">${proj.channel_id ? `<a class="btn" href="#/chat/${proj.channel_id}">${icon('chat')} Team chat</a>` : ''}
      ${canEdit && proj.status === 'active' ? `<button class="btn primary" data-act="create">${icon('plus')} Create issue</button>` : ''}</span></div>
    <div class="tabs">${TABS.map(([k, l]) => `<a href="#/p/${pid}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    <div id="ptab"><div class="spinner"></div></div>`;
  const host = view.querySelector('#ptab');
  on(view, 'click', '[data-act=create]', () => openCreateIssue({ projectId: pid }));

  const ctx = { pid, proj, canEdit, canManage, host, view };
  const tabs = { board: boardTab, backlog: backlogTab, list: listTab, reports: reportsTab, activity: activityTab, settings: settingsTab };
  const handler = await tabs[tab](ctx);
  return {
    onProject: (e) => {
      if (e.project_id !== pid) return;
      if (e.kind === 'deleted') { toast('This project was deleted or you no longer have access.', 'error'); location.hash = '#/projects'; return; }
      handler && handler.refresh && handler.refresh(e);
    },
    destroy: () => handler && handler.destroy && handler.destroy(),
  };
}

// shared filter UI
function filterBar(ctx, f, { sprint = false } = {}) {
  const { proj } = ctx;
  return `<div class="filters">
    <input type="search" data-flt="q" placeholder="Search issues…" value="${esc(f.q || '')}">
    <select data-flt="assignee"><option value="">All assignees</option><option value="me"${f.assignee === 'me' ? ' selected' : ''}>Assigned to me</option><option value="none"${f.assignee === 'none' ? ' selected' : ''}>Unassigned</option>${opts(proj.assignable, f.assignee)}</select>
    <select data-flt="type"><option value="">All types</option>${['task', 'bug', 'story', 'epic', 'subtask'].map((t) => `<option value="${t}"${f.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
    <select data-flt="priority"><option value="">All priorities</option>${['critical', 'high', 'medium', 'low'].map((t) => `<option value="${t}"${f.priority === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
    ${sprint ? `<select data-flt="sprint"><option value="active"${f.sprint === 'active' ? ' selected' : ''}>Active sprint</option><option value=""${f.sprint === '' ? ' selected' : ''}>All issues</option><option value="backlog"${f.sprint === 'backlog' ? ' selected' : ''}>Backlog only</option>${proj.sprints.map((s) => `<option value="${s.id}"${String(f.sprint) === String(s.id) ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
    <button class="btn ghost sm" data-flt-clear>Clear</button></div>`;
}
function bindFilters(root, f, onChange) {
  const apply = debounce(() => onChange(), 250);
  root.addEventListener('input', (e) => { const k = e.target.dataset && e.target.dataset.flt; if (k === 'q') { f.q = e.target.value; apply(); } });
  root.addEventListener('change', (e) => { const k = e.target.dataset && e.target.dataset.flt; if (k && k !== 'q') { f[k] = e.target.value; onChange(); } });
  root.addEventListener('click', (e) => { if (e.target.closest('[data-flt-clear]')) { for (const k of Object.keys(f)) f[k] = k === 'sprint' ? '' : ''; onChange(true); } });
}

// ---------------- board ----------------
async function boardTab(ctx) {
  const { pid, proj, host, canEdit } = ctx;
  const hasActive = proj.sprints.some((s) => s.status === 'active');
  const f = { q: '', assignee: '', type: '', priority: '', sprint: hasActive ? 'active' : '' };
  let issues = [], dragging = false, pending = false;
  host.innerHTML = `<div id="bf"></div><div id="bd"></div>`;
  const bf = host.querySelector('#bf'), bd = host.querySelector('#bd');
  const active = proj.sprints.find((s) => s.status === 'active');
  const redrawFilters = () => { bf.innerHTML = filterBar(ctx, f, { sprint: true }); };

  async function load() {
    issues = await get(`/api/projects/${pid}/issues${qs({ q: f.q, assignee: f.assignee, type: f.type, priority: f.priority, sprint: f.sprint })}`);
    drawBoard();
  }
  function card(i) {
    const subs = i.sub_total ? `<span class="small muted" title="Subtasks done">${icon('check').replace('class="ic"', 'class="ic" style="width:12px;height:12px"')} ${i.sub_done}/${i.sub_total}</span>` : '';
    const time = i.estimate_h || i.logged_h ? `<span class="small muted" title="Logged / estimate">${icon('clock').replace('class="ic"', 'class="ic" style="width:12px;height:12px"')} ${hrs(i.logged_h)}${i.estimate_h ? ' / ' + hrs(i.estimate_h) : ''}</span>` : '';
    return `<div class="bcard" draggable="${canEdit}" data-id="${i.id}" data-open-issue="${i.id}">
      <div class="t">${esc(i.title)}</div>${i.labels.length ? `<div>${labelHtml(i.labels)}</div>` : ''}
      <div class="row wrap">${typeChip(i.type)}<span class="key">${esc(i.key)}</span>${prio(i.priority)}${subs}${time}<span class="right row">${dueLabel(i)}${avatar(i.assignee_name, i.assignee_color)}</span></div></div>`;
  }
  function drawBoard() {
    const scroll = bd.querySelector('.board');
    const left = scroll ? scroll.scrollLeft : 0;
    const by = new Map(proj.columns.map((c) => [c.id, []]));
    for (const i of issues) if (by.has(i.column_id)) by.get(i.column_id).push(i);
    const banner = active && f.sprint === 'active' ? `<div class="card card-b row" style="margin-bottom:12px"><b>${esc(active.name)}</b><span class="muted small">${fmtDate(active.start_date)} – ${fmtDate(active.end_date)}</span>${active.goal ? `<span class="muted small trunc">Goal: ${esc(active.goal)}</span>` : ''}<a class="btn sm right" href="#/p/${pid}/backlog">Manage sprint</a></div>` : '';
    bd.innerHTML = `${banner}<div class="board">${proj.columns.map((c) => `<div class="bcol" data-col="${c.id}"><div class="bcol-h"><span class="pill ${c.category}" style="padding:0 7px">●</span> ${esc(c.name)} <span class="count">${by.get(c.id).length}</span>
      ${canEdit && proj.status === 'active' ? `<button class="icon-btn right" style="padding:2px" data-add-col="${c.id}" title="Add issue here">${icon('plus')}</button>` : ''}</div>
      <div class="bcol-b" data-col-body="${c.id}">${by.get(c.id).map(card).join('') || '<div class="empty small" style="padding:14px 4px">No issues</div>'}</div></div>`).join('')}</div>`;
    const nb = bd.querySelector('.board');
    if (nb) nb.scrollLeft = left;
  }
  on(bd, 'click', '[data-add-col]', (el, e) => { e.stopPropagation(); openCreateIssue({ projectId: pid, columnId: Number(el.dataset.addCol), sprintId: active && f.sprint === 'active' ? active.id : null }); });

  // drag & drop
  let dragId = null, line = null;
  const clearLine = () => { if (line) { line.remove(); line = null; } bd.querySelectorAll('.bcol.over').forEach((c) => c.classList.remove('over')); };
  bd.addEventListener('dragstart', (e) => {
    const c = e.target.closest && e.target.closest('.bcard');
    if (!c) return;
    dragId = Number(c.dataset.id); dragging = true; c.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragId));
  });
  bd.addEventListener('dragend', () => { dragging = false; dragId = null; clearLine(); bd.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging')); if (pending) { pending = false; load().catch(errToast); } });
  function beforeCard(body, y) {
    const cards = [...body.querySelectorAll('.bcard:not(.dragging)')];
    return cards.find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
  }
  bd.addEventListener('dragover', (e) => {
    const body = e.target.closest && e.target.closest('[data-col-body]');
    if (!body || dragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    body.closest('.bcol').classList.add('over');
    if (!line) { line = document.createElement('div'); line.className = 'drop-line'; }
    const before = beforeCard(body, e.clientY);
    body.querySelector('.empty')?.remove();
    if (before) body.insertBefore(line, before); else body.appendChild(line);
  });
  bd.addEventListener('dragleave', (e) => { const col = e.target.closest && e.target.closest('.bcol'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('over'); });
  bd.addEventListener('drop', async (e) => {
    const body = e.target.closest && e.target.closest('[data-col-body]');
    if (!body || dragId == null) return;
    e.preventDefault();
    const before = beforeCard(body, e.clientY);
    const colId = Number(body.dataset.colBody), moving = dragId;
    clearLine();
    try { await patch(`/api/issues/${moving}`, { column_id: colId, before_id: before ? Number(before.dataset.id) : null }); } catch (err) { errToast(err); }
    dragging = false; pending = false;
    await load().catch(errToast);
  });

  bindFilters(bf, f, (clear) => { if (clear) { f.sprint = hasActive ? 'active' : ''; redrawFilters(); } load().catch(errToast); });
  redrawFilters();
  await load();
  return { refresh: () => { if (dragging) pending = true; else load().catch(() => {}); } };
}

// ---------------- backlog & sprints ----------------
async function backlogTab(ctx) {
  const { pid, proj, host, canEdit, canManage } = ctx;
  let issues = [], sprints = proj.sprints, f = { q: '', assignee: '', type: '', priority: '' }, dragId = null;
  host.innerHTML = '<div id="bf"></div><div id="bl"></div>';
  const bf = host.querySelector('#bf'), bl = host.querySelector('#bl');
  const redrawFilters = () => { bf.innerHTML = filterBar(ctx, f); };

  async function load() {
    const [p, list] = await Promise.all([get(`/api/projects/${pid}`), get(`/api/projects/${pid}/issues${qs(f)}`)]);
    sprints = p.sprints; ctx.proj.sprints = p.sprints; ctx.proj.columns = p.columns; issues = list; draw();
  }
  const sec = (s, list) => {
    const isBacklog = !s;
    const est = list.reduce((a, i) => a + (i.estimate_h || 0), 0), done = list.filter((i) => i.status_category === 'done').length;
    return `<div class="card sprint-box" data-drop-sprint="${s ? s.id : ''}">
      <div class="card-h"><span>${isBacklog ? 'Backlog' : esc(s.name)}</span>${s && s.status === 'active' ? '<span class="pill in_progress">Active</span>' : s ? '<span class="pill">Planned</span>' : ''}
        <span class="muted small" style="font-weight:400">${list.length} issue${list.length === 1 ? '' : 's'}${est ? ` · ${hrs(est)} est.` : ''}${s ? ` · ${done} done` : ''}${s && s.start_date ? ` · ${fmtDate(s.start_date)} – ${fmtDate(s.end_date)}` : ''}</span>
        <span class="right row">${s && canEdit ? `${s.status === 'planned' ? `<button class="btn sm" data-sp="start" data-id="${s.id}">Start sprint</button>` : ''}${s.status === 'active' ? `<button class="btn sm primary" data-sp="complete" data-id="${s.id}">Complete sprint</button>` : ''}<button class="btn sm ghost" data-sp="edit" data-id="${s.id}">Edit</button>${canManage && s.status !== 'active' ? `<button class="btn sm ghost danger" data-sp="delete" data-id="${s.id}">${icon('trash')}</button>` : ''}` : ''}</span></div>
      ${s && s.goal ? `<div class="card-b small muted" style="padding:6px 16px">Goal: ${esc(s.goal)}</div>` : ''}
      <div data-sprint-list>${list.map((i) => issueRowDrag(i)).join('') || `<div class="empty small" style="padding:18px">${isBacklog ? 'Backlog is empty.' : 'Plan your sprint by dragging issues here.'}</div>`}</div>
      ${canEdit && proj.status === 'active' ? `<div class="quick-add"><input type="text" data-quick="${s ? s.id : ''}" maxlength="200" placeholder="+ Create issue and press Enter"></div>` : ''}</div>`;
  };
  const issueRowDrag = (i) => issueRow(i).replace('class="irow"', `class="irow" draggable="${canEdit}" data-drag="${i.id}"`);
  function draw() {
    const open = issues.filter((i) => i.status_category !== 'done' || i.sprint_id);
    const inSprint = (id) => open.filter((i) => i.sprint_id === id);
    const act = sprints.filter((s) => s.status === 'active'), planned = sprints.filter((s) => s.status === 'planned'), completed = sprints.filter((s) => s.status === 'completed');
    bl.innerHTML = `${canEdit ? `<div class="row" style="margin-bottom:12px"><button class="btn" data-sp="new">${icon('plus')} Create sprint</button></div>` : ''}
      ${[...act, ...planned].map((s) => sec(s, inSprint(s.id))).join('')}
      ${sec(null, issues.filter((i) => !i.sprint_id && i.status_category !== 'done'))}
      ${completed.length ? `<div class="sec-title">Completed sprints</div><div class="card">${completed.map((s) => `<div class="irow" style="cursor:default"><b>${esc(s.name)}</b><span class="muted small">${fmtDate(s.start_date)} – ${fmtDate(s.end_date)}</span><span class="small right">${s.issue_count} issues · committed ${s.committed ?? '—'}</span>${canManage ? `<button class="btn ghost sm danger" data-sp="delete" data-id="${s.id}">${icon('trash')}</button>` : ''}</div>`).join('')}</div>` : ''}`;
  }

  async function sprintForm(s) {
    const m = openModal({
      title: s ? 'Edit sprint' : 'New sprint',
      body: `<form id="sf" class="col" style="gap:12px"><label class="f">Name<input type="text" name="name" maxlength="80" value="${esc(s ? s.name : `Sprint ${sprints.length + 1}`)}" required></label>
        <label class="f">Goal<textarea name="goal" rows="2" maxlength="500">${esc(s ? s.goal || '' : '')}</textarea></label>
        <div class="form-grid"><label class="f">Start<input type="date" name="start_date" value="${esc(s ? s.start_date || '' : '')}"></label><label class="f">End<input type="date" name="end_date" value="${esc(s ? s.end_date || '' : '')}"></label></div></form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ssave">Save</button>',
    });
    const submit = () => guarded(m.$('#ssave'), async () => {
      const v = formValues(m.$('#sf'));
      const body = { name: v.name, goal: v.goal, start_date: nullIfEmpty(v.start_date), end_date: nullIfEmpty(v.end_date) };
      if (s) await patch(`/api/sprints/${s.id}`, body); else await post(`/api/projects/${pid}/sprints`, body);
      m.close(); await load();
    });
    m.$('#ssave').addEventListener('click', submit);
    m.$('#sf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }
  async function completeSprint(s) {
    const planned = sprints.filter((x) => x.status === 'planned');
    const unfinished = issues.filter((i) => i.sprint_id === s.id && i.status_category !== 'done').length;
    const m = openModal({
      title: `Complete ${s.name}`,
      body: `<p>${unfinished ? `<b>${unfinished}</b> unfinished issue${unfinished === 1 ? '' : 's'} will be moved out of this sprint.` : 'All issues in this sprint are done. 🎉'}</p>
        ${unfinished ? `<label class="f">Move unfinished issues to<select id="mv"><option value="">Backlog</option>${opts(planned, '')}</select></label>` : ''}`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="cok">Complete sprint</button>',
    });
    m.$('#cok').addEventListener('click', () => guarded(m.$('#cok'), async () => {
      await patch(`/api/sprints/${s.id}`, { action: 'complete', move_to: nullIfEmpty(m.$('#mv') ? m.$('#mv').value : '') });
      m.close(); toast(`${s.name} completed`, 'ok'); await load();
    }));
  }

  on(bl, 'click', '[data-sp]', async (el) => {
    const act = el.dataset.sp, s = sprints.find((x) => x.id === Number(el.dataset.id));
    if (act === 'new') return sprintForm(null);
    if (act === 'edit') return sprintForm(s);
    if (act === 'start') return guarded(el, async () => { await patch(`/api/sprints/${s.id}`, { action: 'start' }); toast(`${s.name} started`, 'ok'); await load(); });
    if (act === 'complete') return completeSprint(s);
    if (act === 'delete' && await confirmDialog(`Delete ${s.name}? Its issues go back to the backlog.`)) { try { await del(`/api/sprints/${s.id}`); await load(); } catch (e) { errToast(e); } }
  });
  bl.addEventListener('keydown', async (e) => {
    const inp = e.target.closest && e.target.closest('[data-quick]');
    if (!inp || e.key !== 'Enter') return;
    e.preventDefault();
    const title = inp.value.trim();
    if (!title) return;
    inp.disabled = true;
    try { await post(`/api/projects/${pid}/issues`, { title, sprint_id: inp.dataset.quick ? Number(inp.dataset.quick) : null }); } catch (err) { errToast(err); }
    await load();
    bl.querySelector(`[data-quick="${inp.dataset.quick}"]`)?.focus();
  });
  // drag issues between sprints / backlog
  bl.addEventListener('dragstart', (e) => { const r = e.target.closest && e.target.closest('[data-drag]'); if (!r) return; dragId = Number(r.dataset.drag); r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragId)); });
  bl.addEventListener('dragend', () => { dragId = null; bl.querySelectorAll('.dragging,.over').forEach((x) => x.classList.remove('dragging', 'over')); });
  bl.addEventListener('dragover', (e) => { const b = e.target.closest && e.target.closest('[data-drop-sprint]'); if (!b || dragId == null) return; e.preventDefault(); bl.querySelectorAll('.over').forEach((x) => x !== b && x.classList.remove('over')); b.classList.add('over'); });
  bl.addEventListener('drop', async (e) => {
    const b = e.target.closest && e.target.closest('[data-drop-sprint]');
    if (!b || dragId == null) return;
    e.preventDefault();
    const id = dragId; dragId = null;
    try { await patch(`/api/issues/${id}`, { sprint_id: b.dataset.dropSprint ? Number(b.dataset.dropSprint) : null }); } catch (err) { errToast(err); }
    await load();
  });
  bindFilters(bf, f, (clear) => { if (clear) redrawFilters(); load().catch(errToast); });
  redrawFilters();
  await load();
  return { refresh: () => { if (dragId == null && !document.activeElement?.matches?.('[data-quick]')) load().catch(() => {}); } };
}

// ---------------- list ----------------
async function listTab(ctx) {
  const { pid, proj, host } = ctx;
  let issues = [], sort = { k: 'key', dir: 1 };
  const f = { q: '', assignee: '', type: '', priority: '', status: '' };
  host.innerHTML = '<div id="lf"></div><div id="ll"></div>';
  const lf = host.querySelector('#lf'), ll = host.querySelector('#ll');
  const redrawFilters = () => {
    lf.innerHTML = filterBar(ctx, f).replace('<button class="btn ghost sm" data-flt-clear>', `<select data-flt="status"><option value="">All statuses</option>${opts(proj.columns, f.status)}</select><a class="btn sm right" href="/api/reports/issues.csv${qs({ project: pid })}" download>${icon('download')} Export CSV</a><button class="btn ghost sm" data-flt-clear>`);
  };
  const PR = { critical: 0, high: 1, medium: 2, low: 3 };
  const val = (i, k) => ({ key: i.num, title: i.title.toLowerCase(), status: i.status_name, priority: PR[i.priority], assignee: (i.assignee_name || '~').toLowerCase(), due: i.due_date || '9999', est: i.estimate_h ?? -1, logged: i.logged_h, type: i.type }[k]);
  function draw() {
    const rows = [...issues].sort((a, b) => { const x = val(a, sort.k), y = val(b, sort.k); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || a.num - b.num; });
    const th = (k, l) => `<th class="sortable" data-sort="${k}">${l}${sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    ll.innerHTML = `<div class="card scroll-x"><table class="t"><thead><tr>${th('key', 'Key')}${th('type', 'Type')}${th('title', 'Title')}${th('status', 'Status')}${th('priority', 'Priority')}${th('assignee', 'Assignee')}${th('due', 'Due')}${th('est', 'Estimate')}${th('logged', 'Logged')}</tr></thead>
      <tbody>${rows.map((i) => `<tr class="click" data-open-issue="${i.id}"><td class="key">${esc(i.key)}</td><td>${typeChip(i.type)}</td><td style="max-width:420px">${esc(i.title)} ${labelHtml(i.labels)}</td><td>${statusPill(i.status_name, i.status_category)}</td><td>${prio(i.priority)}</td>
        <td><span class="row">${avatar(i.assignee_name, i.assignee_color, 'xs')} ${esc(i.assignee_name || 'Unassigned')}</span></td><td>${dueLabel(i) || '<span class="muted">—</span>'}</td><td>${i.estimate_h != null ? hrs(i.estimate_h) : '—'}</td><td>${hrs(i.logged_h)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No issues match your filters.</td></tr>'}</tbody></table></div>
      <p class="muted small">${rows.length} issue${rows.length === 1 ? '' : 's'}</p>`;
  }
  async function load() { issues = await get(`/api/projects/${pid}/issues${qs(f)}`); draw(); }
  on(ll, 'click', '[data-sort]', (el) => { const k = el.dataset.sort; sort = { k, dir: sort.k === k ? -sort.dir : 1 }; draw(); });
  bindFilters(lf, f, (clear) => { if (clear) redrawFilters(); load().catch(errToast); });
  redrawFilters();
  await load();
  return { refresh: () => load().catch(() => {}) };
}

// ---------------- reports / activity ----------------
async function reportsTab(ctx) { return renderReports(ctx.host, { project: ctx.pid }); }

async function activityTab(ctx) {
  const { pid, host } = ctx;
  async function load() {
    const rows = await get(`/api/projects/${pid}/activity`);
    host.innerHTML = `<div class="card">${rows.map((a) => `<div class="irow" style="cursor:default">${avatar(a.user_name, a.user_color)}<span><b>${esc(a.user_name || 'Someone')}</b> ${esc(a.detail || a.action)}${a.issue_id ? ` <a href="#/issue/${a.issue_id}">${esc(a.pkey)}-${a.inum}</a>` : ''}</span><span class="muted small right">${timeAgo(a.created_at)}</span></div>`).join('') || '<div class="empty">No activity yet.</div>'}</div>`;
  }
  await load();
  return { refresh: debounce(() => load().catch(() => {}), 500) };
}

// ---------------- settings ----------------
async function settingsTab(ctx) {
  const { pid, host, canManage } = ctx;
  let proj = ctx.proj;
  await loadUsers();
  async function draw() {
    const ro = canManage ? '' : 'disabled';
    const memberIds = new Set(proj.members.map((m) => m.id));
    const addable = state.users.filter((u) => u.active && !memberIds.has(u.id));
    host.innerHTML = `<div class="grid g-main"><div class="col gap-lg">
      <div class="card"><div class="card-h">Project details</div><div class="card-b"><form id="pd" class="form-grid">
        <label class="f">Name<input type="text" name="name" value="${esc(proj.name)}" maxlength="100" required ${ro}></label>
        <label class="f">Key<input type="text" value="${esc(proj.key)}" disabled></label>
        <label class="f full">Description<textarea name="description" rows="3" maxlength="5000" ${ro}>${esc(proj.description || '')}</textarea></label>
        <label class="f">Start date<input type="date" name="start_date" value="${esc(proj.start_date || '')}" ${ro}></label>
        <label class="f">Target end date<input type="date" name="end_date" value="${esc(proj.end_date || '')}" ${ro}></label>
        ${canManage ? `<div class="full row"><button class="btn primary">Save changes</button><button type="button" class="btn" data-act="archive">${proj.status === 'archived' ? 'Reactivate project' : 'Archive project'}</button></div>` : ''}</form></div></div>
      <div class="card"><div class="card-h">Board columns ${canManage ? '<span class="muted small" style="font-weight:400">— the workflow every issue moves through</span>' : ''}</div>
        <div class="card-b col">${proj.columns.map((c, idx) => `<div class="row" data-col="${c.id}">
          <input type="text" value="${esc(c.name)}" maxlength="40" data-colname ${ro} style="flex:1">
          <select data-colcat style="width:140px" ${ro}><option value="todo"${c.category === 'todo' ? ' selected' : ''}>To do</option><option value="in_progress"${c.category === 'in_progress' ? ' selected' : ''}>In progress</option><option value="done"${c.category === 'done' ? ' selected' : ''}>Done</option></select>
          ${canManage ? `<button class="icon-btn" data-colmove="left" ${idx === 0 ? 'disabled' : ''} title="Move left">${icon('left')}</button><button class="icon-btn" data-colmove="right" ${idx === proj.columns.length - 1 ? 'disabled' : ''} title="Move right">${icon('right')}</button><button class="icon-btn" data-coldel title="Delete column">${icon('trash')}</button>` : ''}</div>`).join('')}
          ${canManage ? `<form id="addcol" class="row"><input type="text" name="name" placeholder="New column name" maxlength="40" required><select name="category" style="width:140px"><option value="in_progress">In progress</option><option value="todo">To do</option><option value="done">Done</option></select><button class="btn">Add column</button></form>` : ''}
          <p class="muted small" style="margin:0">“Done” columns count issues as completed in progress and reports.</p></div></div></div>
      <div class="col gap-lg"><div class="card"><div class="card-h">Team (${proj.members.length})</div><div class="card-b col">
        ${proj.members.map((m) => `<div class="row" data-mem="${m.id}">${avatar(m.name, m.color)}<span class="grow trunc">${esc(m.name)}<br><span class="muted small">${esc(m.email)}</span></span>
          ${canManage ? `<select data-memrole style="width:105px"><option value="manager"${m.role === 'manager' ? ' selected' : ''}>Manager</option><option value="member"${m.role === 'member' ? ' selected' : ''}>Member</option><option value="viewer"${m.role === 'viewer' ? ' selected' : ''}>Viewer</option></select><button class="icon-btn" data-memdel title="Remove from project">${icon('x')}</button>` : `<span class="pill">${esc(m.role)}</span>`}</div>`).join('')}
        ${canManage ? (addable.length ? `<form id="addmem" class="row" style="margin-top:6px"><select name="user_id" required><option value="">Add team member…</option>${opts(addable, '')}</select><select name="role" style="width:105px"><option value="member">Member</option><option value="manager">Manager</option><option value="viewer">Viewer</option></select><button class="btn">Add</button></form>` : '<p class="muted small">Everyone on the team is already in this project. Administrators can add accounts in the Team page.</p>') : ''}
        <p class="muted small" style="margin:0">Managers edit settings &amp; team. Members create and edit issues. Viewers are read-only. Administrators can access every project.</p></div></div>
      ${canManage ? `<div class="card"><div class="card-h" style="color:var(--danger)">Danger zone</div><div class="card-b"><p class="muted small">Deleting a project permanently removes all its issues, comments, time entries and chat.</p><button class="btn danger" data-act="delete-project">${icon('trash')} Delete project</button></div></div>` : ''}</div></div>`;
  }
  async function refreshProj() { proj = await get(`/api/projects/${pid}`); ctx.proj = proj; await loadProjects(); await draw(); }

  host.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = e.target.id;
    if (id === 'pd') { const v = formValues(e.target); await guarded(e.target.querySelector('button'), async () => { proj = await patch(`/api/projects/${pid}`, { name: v.name, description: v.description, start_date: nullIfEmpty(v.start_date), end_date: nullIfEmpty(v.end_date) }); toast('Project saved', 'ok', 2000); await loadProjects(); }); }
    else if (id === 'addcol') { const v = formValues(e.target); await guarded(e.target.querySelector('button'), async () => { await post(`/api/projects/${pid}/columns`, v); await refreshProj(); }); }
    else if (id === 'addmem') { const v = formValues(e.target); if (!v.user_id) return; await guarded(e.target.querySelector('button'), async () => { await post(`/api/projects/${pid}/members`, { user_id: Number(v.user_id), role: v.role }); await refreshProj(); }); }
  });
  host.addEventListener('change', async (e) => {
    const row = e.target.closest('[data-col]'), mem = e.target.closest('[data-mem]');
    try {
      if (row && e.target.matches('[data-colname]')) { if (!e.target.value.trim()) { await draw(); return; } await patch(`/api/columns/${row.dataset.col}`, { name: e.target.value }); }
      else if (row && e.target.matches('[data-colcat]')) await patch(`/api/columns/${row.dataset.col}`, { category: e.target.value });
      else if (mem && e.target.matches('[data-memrole]')) await post(`/api/projects/${pid}/members`, { user_id: Number(mem.dataset.mem), role: e.target.value });
      else return;
      await refreshProj();
    } catch (err) { errToast(err); await refreshProj().catch(() => {}); }
  });
  on(host, 'click', '[data-colmove]', async (el) => { try { await patch(`/api/columns/${el.closest('[data-col]').dataset.col}`, { move: el.dataset.colmove }); await refreshProj(); } catch (e) { errToast(e); } });
  on(host, 'click', '[data-coldel]', async (el) => {
    const c = proj.columns.find((x) => x.id === Number(el.closest('[data-col]').dataset.col));
    const others = proj.columns.filter((x) => x.id !== c.id);
    const m = openModal({
      title: `Delete column “${c.name}”`,
      body: `<p>Issues in this column will be moved to another column.</p><label class="f">Move issues to<select id="mvto">${opts(others, others[0] && others[0].id)}</select></label>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="dok" style="background:var(--danger);border-color:var(--danger)">Delete column</button>',
    });
    m.$('#dok').addEventListener('click', () => guarded(m.$('#dok'), async () => { await del(`/api/columns/${c.id}?move_to=${m.$('#mvto').value}`); m.close(); await refreshProj(); }));
  });
  on(host, 'click', '[data-memdel]', async (el) => {
    const mid = Number(el.closest('[data-mem]').dataset.mem), m = proj.members.find((x) => x.id === mid);
    if (await confirmDialog(`Remove ${m.name} from this project? Their issues here become unassigned.`, { okText: 'Remove' })) { try { await del(`/api/projects/${pid}/members/${mid}`); await refreshProj(); } catch (e) { errToast(e); } }
  });
  on(host, 'click', '[data-act=archive]', (el) => guarded(el, async () => { await patch(`/api/projects/${pid}`, { status: proj.status === 'archived' ? 'active' : 'archived' }); await refreshProj(); toast('Project updated', 'ok', 2000); }));
  on(host, 'click', '[data-act=delete-project]', () => {
    const m = openModal({
      title: 'Delete project',
      body: `<p>This permanently deletes <b>${esc(proj.name)}</b> with all ${proj.total} issues, comments and time entries.</p><label class="f">Type the project key <b>${esc(proj.key)}</b> to confirm<input type="text" id="kc" autocomplete="off"></label>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="dp" style="background:var(--danger);border-color:var(--danger)" disabled>Delete forever</button>',
    });
    m.$('#kc').addEventListener('input', (e) => { m.$('#dp').disabled = e.target.value.trim().toUpperCase() !== proj.key; });
    m.$('#dp').addEventListener('click', () => guarded(m.$('#dp'), async () => { await del(`/api/projects/${pid}`); m.close(); toast('Project deleted', 'ok'); await loadProjects(); location.hash = '#/projects'; }));
  });
  await draw();
  return { refresh: () => { if (!host.contains(document.activeElement) || !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) refreshProj().catch(() => {}); } };
}
