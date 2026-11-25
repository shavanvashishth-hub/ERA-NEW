@echo off
title ERA Local Agent (Port 8000)
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" api_server.py
) else (
    python api_server.py
)
pause
