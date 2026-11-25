# Start all ERA services in background reliably
$python = "d:\era_agent\.venv\Scripts\python.exe"

# 1. Local Agent (port 8000)
Write-Host "[1/4] Starting ERA Local Agent (8000)..."
Start-Process $python -ArgumentList "-m uvicorn api_server:app --host 127.0.0.1 --port 8000" -WorkingDirectory "d:\era_agent" -WindowStyle Hidden
Start-Sleep -Seconds 3

# 2. Bridge Gateway (port 8100)
Write-Host "[2/4] Starting ERA Bridge Gateway (8100)..."
Start-Process $python -ArgumentList "main.py" -WorkingDirectory "d:\era_bridge\era_bridge" -WindowStyle Hidden
Start-Sleep -Seconds 3

# 3. Vision Agent (port 8200)
Write-Host "[3/4] Starting ERA Vision Agent (8200)..."
Start-Process $python -ArgumentList "main.py" -WorkingDirectory "d:\era_vision\era_vision_agent_phase2\era_vision_agent" -WindowStyle Hidden
Start-Sleep -Seconds 3

# 4. Voice Assistant UI (port 3000)
Write-Host "[4/4] Starting ERA Voice Assistant UI (3000)..."
Start-Process "cmd.exe" -ArgumentList "/c cd /d d:\era-voice-assistant && npx tsx server.ts" -WindowStyle Hidden
Start-Sleep -Seconds 7

# 5. Screen Streamer (continuous desktop capture -> port 3000)
Write-Host "[+] Starting Desktop Screen Streamer..."
Start-Process $python -ArgumentList "d:\era-voice-assistant\server\desktop_screen_streamer.py" -WindowStyle Hidden

Write-Host "All services initiated. Verifying..."
Start-Sleep -Seconds 4
Status-Era
