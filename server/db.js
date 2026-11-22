// SQLite storage (uses Node's built-in node:sqlite - no npm packages needed)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Default data folder: ./data, but a cloud-synced folder (OneDrive) can corrupt a live SQLite file,
// so in that case the database is kept in %LOCALAPPDATA%/TaskFlow instead.
const PROJECT_DIR = path.join(import.meta.dirname, '..');
const synced = /onedrive|dropbox|google drive/i.test(PROJECT_DIR);
export const DATA_DIR = process.env.DATA_DIR || (synced ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'TaskFlow') : path.join(PROJECT_DIR, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
export const DB_FILE = path.join(DATA_DIR, 'pm.db');

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  color TEXT NOT NULL DEFAULT '#6366f1',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  start_date TEXT,
  end_date TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members(
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY(project_id, user_id)
);
CREATE TABLE IF NOT EXISTS board_columns(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'todo',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sprints(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  committed INTEGER,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS issues(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  num INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'task',
  title TEXT NOT NULL,
  description TEXT,
  column_id INTEGER NOT NULL REFERENCES board_columns(id),
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  estimate_h REAL,
  start_date TEXT,
  due_date TEXT,
  sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  labels TEXT,
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(project_id, num)
);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_id);
CREATE INDEX IF NOT EXISTS idx_issues_column ON issues(column_id);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worklogs(
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  hours REAL NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worklogs_issue ON worklogs(issue_id);
CREATE INDEX IF NOT EXISTS idx_worklogs_date ON worklogs(date);
CREATE TABLE IF NOT EXISTS timers(
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id, id);
CREATE TABLE IF NOT EXISTS reminders(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT,
  remind_at TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none',
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  done INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  link TEXT,
  dedupe TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(user_id, dedupe) WHERE dedupe IS NOT NULL;
CREATE TABLE IF NOT EXISTS channels(
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT,
  project_id INTEGER UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  user_a INTEGER REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_a, user_b)
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS channel_reads(
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id, user_id)
);
`);

const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
};

export const q = {
  all: (sql, ...p) => stmt(sql).all(...clean(p)),
  get: (sql, ...p) => stmt(sql).get(...clean(p)),
  run: (sql, ...p) => stmt(sql).run(...clean(p)),
};

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export const now = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, '0');
export const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => dateStr(new Date());
export const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return dateStr(new Date(y, m - 1, d + n));
};

// chat attachments (added after first release, so migrate older databases)
for (const [col, type] of [['file_name', 'TEXT'], ['file_key', 'TEXT'], ['file_type', 'TEXT'], ['file_size', 'INTEGER']]) {
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
}

// the shared "General" channel always exists
if (!q.get("SELECT id FROM channels WHERE type='general'")) {
  q.run("INSERT INTO channels(type,name) VALUES('general','General')");
}
