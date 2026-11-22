// Dashboard, My work, Reminders, Team
import {
  state, get, post, patch, del, esc, icon, avatar, issueRow, progressBar, hrs, pct, fmtDate, fmtDateTime, timeAgo, todayStr, addDays, toLocalInput,
  openModal, confirmDialog, toast, errToast, guarded, formValues, on, bus, loadUsers, loadProjects, beep, nullIfEmpty,
} from './lib.js';
import { openReminderForm, openCreateIssue } from './issue.js';
import { openNewProject } from './project.js';

// =============== dashboard ===============
export async function dashboardPage(view) {
  async function draw() {
    const d = await get('/api/dashboard');
    const hour = new Date().getHours();
    const s = d.stats;
    const stat = (v, l, cls = '') => `<div class="card stat ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    view.innerHTML = `<div class="page-head"><h1>${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${esc(state.user.name.split(' ')[0])}</h1><span class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
      <button class="btn primary right" data-act="create">${icon('plus')} Create issue</button></div>
      <div class="grid g5" style="margin-bottom:16px">${stat(s.open, 'My open issues')}${stat(s.overdue, 'Overdue', s.overdue ? 'bad' : '')}${stat(s.due_week, 'Due in 7 days')}${stat(s.done_week, 'Completed this week', 'good')}${stat(hrs(s.logged_today), `Logged today · ${hrs(s.logged_week)} this week`)}</div>
      <div class="grid g-main">
        <div class="col gap-lg">
          <div class="card"><div class="card-h">My work <a class="small right" href="#/my">View all</a></div>${d.my_issues.length ? d.my_issues.map((i) => issueRow(i, { showProject: true })).join('') : '<div class="empty"><h3>Nothing assigned to you</h3><p>Issues assigned to you will show up here.</p></div>'}</div>
          <div class="card"><div class="card-h">Projects <a class="small right" href="#/projects">All projects</a></div>
            ${d.projects.length ? d.projects.map((p) => `<a href="#/p/${p.id}/board" class="irow" style="color:inherit;text-decoration:none;cursor:pointer"><span class="pkey">${esc(p.key)}</span><span class="title">${esc(p.name)}</span><div style="width:140px">${progressBar(p.done, p.total, p.total && p.done === p.total ? 'ok' : '')}</div><span class="small muted" style="width:96px;text-align:right">${p.done}/${p.total} · ${pct(p.done, p.total)}%</span>${p.overdue ? `<span class="pill bad">${p.overdue} late</span>` : ''}</a>`).join('') : `<div class="empty"><h3>No projects yet</h3><button class="btn primary" data-act="newproj">${icon('plus')} New project</button></div>`}</div></div>
        <div class="col gap-lg">
          <div class="card"><div class="card-h">Upcoming reminders <a class="small right" href="#/reminders">Manage</a></div>${d.reminders.length ? d.reminders.map((r) => `<div class="irow" style="cursor:default">${icon('bell')}<span class="title">${esc(r.title)}</span><span class="small ${r.remind_at < new Date().toISOString() ? 'due over' : 'muted'}">${fmtDateTime(r.remind_at)}</span></div>`).join('') : '<div class="empty small">No reminders. <a href="#/reminders">Add one</a></div>'}</div>
          <div class="card"><div class="card-h">Recent activity</div>${d.activity.length ? d.activity.map((a) => `<div class="irow" style="cursor:default;align-items:flex-start">${avatar(a.user_name, a.user_color, 'xs')}<span class="small"><b>${esc(a.user_name || 'Someone')}</b> ${esc(a.detail || a.action)}${a.issue_id ? ` <a href="#/issue/${a.issue_id}">${esc(a.pkey)}-${a.inum}</a>` : ''}<br><span class="muted">${timeAgo(a.created_at)}</span></span></div>`).join('') : '<div class="empty small">No activity yet.</div>'}</div></div></div>`;
  }
  on(view, 'click', '[data-act=create]', () => openCreateIssue());
  on(view, 'click', '[data-act=newproj]', () => openNewProject((id) => { location.hash = `#/p/${id}/board`; }));
  await draw();
  return { onProject: () => draw().catch(() => {}), onTick: () => {} };
}

// =============== my work ===============
export async function myWorkPage(view) {
  let showDone = false;
  async function draw() {
    const rows = await get('/api/my/issues' + (showDone ? '?all=1' : ''));
    const t = todayStr(), wk = addDays(t, 7);
    const open = rows.filter((i) => i.status_category !== 'done');
    const groups = [
      ['Overdue', open.filter((i) => i.due_date && i.due_date < t)],
      ['Due today', open.filter((i) => i.due_date === t)],
      ['Due this week', open.filter((i) => i.due_date > t && i.due_date <= wk)],
      ['Later', open.filter((i) => i.due_date > wk)],
      ['No due date', open.filter((i) => !i.due_date)],
      ['Completed', rows.filter((i) => i.status_category === 'done')],
    ].filter(([, l]) => l.length);
    view.innerHTML = `<div class="page-head"><h1>My work</h1><span class="sub">${open.length} open issue${open.length === 1 ? '' : 's'} assigned to you</span>
      <label class="check small right"><input type="checkbox" id="showdone" ${showDone ? 'checked' : ''}> Show completed</label></div>
      ${groups.map(([name, list]) => `<div class="card" style="margin-bottom:16px"><div class="card-h" style="${name === 'Overdue' ? 'color:var(--danger)' : ''}">${name} <span class="pill">${list.length}</span></div>${list.map((i) => issueRow(i, { showProject: true })).join('')}</div>`).join('') || '<div class="card empty"><h3>All clear</h3><p>You have no open issues assigned to you.</p></div>'}`;
  }
  on(view, 'change', '#showdone', (el) => { showDone = el.checked; draw(); });
  await draw();
  return { onProject: () => draw().catch(() => {}) };
}

// =============== reminders ===============
export async function remindersPage(view) {
  async function draw() {
    const rows = await get('/api/reminders');
    const nowIso = new Date().toISOString();
    const active = rows.filter((r) => !r.done), done = rows.filter((r) => r.done);
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const item = (r) => `<div class="irow" style="cursor:default" data-rid="${r.id}">
      <label class="check" title="Mark as done"><input type="checkbox" data-done ${r.done ? 'checked' : ''}></label>
      <div class="grow"><div style="${r.done ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(r.title)} ${r.repeat !== 'none' ? `<span class="pill">repeats ${r.repeat}</span>` : ''}</div>
        <div class="small muted">${r.note ? esc(r.note) + ' · ' : ''}${r.issue_id ? `<a href="#/issue/${r.issue_id}">${esc(r.issue_key)}</a> · ` : ''}</div></div>
      <span class="small ${!r.done && r.remind_at < nowIso ? 'due over' : 'muted'} nowrap">${fmtDateTime(r.remind_at)}${!r.done && r.remind_at < nowIso ? ' (due)' : ''}</span>
      ${!r.done ? `<select data-snooze style="width:100px" title="Snooze"><option value="">Snooze…</option><option value="10m">10 minutes</option><option value="1h">1 hour</option><option value="tom">Tomorrow 9am</option></select>` : ''}
      <button class="icon-btn" data-del title="Delete">${icon('trash')}</button></div>`;
    view.innerHTML = `<div class="page-head"><h1>Reminders</h1><span class="sub">Get notified in the app, and on your desktop</span><button class="btn primary right" data-act="new">${icon('plus')} New reminder</button></div>
      ${perm === 'default' ? `<div class="card card-b row" style="margin-bottom:16px"><span>${icon('bell')}</span><span class="grow">Turn on desktop notifications so reminders reach you even when this tab is in the background.</span><button class="btn primary sm" data-act="perm">Enable notifications</button></div>` : ''}
      ${perm === 'denied' ? '<div class="card card-b small muted" style="margin-bottom:16px">Desktop notifications are blocked in your browser settings. Reminders will still appear inside TaskFlow.</div>' : ''}
      <div class="card" style="margin-bottom:16px"><div class="card-h">Upcoming <span class="pill">${active.length}</span></div>${active.map(item).join('') || '<div class="empty small">No active reminders.</div>'}</div>
      ${done.length ? `<div class="card"><div class="card-h">Completed <span class="pill">${done.length}</span><button class="btn sm ghost right" data-act="clear">Clear completed</button></div>${done.map(item).join('')}</div>` : ''}
      <p class="muted small">Tip: you can also set a reminder from inside any issue with “Remind me”. Tasks with a due date notify you automatically when they are due tomorrow, today, or overdue.</p>`;
  }
  on(view, 'click', '[data-act=new]', () => openReminderForm({ onSaved: draw }));
  on(view, 'click', '[data-act=perm]', async () => { try { await Notification.requestPermission(); } catch { /* ignore */ } draw(); });
  on(view, 'click', '[data-act=clear]', async () => {
    const rows = await get('/api/reminders');
    try { await Promise.all(rows.filter((r) => r.done).map((r) => del(`/api/reminders/${r.id}`))); } catch (e) { errToast(e); }
    draw();
  });
  on(view, 'change', '[data-done]', async (el) => { const id = el.closest('[data-rid]').dataset.rid; try { await patch(`/api/reminders/${id}`, { done: el.checked }); } catch (e) { errToast(e); } draw(); });
  on(view, 'click', '[data-del]', async (el) => { try { await del(`/api/reminders/${el.closest('[data-rid]').dataset.rid}`); } catch (e) { errToast(e); } draw(); });
  on(view, 'change', '[data-snooze]', async (el) => {
    if (!el.value) return;
    const d = new Date();
    if (el.value === '10m') d.setMinutes(d.getMinutes() + 10);
    else if (el.value === '1h') d.setHours(d.getHours() + 1);
    else { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
    try { await patch(`/api/reminders/${el.closest('[data-rid]').dataset.rid}`, { remind_at: d.toISOString() }); toast('Snoozed', 'ok', 1800); } catch (e) { errToast(e); }
    draw();
  });
  await draw();
  const off = bus.on('reminder', () => draw().catch(() => {}));
  return { destroy: off };
}

// =============== team ===============
export async function teamPage(view) {
  const isAdmin = state.user.role === 'admin';
  async function draw() {
    await loadUsers();
    const users = state.users;
    view.innerHTML = `<div class="page-head"><h1>Team</h1><span class="sub">${users.filter((u) => u.active).length} active member${users.filter((u) => u.active).length === 1 ? '' : 's'}</span>
      ${isAdmin ? `<button class="btn primary right" data-act="add">${icon('plus')} Add team member</button>` : ''}</div>
      <div class="card scroll-x"><table class="t"><thead><tr><th>Member</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr data-uid="${u.id}" style="${u.active ? '' : 'opacity:.55'}"><td><span class="row">${avatar(u.name, u.color, 'lg')} <b>${esc(u.name)}</b> ${u.id === state.user.id ? '<span class="pill">you</span>' : ''}</span></td><td>${esc(u.email)}</td>
        <td><span class="pill ${u.role === 'admin' ? 'warn' : ''}">${u.role === 'admin' ? 'Administrator' : 'Member'}</span></td><td>${u.active ? '<span class="pill done">Active</span>' : '<span class="pill">Deactivated</span>'}</td>
        <td class="right nowrap">${u.active && u.id !== state.user.id ? `<button class="btn sm" data-act="dm">${icon('chat')} Message</button>` : ''} ${isAdmin ? '<button class="btn sm" data-act="edit">Edit</button>' : ''}</td></tr>`).join('')}</tbody></table></div>
      ${isAdmin ? '<p class="muted small">Administrators can see every project and manage accounts. Add members to projects from each project’s “Team &amp; settings” tab.</p>' : '<p class="muted small">Ask an administrator if you need a teammate added.</p>'}`;
  }
  function userForm(u) {
    const m = openModal({
      title: u ? `Edit ${u.name}` : 'Add team member',
      body: `<form id="uf" class="col" style="gap:12px"><div class="form-grid"><label class="f">Full name<input type="text" name="name" required maxlength="80" value="${esc(u ? u.name : '')}"></label>
        <label class="f">Email (sign-in)<input type="email" name="email" required maxlength="120" value="${esc(u ? u.email : '')}"></label>
        <label class="f">${u ? 'Reset password (optional)' : 'Password'}<input type="password" name="password" minlength="6" maxlength="200" ${u ? '' : 'required'} autocomplete="new-password" placeholder="At least 6 characters"></label>
        <label class="f">Role<select name="role"><option value="member"${u && u.role === 'member' ? ' selected' : ''}>Member</option><option value="admin"${u && u.role === 'admin' ? ' selected' : ''}>Administrator</option></select></label></div>
        ${u ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${u.id === state.user.id ? 'disabled' : ''}> Account active (can sign in)</label>` : ''}</form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="usave">Save</button>',
    });
    const submit = () => guarded(m.$('#usave'), async () => {
      const f = m.$('#uf');
      if (!f.reportValidity()) return;
      const v = formValues(f);
      const body = { name: v.name, email: v.email, role: v.role };
      if (v.password) body.password = v.password;
      if (u) { if (u.id !== state.user.id) body.active = v.active; await patch(`/api/users/${u.id}`, body); } else await post('/api/users', body);
      m.close(); toast(u ? 'User updated' : 'Team member added', 'ok'); await draw();
    });
    m.$('#usave').addEventListener('click', submit);
    m.$('#uf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }
  on(view, 'click', '[data-act=add]', () => userForm(null));
  on(view, 'click', '[data-act=edit]', (el) => userForm(state.users.find((u) => u.id === Number(el.closest('[data-uid]').dataset.uid))));
  on(view, 'click', '[data-act=dm]', async (el) => { try { const r = await post('/api/channels/dm', { user_id: Number(el.closest('[data-uid]').dataset.uid) }); location.hash = `#/chat/${r.id}`; } catch (e) { errToast(e); } });
  await draw();
}

// =============== profile dialog ===============
export function openProfile(onDone) {
  const u = state.user;
  const colors = ['#16a34a', '#0d9488', '#65a30d', '#059669', '#0891b2', '#15803d', '#4d7c0f', '#0f766e', '#22c55e', '#2f855a'];
  const m = openModal({
    title: 'My profile',
    body: `<form id="mf" class="col" style="gap:12px"><label class="f">Name<input type="text" name="name" value="${esc(u.name)}" maxlength="80" required></label>
      <div class="f">Avatar color<div class="row wrap">${colors.map((c) => `<label style="cursor:pointer"><input type="radio" name="color" value="${c}" ${c === u.color ? 'checked' : ''} style="display:none"><span class="avatar lg" data-sw style="background:${c};outline:${c === u.color ? '3px solid var(--text)' : 'none'};outline-offset:2px"></span></label>`).join('')}</div></div>
      <div class="sec-title" style="margin:4px 0 0">Change password</div><div class="form-grid"><label class="f">Current password<input type="password" name="current_password" autocomplete="current-password"></label>
      <label class="f">New password<input type="password" name="new_password" minlength="6" autocomplete="new-password"></label></div></form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="msave">Save</button>',
  });
  m.$('#mf').addEventListener('change', (e) => { if (e.target.name === 'color') m.$$('[data-sw]').forEach((s) => { s.style.outline = s.previousElementSibling.checked ? '3px solid var(--text)' : 'none'; }); });
  m.$('#msave').addEventListener('click', () => guarded(m.$('#msave'), async () => {
    const v = formValues(m.$('#mf'));
    const body = { name: v.name, color: v.color };
    if (v.new_password) { body.new_password = v.new_password; body.current_password = v.current_password; }
    const r = await patch('/api/me', body);
    state.user = r.user; m.close(); toast('Profile updated', 'ok', 2000); if (onDone) onDone();
  }));
}
