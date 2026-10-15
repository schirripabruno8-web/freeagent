@echo off
rem Starts FreeAgent from source (after Install.bat or "npm run build").
cd /d "%~dp0"
if not exist "out\main\index.js" (
  echo FreeAgent is not built yet: run Install.bat first.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
