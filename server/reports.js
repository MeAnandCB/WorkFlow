// Reports: totals, progress, pending work, time tracking, burndown, CSV export
import { q, today, addDays, dateStr } from './db.js';
import { route, RAW } from './router.js';
import { E, date, intId, projectIdsFor, needProject, inList } from './core.js';

const OPEN = "c.category!='done'";
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function scope(user, query) {
  let ids = projectIdsFor(user);
  let pid = null;
  if (query.project) {
    pid = intId(query.project, 'Project');
    needProject(user, pid);
    ids = [pid];
  }
  const to = date(query.to, 'To') || today();
  const from = date(query.from, 'From') || addDays(to, -29);
  if (from > to) throw E(400, 'The "from" date must be before the "to" date');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 731) throw E(400, 'Please choose a range of two years or less');
  return { ids, pid, from, to };
}

route('GET', '/api/reports/summary', ({ user, query }) => {
  const { ids, pid, from, to } = scope(user, query);
  const t = today();
  const empty = { range: { from, to }, totals: { total: 0, done: 0, open: 0, overdue: 0, unassigned: 0, estimate_h: 0, logged_h: 0, remaining_h: 0, completion: 0 }, by_category: [], by_column: [], by_priority: [], by_type: [], by_assignee: [], by_project: [], time_by_user: [], time_by_day: [], time_by_project: [], overdue: [], pending: [], velocity: [], burndown: null };
  if (!ids.length) return empty;
  const ph = inList(ids);
  const base = `FROM issues i JOIN board_columns c ON c.id=i.column_id WHERE i.project_id IN (${ph})`;
  const logged = '(SELECT COALESCE(SUM(hours),0) FROM worklogs w WHERE w.issue_id=i.id)';

  const tot = q.get(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN c.category='done' THEN 1 ELSE 0 END),0) done,
      COALESCE(SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END),0) open,
      COALESCE(SUM(CASE WHEN ${OPEN} AND i.due_date<? THEN 1 ELSE 0 END),0) overdue,
      COALESCE(SUM(CASE WHEN ${OPEN} AND i.assignee_id IS NULL THEN 1 ELSE 0 END),0) unassigned,
      COALESCE(SUM(i.estimate_h),0) estimate_h,
      COALESCE(SUM(${logged}),0) logged_h,
      COALESCE(SUM(CASE WHEN ${OPEN} AND i.estimate_h IS NOT NULL THEN MAX(i.estimate_h-${logged},0) ELSE 0 END),0) remaining_h
    ${base}`, t, ...ids);
  const totals = { ...tot, estimate_h: r2(tot.estimate_h), logged_h: r2(tot.logged_h), remaining_h: r2(tot.remaining_h), completion: tot.total ? Math.round((tot.done / tot.total) * 100) : 0 };

  const by_category = q.all(`SELECT c.category name, COUNT(*) count ${base} GROUP BY c.category`, ...ids);
  const by_column = pid ? q.all('SELECT c.id, c.name, c.category, COUNT(i.id) count FROM board_columns c LEFT JOIN issues i ON i.column_id=c.id WHERE c.project_id=? GROUP BY c.id ORDER BY c.position, c.id', pid) : [];
  const by_priority = q.all(`SELECT i.priority name, COUNT(*) count, SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END) open ${base} GROUP BY i.priority`, ...ids);
  const by_type = q.all(`SELECT i.type name, COUNT(*) count, SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END) open ${base} GROUP BY i.type`, ...ids);

  const by_assignee = q.all(`SELECT i.assignee_id id, u.name, u.color, COUNT(*) total,
      SUM(CASE WHEN c.category='done' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN ${OPEN} AND i.due_date<? THEN 1 ELSE 0 END) overdue,
      COALESCE(SUM(i.estimate_h),0) estimate_h, COALESCE(SUM(${logged}),0) logged_h
    FROM issues i JOIN board_columns c ON c.id=i.column_id LEFT JOIN users u ON u.id=i.assignee_id
    WHERE i.project_id IN (${ph}) GROUP BY i.assignee_id ORDER BY open DESC, total DESC`, t, ...ids)
    .map((r) => ({ ...r, name: r.name || 'Unassigned', estimate_h: r2(r.estimate_h), logged_h: r2(r.logged_h) }));

  const by_project = q.all(`SELECT p.id, p.key, p.name, COUNT(i.id) total,
      COALESCE(SUM(CASE WHEN c.category='done' THEN 1 ELSE 0 END),0) done,
      COALESCE(SUM(CASE WHEN c.category!='done' AND i.due_date<? THEN 1 ELSE 0 END),0) overdue,
      COALESCE(SUM(i.estimate_h),0) estimate_h,
      COALESCE(SUM((SELECT SUM(hours) FROM worklogs w WHERE w.issue_id=i.id)),0) logged_h
    FROM projects p LEFT JOIN issues i ON i.project_id=p.id LEFT JOIN board_columns c ON c.id=i.column_id
    WHERE p.id IN (${ph}) GROUP BY p.id ORDER BY p.name COLLATE NOCASE`, t, ...ids)
    .map((r) => ({ ...r, estimate_h: r2(r.estimate_h), logged_h: r2(r.logged_h) }));

  const wbase = `FROM worklogs w JOIN issues i ON i.id=w.issue_id WHERE i.project_id IN (${ph}) AND w.date BETWEEN ? AND ?`;
  const time_by_user = q.all(`SELECT w.user_id id, COALESCE(u.name,'Former member') name, u.color, SUM(w.hours) hours, COUNT(*) entries ${wbase.replace('WHERE', 'LEFT JOIN users u ON u.id=w.user_id WHERE')} GROUP BY w.user_id ORDER BY hours DESC`, ...ids, from, to)
    .map((r) => ({ ...r, hours: r2(r.hours) }));
  const dayRows = Object.fromEntries(q.all(`SELECT w.date d, SUM(w.hours) h ${wbase} GROUP BY w.date`, ...ids, from, to).map((r) => [r.d, r.h]));
  const time_by_day = [];
  for (let d = from; d <= to; d = addDays(d, 1)) time_by_day.push({ date: d, hours: r2(dayRows[d] || 0) });
  const time_by_project = q.all(`SELECT p.id, p.key, p.name, SUM(w.hours) hours FROM worklogs w JOIN issues i ON i.id=w.issue_id JOIN projects p ON p.id=i.project_id WHERE i.project_id IN (${ph}) AND w.date BETWEEN ? AND ? GROUP BY p.id ORDER BY hours DESC`, ...ids, from, to)
    .map((r) => ({ ...r, hours: r2(r.hours) }));

  const issueCols = `i.id, p.key||'-'||i.num AS key, i.title, i.priority, i.type, i.due_date, i.estimate_h, c.name AS status, c.category, u.name AS assignee, ${logged} AS logged_h`;
  const listSql = (cond, order) => `SELECT ${issueCols} FROM issues i JOIN board_columns c ON c.id=i.column_id JOIN projects p ON p.id=i.project_id LEFT JOIN users u ON u.id=i.assignee_id WHERE i.project_id IN (${ph}) AND ${cond} ORDER BY ${order} LIMIT 100`;
  const overdue = q.all(listSql(`${OPEN} AND i.due_date<?`, 'i.due_date'), ...ids, t);
  const pending = q.all(listSql(OPEN, "(i.due_date IS NULL), i.due_date, CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END"), ...ids);

  let velocity = [], burndown = null;
  if (pid) {
    velocity = q.all("SELECT s.id, s.name, s.committed, (SELECT COUNT(*) FROM issues i JOIN board_columns c ON c.id=i.column_id WHERE i.sprint_id=s.id AND c.category='done') AS completed FROM sprints s WHERE s.project_id=? AND s.status='completed' ORDER BY s.id DESC LIMIT 8", pid).reverse();
    const sp = q.get("SELECT * FROM sprints WHERE project_id=? AND status='active'", pid);
    if (sp && sp.start_date && sp.end_date) burndown = buildBurndown(sp);
  }
  return { range: { from, to }, totals, by_category, by_column, by_priority, by_type, by_assignee, by_project, time_by_user, time_by_day, time_by_project, overdue, pending, velocity, burndown };
});

function buildBurndown(sp) {
  const issues = q.all('SELECT i.estimate_h, i.resolved_at, c.category FROM issues i JOIN board_columns c ON c.id=i.column_id WHERE i.sprint_id=?', sp.id);
  const total = issues.length;
  const totalH = issues.reduce((a, i) => a + (i.estimate_h || 0), 0);
  const days = [];
  for (let d = sp.start_date; d <= sp.end_date && days.length < 120; d = addDays(d, 1)) days.push(d);
  const t = today();
  const span = Math.max(1, days.length - 1);
  const points = days.map((d, idx) => {
    const resolvedBy = issues.filter((i) => i.category === 'done' && i.resolved_at && dateStr(new Date(i.resolved_at)) <= d);
    return {
      date: d,
      ideal: r2(total - (total * idx) / span),
      remaining: d <= t ? total - resolvedBy.length : null,
      remaining_h: d <= t ? r2(totalH - resolvedBy.reduce((a, i) => a + (i.estimate_h || 0), 0)) : null,
    };
  });
  return { sprint: { id: sp.id, name: sp.name, start_date: sp.start_date, end_date: sp.end_date }, total, total_h: r2(totalH), points };
}

route('GET', '/api/reports/timesheet', ({ user, query }) => {
  const { ids, from, to } = scope(user, query);
  if (!ids.length) return [];
  return timesheetRows(ids, from, to, query.user ? Number(query.user) : null);
});

function timesheetRows(ids, from, to, uid) {
  return q.all(`SELECT w.id, w.date, COALESCE(u.name,'Former member') AS user, p.key||'-'||i.num AS issue, i.title, p.name AS project, w.hours, w.note
    FROM worklogs w JOIN issues i ON i.id=w.issue_id JOIN projects p ON p.id=i.project_id LEFT JOIN users u ON u.id=w.user_id
    WHERE i.project_id IN (${inList(ids)}) AND w.date BETWEEN ? AND ? ${uid ? 'AND w.user_id=?' : ''} ORDER BY w.date DESC, w.id DESC LIMIT 5000`, ...ids, from, to, ...(uid ? [uid] : []));
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, name, header, rows) {
  const lines = [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.end('﻿' + lines.join('\r\n'));
  return RAW;
}

route('GET', '/api/reports/timesheet.csv', ({ user, query, res }) => {
  const { ids, from, to } = scope(user, query);
  const rows = ids.length ? timesheetRows(ids, from, to, query.user ? Number(query.user) : null) : [];
  return sendCsv(res, `timesheet_${from}_${to}.csv`, ['Date', 'Person', 'Project', 'Issue', 'Title', 'Hours', 'Note'], rows.map((r) => [r.date, r.user, r.project, r.issue, r.title, r.hours, r.note]));
});

route('GET', '/api/reports/issues.csv', ({ user, query, res }) => {
  const { ids } = scope(user, query);
  const rows = ids.length ? q.all(`SELECT p.key||'-'||i.num AS key, p.name AS project, i.type, i.title, c.name AS status, i.priority, a.name AS assignee, r.name AS reporter, i.estimate_h, (SELECT COALESCE(SUM(hours),0) FROM worklogs w WHERE w.issue_id=i.id) AS logged, i.start_date, i.due_date, s.name AS sprint, i.created_at, i.resolved_at
    FROM issues i JOIN projects p ON p.id=i.project_id JOIN board_columns c ON c.id=i.column_id LEFT JOIN users a ON a.id=i.assignee_id LEFT JOIN users r ON r.id=i.reporter_id LEFT JOIN sprints s ON s.id=i.sprint_id
    WHERE i.project_id IN (${inList(ids)}) ORDER BY p.key, i.num`, ...ids) : [];
  return sendCsv(res, `issues_${today()}.csv`, ['Key', 'Project', 'Type', 'Title', 'Status', 'Priority', 'Assignee', 'Reporter', 'Estimate (h)', 'Logged (h)', 'Start', 'Due', 'Sprint', 'Created', 'Resolved'],
    rows.map((r) => [r.key, r.project, r.type, r.title, r.status, r.priority, r.assignee, r.reporter, r.estimate_h, r2(r.logged), r.start_date, r.due_date, r.sprint, r.created_at, r.resolved_at]));
});
