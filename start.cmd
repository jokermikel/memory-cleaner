@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Memory Cleaner

echo.
echo ==========================================
echo   Memory Cleaner
echo ==========================================
echo   dir: %CD%
echo.

set "NODE_EXE="
if exist "%LOCALAPPDATA%\nvm-node\node.exe" set "NODE_EXE=%LOCALAPPDATA%\nvm-node\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\AppData\Local\nvm-node\node.exe" set "NODE_EXE=%USERPROFILE%\AppData\Local\nvm-node\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%I in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%I"
  )
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

if not defined NODE_EXE (
  echo [ERROR] Node.js not found.
  echo         Install from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo [OK] node = %NODE_EXE%
echo.

"%NODE_EXE%" "%~dp0launcher.js"
set "EC=%ERRORLEVEL%"
echo.
if not "%EC%"=="0" (
  echo [ERROR] launcher exit code %EC%
)
echo Press any key to close.
pause >nul
endlocal
exit /b %EC%
