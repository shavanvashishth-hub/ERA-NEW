@echo off
title ERA Hand Gesture Intelligence
cd /d "d:\era_agent"
echo Starting ERA Hand Gesture Intelligence...
".venv\Scripts\python.exe" run_gesture_control.py --preview %*
pause
