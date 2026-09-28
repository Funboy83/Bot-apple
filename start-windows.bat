@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Please install Node.js 20 or newer from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo First run: installing...
  call npm install || (pause & exit /b 1)
  call npx playwright install chromium
)
start "" http://localhost:3777
node src/server.js
pause
