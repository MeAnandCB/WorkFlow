# TaskFlow – local project management tool

A Jira-style work management tool that runs on your own computer. No internet, no accounts with third parties, and **no packages to install** – it only needs Node.js 22.5 or newer.

## Start it

Double-click **`start.bat`** (or run `node server/server.js`). Your browser opens at <http://localhost:3000>.

* The first time, create the **administrator account**.
* Teammates on the same Wi-Fi/LAN open the `http://<your-ip>:3000` address printed in the console window (Windows may ask to allow Node through the firewall – allow it for private networks). The admin adds their accounts under **Team**.
* Use `start-this-computer-only.bat` if you do not want anyone else to reach it.
* Change the port with `set PORT=4000` before starting.

Your data lives in one SQLite file, `pm.db`. The console prints its location when the server starts. Because this folder is inside OneDrive (which can corrupt a live database), data is stored in `%LOCALAPPDATA%/TaskFlow` instead; set the `DATA_DIR` environment variable to choose another place. **Back it up by copying `pm.db` while the server is stopped.**

## What's inside

| Area | Features |
|---|---|
| **Projects** | Create projects with a key (e.g. `WEB-12` style ids), description, dates, archive/delete, per-project team with roles (manager / member / viewer) |
| **Issues** | Task, Bug, Story, Epic, Subtask · priority · assignee · estimate · start & due dates · labels · parent/epic · sprint · full edit history · comments with `@mentions` |
| **Board** | Kanban with drag & drop (also reorders inside a column), custom columns (rename, reorder, add, delete) with To do / In progress / Done categories, filters and search |
| **Sprints & backlog** | Plan sprints by dragging issues, start/complete sprints (unfinished work carries over), goal and dates, quick-add |
| **Task assignment** | Assign to project members; assignees are notified; "My work" groups everything by overdue / today / this week / later |
| **Time tracking** | Start/stop timer anywhere, manual time logs, estimate vs. logged vs. remaining, over-estimate warning |
| **Reminders** | Personal reminders (one-off, daily, weekly, monthly), snooze, in-app alert + sound + desktop notification, automatic alerts for tasks due tomorrow / today / overdue |
| **Team chat (local)** | General channel, one channel per project, direct messages, live delivery, unread badges, `@mentions` |
| **Notifications** | Bell with unread count: assignments, status changes, comments, mentions, due dates |
| **Progress & reports** | Completion %, pending & overdue lists, workload per person, time per day / person / project, priority & type breakdown, sprint burndown and velocity, timesheet; **CSV export** of timesheets and issues |
| **Team admin** | Add/deactivate users, roles (administrator / member), reset passwords, profile & avatar colour |
| **Other** | Global search (press `/`), dark mode, works on phones |

Tips: type `@name` (the part of the email before the `@`) to mention someone; press **Ctrl+Enter** to send a comment; press **Esc** to close dialogs.

## Safety & security

Passwords are hashed (scrypt), sessions use HttpOnly cookies, login attempts are rate limited, state-changing requests from other websites are blocked, and all text is escaped before display. The server has no internet access requirements. Only expose it on a network you trust (use plain HTTP on your LAN; put a reverse proxy with HTTPS in front if you ever host it on the internet).

## Tests

`node test/test.js` starts a throw-away server with a temporary database and checks the whole API (permissions, workflows, sprints, time tracking, reminders, chat, reports, exports, security). It takes about 15 seconds.

## Project layout

```
server/   db.js (schema) · core.js (helpers, permissions) · router.js · routes.js (API) · reports.js · hub.js (live events) · server.js
public/   index.html · style.css · js/ (app, project, issue, pages, chat, reports, lib)
test/     test.js
(data)    pm.db – created on first run, location printed at startup
```
