@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title RoleHaven

set "PORT=8787"
set "URL=http://127.0.0.1:%PORT%"

echo ============================================
echo   RoleHaven
echo ============================================
echo.

rem ---- 1) already running? just open the browser ----
netstat -ano | findstr /C:"127.0.0.1:%PORT%" | findstr /I "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [i] Server is already running at %URL%
  echo [i] Opening browser...
  start "" "%URL%"
  exit /b 0
)

rem ---- 2) locate node.exe ----
rem 只查 PATH 与标准安装位置；放在项目根的 node\ 目录也认（便携版可直接整包分发）
set "NODE="
where node >nul 2>&1 && set "NODE=node"
if not defined NODE if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE (
  echo [X] Node.js not found.
  echo     Install Node.js 18 or newer from https://nodejs.org
  echo     then run start.cmd again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('"%NODE%" -v 2^>nul') do set "NODEV=%%v"
echo [i] Node:    %NODE%  !NODEV!
echo [i] Address: %URL%
echo [i] Browser opens in 3s. Press Ctrl+C to stop the server.
echo.

start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process '%URL%'"

"%NODE%" server.js

echo.
echo [i] Server stopped. Press any key to close this window.
pause >nul
