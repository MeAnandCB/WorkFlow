// App shell: sign-in, layout, router, live events, notifications, search, timer
import {
  state, api, get, post, esc, icon, avatar, toast, errToast, bus, loadProjects, on, debounce, lsGet, lsSet, fmtClock, timeAgo, beep, guarded, closeAllModals, typeChip, statusPill,
} from './lib.js';
import { openIssue, openCreateIssue, stopTimer } from './issue.js';
import { dashboardPage, myWorkPage, remindersPage, teamPage, openProfile } from './pages.js';
import { projectsPage, projectPage, openNewProject } from './project.js';
import { chatPage, refreshChatBadge } from './chat.js';
import { reportsPage } from './reports.js';

const app = document.getElementById('app');
let es = null, current = null, routeToken = 0, tickTimer = null;

// ---------- theme ----------
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); lsSet('theme', t); }
applyTheme(lsGet('theme') || 'light');

// ---------- boot / auth ----------
async function boot() {
  let status;
  try { status = await get('/api/auth/status'); } catch (e) { app.innerHTML = `<div class="auth"><div class="card"><h2>Cannot reach the server</h2><p class="muted">${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Retry</button></div></div>`; return; }
  try {
    const me = await get('/api/me');
    state.user = me.user; state.unread = me.unread; state.timer = me.timer;
  } catch { state.user = null; }
  if (!state.user) return showAuth(status.needsSetup);
  startApp();
}

function showAuth(setup) {
  stopLive();
  app.innerHTML = `<div class="auth"><div class="card"><div class="row" style="gap:10px"><span class="logo" style="padding:0"><span class="mark" style="width:34px;height:34px">${icon('check')}</span></span><b style="font-size:20px">TaskFlow</b></div>
    <h1>${setup ? 'Welcome! Create your account' : 'Sign in'}</h1><p class="muted" style="margin:0 0 16px">${setup ? 'This first account becomes the administrator. You can add your team afterwards.' : 'Plan, track and ship work with your team.'}</p>
    <form id="af" class="col" style="gap:12px">
      ${setup ? '<label class="f">Your name<input type="text" name="name" required maxlength="80" autocomplete="name" autofocus></label>' : ''}
      <label class="f">Email<input type="email" name="email" required maxlength="120" autocomplete="username" ${setup ? '' : 'autofocus'}></label>
      <label class="f">Password<input type="password" name="password" required minlength="${setup ? 6 : 1}" maxlength="200" autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
      ${setup ? '<label class="f">Confirm password<input type="password" name="confirm" required minlength="6" autocomplete="new-password"></label>' : ''}
      <div id="aerr" class="small" style="color:var(--danger);min-height:18px"></div>
      <button class="btn primary" style="padding:10px">${setup ? 'Create account' : 'Sign in'}</button></form></div></div>`;
  const form = app.querySelector('#af');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const err = app.querySelector('#aerr');
    err.textContent = '';
    if (setup && fd.password !== fd.confirm) { err.textContent = 'Passwords do not match'; return; }
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await post(setup ? '/api/auth/setup' : '/api/auth/login', setup ? { name: fd.name, email: fd.email, password: fd.password } : { email: fd.email, password: fd.password });
      const me = await get('/api/me');
      state.user = me.user; state.unread = me.unread; state.timer = me.timer;
      startApp();
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
}
window.addEventListener('auth-lost', () => { if (state.user) { state.user = null; closeAllModals(); boot(); } });

// ---------- shell ----------
function startApp() {
  app.innerHTML = `<div class="shell"><aside class="sidebar" id="sb"></aside><div class="scrim" id="scrim"></div>
    <div class="main"><header class="topbar">
      <button class="icon-btn menu-btn" id="menubtn" aria-label="Menu">${icon('menu')}</button>
      <div class="search"><span>${icon('search')}</span><input type="search" id="gs" placeholder="Search issues (e.g. login, WEB-12)" autocomplete="off" aria-label="Search issues"><div class="dropdown hidden" id="gsr"></div></div>
      <div class="right row" style="gap:6px"><div id="timerchip"></div>
        <button class="btn primary sm" id="newissue">${icon('plus')} <span class="hide-sm">Create</span></button>
        <div style="position:relative"><button class="icon-btn" id="bell" aria-label="Notifications">${icon('bell')}<span class="badge hidden" id="bellb" style="position:absolute;top:0;right:0"></span></button><div class="dropdown notif-panel hidden" id="np"></div></div>
        <button class="icon-btn" id="theme" aria-label="Toggle dark mode"></button></div></header>
      <main id="view"></main></div></div>`;
  drawSidebar(); drawTimer(); updateBadges(); drawThemeBtn();
  const sb = document.getElementById('sb'), scrim = document.getElementById('scrim');
  const closeMenu = () => { sb.classList.remove('open'); scrim.classList.remove('show'); };
  document.getElementById('menubtn').addEventListener('click', () => { sb.classList.toggle('open'); scrim.classList.toggle('show'); });
  scrim.addEventListener('click', closeMenu);
  sb.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });
  document.getElementById('newissue').addEventListener('click', () => openCreateIssue());
  document.getElementById('theme').addEventListener('click', () => { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); drawThemeBtn(); });
  setupSearch(); setupBell();
  loadProjects().then(drawSidebar).catch(() => {});
  refreshChatBadge();
  connectLive();
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(drawTimerClock, 1000);
  if (!location.hash || location.hash === '#') location.hash = '#/dashboard';
  route();
}
const drawThemeBtn = () => { const b = document.getElementById('theme'); if (b) b.innerHTML = icon(document.documentElement.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon'); };

function drawSidebar() {
  const sb = document.getElementById('sb');
  if (!sb) return;
  const active = state.projects.filter((p) => p.status === 'active');
  sb.innerHTML = `<div class="logo"><span class="mark">${icon('check')}</span> TaskFlow</div>
    <nav class="nav">
      <a href="#/dashboard" data-nav="dashboard">${icon('home')} Dashboard</a>
      <a href="#/my" data-nav="my">${icon('check')} My work</a>
      <a href="#/projects" data-nav="projects">${icon('folder')} All projects</a>
      <a href="#/chat" data-nav="chat">${icon('chat')} Team chat <span class="badge hidden" id="chatb"></span></a>
      <a href="#/reminders" data-nav="reminders">${icon('bell')} Reminders</a>
      <a href="#/reports" data-nav="reports">${icon('chart')} Reports</a>
      <a href="#/team" data-nav="team">${icon('users')} Team</a></nav>
    <div class="nav-title">Projects <button id="sbnew" title="New project" aria-label="New project">${icon('plus')}</button></div>
    <nav class="nav">${active.map((p) => `<a href="#/p/${p.id}/board" data-nav="p${p.id}"><span class="pkey">${esc(p.key)}</span><span class="trunc">${esc(p.name)}</span></a>`).join('') || '<span class="small muted" style="padding:4px 12px">No projects yet</span>'}</nav>
    <div style="margin-top:auto;padding:14px;border-top:1px solid var(--sidebar-border)" class="row">
      <button class="row grow" id="me" style="background:none;border:0;color:inherit;cursor:pointer;text-align:left;gap:8px;min-width:0">${avatar(state.user.name, state.user.color, 'lg')}<span class="trunc"><b style="color:var(--sidebar-strong)">${esc(state.user.name)}</b><br><span class="small">${state.user.role === 'admin' ? 'Administrator' : 'Member'}</span></span></button>
      <button class="icon-btn" id="logout" title="Sign out" aria-label="Sign out" style="color:var(--sidebar-t)">${icon('logout')}</button></div>`;
  document.getElementById('sbnew').addEventListener('click', () => openNewProject((id) => { location.hash = `#/p/${id}/board`; }));
  document.getElementById('me').addEventListener('click', () => openProfile(drawSidebar));
  document.getElementById('logout').addEventListener('click', async () => { try { await post('/api/auth/logout'); } catch { /* ignore */ } state.user = null; closeAllModals(); stopLive(); boot(); });
  highlightNav(); updateBadges();
}
function highlightNav() {
  const key = navKey();
  document.querySelectorAll('#sb [data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}
function navKey() {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  return a === 'p' ? 'p' + b : a || 'dashboard';
}
bus.on('projects', drawSidebar);

function updateBadges() {
  const bb = document.getElementById('bellb'), cb = document.getElementById('chatb');
  if (bb) { bb.textContent = state.unread > 99 ? '99+' : state.unread; bb.classList.toggle('hidden', !state.unread); }
  if (cb) { cb.textContent = state.chatUnread > 99 ? '99+' : state.chatUnread; cb.classList.toggle('hidden', !state.chatUnread); }
  document.title = `${state.unread + state.chatUnread ? `(${state.unread + state.chatUnread}) ` : ''}TaskFlow`;
}
bus.on('badges', updateBadges);

// ---------- timer chip ----------
function drawTimer() {
  const el = document.getElementById('timerchip');
  if (!el) return;
  if (!state.timer) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="timer-chip"><span class="dot"></span><a href="#/issue/${state.timer.issue_id}" style="color:inherit" title="${esc(state.timer.title)}">${esc(state.timer.key)}</a><span id="tclock">${fmtClock(Date.now() - Date.parse(state.timer.started_at))}</span>
    <button class="icon-btn" id="tstop" title="Stop timer and log time" style="padding:2px;color:inherit">${icon('stop')}</button></div>`;
  document.getElementById('tstop').addEventListener('click', () => stopTimer());
}
function drawTimerClock() {
  const c = document.getElementById('tclock');
  if (c && state.timer) c.textContent = fmtClock(Date.now() - Date.parse(state.timer.started_at));
}
bus.on('timer', drawTimer);

// ---------- search ----------
function setupSearch() {
  const input = document.getElementById('gs'), box = document.getElementById('gsr');
  const hide = () => box.classList.add('hidden');
  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) return hide();
    try {
      const rows = await get('/api/search?q=' + encodeURIComponent(q));
      box.innerHTML = rows.map((i) => `<div class="dd-item" data-id="${i.id}">${typeChip(i.type)}<span class="key">${esc(i.key)}</span><span class="trunc grow">${esc(i.title)}</span>${statusPill(i.status_name, i.status_category)}</div>`).join('') || '<div class="dd-item muted">No matching issues</div>';
      box.classList.remove('hidden');
    } catch { hide(); }
  }, 220);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; hide(); input.blur(); } });
  box.addEventListener('click', (e) => { const it = e.target.closest('[data-id]'); if (it) { hide(); input.value = ''; location.hash = `#/issue/${it.dataset.id}`; } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.querySelector('.overlay')) { e.preventDefault(); input.focus(); } });
}

// ---------- notifications bell ----------
function setupBell() {
  const bell = document.getElementById('bell'), panel = document.getElementById('np');
  async function draw() {
    const r = await get('/api/notifications');
    state.unread = r.unread; updateBadges();
    panel.innerHTML = `<div class="row" style="padding:10px 14px;border-bottom:1px solid var(--border)"><b>Notifications</b><button class="btn sm ghost right" id="readall">Mark all read</button></div>
      ${r.items.map((n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.link || '#/dashboard')}" data-nid="${n.id}"><div>${esc(n.text)}</div><div class="small muted">${timeAgo(n.created_at)}</div></a>`).join('') || '<div class="empty small">You’re all caught up.</div>'}`;
  }
  bell.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) { try { await draw(); } catch (err) { errToast(err); return; } panel.classList.remove('hidden'); } else panel.classList.add('hidden');
  });
  panel.addEventListener('click', async (e) => {
    if (e.target.closest('#readall')) { e.stopPropagation(); try { const r = await post('/api/notifications/read', {}); state.unread = r.unread; updateBadges(); await draw(); } catch (err) { errToast(err); } return; }
    const n = e.target.closest('[data-nid]');
    if (n) { panel.classList.add('hidden'); post('/api/notifications/read', { ids: [Number(n.dataset.nid)] }).then((r) => { state.unread = r.unread; updateBadges(); }).catch(() => {}); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#np') && !e.target.closest('#bell')) panel.classList.add('hidden'); });
}

// ---------- live events ----------
function desktopNotify(title, body, link) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      const n = new Notification(title, { body, tag: link || title });
      n.onclick = () => { window.focus(); if (link) location.hash = link; n.close(); };
    }
  } catch { /* not supported */ }
}
function connectLive() {
  stopLive();
  es = new EventSource('/api/events');
  const json = (e) => { try { return JSON.parse(e.data); } catch { return null; } };
  es.addEventListener('notification', (e) => {
    const n = json(e); if (!n) return;
    state.unread++; updateBadges();
    if (n.type !== 'reminder') { toast(n.text, '', 6000, n.link); beep(); desktopNotify('TaskFlow', n.text, n.link); }
  });
  es.addEventListener('reminder', (e) => {
    const r = json(e); if (!r) return;
    toast('⏰ ' + r.title + (r.note ? ' — ' + r.note : ''), 'reminder', 20000, r.link);
    beep('reminder'); desktopNotify('Reminder', r.title + (r.note ? '\n' + r.note : ''), r.link);
    bus.emit('reminder', r);
  });
  es.addEventListener('message', (e) => {
    const d = json(e); if (!d) return;
    bus.emit('message', d);
    if (d.message.user_id !== state.user.id && !location.hash.startsWith('#/chat')) {
      beep();
      toast(`${d.message.user_name}: ${(d.message.body || '📎 ' + d.message.file_name).slice(0, 80)}`, '', 5000, `#/chat/${d.channel_id}`);
      desktopNotify(d.message.user_name || 'New message', (d.message.body || '📎 ' + d.message.file_name).slice(0, 120), `#/chat/${d.channel_id}`);
      refreshChatBadge();
    }
  });
  es.addEventListener('project', (e) => {
    const d = json(e); if (!d) return;
    bus.emit('project-event', d);
    if (d.kind === 'project' || d.kind === 'deleted') loadProjects().catch(() => {});
    if (current && current.onProject) { try { current.onProject(d); } catch (err) { console.error(err); } }
  });
}
function stopLive() { if (es) { es.close(); es = null; } if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

// ---------- router ----------
const ROUTES = [
  [/^dashboard$/, () => dashboardPage],
  [/^my$/, () => myWorkPage],
  [/^projects$/, () => projectsPage],
  [/^p\/(\d+)(?:\/(\w+))?$/, (m) => (view) => projectPage(view, { id: m[1], tab: m[2] })],
  [/^chat(?:\/(\d+))?$/, (m) => (view) => chatPage(view, { cid: m[1] })],
  [/^reminders$/, () => remindersPage],
  [/^reports$/, () => reportsPage],
  [/^team$/, () => teamPage],
];

async function route() {
  const view = document.getElementById('view');
  if (!view || !state.user) return;
  const token = ++routeToken;
  if (current && current.destroy) { try { current.destroy(); } catch (e) { console.error(e); } }
  current = null;
  const path = location.hash.replace(/^#\/?/, '');
  highlightNav();

  const im = /^issue\/(\d+)$/.exec(path);
  if (im) {
    try {
      const issue = await get(`/api/issues/${im[1]}`);
      history.replaceState(null, '', `#/p/${issue.project_id}/board`);
      await route();
      openIssue(Number(im[1]));
    } catch (e) { errToast(e); history.replaceState(null, '', '#/dashboard'); route(); }
    return;
  }
  let handler = null;
  for (const [re, make] of ROUTES) { const m = re.exec(path); if (m) { handler = make(m); break; } }
  if (!handler) { location.hash = '#/dashboard'; return; }
  view.innerHTML = '<div class="spinner"></div>';
  window.scrollTo(0, 0);
  try {
    const res = await handler(view);
    if (token !== routeToken) { if (res && res.destroy) res.destroy(); return; }
    current = res || null;
  } catch (e) {
    if (token !== routeToken) return;
    console.error(e);
    view.innerHTML = `<div class="card empty"><h3>Something went wrong</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
  }
}
window.addEventListener('hashchange', route);

// open issue from anywhere (cards, rows, search results)
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-open-issue]');
  if (!el || e.target.closest('a, button, input, select, textarea, label')) return;
  openIssue(Number(el.dataset.openIssue));
});

boot();
