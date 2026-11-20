@echo off
rem paper-reader: start the local server (127.0.0.1 only) and open the browser.
rem Close this window to stop the server.
title paper-reader
cd /d "%~dp0"
set PYTHONUTF8=1
python server.py %*
if errorlevel 1 pause
