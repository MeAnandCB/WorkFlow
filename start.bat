@echo off
title TaskFlow server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.5 or newer is required. Download it from https://nodejs.org
  pause
  exit /b 1
)
echo Starting TaskFlow... (close this window to stop the server)
start "" http://localhost:3000
node server\server.js
pause
