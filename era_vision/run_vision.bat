@echo off
title ERA Vision Agent (Port 8200)
cd /d "%~dp0"
if exist "d:\era_agent\.venv\Scripts\python.exe" (
    "d:\era_agent\.venv\Scripts\python.exe" main.py
) else (
    python main.py
)
pause
