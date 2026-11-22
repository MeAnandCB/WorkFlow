// API routes: auth, users, projects, sprints, issues, time, reminders, notifications, chat
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, tx, now, today, addDays, DATA_DIR } from './db.js';
import { route, RAW, parseCookies } from './router.js';
import { sendTo } from './hub.js';
import {
  E, str, num, date, oneOf, intId, has, ROLES, PROJECT_ROLES, TYPES, PRIORITIES, CATEGORIES,
  hashPassword, verifyPassword, checkPassword, createSession, destroySession, publicUser, pickColor,
  projectIdsFor, memberRole, needProject, projectUserIds, inList, logActivity, notify, projectEvent, mentionedUsers,
} from './core.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cookie = (token, maxAge) => `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const getEmail = (v) => {
  const e = str(v, 'Email', { req: true, max: 120 }).toLowerCase();
  if (!EMAIL_RE.test(e)) throw E(400, 'Enter a valid email address');
  return e;
};

// ================= AUTH =================
const attempts = new Map(); // ip|email -> {n, until}
function throttle(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.n >= 8) throw E(429, 'Too many failed attempts. Try again in a few minutes.');
}
function failed(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now()) a.n++; else attempts.set(key, { n: 1, until: Date.now() + 10 * 60000 });
}

route('GET', '/api/auth/status', () => ({ needsSetup: q.get('SELECT COUNT(*) c FROM users').c === 0 }), { public: true });

route('POST', '/api/auth/setup', ({ body, res }) => {
  if (q.get('SELECT COUNT(*) c FROM users').c > 0) throw E(403, 'Setup is already complete');
  const name = str(body.name, 'Name', { req: true, max: 80 });
  const email = getEmail(body.email);
  checkPassword(body.password);
  const r = q.run('INSERT INTO users(name,email,password_hash,role,color,created_at) VALUES(?,?,?,?,?,?)', name, email, hashPassword(body.password), 'admin', pickColor(0), now());
  res.setHeader('Set-Cookie', cookie(createSession(Number(r.lastInsertRowid)), 2592000));
  return { ok: true };
}, { public: true });

route('POST', '/api/auth/login', ({ body, req, res }) => {
  const email = str(body.email, 'Email', { req: true, max: 120 }).toLowerCase();
  const key = `${req.socket.remoteAddress}|${email}`;
  throttle(key);
  const u = q.get('SELECT * FROM users WHERE email=?', email);
  if (!u || !u.active || typeof body.password !== 'string' || !verifyPassword(body.password, u.password_hash)) {
    failed(key);
    throw E(401, 'Invalid email or password');
  }
  attempts.delete(key);
  res.setHeader('Set-Cookie', cookie(createSession(u.id), 2592000));
  return { ok: true };
}, { public: true });

route('POST', '/api/auth/logout', ({ res, token }) => {
  destroySession(token);
  res.setHeader('Set-Cookie', cookie('', 0));
  return { ok: true };
}, { public: true });

route('GET', '/api/me', ({ user }) => ({
  user: publicUser(user),
  unread: q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', user.id).c,
  timer: getTimer(user.id),
}));

route('PATCH', '/api/me', ({ user, body }) => {
  const sets = [], vals = [];
  if (has(body, 'name')) { sets.push('name=?'); vals.push(str(body.name, 'Name', { req: true, max: 80 })); }
  if (has(body, 'color')) {
    if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw E(400, 'Invalid color');
    sets.push('color=?'); vals.push(body.color);
  }
  if (body.new_password) {
    const u = q.get('SELECT password_hash FROM users WHERE id=?', user.id);
    if (!verifyPassword(String(body.current_password || ''), u.password_hash)) throw E(400, 'Current password is incorrect');
    checkPassword(body.new_password);
    sets.push('password_hash=?'); vals.push(hashPassword(body.new_password));
  }
  if (sets.length) q.run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...vals, user.id);
  return { user: publicUser(q.get('SELECT * FROM users WHERE id=?', user.id)) };
});

// ================= USERS (team) =================
route('GET', '/api/users', ({ user }) => {
  const rows = user.role === 'admin' ? q.all('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE') : q.all('SELECT * FROM users WHERE active=1 ORDER BY name COLLATE NOCASE');
  return rows.map(publicUser);
});

function adminOnly(user) { if (user.role !== 'admin') throw E(403, 'Only administrators can do this'); }
const activeAdmins = () => q.get("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").c;

route('POST', '/api/users', ({ user, body }) => {
  adminOnly(user);
  const name = str(body.name, 'Name', { req: true, max: 80 });
  const email = getEmail(body.email);
  checkPassword(body.password);
  const role = oneOf(body.role, ROLES, 'Role', 'member');
  const n = q.get('SELECT COUNT(*) c FROM users').c;
  const r = q.run('INSERT INTO users(name,email,password_hash,role,color,created_at) VALUES(?,?,?,?,?,?)', name, email, hashPassword(body.password), role, pickColor(n), now());
  return publicUser(q.get('SELECT * FROM users WHERE id=?', Number(r.lastInsertRowid)));
});

route('PATCH', '/api/users/:id', ({ user, params, body }) => {
  adminOnly(user);
  const id = intId(params.id);
  const t = q.get('SELECT * FROM users WHERE id=?', id);
  if (!t) throw E(404, 'User not found');
  const sets = [], vals = [];
  if (has(body, 'name')) { sets.push('name=?'); vals.push(str(body.name, 'Name', { req: true, max: 80 })); }
  if (has(body, 'email')) { sets.push('email=?'); vals.push(getEmail(body.email)); }
  const newRole = has(body, 'role') ? oneOf(body.role, ROLES, 'Role') : t.role;
  const newActive = has(body, 'active') ? (body.active ? 1 : 0) : t.active;
  if (t.role === 'admin' && t.active && (newRole !== 'admin' || !newActive) && activeAdmins() <= 1) throw E(400, 'There must be at least one active administrator');
  if (id === user.id && !newActive) throw E(400, 'You cannot deactivate yourself');
  if (newRole !== t.role) { sets.push('role=?'); vals.push(newRole); }
  if (newActive !== t.active) { sets.push('active=?'); vals.push(newActive); }
  if (body.password) { checkPassword(body.password); sets.push('password_hash=?'); vals.push(hashPassword(body.password)); }
  if (sets.length) {
    q.run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...vals, id);
    if (!newActive || body.password) q.run('DELETE FROM sessions WHERE user_id=?', id);
    if (!newActive) q.run('DELETE FROM timers WHERE user_id=?', id);
  }
  return publicUser(q.get('SELECT * FROM users WHERE id=?', id));
});

// ================= PROJECTS =================
const projectStatsSql = `
  (SELECT COUNT(*) FROM issues i WHERE i.project_id=p.id) AS total,
  (SELECT COUNT(*) FROM issues i JOIN board_columns c ON c.id=i.column_id WHERE i.project_id=p.id AND c.category='done') AS done,
  (SELECT COUNT(*) FROM issues i JOIN board_columns c ON c.id=i.column_id WHERE i.project_id=p.id AND c.category!='done' AND i.due_date<? ) AS overdue,
  COALESCE((SELECT SUM(estimate_h) FROM issues i WHERE i.project_id=p.id),0) AS estimate_h,
  COALESCE((SELECT SUM(w.hours) FROM worklogs w JOIN issues i ON i.id=w.issue_id WHERE i.project_id=p.id),0) AS logged_h,
  (SELECT COUNT(*) FROM project_members m WHERE m.project_id=p.id) AS member_count`;

route('GET', '/api/projects', ({ user }) => {
  const ids = projectIdsFor(user);
  if (!ids.length) return [];
  return q.all(`SELECT p.*, ${projectStatsSql}, (SELECT name FROM users u WHERE u.id=p.created_by) AS creator FROM projects p WHERE p.id IN (${inList(ids)}) ORDER BY p.status, p.name COLLATE NOCASE`, today(), ...ids)
    .map((p) => ({ ...p, role: memberRole(user, p.id) }));
});

function projectDetail(user, pid) {
  const { p, role } = needProject(user, pid);
  const stats = q.get(`SELECT ${projectStatsSql} FROM projects p WHERE p.id=?`, today(), pid);
  const members = q.all('SELECT u.id,u.name,u.email,u.color,u.active,m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.name COLLATE NOCASE', pid);
  const assignable = q.all(`SELECT id,name,color FROM users WHERE active=1 AND (role='admin' OR id IN (SELECT user_id FROM project_members WHERE project_id=? AND role!='viewer')) ORDER BY name COLLATE NOCASE`, pid);
  return {
    ...p, ...stats, role,
    columns: q.all('SELECT * FROM board_columns WHERE project_id=? ORDER BY position, id', pid),
    sprints: q.all("SELECT s.*, (SELECT COUNT(*) FROM issues i WHERE i.sprint_id=s.id) AS issue_count FROM sprints s WHERE project_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, id DESC", pid),
    members, assignable,
    channel_id: (q.get('SELECT id FROM channels WHERE project_id=?', pid) || {}).id || null,
  };
}

function readMembers(list) {
  if (!Array.isArray(list)) return [];
  return list.map((m) => {
    const o = typeof m === 'object' && m ? m : { user_id: m };
    const uid = intId(o.user_id, 'Member');
    if (!q.get('SELECT id FROM users WHERE id=? AND active=1', uid)) throw E(400, 'A selected team member no longer exists');
    return { user_id: uid, role: oneOf(o.role, PROJECT_ROLES, 'Member role', 'member') };
  });
}

route('POST', '/api/projects', ({ user, body }) => {
  const name = str(body.name, 'Project name', { req: true, max: 100 });
  const key = str(body.key, 'Project key', { req: true, max: 10 }).toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw E(400, 'Project key must be 2-10 letters/numbers and start with a letter (e.g. WEB)');
  const description = str(body.description, 'Description', { max: 5000 });
  const start = date(body.start_date, 'Start date'), end = date(body.end_date, 'End date');
  if (start && end && end < start) throw E(400, 'End date cannot be before start date');
  const members = readMembers(body.members);
  if (q.get('SELECT id FROM projects WHERE key=?', key)) throw E(409, `The key ${key} is already used by another project`);
  const pid = tx(() => {
    const r = q.run('INSERT INTO projects(key,name,description,start_date,end_date,created_by,created_at) VALUES(?,?,?,?,?,?,?)', key, name, description, start, end, user.id, now());
    const id = Number(r.lastInsertRowid);
    [['To Do', 'todo'], ['In Progress', 'in_progress'], ['In Review', 'in_progress'], ['Done', 'done']]
      .forEach(([n, c], i) => q.run('INSERT INTO board_columns(project_id,name,category,position) VALUES(?,?,?,?)', id, n, c, i));
    q.run("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'manager')", id, user.id);
    for (const m of members) if (m.user_id !== user.id) q.run('INSERT OR IGNORE INTO project_members(project_id,user_id,role) VALUES(?,?,?)', id, m.user_id, m.role);
    q.run("INSERT INTO channels(type,name,project_id) VALUES('project',?,?)", name, id);
    logActivity(id, null, user.id, 'project_created', `created project ${name}`);
    return id;
  });
  for (const m of members) if (m.user_id !== user.id) notify(m.user_id, 'project', `${user.name} added you to project ${name}`, `#/p/${pid}/board`);
  projectEvent(pid, 'project');
  return projectDetail(user, pid);
});

route('GET', '/api/projects/:id', ({ user, params }) => projectDetail(user, intId(params.id)));

route('PATCH', '/api/projects/:id', ({ user, params, body }) => {
  const pid = intId(params.id);
  const { p } = needProject(user, pid, 'manage');
  const name = has(body, 'name') ? str(body.name, 'Project name', { req: true, max: 100 }) : p.name;
  const description = has(body, 'description') ? str(body.description, 'Description', { max: 5000 }) : p.description;
  const start = has(body, 'start_date') ? date(body.start_date, 'Start date') : p.start_date;
  const end = has(body, 'end_date') ? date(body.end_date, 'End date') : p.end_date;
  const status = has(body, 'status') ? oneOf(body.status, ['active', 'archived'], 'Status') : p.status;
  if (start && end && end < start) throw E(400, 'End date cannot be before start date');
  q.run('UPDATE projects SET name=?,description=?,start_date=?,end_date=?,status=? WHERE id=?', name, description, start, end, status, pid);
  q.run("UPDATE channels SET name=? WHERE project_id=?", name, pid);
  logActivity(pid, null, user.id, 'project_updated', 'updated project settings');
  projectEvent(pid, 'project');
  return projectDetail(user, pid);
});

route('DELETE', '/api/projects/:id', ({ user, params }) => {
  const pid = intId(params.id);
  needProject(user, pid, 'manage');
  const ids = projectUserIds(pid);
  q.run('DELETE FROM projects WHERE id=?', pid);
  sendTo(ids, 'project', { project_id: pid, kind: 'deleted' });
});

route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
  const pid = intId(params.id);
  const { p } = needProject(user, pid, 'manage');
  const [m] = readMembers([body]);
  if (!m) throw E(400, 'Choose a team member');
  q.run('INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role', pid, m.user_id, m.role);
  notify(m.user_id, 'project', `${user.name} added you to project ${p.name}`, `#/p/${pid}/board`);
  logActivity(pid, null, user.id, 'member_added', `added ${q.get('SELECT name FROM users WHERE id=?', m.user_id).name} to the team`);
  projectEvent(pid, 'project');
  return projectDetail(user, pid);
});

route('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
  const pid = intId(params.id), uid = intId(params.uid);
  needProject(user, pid, 'manage');
  const m = q.get('SELECT role FROM project_members WHERE project_id=? AND user_id=?', pid, uid);
  if (!m) throw E(404, 'Member not found');
  if (m.role === 'manager' && q.get("SELECT COUNT(*) c FROM project_members WHERE project_id=? AND role='manager'", pid).c <= 1) throw E(400, 'A project needs at least one manager');
  tx(() => {
    q.run('DELETE FROM project_members WHERE project_id=? AND user_id=?', pid, uid);
    q.run('UPDATE issues SET assignee_id=NULL WHERE project_id=? AND assignee_id=?', pid, uid);
    q.run('DELETE FROM timers WHERE user_id=? AND issue_id IN (SELECT id FROM issues WHERE project_id=?)', uid, pid);
    logActivity(pid, null, user.id, 'member_removed', `removed ${q.get('SELECT name FROM users WHERE id=?', uid).name} from the team`);
  });
  sendTo([uid], 'project', { project_id: pid, kind: 'deleted' });
  projectEvent(pid, 'project');
  return projectDetail(user, pid);
});

// ---- board columns ----
function columnFor(user, id, level = 'manage') {
  const c = q.get('SELECT * FROM board_columns WHERE id=?', id);
  if (!c) throw E(404, 'Column not found');
  needProject(user, c.project_id, level);
  return c;
}
const doneCount = (pid, exceptId = 0) => q.get("SELECT COUNT(*) c FROM board_columns WHERE project_id=? AND category='done' AND id!=?", pid, exceptId).c;

route('POST', '/api/projects/:id/columns', ({ user, params, body }) => {
  const pid = intId(params.id);
  needProject(user, pid, 'manage');
  const name = str(body.name, 'Column name', { req: true, max: 40 });
  const category = oneOf(body.category, CATEGORIES, 'Category', 'in_progress');
  if (q.get('SELECT COUNT(*) c FROM board_columns WHERE project_id=?', pid).c >= 12) throw E(400, 'A board can have at most 12 columns');
  const pos = q.get('SELECT COALESCE(MAX(position),-1)+1 p FROM board_columns WHERE project_id=?', pid).p;
  q.run('INSERT INTO board_columns(project_id,name,category,position) VALUES(?,?,?,?)', pid, name, category, pos);
  projectEvent(pid, 'project');
  return projectDetail(user, pid).columns;
});

route('PATCH', '/api/columns/:id', ({ user, params, body }) => {
  const c = columnFor(user, intId(params.id));
  const name = has(body, 'name') ? str(body.name, 'Column name', { req: true, max: 40 }) : c.name;
  const category = has(body, 'category') ? oneOf(body.category, CATEGORIES, 'Category') : c.category;
  if (category !== 'done' && c.category === 'done' && doneCount(c.project_id, c.id) === 0) throw E(400, 'The board needs at least one "Done" column');
  tx(() => {
    q.run('UPDATE board_columns SET name=?,category=? WHERE id=?', name, category, c.id);
    if (category !== c.category) {
      if (category === 'done') q.run('UPDATE issues SET resolved_at=? WHERE column_id=? AND resolved_at IS NULL', now(), c.id);
      else if (c.category === 'done') q.run('UPDATE issues SET resolved_at=NULL WHERE column_id=?', c.id);
    }
    if (body.move === 'left' || body.move === 'right') {
      const cols = q.all('SELECT id FROM board_columns WHERE project_id=? ORDER BY position,id', c.project_id).map((r) => r.id);
      const i = cols.indexOf(c.id), j = body.move === 'left' ? i - 1 : i + 1;
      if (j >= 0 && j < cols.length) { [cols[i], cols[j]] = [cols[j], cols[i]]; cols.forEach((id, k) => q.run('UPDATE board_columns SET position=? WHERE id=?', k, id)); }
    }
  });
  projectEvent(c.project_id, 'project');
  return q.all('SELECT * FROM board_columns WHERE project_id=? ORDER BY position,id', c.project_id);
});

route('DELETE', '/api/columns/:id', ({ user, params, query }) => {
  const c = columnFor(user, intId(params.id));
  if (q.get('SELECT COUNT(*) c FROM board_columns WHERE project_id=?', c.project_id).c <= 1) throw E(400, 'A board needs at least one column');
  if (c.category === 'done' && doneCount(c.project_id, c.id) === 0) throw E(400, 'The board needs at least one "Done" column');
  const used = q.get('SELECT COUNT(*) c FROM issues WHERE column_id=?', c.id).c;
  tx(() => {
    if (used) {
      const to = q.get('SELECT * FROM board_columns WHERE id=? AND project_id=? AND id!=?', Number(query.move_to) || 0, c.project_id, c.id);
      if (!to) throw E(400, 'Choose a column to move the existing issues into');
      const end = q.get('SELECT COALESCE(MAX(position),0) p FROM issues WHERE column_id=?', to.id).p;
      const rows = q.all('SELECT id FROM issues WHERE column_id=? ORDER BY position', c.id);
      rows.forEach((r, i) => q.run('UPDATE issues SET column_id=?, position=?, resolved_at=? WHERE id=?', to.id, end + (i + 1) * 1000, to.category === 'done' ? now() : null, r.id));
    }
    q.run('DELETE FROM board_columns WHERE id=?', c.id);
  });
  projectEvent(c.project_id, 'project');
  return q.all('SELECT * FROM board_columns WHERE project_id=? ORDER BY position,id', c.project_id);
});

// ---- sprints ----
function sprintFor(user, id, level = 'edit') {
  const s = q.get('SELECT * FROM sprints WHERE id=?', id);
  if (!s) throw E(404, 'Sprint not found');
  needProject(user, s.project_id, level);
  return s;
}
route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
  const pid = intId(params.id);
  needProject(user, pid, 'edit');
  const n = q.get('SELECT COUNT(*) c FROM sprints WHERE project_id=?', pid).c + 1;
  const name = str(body.name, 'Sprint name', { max: 80 }) || `Sprint ${n}`;
  const start = date(body.start_date, 'Start date'), end = date(body.end_date, 'End date');
  if (start && end && end < start) throw E(400, 'End date cannot be before start date');
  const r = q.run('INSERT INTO sprints(project_id,name,goal,start_date,end_date) VALUES(?,?,?,?,?)', pid, name, str(body.goal, 'Goal', { max: 500 }), start, end);
  logActivity(pid, null, user.id, 'sprint_created', `created ${name}`);
  projectEvent(pid, 'sprint');
  return q.get('SELECT * FROM sprints WHERE id=?', Number(r.lastInsertRowid));
});

route('PATCH', '/api/sprints/:id', ({ user, params, body }) => {
  const s = sprintFor(user, intId(params.id));
  if (s.status === 'completed') throw E(400, 'This sprint is already completed');
  const name = has(body, 'name') ? str(body.name, 'Sprint name', { req: true, max: 80 }) : s.name;
  const goal = has(body, 'goal') ? str(body.goal, 'Goal', { max: 500 }) : s.goal;
  let start = has(body, 'start_date') ? date(body.start_date, 'Start date') : s.start_date;
  let end = has(body, 'end_date') ? date(body.end_date, 'End date') : s.end_date;
  let status = s.status, committed = s.committed, completedAt = s.completed_at;
  if (body.action === 'start') {
    if (s.status !== 'planned') throw E(400, 'Only a planned sprint can be started');
    if (q.get("SELECT id FROM sprints WHERE project_id=? AND status='active'", s.project_id)) throw E(400, 'Another sprint is already active. Complete it first.');
    start = start || today();
    end = end || addDays(start, 14);
    status = 'active';
  } else if (body.action === 'complete') {
    if (s.status !== 'active') throw E(400, 'Only an active sprint can be completed');
    status = 'completed'; completedAt = now();
    committed = q.get('SELECT COUNT(*) c FROM issues WHERE sprint_id=?', s.id).c;
  } else if (body.action) throw E(400, 'Unknown action');
  if (start && end && end < start) throw E(400, 'End date cannot be before start date');
  tx(() => {
    q.run('UPDATE sprints SET name=?,goal=?,start_date=?,end_date=?,status=?,committed=?,completed_at=? WHERE id=?', name, goal, start, end, status, committed, completedAt, s.id);
    if (body.action === 'complete') {
      let target = null;
      if (body.move_to) {
        const t = q.get("SELECT id FROM sprints WHERE id=? AND project_id=? AND status='planned'", Number(body.move_to), s.project_id);
        if (!t) throw E(400, 'Choose a planned sprint to move unfinished issues into');
        target = t.id;
      }
      q.run("UPDATE issues SET sprint_id=? WHERE sprint_id=? AND column_id IN (SELECT id FROM board_columns WHERE category!='done')", target, s.id);
    }
    if (body.action) logActivity(s.project_id, null, user.id, `sprint_${body.action}`, `${body.action === 'start' ? 'started' : 'completed'} ${name}`);
  });
  projectEvent(s.project_id, 'sprint');
  return q.get('SELECT * FROM sprints WHERE id=?', s.id);
});

route('DELETE', '/api/sprints/:id', ({ user, params }) => {
  const s = sprintFor(user, intId(params.id), 'manage');
  if (s.status === 'active') throw E(400, 'Complete the active sprint before deleting it');
  q.run('DELETE FROM sprints WHERE id=?', s.id);
  projectEvent(s.project_id, 'sprint');
});

// ================= ISSUES =================
const ISSUE_SQL = `
SELECT i.*, p.key AS pkey, p.name AS project_name, c.name AS status_name, c.category AS status_category,
  a.name AS assignee_name, a.color AS assignee_color, rp.name AS reporter_name,
  s.name AS sprint_name, par.title AS parent_title, par.num AS parent_num,
  COALESCE((SELECT SUM(hours) FROM worklogs w WHERE w.issue_id=i.id),0) AS logged_h,
  (SELECT COUNT(*) FROM issues x WHERE x.parent_id=i.id) AS sub_total,
  (SELECT COUNT(*) FROM issues x JOIN board_columns xc ON xc.id=x.column_id WHERE x.parent_id=i.id AND xc.category='done') AS sub_done
FROM issues i
JOIN projects p ON p.id=i.project_id
JOIN board_columns c ON c.id=i.column_id
LEFT JOIN users a ON a.id=i.assignee_id
LEFT JOIN users rp ON rp.id=i.reporter_id
LEFT JOIN sprints s ON s.id=i.sprint_id
LEFT JOIN issues par ON par.id=i.parent_id`;

function shape(r) {
  return {
    ...r,
    key: `${r.pkey}-${r.num}`,
    parent_key: r.parent_id ? `${r.pkey}-${r.parent_num}` : null,
    labels: r.labels ? r.labels.split(',') : [],
    overdue: !!(r.due_date && r.due_date < today() && r.status_category !== 'done'),
  };
}
const issueById = (id) => { const r = q.get(ISSUE_SQL + ' WHERE i.id=?', id); return r ? shape(r) : null; };
function needIssue(user, id, level = 'view') {
  const r = q.get('SELECT project_id FROM issues WHERE id=?', id);
  if (!r) throw E(404, 'Issue not found');
  const { role } = needProject(user, r.project_id, level);
  return { issue: issueById(id), role };
}

function readLabels(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (let l of arr) {
    l = String(l).trim().replace(/,/g, '');
    if (!l) continue;
    if (l.length > 30) throw E(400, 'A label is too long (max 30)');
    if (!out.some((x) => x.toLowerCase() === l.toLowerCase())) out.push(l);
  }
  if (out.length > 10) throw E(400, 'At most 10 labels');
  return out.length ? out.join(',') : null;
}
function checkAssignee(pid, id) {
  if (id == null) return null;
  const uid = intId(id, 'Assignee');
  const u = q.get('SELECT * FROM users WHERE id=? AND active=1', uid);
  const role = u && memberRole(u, pid);
  if (!u || !role || role === 'viewer') throw E(400, 'The assignee must be an active member of this project');
  return uid;
}
function checkSprint(pid, id) {
  if (id == null || id === '') return null;
  const s = q.get('SELECT * FROM sprints WHERE id=? AND project_id=?', Number(id), pid);
  if (!s) throw E(400, 'Sprint not found in this project');
  if (s.status === 'completed') throw E(400, 'You cannot add issues to a completed sprint');
  return s.id;
}
function checkParent(pid, id, selfId = 0) {
  if (id == null || id === '') return null;
  const pidn = Number(id);
  const par = q.get('SELECT id,parent_id FROM issues WHERE id=? AND project_id=?', pidn, pid);
  if (!par) throw E(400, 'Parent issue not found in this project');
  if (selfId) {
    let cur = par, guard = 0;
    while (cur && guard++ < 50) {
      if (cur.id === selfId) throw E(400, 'An issue cannot be its own parent');
      cur = cur.parent_id ? q.get('SELECT id,parent_id FROM issues WHERE id=?', cur.parent_id) : null;
    }
  }
  return par.id;
}
function checkColumn(pid, id) {
  const c = q.get('SELECT * FROM board_columns WHERE id=? AND project_id=?', Number(id), pid);
  if (!c) throw E(400, 'Status column not found in this project');
  return c;
}
function checkDates(start, due) { if (start && due && due < start) throw E(400, 'Due date cannot be before start date'); }

route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
  const pid = intId(params.id);
  needProject(user, pid);
  const where = ['i.project_id=?'], vals = [pid];
  if (query.q) {
    const t = query.q.trim().slice(0, 100);
    const esc = t.replace(/[\\%_]/g, '\\$&');
    where.push("(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR (p.key||'-'||i.num) LIKE ? ESCAPE '\\' OR i.labels LIKE ? ESCAPE '\\')");
    vals.push(`%${esc}%`, `%${esc}%`, `%${esc}%`, `%${esc}%`);
  }
  if (query.assignee === 'me') { where.push('i.assignee_id=?'); vals.push(user.id); }
  else if (query.assignee === 'none') where.push('i.assignee_id IS NULL');
  else if (query.assignee) { where.push('i.assignee_id=?'); vals.push(Number(query.assignee) || 0); }
  if (query.type) { where.push('i.type=?'); vals.push(query.type); }
  if (query.priority) { where.push('i.priority=?'); vals.push(query.priority); }
  if (query.status) { where.push('i.column_id=?'); vals.push(Number(query.status) || 0); }
  if (query.category) { where.push('c.category=?'); vals.push(query.category); }
  if (query.sprint === 'backlog') where.push('i.sprint_id IS NULL');
  else if (query.sprint === 'active') where.push("i.sprint_id IN (SELECT id FROM sprints WHERE project_id=i.project_id AND status='active')");
  else if (query.sprint) { where.push('i.sprint_id=?'); vals.push(Number(query.sprint) || 0); }
  return q.all(`${ISSUE_SQL} WHERE ${where.join(' AND ')} ORDER BY i.position, i.id LIMIT 3000`, ...vals).map(shape);
});

route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
  const pid = intId(params.id);
  const { p } = needProject(user, pid, 'edit');
  if (p.status === 'archived') throw E(400, 'This project is archived');
  const title = str(body.title, 'Title', { req: true, max: 200 });
  const type = oneOf(body.type, TYPES, 'Type', 'task');
  const priority = oneOf(body.priority, PRIORITIES, 'Priority', 'medium');
  const description = str(body.description, 'Description', { max: 20000 });
  const assignee = checkAssignee(pid, body.assignee_id);
  const col = body.column_id ? checkColumn(pid, body.column_id) : q.get('SELECT * FROM board_columns WHERE project_id=? ORDER BY position,id LIMIT 1', pid);
  const est = num(body.estimate_h, 'Estimate', { max: 10000 });
  const start = date(body.start_date, 'Start date'), due = date(body.due_date, 'Due date');
  checkDates(start, due);
  const sprint = checkSprint(pid, body.sprint_id);
  const parent = checkParent(pid, body.parent_id);
  const labels = readLabels(body.labels);
  const id = tx(() => {
    const n = q.get('SELECT COALESCE(MAX(num),0)+1 n FROM issues WHERE project_id=?', pid).n;
    const pos = q.get('SELECT COALESCE(MAX(position),0)+1000 p FROM issues WHERE column_id=?', col.id).p;
    const t = now();
    const r = q.run(`INSERT INTO issues(project_id,num,type,title,description,column_id,priority,assignee_id,reporter_id,estimate_h,start_date,due_date,sprint_id,parent_id,labels,position,created_at,updated_at,resolved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, pid, n, type, title, description, col.id, priority, assignee, user.id, est, start, due, sprint, parent, labels, pos, t, t, col.category === 'done' ? t : null);
    const iid = Number(r.lastInsertRowid);
    logActivity(pid, iid, user.id, 'created', `created “${title}”`);
    return iid;
  });
  const issue = issueById(id);
  if (assignee && assignee !== user.id) notify(assignee, 'assigned', `${user.name} assigned you ${issue.key}: ${title}`, `#/issue/${id}`);
  projectEvent(pid, 'issue', { issue_id: id });
  return issue;
});

const FIELD_LABEL = { title: 'title', type: 'type', priority: 'priority', assignee_id: 'assignee', estimate_h: 'estimate', start_date: 'start date', due_date: 'due date', sprint_id: 'sprint', parent_id: 'parent', labels: 'labels', description: 'description', column_id: 'status' };

function placeIssue(issue, col, beforeId) {
  // returns a position that puts the issue right before issue #beforeId in the column (or at the end)
  const list = q.all('SELECT id,position FROM issues WHERE column_id=? AND id!=? ORDER BY position,id', col.id, issue.id);
  const at = beforeId ? list.findIndex((r) => r.id === Number(beforeId)) : -1;
  const i = at < 0 ? list.length : at;
  const before = list[i - 1], after = list[i];
  let pos;
  if (before && after) pos = (before.position + after.position) / 2;
  else if (before) pos = before.position + 1000;
  else if (after) pos = after.position - 1000;
  else pos = 1000;
  if (before && after && after.position - before.position < 1e-6) {
    // positions got too close: renumber the whole column
    const order = list.map((r) => r.id);
    order.splice(i, 0, issue.id);
    order.forEach((id, k) => { if (id !== issue.id) q.run('UPDATE issues SET position=? WHERE id=?', (k + 1) * 1000, id); });
    pos = (i + 1) * 1000;
  }
  return pos;
}

route('PATCH', '/api/issues/:id', ({ user, params, body }) => {
  const id = intId(params.id);
  const { issue } = needIssue(user, id, 'edit');
  const pid = issue.project_id;
  const upd = {}; // column -> new value
  const changes = [];
  const set = (col, val, label, fmt = (v) => v) => {
    const old = col === 'labels' ? (issue.labels.join(',') || null) : issue[col];
    if ((old ?? null) === (val ?? null)) return;
    upd[col] = val;
    changes.push(`${label}: ${fmt(old)} → ${fmt(val)}`);
  };
  const nameOf = (uid) => (uid ? (q.get('SELECT name FROM users WHERE id=?', uid) || {}).name : 'none');
  if (has(body, 'title')) set('title', str(body.title, 'Title', { req: true, max: 200 }), 'title');
  if (has(body, 'description')) { const d = str(body.description, 'Description', { max: 20000 }); if ((issue.description ?? null) !== d) { upd.description = d; changes.push('updated the description'); } }
  if (has(body, 'type')) set('type', oneOf(body.type, TYPES, 'Type'), 'type');
  if (has(body, 'priority')) set('priority', oneOf(body.priority, PRIORITIES, 'Priority'), 'priority');
  if (has(body, 'assignee_id')) set('assignee_id', checkAssignee(pid, body.assignee_id), 'assignee', nameOf);
  if (has(body, 'estimate_h')) set('estimate_h', num(body.estimate_h, 'Estimate', { max: 10000 }), 'estimate', (v) => (v == null ? 'none' : v + 'h'));
  if (has(body, 'start_date')) set('start_date', date(body.start_date, 'Start date'), 'start date', (v) => v || 'none');
  if (has(body, 'due_date')) set('due_date', date(body.due_date, 'Due date'), 'due date', (v) => v || 'none');
  checkDates(has(upd, 'start_date') ? upd.start_date : issue.start_date, has(upd, 'due_date') ? upd.due_date : issue.due_date);
  if (has(body, 'sprint_id')) {
    const sp = checkSprint(pid, body.sprint_id);
    set('sprint_id', sp, 'sprint', (v) => (v ? (q.get('SELECT name FROM sprints WHERE id=?', v) || {}).name : 'backlog'));
  }
  if (has(body, 'parent_id')) set('parent_id', checkParent(pid, body.parent_id, id), 'parent', (v) => (v ? `#${v}` : 'none'));
  if (has(body, 'labels')) set('labels', readLabels(body.labels), 'labels', (v) => v || 'none');
  let newCol = null;
  if (has(body, 'column_id') && (Number(body.column_id) !== issue.column_id || has(body, 'before_id'))) {
    const col = checkColumn(pid, body.column_id);
    upd.position = placeIssue(issue, col, body.before_id);
    if (col.id !== issue.column_id) {
      newCol = col;
      upd.column_id = col.id;
      upd.resolved_at = col.category === 'done' ? now() : null;
      changes.push(`status: ${issue.status_name} → ${col.name}`);
    }
  }
  if (!Object.keys(upd).length) return issue;
  upd.updated_at = now();
  const cols = Object.keys(upd);
  tx(() => {
    q.run(`UPDATE issues SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, ...cols.map((c) => upd[c]), id);
    for (const c of changes) logActivity(pid, id, user.id, 'updated', c);
  });
  const fresh = issueById(id);
  if (has(upd, 'assignee_id') && upd.assignee_id && upd.assignee_id !== user.id) notify(upd.assignee_id, 'assigned', `${user.name} assigned you ${fresh.key}: ${fresh.title}`, `#/issue/${id}`);
  if (newCol) {
    for (const uid of new Set([fresh.assignee_id, fresh.reporter_id])) {
      if (uid && uid !== user.id) notify(uid, 'status', `${user.name} moved ${fresh.key} to ${newCol.name}`, `#/issue/${id}`);
    }
  }
  projectEvent(pid, 'issue', { issue_id: id });
  return fresh;
});

route('DELETE', '/api/issues/:id', ({ user, params }) => {
  const { issue, role } = needIssue(user, intId(params.id), 'edit');
  if (role !== 'manager' && issue.reporter_id !== user.id) throw E(403, 'Only the reporter or a project manager can delete this issue');
  tx(() => {
    q.run('DELETE FROM issues WHERE id=?', issue.id);
    logActivity(issue.project_id, null, user.id, 'deleted', `deleted ${issue.key} ${issue.title}`);
  });
  projectEvent(issue.project_id, 'issue', { issue_id: issue.id });
});

route('GET', '/api/issues/:id', ({ user, params }) => {
  const { issue } = needIssue(user, intId(params.id));
  const id = issue.id;
  const bare = (s) => ({ ...s, key: `${s.pkey}-${s.num}` });
  return {
    ...issue,
    comments: q.all('SELECT c.*, u.name AS user_name, u.color AS user_color FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.issue_id=? ORDER BY c.id', id),
    worklogs: q.all('SELECT w.*, u.name AS user_name, u.color AS user_color FROM worklogs w LEFT JOIN users u ON u.id=w.user_id WHERE w.issue_id=? ORDER BY w.date DESC, w.id DESC', id),
    activity: q.all('SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.issue_id=? ORDER BY a.id DESC LIMIT 100', id),
    children: q.all(`${ISSUE_SQL} WHERE i.parent_id=? ORDER BY i.id`, id).map(shape).map(bare),
  };
});

route('POST', '/api/issues/:id/comments', ({ user, params, body }) => {
  const { issue } = needIssue(user, intId(params.id), 'edit');
  const text = str(body.body, 'Comment', { req: true, max: 5000 });
  const r = q.run('INSERT INTO comments(issue_id,user_id,body,created_at) VALUES(?,?,?,?)', issue.id, user.id, text, now());
  q.run('UPDATE issues SET updated_at=? WHERE id=?', now(), issue.id);
  logActivity(issue.project_id, issue.id, user.id, 'commented', 'added a comment');
  const mentioned = mentionedUsers(text).filter((u) => memberRole(q.get('SELECT * FROM users WHERE id=?', u), issue.project_id));
  for (const u of mentioned) if (u !== user.id) notify(u, 'mention', `${user.name} mentioned you on ${issue.key}`, `#/issue/${issue.id}`);
  for (const u of new Set([issue.assignee_id, issue.reporter_id])) {
    if (u && u !== user.id && !mentioned.includes(u)) notify(u, 'comment', `${user.name} commented on ${issue.key}: ${issue.title}`, `#/issue/${issue.id}`);
  }
  projectEvent(issue.project_id, 'issue', { issue_id: issue.id });
  return q.get('SELECT c.*, u.name AS user_name, u.color AS user_color FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?', Number(r.lastInsertRowid));
});

route('DELETE', '/api/comments/:id', ({ user, params }) => {
  const c = q.get('SELECT c.*, i.project_id FROM comments c JOIN issues i ON i.id=c.issue_id WHERE c.id=?', intId(params.id));
  if (!c) throw E(404, 'Comment not found');
  const { role } = needProject(user, c.project_id, 'edit');
  if (c.user_id !== user.id && role !== 'manager') throw E(403, 'You can only delete your own comments');
  q.run('DELETE FROM comments WHERE id=?', c.id);
  projectEvent(c.project_id, 'issue', { issue_id: c.issue_id });
});

// ================= TIME TRACKING =================
function addWorklog(user, issue, hours, day, note) {
  const r = q.run('INSERT INTO worklogs(issue_id,user_id,hours,date,note,created_at) VALUES(?,?,?,?,?,?)', issue.id, user.id, hours, day, note, now());
  logActivity(issue.project_id, issue.id, user.id, 'worklog', `logged ${hours}h`);
  projectEvent(issue.project_id, 'issue', { issue_id: issue.id });
  return q.get('SELECT w.*, u.name AS user_name, u.color AS user_color FROM worklogs w LEFT JOIN users u ON u.id=w.user_id WHERE w.id=?', Number(r.lastInsertRowid));
}
route('POST', '/api/issues/:id/worklogs', ({ user, params, body }) => {
  const { issue } = needIssue(user, intId(params.id), 'edit');
  const hours = num(body.hours, 'Time spent', { min: 0.01, max: 200, req: true });
  const day = date(body.date, 'Date') || today();
  return addWorklog(user, issue, Math.round(hours * 100) / 100, day, str(body.note, 'Note', { max: 500 }));
});
route('DELETE', '/api/worklogs/:id', ({ user, params }) => {
  const w = q.get('SELECT w.*, i.project_id FROM worklogs w JOIN issues i ON i.id=w.issue_id WHERE w.id=?', intId(params.id));
  if (!w) throw E(404, 'Time entry not found');
  const { role } = needProject(user, w.project_id, 'edit');
  if (w.user_id !== user.id && role !== 'manager') throw E(403, 'You can only delete your own time entries');
  q.run('DELETE FROM worklogs WHERE id=?', w.id);
  projectEvent(w.project_id, 'issue', { issue_id: w.issue_id });
});

function getTimer(uid) {
  const t = q.get(`SELECT t.issue_id, t.started_at, i.title, p.key||'-'||i.num AS key FROM timers t JOIN issues i ON i.id=t.issue_id JOIN projects p ON p.id=i.project_id WHERE t.user_id=?`, uid);
  return t || null;
}
function stopTimer(user) {
  const t = q.get('SELECT * FROM timers WHERE user_id=?', user.id);
  if (!t) return null;
  q.run('DELETE FROM timers WHERE user_id=?', user.id);
  const issue = issueById(t.issue_id);
  if (!issue) return null;
  const hours = Math.max(0.01, Math.round(((Date.now() - Date.parse(t.started_at)) / 3600000) * 100) / 100);
  return addWorklog(user, issue, hours, today(), 'Logged with timer');
}
route('POST', '/api/timer/start', ({ user, body }) => {
  const { issue } = needIssue(user, intId(body.issue_id, 'Issue'), 'edit');
  const cur = q.get('SELECT issue_id FROM timers WHERE user_id=?', user.id);
  if (cur && cur.issue_id === issue.id) return { timer: getTimer(user.id) };
  tx(() => {
    stopTimer(user);
    q.run('INSERT INTO timers(user_id,issue_id,started_at) VALUES(?,?,?)', user.id, issue.id, now());
  });
  return { timer: getTimer(user.id) };
});
route('POST', '/api/timer/stop', ({ user }) => {
  const w = tx(() => stopTimer(user));
  return { timer: null, worklog: w };
});

// ================= SEARCH, MY WORK =================
route('GET', '/api/search', ({ user, query }) => {
  const t = String(query.q || '').trim().slice(0, 100);
  const ids = projectIdsFor(user);
  if (!t || !ids.length) return [];
  const esc = `%${t.replace(/[\\%_]/g, '\\$&')}%`;
  return q.all(`${ISSUE_SQL} WHERE i.project_id IN (${inList(ids)}) AND (i.title LIKE ? ESCAPE '\\' OR (p.key||'-'||i.num) LIKE ? ESCAPE '\\') ORDER BY i.updated_at DESC LIMIT 20`, ...ids, esc, esc).map(shape);
});

route('GET', '/api/my/issues', ({ user, query }) => {
  const ids = projectIdsFor(user);
  if (!ids.length) return [];
  const doneFilter = query.all ? '' : "AND c.category!='done'";
  return q.all(`${ISSUE_SQL} WHERE i.assignee_id=? AND i.project_id IN (${inList(ids)}) ${doneFilter} ORDER BY (i.due_date IS NULL), i.due_date, CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 500`, user.id, ...ids).map(shape);
});

route('GET', '/api/dashboard', ({ user }) => {
  const ids = projectIdsFor(user);
  const t = today();
  const out = { stats: { open: 0, overdue: 0, due_week: 0, done_week: 0, logged_week: 0, logged_today: 0 }, my_issues: [], activity: [], reminders: [], projects: [] };
  const wkStart = addDays(t, -((new Date().getDay() + 6) % 7)); // Monday
  out.stats.logged_week = q.get('SELECT COALESCE(SUM(hours),0) h FROM worklogs WHERE user_id=? AND date>=?', user.id, wkStart).h;
  out.stats.logged_today = q.get('SELECT COALESCE(SUM(hours),0) h FROM worklogs WHERE user_id=? AND date=?', user.id, t).h;
  out.reminders = q.all('SELECT * FROM reminders WHERE user_id=? AND done=0 ORDER BY remind_at LIMIT 5', user.id);
  if (!ids.length) return out;
  const ph = inList(ids);
  out.stats.open = q.get(`SELECT COUNT(*) c FROM issues i JOIN board_columns c ON c.id=i.column_id WHERE i.assignee_id=? AND c.category!='done' AND i.project_id IN (${ph})`, user.id, ...ids).c;
  out.stats.overdue = q.get(`SELECT COUNT(*) c FROM issues i JOIN board_columns c ON c.id=i.column_id WHERE i.assignee_id=? AND c.category!='done' AND i.due_date<? AND i.project_id IN (${ph})`, user.id, t, ...ids).c;
  out.stats.due_week = q.get(`SELECT COUNT(*) c FROM issues i JOIN board_columns c ON c.id=i.column_id WHERE i.assignee_id=? AND c.category!='done' AND i.due_date BETWEEN ? AND ? AND i.project_id IN (${ph})`, user.id, t, addDays(t, 7), ...ids).c;
  out.stats.done_week = q.get(`SELECT COUNT(*) c FROM issues i WHERE i.assignee_id=? AND i.resolved_at>=? AND i.project_id IN (${ph})`, user.id, new Date(wkStart + 'T00:00:00').toISOString(), ...ids).c;
  out.my_issues = q.all(`${ISSUE_SQL} WHERE i.assignee_id=? AND c.category!='done' AND i.project_id IN (${ph}) ORDER BY (i.due_date IS NULL), i.due_date, CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 8`, user.id, ...ids).map(shape);
  out.activity = q.all(`SELECT a.*, u.name AS user_name, u.color AS user_color, p.key AS pkey, i.num AS inum, i.title AS ititle FROM activity a LEFT JOIN users u ON u.id=a.user_id JOIN projects p ON p.id=a.project_id LEFT JOIN issues i ON i.id=a.issue_id WHERE a.project_id IN (${ph}) ORDER BY a.id DESC LIMIT 12`, ...ids);
  out.projects = q.all(`SELECT p.id,p.key,p.name,p.status, ${projectStatsSql} FROM projects p WHERE p.id IN (${ph}) AND p.status='active' ORDER BY p.name COLLATE NOCASE`, t, ...ids);
  return out;
});

route('GET', '/api/projects/:id/activity', ({ user, params }) => {
  const pid = intId(params.id);
  needProject(user, pid);
  return q.all('SELECT a.*, u.name AS user_name, u.color AS user_color, p.key AS pkey, i.num AS inum, i.title AS ititle FROM activity a LEFT JOIN users u ON u.id=a.user_id JOIN projects p ON p.id=a.project_id LEFT JOIN issues i ON i.id=a.issue_id WHERE a.project_id=? ORDER BY a.id DESC LIMIT 60', pid);
});

// ================= REMINDERS =================
function readRemindAt(v) {
  if (typeof v !== 'string' || isNaN(Date.parse(v))) throw E(400, 'Choose a valid reminder date and time');
  return new Date(v).toISOString();
}
const REPEATS = ['none', 'daily', 'weekly', 'monthly'];
route('GET', '/api/reminders', ({ user }) => q.all(
  `SELECT r.*, p.key||'-'||i.num AS issue_key, i.title AS issue_title FROM reminders r LEFT JOIN issues i ON i.id=r.issue_id LEFT JOIN projects p ON p.id=i.project_id WHERE r.user_id=? ORDER BY r.done, r.remind_at`, user.id));
route('POST', '/api/reminders', ({ user, body }) => {
  const title = str(body.title, 'Title', { req: true, max: 200 });
  let issueId = null;
  if (body.issue_id) { issueId = needIssue(user, intId(body.issue_id, 'Issue')).issue.id; }
  const r = q.run('INSERT INTO reminders(user_id,title,note,remind_at,repeat,issue_id,created_at) VALUES(?,?,?,?,?,?,?)', user.id, title, str(body.note, 'Note', { max: 1000 }), readRemindAt(body.remind_at), oneOf(body.repeat, REPEATS, 'Repeat', 'none'), issueId, now());
  return q.get('SELECT * FROM reminders WHERE id=?', Number(r.lastInsertRowid));
});
route('PATCH', '/api/reminders/:id', ({ user, params, body }) => {
  const r = q.get('SELECT * FROM reminders WHERE id=? AND user_id=?', intId(params.id), user.id);
  if (!r) throw E(404, 'Reminder not found');
  const title = has(body, 'title') ? str(body.title, 'Title', { req: true, max: 200 }) : r.title;
  const note = has(body, 'note') ? str(body.note, 'Note', { max: 1000 }) : r.note;
  const repeat = has(body, 'repeat') ? oneOf(body.repeat, REPEATS, 'Repeat') : r.repeat;
  let at = r.remind_at, notified = r.notified, done = r.done;
  if (has(body, 'remind_at')) { at = readRemindAt(body.remind_at); notified = 0; done = 0; }
  if (has(body, 'done')) { done = body.done ? 1 : 0; if (!done && at < now()) { notified = 1; } }
  q.run('UPDATE reminders SET title=?,note=?,repeat=?,remind_at=?,notified=?,done=? WHERE id=?', title, note, repeat, at, notified, done, r.id);
  return q.get('SELECT * FROM reminders WHERE id=?', r.id);
});
route('DELETE', '/api/reminders/:id', ({ user, params }) => {
  q.run('DELETE FROM reminders WHERE id=? AND user_id=?', intId(params.id), user.id);
});

// ================= NOTIFICATIONS =================
route('GET', '/api/notifications', ({ user }) => ({
  items: q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 60', user.id),
  unread: q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', user.id).c,
}));
route('POST', '/api/notifications/read', ({ user, body }) => {
  if (Array.isArray(body.ids) && body.ids.length) {
    const ids = body.ids.map(Number).filter(Number.isInteger).slice(0, 200);
    if (ids.length) q.run(`UPDATE notifications SET read=1 WHERE user_id=? AND id IN (${inList(ids)})`, user.id, ...ids);
  } else q.run('UPDATE notifications SET read=1 WHERE user_id=?', user.id);
  return { unread: q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', user.id).c };
});
route('DELETE', '/api/notifications', ({ user }) => { q.run('DELETE FROM notifications WHERE user_id=? AND read=1', user.id); });

// ================= CHAT (local team chat) =================
function channelMembers(ch) {
  if (ch.type === 'general') return q.all('SELECT id FROM users WHERE active=1').map((r) => r.id);
  if (ch.type === 'project') return projectUserIds(ch.project_id);
  return [ch.user_a, ch.user_b];
}
function needChannel(user, id) {
  const ch = q.get('SELECT * FROM channels WHERE id=?', id);
  if (!ch) throw E(404, 'Channel not found');
  if (ch.type === 'project' && !memberRole(user, ch.project_id)) throw E(404, 'Channel not found');
  if (ch.type === 'dm' && ch.user_a !== user.id && ch.user_b !== user.id) throw E(404, 'Channel not found');
  return ch;
}
const MSG_SQL = 'SELECT m.id, m.channel_id, m.user_id, m.body, m.created_at, m.file_name, m.file_type, m.file_size, u.name AS user_name, u.color AS user_color FROM messages m LEFT JOIN users u ON u.id=m.user_id';

route('GET', '/api/channels', ({ user }) => {
  const pids = projectIdsFor(user);
  const rows = q.all(`SELECT c.*, p.status AS pstatus,
      (SELECT m.id FROM messages m WHERE m.channel_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_id,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id=c.id AND m.user_id IS NOT ? AND m.id > COALESCE((SELECT last_id FROM channel_reads r WHERE r.channel_id=c.id AND r.user_id=?),0)) AS unread
    FROM channels c LEFT JOIN projects p ON p.id=c.project_id
    WHERE c.type='general' OR (c.type='dm' AND (c.user_a=? OR c.user_b=?)) ${pids.length ? `OR (c.type='project' AND c.project_id IN (${inList(pids)}))` : ''}`, user.id, user.id, user.id, user.id, ...pids);
  return rows.map((c) => {
    let name = c.name;
    if (c.type === 'dm') {
      const other = q.get('SELECT id,name,color FROM users WHERE id=?', c.user_a === user.id ? c.user_b : c.user_a);
      name = other ? other.name : 'Unknown';
      c.other = other;
    }
    const last = c.last_id ? q.get(`${MSG_SQL} WHERE m.id=?`, c.last_id) : null;
    return { ...c, name, last };
  });
});

route('POST', '/api/channels/dm', ({ user, body }) => {
  const other = intId(body.user_id, 'User');
  if (other === user.id) throw E(400, 'You cannot message yourself');
  if (!q.get('SELECT id FROM users WHERE id=? AND active=1', other)) throw E(404, 'User not found');
  const a = Math.min(user.id, other), b = Math.max(user.id, other);
  let ch = q.get("SELECT * FROM channels WHERE type='dm' AND user_a=? AND user_b=?", a, b);
  if (!ch) { q.run("INSERT INTO channels(type,user_a,user_b) VALUES('dm',?,?)", a, b); ch = q.get("SELECT * FROM channels WHERE type='dm' AND user_a=? AND user_b=?", a, b); }
  return { id: ch.id };
});

route('GET', '/api/channels/:id/messages', ({ user, params, query }) => {
  const ch = needChannel(user, intId(params.id));
  const before = Number(query.before) || 0;
  const rows = q.all(`${MSG_SQL} WHERE m.channel_id=? ${before ? 'AND m.id<?' : ''} ORDER BY m.id DESC LIMIT 50`, ...(before ? [ch.id, before] : [ch.id]));
  return rows.reverse();
});

route('POST', '/api/channels/:id/messages', ({ user, params, body }) => {
  const ch = needChannel(user, intId(params.id));
  const text = str(body.body, 'Message', { req: true, max: 4000 });
  const r = q.run('INSERT INTO messages(channel_id,user_id,body,created_at) VALUES(?,?,?,?)', ch.id, user.id, text, now());
  const msg = q.get(`${MSG_SQL} WHERE m.id=?`, Number(r.lastInsertRowid));
  q.run('INSERT INTO channel_reads(channel_id,user_id,last_id) VALUES(?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET last_id=excluded.last_id', ch.id, user.id, msg.id);
  const members = channelMembers(ch);
  sendTo(members, 'message', { channel_id: ch.id, message: msg });
  const label = ch.type === 'dm' ? `${user.name}` : `${user.name} in #${ch.name}`;
  if (ch.type !== 'dm') for (const u of mentionedUsers(text)) if (u !== user.id && members.includes(u)) notify(u, 'mention', `${label} mentioned you: ${text.slice(0, 80)}`, `#/chat/${ch.id}`);
  return msg;
});

// ---- chat attachments (images, audio, any file up to 25 MB) ----
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_UPLOAD = 25 * 1024 * 1024;
// only these types are shown inline in the browser; everything else is forced to download (prevents script/HTML uploads running)
const INLINE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', webm: 'audio/webm', aac: 'audio/aac',
};

route('POST', '/api/channels/:id/upload', async ({ req, user, params }) => {
  const ch = needChannel(user, intId(params.id));
  let name = 'file';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { /* keep default */ }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'file';
  let caption = '';
  try { caption = decodeURIComponent(String(req.headers['x-caption'] || '')).trim().slice(0, 4000); } catch { /* ignore */ }
  let ext = path.extname(name).slice(1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) ext = 'bin';
  const declared = Number(req.headers['content-length']);
  if (!declared) throw E(400, 'The file is empty');
  if (declared > MAX_UPLOAD) throw E(413, 'Files can be at most 25 MB');
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { reject(E(413, 'Files can be at most 25 MB')); req.destroy(); } else chunks.push(c); });
    req.on('end', resolve);
    req.on('error', reject);
  });
  if (!size) throw E(400, 'The file is empty');
  const key = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, key), Buffer.concat(chunks));
  const type = INLINE_TYPES[ext] || 'application/octet-stream';
  const r = q.run('INSERT INTO messages(channel_id,user_id,body,created_at,file_name,file_key,file_type,file_size) VALUES(?,?,?,?,?,?,?,?)', ch.id, user.id, caption, now(), name, key, type, size);
  const msg = q.get(`${MSG_SQL} WHERE m.id=?`, Number(r.lastInsertRowid));
  q.run('INSERT INTO channel_reads(channel_id,user_id,last_id) VALUES(?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET last_id=excluded.last_id', ch.id, user.id, msg.id);
  sendTo(channelMembers(ch), 'message', { channel_id: ch.id, message: msg });
  return msg;
}, { raw: true });

route('GET', '/api/files/:id', ({ req, res, user, params }) => {
  const m = q.get('SELECT * FROM messages WHERE id=? AND file_key IS NOT NULL', intId(params.id));
  if (!m) throw E(404, 'File not found');
  needChannel(user, m.channel_id);
  const fp = path.join(UPLOAD_DIR, m.file_key);
  let st;
  try { st = fs.statSync(fp); } catch { throw E(404, 'File not found'); }
  const inline = Object.values(INLINE_TYPES).includes(m.file_type);
  const headers = {
    'Content-Type': m.file_type || 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.file_name)}`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes',
  };
  let start = 0, end = st.size - 1, status = 200;
  const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (rm && (rm[1] || rm[2])) {
    if (rm[1]) { start = Number(rm[1]); if (rm[2]) end = Math.min(Number(rm[2]), end); } else start = Math.max(0, st.size - Number(rm[2]));
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return RAW; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  const stream = fs.createReadStream(fp, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return RAW;
});

route('POST', '/api/channels/:id/read', ({ user, params }) => {
  const ch = needChannel(user, intId(params.id));
  const last = q.get('SELECT COALESCE(MAX(id),0) m FROM messages WHERE channel_id=?', ch.id).m;
  q.run('INSERT INTO channel_reads(channel_id,user_id,last_id) VALUES(?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET last_id=excluded.last_id', ch.id, user.id, last);
  q.run("UPDATE notifications SET read=1 WHERE user_id=? AND type IN ('chat','mention') AND link=?", user.id, `#/chat/${ch.id}`);
});

export { issueById, ISSUE_SQL, shape, RAW, parseCookies };
