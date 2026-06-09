@echo off
setlocal

cd /d "%~dp0"
set "PORT=3000"

where node >nul 2>nul
if errorlevel 1 goto missing_node

for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 22 goto old_node

where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node

netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 set "PORT=3001"

echo Dang khoi dong GreenLoop...
echo.
echo Neu Windows hoi quyen Firewall, hay bam Allow access.
echo Trinh duyet se tu mo sau vai giay.
echo.

start "GreenLoop Server" cmd /k "cd /d ""%~dp0"" && set PORT=%PORT% && npm run dev"

timeout /t 5 /nobreak >nul
start "" "http://localhost:%PORT%"

echo GreenLoop dang chay tai:
echo http://localhost:%PORT%
echo.
echo Dung dong cua so "GreenLoop Server" khi dang su dung app.
echo Muon tat app thi dong cua so "GreenLoop Server".
echo.
pause
exit /b 0

:missing_node
echo Khong tim thay Node.js tren may nay.
echo.
echo Hay cai Node.js ban LTS moi nhat, yeu cau Node 22 tro len:
echo https://nodejs.org/
echo.
start "" "https://nodejs.org/"
pause
exit /b 1

:old_node
echo Node.js tren may nay dang qua cu.
echo Yeu cau Node.js 22 tro len de chay GreenLoop.
echo.
echo Ban hien tai:
node -v
echo.
echo Hay cap nhat Node.js tai:
echo https://nodejs.org/
echo.
start "" "https://nodejs.org/"
pause
exit /b 1
