@echo off
cd /d "%~dp0.."
start "s-curve-server" /min "C:\Program Files\nodejs\node.exe" "%CD%\scripts\static-server.mjs" > "%CD%\server.log" 2>&1
