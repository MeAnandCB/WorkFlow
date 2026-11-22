// End-to-end API test: starts a throw-away server with a temp database and exercises every feature.
// Run with:  node test/test.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 4100 + Math.floor(Math.random() * 500);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-test-'));
const base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server', 'server.js')], { env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = '';
srv.stderr.on('data', (d) => { serverErr += d; });

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body, expect) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const txt = await res.text();
    let data; try { data = JSON.parse(txt); } catch { data = txt; }
    if (expect !== undefined) assert.equal(res.status, expect, `${method} ${url} -> ${res.status} ${txt}`);
    else assert.ok(res.status < 400, `${method} ${url} -> ${res.status} ${txt}`);
    return data;
  }
  get(u, e) { return this.call('GET', u, undefined, e); }
  post(u, b = {}, e) { return this.call('POST', u, b, e); }
  patch(u, b, e) { return this.call('PATCH', u, b, e); }
  del(u, e) { return this.call('DELETE', u, undefined, e); }
}

let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/auth/status'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start: ' + serverErr);
}

async function main() {
  await waitUp();
  const admin = new Client(), bob = new Client(), eve = new Client();

  // ---- auth ----
  assert.equal((await admin.get('/api/auth/status')).needsSetup, true);
  await admin.get('/api/me', 401);
  await admin.post('/api/auth/setup', { name: 'Alice', email: 'alice@x.com', password: '12' }, 400);
  await admin.post('/api/auth/setup', { name: 'Alice', email: 'alice@x.com', password: 'secret1' });
  await admin.post('/api/auth/setup', { name: 'Mallory', email: 'm@x.com', password: 'secret1' }, 403);
  assert.equal((await admin.get('/api/me')).user.role, 'admin');
  ok('first-run setup creates admin');

  const bobU = await admin.post('/api/users', { name: 'Bob', email: 'bob@x.com', password: 'secret2' });
  const eveU = await admin.post('/api/users', { name: 'Eve', email: 'eve@x.com', password: 'secret3' });
  await admin.post('/api/users', { name: 'Dup', email: 'BOB@x.com', password: 'secret2' }, 409);
  await bob.post('/api/auth/login', { email: 'bob@x.com', password: 'wrong' }, 401);
  await bob.post('/api/auth/login', { email: 'bob@x.com', password: 'secret2' });
  await eve.post('/api/auth/login', { email: 'eve@x.com', password: 'secret3' });
  await bob.post('/api/users', { name: 'X', email: 'x@x.com', password: 'secret2' }, 403);
  ok('users, login, admin-only user creation');

  // ---- projects ----
  await admin.post('/api/projects', { name: 'Bad', key: '1x' }, 400);
  const proj = await admin.post('/api/projects', { name: 'Website', key: 'web', description: 'Redesign', members: [{ user_id: bobU.id, role: 'member' }] });
  assert.equal(proj.key, 'WEB');
  assert.equal(proj.columns.length, 4);
  assert.equal(proj.members.length, 2);
  await admin.post('/api/projects', { name: 'Dup', key: 'WEB' }, 409);
  assert.equal((await eve.get('/api/projects')).length, 0);
  await eve.get(`/api/projects/${proj.id}`, 404);
  assert.equal((await bob.get('/api/projects')).length, 1);
  await bob.patch(`/api/projects/${proj.id}`, { name: 'Hacked' }, 403);
  ok('projects & access control');

  const [todo, prog, , done] = proj.columns;

  // ---- sprints ----
  const sp1 = await admin.post(`/api/projects/${proj.id}/sprints`, { name: 'Sprint 1' });
  const sp2 = await admin.post(`/api/projects/${proj.id}/sprints`, {});
  assert.equal(sp2.name, 'Sprint 2');

  // ---- issues ----
  const i1 = await admin.post(`/api/projects/${proj.id}/issues`, { title: 'Design homepage', type: 'story', priority: 'high', assignee_id: bobU.id, estimate_h: 8, due_date: '2020-01-01', labels: ['ui', 'ux'], sprint_id: sp1.id });
  assert.equal(i1.key, 'WEB-1');
  assert.equal(i1.overdue, true);
  const i2 = await bob.post(`/api/projects/${proj.id}/issues`, { title: 'Fix login bug', type: 'bug', priority: 'critical' });
  assert.equal(i2.key, 'WEB-2');
  await admin.post(`/api/projects/${proj.id}/issues`, { title: '', type: 'task' }, 400);
  await admin.post(`/api/projects/${proj.id}/issues`, { title: 'x', assignee_id: eveU.id }, 400); // not a member
  await admin.post(`/api/projects/${proj.id}/issues`, { title: 'x', due_date: '2026-02-31' }, 400);
  await admin.post(`/api/projects/${proj.id}/issues`, { title: 'x', start_date: '2026-05-02', due_date: '2026-05-01' }, 400);
  await eve.post(`/api/projects/${proj.id}/issues`, { title: 'nope' }, 404);
  const sub = await admin.post(`/api/projects/${proj.id}/issues`, { title: 'Sub task', type: 'subtask', parent_id: i1.id });
  await admin.patch(`/api/issues/${i1.id}`, { parent_id: sub.id }, 400); // cycle
  await admin.patch(`/api/issues/${i1.id}`, { parent_id: i1.id }, 400);
  ok('issue create + validation');

  // notifications for assignment
  let n = await bob.get('/api/notifications');
  assert.ok(n.items.some((x) => x.type === 'assigned' && x.text.includes('WEB-1')));
  ok('assignment notification');

  // ---- update / move ----
  let u = await bob.patch(`/api/issues/${i1.id}`, { column_id: prog.id, description: 'Start now', priority: 'low' });
  assert.equal(u.status_name, 'In Progress');
  assert.equal(u.priority, 'low');
  u = await bob.patch(`/api/issues/${i1.id}`, { column_id: done.id });
  assert.ok(u.resolved_at);
  assert.equal(u.overdue, false);
  u = await bob.patch(`/api/issues/${i1.id}`, { column_id: todo.id });
  assert.equal(u.resolved_at, null);
  assert.equal(u.labels.length, 2);
  // unchanged labels must not log activity
  const before = (await admin.get(`/api/issues/${i1.id}`)).activity.length;
  await admin.patch(`/api/issues/${i1.id}`, { labels: ['ui', 'ux'] });
  assert.equal((await admin.get(`/api/issues/${i1.id}`)).activity.length, before);
  // ordering within a column
  await admin.patch(`/api/issues/${sub.id}`, { column_id: todo.id, before_id: i2.id }); // same column, reorder
  let order = (await admin.get(`/api/projects/${proj.id}/issues?status=${todo.id}`)).map((x) => x.key);
  assert.deepEqual(order, ['WEB-3', 'WEB-2', 'WEB-1']);
  await admin.patch(`/api/issues/${i1.id}`, { column_id: todo.id, before_id: sub.id }); // to the top
  order = (await admin.get(`/api/projects/${proj.id}/issues?status=${todo.id}`)).map((x) => x.key);
  assert.deepEqual(order, ['WEB-1', 'WEB-3', 'WEB-2']);
  await admin.patch(`/api/issues/${i1.id}`, { column_id: todo.id, before_id: null }); // to the end
  order = (await admin.get(`/api/projects/${proj.id}/issues?status=${todo.id}`)).map((x) => x.key);
  assert.deepEqual(order, ['WEB-3', 'WEB-2', 'WEB-1']);
  ok('update, move, resolved_at, ordering');

  // filters
  assert.equal((await admin.get(`/api/projects/${proj.id}/issues?q=login`)).length, 1);
  assert.equal((await admin.get(`/api/projects/${proj.id}/issues?q=WEB-1`)).length, 1);
  assert.equal((await admin.get(`/api/projects/${proj.id}/issues?q=%25`)).length, 0);
  assert.equal((await admin.get(`/api/projects/${proj.id}/issues?assignee=none`)).length, 2);
  assert.equal((await admin.get(`/api/projects/${proj.id}/issues?sprint=backlog`)).length, 2);
  assert.equal((await admin.get('/api/search?q=homepage')).length, 1);
  ok('filters & search');

  // ---- comments + mentions ----
  await bob.post(`/api/issues/${i1.id}/comments`, { body: 'Looks good @alice' });
  n = await admin.get('/api/notifications');
  assert.ok(n.items.some((x) => x.type === 'mention'));
  const detail = await admin.get(`/api/issues/${i1.id}`);
  assert.equal(detail.comments.length, 1);
  assert.equal(detail.children.length, 1);
  await eve.post(`/api/issues/${i1.id}/comments`, { body: 'hi' }, 404);
  await admin.del(`/api/comments/${detail.comments[0].id}`);
  ok('comments, mentions');

  // ---- time tracking ----
  await bob.post(`/api/issues/${i1.id}/worklogs`, { hours: 0 }, 400);
  const wl = await bob.post(`/api/issues/${i1.id}/worklogs`, { hours: 2.5, note: 'wireframes' });
  await admin.post(`/api/issues/${i1.id}/worklogs`, { hours: 1, date: '2020-01-02' });
  let iss = await admin.get(`/api/issues/${i1.id}`);
  assert.equal(iss.logged_h, 3.5);
  await admin.del(`/api/worklogs/${wl.id}`); // manager can delete
  assert.equal((await admin.get(`/api/issues/${i1.id}`)).logged_h, 1);
  await bob.post('/api/timer/start', { issue_id: i1.id });
  assert.equal((await bob.get('/api/me')).timer.key, 'WEB-1');
  await bob.post('/api/timer/start', { issue_id: i2.id }); // switching logs the first
  assert.equal((await admin.get(`/api/issues/${i1.id}`)).logged_h > 1, true);
  const stopped = await bob.post('/api/timer/stop');
  assert.ok(stopped.worklog.hours >= 0.01);
  assert.equal((await bob.get('/api/me')).timer, null);
  ok('worklogs and timer');

  // ---- sprints lifecycle ----
  await admin.patch(`/api/sprints/${sp1.id}`, { action: 'start' });
  await admin.patch(`/api/sprints/${sp2.id}`, { action: 'start' }, 400); // one active only
  await admin.patch(`/api/issues/${i2.id}`, { sprint_id: sp1.id });
  await admin.patch(`/api/issues/${i1.id}`, { column_id: done.id });
  let rep = await admin.get(`/api/reports/summary?project=${proj.id}`);
  assert.ok(rep.burndown && rep.burndown.total === 2);
  await admin.patch(`/api/sprints/${sp1.id}`, { action: 'complete', move_to: sp2.id });
  const moved = await admin.get(`/api/issues/${i2.id}`);
  assert.equal(moved.sprint_id, sp2.id);
  assert.equal((await admin.get(`/api/issues/${i1.id}`)).sprint_id, sp1.id);
  await admin.patch(`/api/issues/${i2.id}`, { sprint_id: sp1.id }, 400); // completed
  ok('sprint start/complete/carry-over');

  // ---- columns ----
  const c = (await admin.post(`/api/projects/${proj.id}/columns`, { name: 'QA', category: 'in_progress' }));
  const qa = c[c.length - 1];
  await admin.patch(`/api/columns/${qa.id}`, { name: 'Testing', move: 'left' });
  await admin.patch(`/api/issues/${i2.id}`, { column_id: qa.id });
  await admin.del(`/api/columns/${qa.id}`, 400); // has issues, no target
  await admin.del(`/api/columns/${qa.id}?move_to=${todo.id}`);
  assert.equal((await admin.get(`/api/issues/${i2.id}`)).column_id, todo.id);
  await admin.del(`/api/columns/${done.id}`, 400); // last done column
  await admin.patch(`/api/columns/${done.id}`, { category: 'todo' }, 400);
  ok('board columns');

  // ---- reminders ----
  const soon = new Date(Date.now() + 1000).toISOString();
  const rem = await bob.post('/api/reminders', { title: 'Call client', remind_at: soon, issue_id: i1.id });
  await bob.post('/api/reminders', { title: '', remind_at: soon }, 400);
  await bob.post('/api/reminders', { title: 'x', remind_at: 'garbage' }, 400);
  await new Promise((r) => setTimeout(r, 12000));
  n = await bob.get('/api/notifications');
  assert.ok(n.items.some((x) => x.type === 'reminder' && x.text.includes('Call client')), 'reminder should have fired');
  await bob.patch(`/api/reminders/${rem.id}`, { done: true });
  await eve.patch(`/api/reminders/${rem.id}`, { done: false }, 404);
  const list = await bob.get('/api/reminders');
  assert.equal(list[0].issue_key, 'WEB-1');
  ok('reminders fire via scheduler');

  // due-date alert (issue 2 assigned? assign then check)
  // ---- chat ----
  const chans = await bob.get('/api/channels');
  const general = chans.find((x) => x.type === 'general');
  const pch = chans.find((x) => x.type === 'project');
  assert.ok(general && pch);
  assert.equal((await eve.get('/api/channels')).filter((x) => x.type === 'project').length, 0);
  await eve.get(`/api/channels/${pch.id}/messages`, 404);
  await bob.post(`/api/channels/${pch.id}/messages`, { body: 'Hello team @alice' });
  await bob.post(`/api/channels/${pch.id}/messages`, { body: '   ' }, 400);
  assert.equal((await admin.get('/api/channels')).find((x) => x.id === pch.id).unread, 1);
  assert.equal((await admin.get(`/api/channels/${pch.id}/messages`)).length, 1);
  await admin.post(`/api/channels/${pch.id}/read`);
  assert.equal((await admin.get('/api/channels')).find((x) => x.id === pch.id).unread, 0);
  const dm = await admin.post('/api/channels/dm', { user_id: bobU.id });
  const dm2 = await bob.post('/api/channels/dm', { user_id: 1 });
  assert.equal(dm.id, dm2.id);
  await eve.get(`/api/channels/${dm.id}/messages`, 404);
  await admin.post(`/api/channels/${dm.id}/messages`, { body: 'hi bob' });
  assert.equal((await bob.get('/api/channels')).find((x) => x.id === dm.id).unread, 1);
  await admin.post('/api/channels/dm', { user_id: 1 }, 400);
  ok('chat channels, DMs, unread, access');

  // ---- chat attachments ----
  const up = (client, ch, name, bytes, caption = '') => fetch(base + '/api/channels/' + ch + '/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: client.cookie, 'X-File-Name': encodeURIComponent(name), 'X-Caption': encodeURIComponent(caption) }, body: bytes });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let r1 = await up(bob, pch.id, 'pic.png', png, 'look');
  assert.equal(r1.status, 200);
  const fm = await r1.json();
  assert.equal(fm.file_type, 'image/png');
  assert.equal(fm.body, 'look');
  assert.equal(fm.file_key, undefined);
  const got = await fetch(base + '/api/files/' + fm.id, { headers: { Cookie: admin.cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await got.arrayBuffer()).length, png.length);
  const rng = await fetch(base + '/api/files/' + fm.id, { headers: { Cookie: admin.cookie, Range: 'bytes=0-9' } });
  assert.equal(rng.status, 206);
  assert.equal((await fetch(base + '/api/files/' + fm.id, { headers: { Cookie: eve.cookie } })).status, 404); // eve is not in the project
  const html = await (await up(bob, pch.id, 'evil.html', Buffer.from('<script>alert(1)</script>'))).json();
  const hg = await fetch(base + '/api/files/' + html.id, { headers: { Cookie: admin.cookie } });
  assert.match(hg.headers.get('content-disposition'), /^attachment/);
  assert.equal(hg.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await up(bob, pch.id, 'big.bin', Buffer.alloc(26 * 1024 * 1024))).status, 413);
  assert.equal((await up(bob, pch.id, 'empty.txt', Buffer.alloc(0))).status, 400);
  assert.equal((await up(bob, general.id, 'a.mp3', Buffer.from('ID3xxxx'))).status, 200);
  assert.ok((await admin.get('/api/channels/' + pch.id + '/messages')).some((m) => m.file_name === 'pic.png'));
  ok('chat attachments (image/audio/file, range, access, forced download)');

  // ---- reports ----
  rep = await admin.get(`/api/reports/summary?project=${proj.id}`);
  assert.equal(rep.totals.total, 3);
  assert.equal(rep.totals.done, 1);
  assert.ok(rep.totals.logged_h > 1);
  assert.ok(rep.time_by_day.length === 30);
  assert.ok(rep.pending.length === 2);
  assert.equal(rep.velocity.length, 1);
  await admin.get('/api/reports/summary?from=2026-05-02&to=2026-05-01', 400);
  const all = await bob.get('/api/reports/summary');
  assert.equal(all.by_project.length, 1);
  const csv = await admin.get('/api/reports/timesheet.csv?from=2020-01-01&to=2020-12-31');
  assert.ok(csv.includes('Hours') && csv.includes('2020-01-02'));
  assert.ok((await admin.get('/api/reports/issues.csv')).includes('WEB-1'));
  const dash = await bob.get('/api/dashboard');
  assert.ok(dash.stats && Array.isArray(dash.my_issues));
  ok('reports, CSV export, dashboard');

  // ---- members, archive, delete ----
  await admin.post(`/api/projects/${proj.id}/members`, { user_id: eveU.id, role: 'viewer' });
  await eve.post(`/api/projects/${proj.id}/issues`, { title: 'viewer cannot' }, 403);
  assert.equal((await eve.get(`/api/projects/${proj.id}/issues`)).length, 3);
  await admin.del(`/api/projects/${proj.id}/members/${eveU.id}`);
  await eve.get(`/api/projects/${proj.id}`, 404);
  await admin.del(`/api/projects/${proj.id}/members/1`, 400); // sole manager
  ok('member roles');

  // ---- user admin safety ----
  await admin.patch('/api/users/1', { role: 'member' }, 400);
  await admin.patch('/api/users/1', { active: false }, 400);
  await admin.patch(`/api/users/${eveU.id}`, { active: false });
  await eve.get('/api/me', 401);
  await eve.post('/api/auth/login', { email: 'eve@x.com', password: 'secret3' }, 401);
  await admin.patch('/api/me', { new_password: 'newpass1', current_password: 'bad' }, 400);
  await admin.patch('/api/me', { new_password: 'newpass1', current_password: 'secret1' });
  ok('user management safeguards, password change');

  // ---- delete issue / project ----
  await bob.del(`/api/issues/${i1.id}`, 403); // reporter is admin, bob is a plain member
  await admin.del(`/api/issues/${sub.id}`);
  await admin.del(`/api/projects/${proj.id}`);
  assert.equal((await admin.get('/api/projects')).length, 0);
  await bob.get(`/api/projects/${proj.id}`, 404);
  ok('delete issue/project');

  // ---- csrf ----
  const res = await fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Cookie: admin.cookie }, body: '{}' });
  assert.equal(res.status, 403);
  ok('cross-origin write blocked');

  // ---- static ----
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/..%2fserver%2fdb.js')).status >= 400, true);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status >= 400, true);
  ok('static files & traversal protection');
}

main().then(() => { console.log(`\nAll ${passed} test groups passed.`); }).catch((e) => {
  console.error('\nTEST FAILED:', e.message || e);
  if (serverErr) console.error('server stderr:\n' + serverErr);
  process.exitCode = 1;
}).finally(() => { srv.kill(); setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(process.exitCode || 0); }, 300); });
