// TaskFlow - local project management server (no external dependencies; needs Node 22.5+)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { q, now, today, addDays, DB_FILE } from './db.js';
import { route, dispatch, RAW } from './router.js';
import { addClient, sendTo } from './hub.js';
import { notify } from './core.js';
import './routes.js';
import './reports.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // set HOST=127.0.0.1 to keep it on this computer only
const PUBLIC = path.join(import.meta.dirname, '..', 'public');

// live updates (chat, notifications, board changes)
route('GET', '/api/events', ({ req, res, user }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  addClient(user.id, res);
  req.on('close', () => res.end());
  return RAW;
});

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': st.size, ...SECURITY });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  if (url.pathname.startsWith('/api/')) return dispatch(req, res, url);
  serveStatic(req, res, url);
});

// ---------- background scheduler: reminders + due-date alerts ----------
function nextOccurrence(iso, repeat) {
  const d = new Date(iso);
  const step = () => {
    if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
  };
  do { step(); } while (d.getTime() <= Date.now());
  return d.toISOString();
}

function fireReminders() {
  const due = q.all('SELECT * FROM reminders WHERE done=0 AND notified=0 AND remind_at<=?', now());
  for (const r of due) {
    const link = r.issue_id ? `#/issue/${r.issue_id}` : '#/reminders';
    notify(r.user_id, 'reminder', `Reminder: ${r.title}`, link);
    sendTo([r.user_id], 'reminder', { id: r.id, title: r.title, note: r.note, link });
    if (r.repeat !== 'none') q.run('UPDATE reminders SET remind_at=?, notified=0 WHERE id=?', nextOccurrence(r.remind_at, r.repeat), r.id);
    else q.run('UPDATE reminders SET notified=1 WHERE id=?', r.id);
  }
}

function dueAlerts() {
  const t = today(), tomorrow = addDays(t, 1);
  const rows = q.all(`SELECT i.id, i.title, i.due_date, i.assignee_id, p.key||'-'||i.num AS key
    FROM issues i JOIN board_columns c ON c.id=i.column_id JOIN projects p ON p.id=i.project_id
    JOIN users u ON u.id=i.assignee_id
    WHERE c.category!='done' AND p.status='active' AND u.active=1 AND i.due_date IS NOT NULL AND i.due_date<=?`, tomorrow);
  for (const i of rows) {
    const kind = i.due_date < t ? 'overdue' : i.due_date === t ? 'today' : 'tomorrow';
    const text = kind === 'overdue' ? `${i.key} is overdue (was due ${i.due_date}): ${i.title}` : `${i.key} is due ${kind}: ${i.title}`;
    notify(i.assignee_id, 'due', text, `#/issue/${i.id}`, `due:${i.id}:${kind}:${t}`);
  }
}

function tick() {
  try { fireReminders(); } catch (e) { console.error('reminder error', e); }
}
let lastSweep = 0;
function slowTick() {
  try {
    dueAlerts();
    q.run('DELETE FROM sessions WHERE expires_at<?', now());
    q.run('DELETE FROM notifications WHERE read=1 AND created_at<?', new Date(Date.now() - 60 * 864e5).toISOString());
  } catch (e) { console.error('sweep error', e); }
  lastSweep = Date.now();
}
setInterval(() => { tick(); if (Date.now() - lastSweep > 10 * 60000) slowTick(); }, 10000).unref();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Close the other program, or start with a different port:\n  set PORT=3001 && node server/server.js\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  tick(); slowTick();
  console.log('\n  TaskFlow is running\n');
  console.log(`  This computer:  http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Team (same Wi-Fi/LAN):  http://${n.address}:${PORT}`);
    }
  }
  console.log(`\n  Data file: ${DB_FILE}\n  Press Ctrl+C to stop.\n`);
});

function shutdown() { server.close(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
