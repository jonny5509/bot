@echo off
setlocal
cd /d "%~dp0"
title Time Sync Bot

rem Install Node.js automatically if it is missing or older than version 20.
node -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Installing the latest Node.js LTS automatically...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node.ps1"
  if errorlevel 1 (
    echo.
    echo Automatic Node.js installation failed. Please check the error above.
    pause
    exit /b 1
  )
  rem Refresh this process's PATH so the newly installed Node.js can be found.
  set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%PATH%"
  node -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)" >nul 2>nul
  if errorlevel 1 (
    echo Node.js was installed, but Windows cannot find it yet.
    echo Close this window and run Start Time Sync.bat again.
    pause
    exit /b 1
  )
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

set "HOST=0.0.0.0"
for /f "delims=" %%I in ('node -e "const os=require('node:os');const all=Object.entries(os.networkInterfaces()).flatMap(([name,entries])=>entries.filter(x=>x.family==='IPv4'&&!x.internal).map(x=>({name,address:x.address})));all.sort((a,b)=>Number(/virtual|vethernet|wsl|docker|vmware|virtualbox/i.test(a.name))-Number(/virtual|vethernet|wsl|docker|vmware|virtualbox/i.test(b.name)));console.log(all[0]?.address||'127.0.0.1')"') do set "DASHBOARD_IP=%%I"
if not defined DASHBOARD_IP set "DASHBOARD_IP=127.0.0.1"
start "Open Time Sync Dashboard" cmd /c "ping 127.0.0.1 -n 3 >nul & start http://%DASHBOARD_IP%:3000"
npm start
echo.
echo Time Sync Bot has stopped.
pause
