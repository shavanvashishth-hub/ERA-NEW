@echo off
setlocal EnableDelayedExpansion
set PATH=C:\Program Files\nodejs;%PATH%
title ERA AI Assistant - Desktop Launcher

echo ========================================================
echo          ERA AI DESKTOP ASSISTANT LAUNCHER
echo ========================================================
echo.

REM --- Kill stale instances ---
echo [1/2] Cleaning up any stale ERA instances and ports...
taskkill /F /IM "ERA AI Assistant.exe" >nul 2>&1
taskkill /F /IM electron.exe >nul 2>&1
for %%P in (8000 8100 8200 3000) do (
    for /f "tokens=5" %%A in ('netstat -ano 2^>nul ^| findstr ":%%P "') do (
        taskkill /PID %%A /F >nul 2>&1
    )
)
ping 127.0.0.1 -n 2 >nul

REM --- Launch Desktop App ---
echo [2/2] Launching ERA AI Desktop Application...
if "%1"=="--dev" goto run_dev
if "%1"=="-dev" goto run_dev

if exist "%LOCALAPPDATA%\Programs\ERA AI Assistant\ERA AI Assistant.exe" (
    start "" "%LOCALAPPDATA%\Programs\ERA AI Assistant\ERA AI Assistant.exe"
    echo ERA Desktop App started.
    exit /b 0
)

:run_dev
cd /d "d:\era-voice-assistant"
npm run electron:start
