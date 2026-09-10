@echo off
REM Manual hard-stop fallback. Normally the dashboard supervises CasparCG and
REM MediaMTX itself and cleans them up on its own graceful shutdown (Ctrl+C) -
REM this script is for when that didn't happen (a crash, a forced window close)
REM and something needs to force everything down, including orphaned CEF helper
REM processes that a normal window-close leaves behind.

echo Stopping AMCP dashboard...
REM Stop it the graceful way first (via PM2, if it's running under PM2) so its
REM own SIGINT handler gets a chance to cleanly stop CasparCG/MediaMTX too,
REM then force-kill anything left by raw process match as a fallback - covers
REM both a PM2-managed dashboard and one started directly with "node server.js".
pushd "%~dp0amcp-dashboard" >nul 2>&1
call npx pm2 delete amcp-dashboard >nul 2>&1
popd >nul 2>&1
REM Match by trailing "server.js" in the command line, not by folder name: when launched
REM via "cd /d amcp-dashboard && node server.js" the process's own CommandLine never
REM contains the folder path, so a "*amcp-dashboard*" filter silently matches nothing.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'server\.js$' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Stopping CasparCG (main process + all orphaned CEF helper processes)...
taskkill /IM casparcg.exe /T /F >nul 2>&1

echo Stopping MediaMTX...
taskkill /IM mediamtx.exe /T /F >nul 2>&1

echo Clearing stale CEF profile lock...
del /f /q "%~dp0casparcg-server-v2.5.0-stable-windows\cef-cache\lockfile" >nul 2>&1

echo Done. All project processes stopped.
