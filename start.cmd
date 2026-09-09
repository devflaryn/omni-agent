@echo off
REM Omni Agent — local agentic OS for pi + Claude Code with an Obsidian memory vault.
REM   start.cmd                 local only, pi works in Desktop
REM   start.cmd "C:\project"    pi works in that folder
REM   start.cmd . --lan         also reachable from other devices on your network (token required)
setlocal
set "HERE=%~dp0"
set "WD=%~1"
if "%WD%"=="" set "WD=%USERPROFILE%\Desktop"
if "%WD%"=="." set "WD=%USERPROFILE%\Desktop"
title Omni Agent
echo Omni Agent  (pi cwd: %WD%)
start "" "http://127.0.0.1:4400"
node "%HERE%server\index.mjs" --cwd "%WD%" %2 %3 %4 %5
endlocal
pause
