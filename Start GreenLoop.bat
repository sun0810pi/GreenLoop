@echo off
setlocal
title GreenLoop

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo GreenLoop needs Node.js before it can start.
  echo Please install the LTS version from https://nodejs.org, then run this file again.
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0greenloop-backend"
if not exist node_modules (
  echo Installing GreenLoop for the first time. This may take a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo Installation failed. Please check your internet connection and try again.
    pause
    exit /b 1
  )
)

start "" http://localhost:3000
echo GreenLoop is starting. Keep this window open while using the website.
node server.js
pause
