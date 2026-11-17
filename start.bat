@echo off
rem Starts the telehealth server. Keep this window open while you see clients.
cd /d "%~dp0"
if not exist node_modules call npm install --omit=dev
if not exist data\config.json call npm run setup
node server\server.js
pause
