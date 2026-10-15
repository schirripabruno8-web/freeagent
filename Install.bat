@echo off
rem Double-click to install FreeAgent from source: checks Node.js, installs, builds, makes a Desktop shortcut and starts the app.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
pause
