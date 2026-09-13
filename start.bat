@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title liteticket

rem ============================================================
rem  liteticket launcher
rem
rem  Double-click this file to run the app, or use it from a
rem  terminal with one of the flags below.
rem
rem    start.bat              start (opens browser)
rem    start.bat /noopen      start without opening a browser
rem    start.bat /reset       wipe the database, then start
rem    start.bat /install     force reinstall dependencies first
rem ============================================================

cd /d "%~dp0"

echo.
echo   liteticket
echo   ----------------------------------------
echo.

rem ---- Parse flags -------------------------------------------
set "NOOPEN="
set "RESET="
set "FORCEINSTALL="

for %%A in (%*) do (
  if /i "%%~A"=="/noopen"  set "NOOPEN=--no-open"
  if /i "%%~A"=="/reset"   set "RESET=--reset"
  if /i "%%~A"=="/install" set "FORCEINSTALL=1"
)

rem ---- Check Node --------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Node.js not found.
  echo.
  echo   Install Node.js 20.11 or newer from:
  echo     https://nodejs.org
  echo.
  echo   Then close this window and run it again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%V in ('node --version 2^>nul') do set "NODEVERSION=%%V"
echo   Node.js      !NODEVERSION!

rem ---- Check pnpm --------------------------------------------
set "PNPM="
where pnpm.cmd >nul 2>&1 && set "PNPM=pnpm.cmd"
if not defined PNPM (
  where pnpm >nul 2>&1 && set "PNPM=pnpm"
)
if not defined PNPM (
  where corepack >nul 2>&1 && set "PNPM=corepack pnpm"
)

if not defined PNPM (
  echo   [ERROR] pnpm not found.
  echo.
  echo   Enable it with:
  echo     corepack enable
  echo.
  echo   Or install it with:
  echo     npm install -g pnpm
  echo.
  pause
  exit /b 1
)
echo   pnpm         !PNPM!
echo.

rem ---- Install dependencies if needed ------------------------
if defined FORCEINSTALL goto :doinstall

if not exist "node_modules" (
  echo   Dependencies are not installed yet.
  echo.
  goto :doinstall
)

if not exist "node_modules\hono" (
  echo   Dependency folder looks incomplete.
  echo.
  goto :doinstall
)

goto :run

:doinstall
echo   Installing dependencies - this may take a minute...
echo.
call !PNPM! install
if errorlevel 1 (
  echo.
  echo   [ERROR] Installation failed. See the messages above.
  echo.
  pause
  exit /b 1
)
echo.
echo   Dependencies installed.
echo.

:run
rem ---- Launch ------------------------------------------------
echo   Starting liteticket...
echo.

set "ARGS="
if defined NOOPEN set "ARGS=!ARGS! --no-open"
if defined RESET  set "ARGS=!ARGS! --reset"

node scripts\dev.mjs !ARGS!

rem A clean exit (Ctrl+C) lands here too; only pause on real errors.
if errorlevel 1 (
  echo.
  echo   [ERROR] liteticket exited with an error.
  echo.
  pause
  exit /b 1
)

endlocal
