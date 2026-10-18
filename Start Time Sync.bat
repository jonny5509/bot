@echo off
setlocal
cd /d "%~dp0"
title Time Sync Bot

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Download it from https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules\ (
  echo Installing required packages for the first run...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist .env (
  if exist .env.example copy .env.example .env >nul
)

start "Open Time Sync Dashboard" cmd /c "ping 127.0.0.1 -n 3 >nul & start http://127.0.0.1:3000"
npm start
echo.
echo Time Sync Bot has stopped.
pause
