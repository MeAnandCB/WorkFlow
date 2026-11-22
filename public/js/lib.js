// Shared front-end helpers
export const state = { user: null, users: [], projects: [], timer: null, unread: 0, chatUnread: 0 };

// ---------- API ----------
export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('Cannot reach the server. Is it still running?');
  }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('auth-lost'));
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b = {}) => api('POST', u, b);
export const patch = (u, b) => api('PATCH', u, b);
export const del = (u) => api('DELETE', u);
export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

// ---------- text ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// safe mini-markdown: everything is escaped first, then links / @mentions / `code` / **bold** are added
export function rich(text) {
  let s = esc(text);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|[\s>])@([\w.-]+)/g, '$1<span class="mention">@$2</span>');
  return s;
}

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, '0');
export const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => dateStr(new Date());
export const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return dateStr(new Date(y, m - 1, d + n)); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${y !== new Date().getFullYear() ? ', ' + y : ''}`;
}
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${fmtDate(dateStr(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function timeAgo(iso) {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.round(sec / 86400)}d ago`;
  return fmtDate(dateStr(new Date(iso)));
}
export const toLocalInput = (d) => `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const hrs = (n) => {
  n = Number(n) || 0;
  return (Math.round(n * 100) / 100).toString() + 'h';
};
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

// ---------- icons ----------
const ICONS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  check: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
  up: '<polyline points="18 15 12 9 6 15"/>', down: '<polyline points="6 9 12 15 18 9"/>',
  left: '<polyline points="15 18 9 12 15 6"/>', right: '<polyline points="9 18 15 12 9 6"/>',
};
export const icon = (n) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

// ---------- small components ----------
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const avatar = (name, color, cls = '') => `<span class="avatar ${cls}" style="background:${esc(color || '#94a3b8')}" title="${esc(name || 'Unassigned')}">${esc(name ? initials(name) : '?')}</span>`;
const TYPE_LETTER = { task: 'T', bug: 'B', story: 'S', epic: 'E', subtask: '↳' };
export const typeChip = (t) => `<span class="tchip t-${esc(t)}" title="${esc(t)}">${TYPE_LETTER[t] || '?'}</span>`;
const PRIO_ARROW = { critical: '⏫', high: '▲', medium: '■', low: '▼' };
export const prio = (p) => `<span class="prio ${esc(p)}" title="${esc(p)} priority">${PRIO_ARROW[p] || ''} ${esc(p)}</span>`;
export const statusPill = (name, cat) => `<span class="pill ${esc(cat)}">${esc(name)}</span>`;
export function dueLabel(i) {
  if (!i.due_date) return '';
  const done = i.status_category === 'done';
  const t = todayStr();
  const cls = done ? '' : i.due_date < t ? 'over' : i.due_date <= addDays(t, 2) ? 'soon' : '';
  return `<span class="due ${cls}" title="Due date">${icon('calendar').replace('class="ic"', 'class="ic" style="width:12px;height:12px;vertical-align:-1px"')} ${fmtDate(i.due_date)}</span>`;
}
export const progressBar = (done, total, cls = '') => `<div class="progress ${cls}" title="${done} of ${total} done"><i style="width:${pct(done, total)}%"></i></div>`;
export const labels = (arr) => (arr || []).map((l) => `<span class="label">${esc(l)}</span>`).join(' ');
export const opts = (list, sel, valueKey = 'id', labelKey = 'name') => list.map((o) => `<option value="${esc(o[valueKey])}"${String(o[valueKey]) === String(sel ?? '') ? ' selected' : ''}>${esc(o[labelKey])}</option>`).join('');

export function issueRow(i, { showProject = false } = {}) {
  return `<div class="irow" data-open-issue="${i.id}">
    ${typeChip(i.type)}<span class="key">${esc(i.key)}</span>
    <span class="title" title="${esc(i.title)}">${esc(i.title)}</span>
    ${showProject ? `<span class="small muted hide-sm">${esc(i.project_name)}</span>` : ''}
    ${statusPill(i.status_name, i.status_category)}
    <span class="hide-sm">${prio(i.priority)}</span>
    ${dueLabel(i)}
    ${avatar(i.assignee_name, i.assignee_color)}
  </div>`;
}

// ---------- toasts ----------
export function toast(msg, kind = '', ms = 4500, link = null) {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = esc(msg) + (link ? ` <a href="${esc(link)}">Open</a>` : '');
  root.appendChild(el);
  const kill = () => el.remove();
  el.addEventListener('click', kill);
  if (ms) setTimeout(kill, ms);
  while (root.children.length > 5) root.firstChild.remove();
}
export const errToast = (e) => toast(e && e.message ? e.message : String(e), 'error', 6000);

// ---------- modals ----------
let modalStack = [];
export function openModal({ title, body, footer = '', size = '', onMount, onClose }) {
  const root = document.getElementById('modal-root');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title || 'Dialog')}">
    ${title ? `<div class="modal-h"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>` : ''}
    <div class="modal-b">${body}</div>${footer ? `<div class="modal-f">${footer}</div>` : ''}</div>`;
  root.appendChild(ov);
  const handle = {
    el: ov, box: ov.firstElementChild,
    close() {
      if (!ov.isConnected) return;
      ov.remove();
      modalStack = modalStack.filter((m) => m !== handle);
      if (!modalStack.length) document.body.style.overflow = '';
      if (onClose) onClose();
    },
    $: (sel) => ov.querySelector(sel),
    $$: (sel) => [...ov.querySelectorAll(sel)],
  };
  let downOnBackdrop = false;
  ov.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === ov; });
  ov.addEventListener('click', (e) => { if (e.target === ov && downOnBackdrop) handle.close(); else if (e.target.closest('[data-close]')) handle.close(); });
  modalStack.push(handle);
  document.body.style.overflow = 'hidden';
  if (onMount) onMount(handle);
  const first = ov.querySelector('[autofocus], input:not([type=hidden]):not(:disabled), textarea');
  if (first && !onMount) first.focus();
  return handle;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) {
    const top = modalStack[modalStack.length - 1];
    if (document.activeElement && document.activeElement.matches('[data-no-esc]')) return;
    top.close();
  }
});
export const closeAllModals = () => [...modalStack].forEach((m) => m.close());

export function confirmDialog(message, { okText = 'Delete', danger = true, title = 'Are you sure?' } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title, body: `<p style="margin:0">${esc(message)}</p>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'primary' : 'primary'}" data-ok ${danger ? 'style="background:var(--danger);border-color:var(--danger)"' : ''}>${esc(okText)}</button>`,
      onClose: () => resolve(result),
    });
    m.$('[data-ok]').addEventListener('click', () => { result = true; m.close(); });
    m.$('[data-ok]').focus();
  });
}

// ---------- misc ----------
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}
// delegated click handling: on(root, '[data-act]', (el, event) => ...)
export function on(root, event, selector, fn) {
  root.addEventListener(event, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) fn(el, e);
  });
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const nullIfEmpty = (v) => (v === '' || v == null ? null : v);
export const lsGet = (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

// run an async action, show errors as toasts, disable the button meanwhile
export async function guarded(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { errToast(e); } finally { if (btn) btn.disabled = false; }
}

// tiny event bus used by SSE
const handlers = {};
export const bus = {
  on(ev, fn) { (handlers[ev] ||= new Set()).add(fn); return () => handlers[ev].delete(fn); },
  emit(ev, data) { (handlers[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};

export async function loadProjects() {
  state.projects = await get('/api/projects');
  bus.emit('projects');
  return state.projects;
}
export async function loadUsers() {
  state.users = await get('/api/users');
  return state.users;
}
let audioCtx = null;
const getCtx = () => { try { return (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)()); } catch { return null; } };
// browsers only allow sound after the user has clicked/typed once, so unlock audio on the first interaction
['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { const c = getCtx(); if (c && c.state === 'suspended') c.resume(); }, { once: false, passive: true }));
export function beep(kind = 'alert') {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const notes = kind === 'reminder' ? [880, 660, 880] : [784, 1047];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.16;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.17);
    });
  } catch { /* audio unavailable */ }
}
