@echo off
title TaskFlow server (this computer only)
cd /d "%~dp0"
set HOST=127.0.0.1
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.5 or newer is required. Download it from https://nodejs.org
  pause
  exit /b 1
)
start "" http://localhost:3000
node server\server.js
pause
