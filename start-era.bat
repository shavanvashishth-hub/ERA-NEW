@echo off
REM ==========================================================
REM ERA System - Unified Startup Launcher
REM Launches ERA Agent, Bridge Gateway, Vision Agent, & Desktop App
REM ==========================================================

title ERA Unified System Launcher
echo [ERA] ==============================================
echo [ERA]   Starting ERA AI Assistant Ecosystem...
echo [ERA] ==============================================

set BASE_DIR=%~dp0

REM 1. Start Python Agent Backend
echo [1/4] Starting ERA Agent (Port 8000)...
start "ERA Agent" cmd /k "cd /d %BASE_DIR%era_agent && python api_server.py"

REM Wait 2 seconds
timeout /t 2 /nobreak >nul

REM 2. Start Bridge Gateway
echo [2/4] Starting ERA Bridge Gateway...
start "ERA Bridge" cmd /k "cd /d %BASE_DIR%era_bridge && python main.py"

REM Wait 2 seconds
timeout /t 2 /nobreak >nul

REM 3. Start Vision Agent
echo [3/4] Starting ERA Vision Agent...
start "ERA Vision" cmd /k "cd /d %BASE_DIR%era_vision && python main.py"

REM Wait 2 seconds
timeout /t 2 /nobreak >nul

REM 4. Start Voice Assistant Desktop App / UI
echo [4/4] Starting ERA Voice Assistant (Electron & UI)...
cd /d "%BASE_DIR%era-voice-assistant"
npm run dev

echo [ERA] All systems active.
