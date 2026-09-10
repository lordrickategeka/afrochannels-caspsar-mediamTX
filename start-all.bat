@echo off
REM CasparCG and MediaMTX are spawned and supervised by the dashboard process
REM itself (see amcp-dashboard/process-manager.js) - their live output shows
REM up in the dashboard's own browser log console instead of separate
REM terminal windows. The dashboard itself now runs under PM2, which
REM automatically restarts it if it ever crashes, and runs as a background
REM daemon rather than a window you need to keep open.

call "%~dp0stop-all.bat"

timeout /t 1 /nobreak >nul

cd /d "%~dp0amcp-dashboard"
echo Starting AMCP Dashboard under PM2 (auto-restarts on crash; also starts CasparCG and MediaMTX)...
call npx pm2 start ecosystem.config.js

echo.
echo Dashboard running - open http://localhost:3005
echo View live process status:  npm run pm2:status   (from amcp-dashboard)
echo View dashboard-process logs: npm run pm2:logs   (from amcp-dashboard)
echo   - CasparCG/MediaMTX output is in the dashboard's own browser Process Console instead.
echo To stop everything cleanly, run stop-all.bat.
