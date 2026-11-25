@echo off
echo Starting ERA Agent on 8000...
start "ERA Agent (8000)" cmd /k "cd /d d:\era_agent && d:\era_agent\.venv\Scripts\python.exe -m uvicorn api_server:app --host 127.0.0.1 --port 8000"

ping 127.0.0.1 -n 3 >nul

echo Starting ERA Bridge on 8100...
start "ERA Bridge (8100)" cmd /k "cd /d d:\era_bridge\era_bridge && d:\era_agent\.venv\Scripts\python.exe main.py"

ping 127.0.0.1 -n 3 >nul

echo Starting ERA Vision on 8200...
start "ERA Vision (8200)" cmd /k "cd /d d:\era_vision\era_vision_agent_phase2\era_vision_agent && d:\era_agent\.venv\Scripts\python.exe main.py"

echo Services launched!
