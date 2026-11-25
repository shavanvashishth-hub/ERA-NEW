@echo off
set PATH=C:\Program Files\nodejs;%PATH%
title ERA AI Assistant - Unified Launcher

echo =========================================================================
echo        ERA AI ASSISTANT - FAST SYSTEM LAUNCHER v2.3 (TURBO)
echo =========================================================================

netstat -ano | findstr ":8000 " >nul 2>&1
if not errorlevel 1 (
    echo [ONLINE]  ERA Local Agent is already running (Port 8000).
