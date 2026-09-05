@echo off
REM start-agent.bat - Chay agent voi auto-restart khi crash (Windows).
REM Tuong ung voi start-agent.sh tren Linux/macOS.
REM Yeu cau: node, yt-dlp, ffmpeg tren PATH (cai qua winget hoac scoop).
REM   winget install yt-dlp.yt-dlp
REM   winget install Gyan.FFmpeg
REM   winget install aria2.aria2   (tuy chon)
cd /d "%~dp0"

:loop
echo [%DATE% %TIME%] Starting YT-Queue-Agent...
node agent.js
set EXIT_CODE=%ERRORLEVEL%
echo.
echo [%DATE% %TIME%] Agent stopped (exit code %EXIT_CODE%%). Restarting in 10 seconds...
echo Press Ctrl+C to exit completely.
timeout /t 10 /nobreak >nul
goto loop
