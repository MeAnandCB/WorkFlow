// Shared helpers: errors, validation, auth, permissions, notifications
import crypto from 'node:crypto';
import { q, now, today } from './db.js';
import { sendTo } from './hub.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const E = (s, m) => new HttpError(s, m);

// ---------- validation ----------
export function str(v, name, { max = 200, req = false } = {}) {
  if (v == null || v === '') { if (req) throw E(400, `${name} is required`); return null; }
  if (typeof v !== 'string') throw E(400, `${name} must be text`);
  v = v.trim();
  if (!v) { if (req) throw E(400, `${name} is required`); return null; }
  if (v.length > max) throw E(400, `${name} is too long (max ${max})`);
  return v;
}
export function num(v, name, { min = 0, max = 100000, req = false } = {}) {
  if (v == null || v === '') { if (req) throw E(400, `${name} is required`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw E(400, `${name} is invalid (${min} to ${max})`);
  return n;
}
export function date(v, name) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw E(400, `${name} must be a date (YYYY-MM-DD)`);
  const d = new Date(v + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== v) throw E(400, `${name} is not a valid date`);
  return v;
}
export function oneOf(v, list, name, def) {
  if (v == null || v === '') return def;
  if (!list.includes(v)) throw E(400, `${name} is invalid`);
  return v;
}
export function intId(v, name = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw E(400, `${name} is invalid`);
  return n;
}
export const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export const ROLES = ['admin', 'member'];
export const PROJECT_ROLES = ['manager', 'member', 'viewer'];
export const TYPES = ['task', 'bug', 'story', 'epic', 'subtask'];
export const PRIORITIES = ['critical', 'high', 'medium', 'low'];
export const CATEGORIES = ['todo', 'in_progress', 'done'];

// ---------- passwords & sessions ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(h, b);
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) throw E(400, 'Password must be at least 6 characters');
  if (pw.length > 200) throw E(400, 'Password is too long');
}
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + 30 * 864e5).toISOString();
  q.run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', sha(token), userId, exp);
  return token;
}
export function destroySession(token) { if (token) q.run('DELETE FROM sessions WHERE token=?', sha(token)); }
export function userFromToken(token) {
  if (!token) return null;
  const s = q.get('SELECT user_id, expires_at FROM sessions WHERE token=?', sha(token));
  if (!s) return null;
  if (s.expires_at < now()) { q.run('DELETE FROM sessions WHERE token=?', sha(token)); return null; }
  return q.get('SELECT id,name,email,role,color,active FROM users WHERE id=? AND active=1', s.user_id) || null;
}
export const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, color: u.color, active: !!u.active });

const COLORS = ['#16a34a', '#0d9488', '#65a30d', '#059669', '#0891b2', '#15803d', '#4d7c0f', '#0f766e', '#22c55e', '#2f855a'];
export const pickColor = (n) => COLORS[n % COLORS.length];

// ---------- permissions ----------
export function projectIdsFor(user) {
  if (user.role === 'admin') return q.all('SELECT id FROM projects').map((r) => r.id);
  return q.all('SELECT project_id AS id FROM project_members WHERE user_id=?', user.id).map((r) => r.id);
}
export function memberRole(user, pid) {
  if (user.role === 'admin') return 'manager';
  const r = q.get('SELECT role FROM project_members WHERE project_id=? AND user_id=?', pid, user.id);
  return r ? r.role : null;
}
export function needProject(user, pid, level = 'view') {
  const p = q.get('SELECT * FROM projects WHERE id=?', pid);
  const role = p && memberRole(user, pid);
  if (!p || !role) throw E(404, 'Project not found');
  if (level === 'edit' && role === 'viewer') throw E(403, 'You have view-only access to this project');
  if (level === 'manage' && role !== 'manager') throw E(403, 'Only project managers can do this');
  return { p, role };
}
export function projectUserIds(pid) {
  const ids = q.all('SELECT user_id AS id FROM project_members WHERE project_id=?', pid).map((r) => r.id);
  const admins = q.all("SELECT id FROM users WHERE role='admin' AND active=1").map((r) => r.id);
  return [...new Set([...ids, ...admins])];
}
export const inList = (ids) => ids.map(() => '?').join(',');

// ---------- activity, notifications, realtime ----------
export function logActivity(pid, issueId, userId, action, detail) {
  q.run('INSERT INTO activity(project_id,issue_id,user_id,action,detail,created_at) VALUES(?,?,?,?,?,?)', pid, issueId, userId, action, detail, now());
}
export function notify(userId, type, text, link, dedupe = null) {
  if (!userId) return;
  const r = q.run('INSERT OR IGNORE INTO notifications(user_id,type,text,link,dedupe,created_at) VALUES(?,?,?,?,?,?)', userId, type, text, link, dedupe, now());
  if (r.changes) sendTo([userId], 'notification', { id: Number(r.lastInsertRowid), type, text, link });
}
export function projectEvent(pid, kind, extra = {}) {
  sendTo(projectUserIds(pid), 'project', { project_id: pid, kind, ...extra });
}
// @mentions use the part of the email before the @ sign, e.g. @john for john@x.com
export function mentionedUsers(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/(?:^|\s)@([\w.-]+)/g)) {
    const u = q.get("SELECT id FROM users WHERE active=1 AND lower(substr(email,1,instr(email,'@')-1))=?", m[1].toLowerCase());
    if (u) out.add(u.id);
  }
  return [...out];
}
export { today };
