@echo off
title fm_board_enhance - share
cd /d "%~dp0"
echo.
echo  Starting local server + Cloudflare tunnel...
echo  Keep this window open. Ctrl+C to stop.
echo.
node scripts\share.mjs
pause
