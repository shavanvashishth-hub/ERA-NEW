# ==========================================================
# ERA System - PowerShell Unified Launcher
# ==========================================================

$BaseDir = $PSScriptRoot

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Launching ERA AI Assistant Ecosystem...    " -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# 1. Local Agent (Port 8000)
Write-Host "[1/4] Starting ERA Agent (Port 8000)..." -ForegroundColor Yellow
Start-Process "powershell" -ArgumentList "-NoExit", "-Command", "cd '$BaseDir\era_agent'; python api_server.py"

Start-Sleep -Seconds 2

# 2. Bridge Gateway
Write-Host "[2/4] Starting ERA Bridge Gateway..." -ForegroundColor Yellow
Start-Process "powershell" -ArgumentList "-NoExit", "-Command", "cd '$BaseDir\era_bridge'; python main.py"

Start-Sleep -Seconds 2

# 3. Vision Agent
Write-Host "[3/4] Starting ERA Vision Agent..." -ForegroundColor Yellow
Start-Process "powershell" -ArgumentList "-NoExit", "-Command", "cd '$BaseDir\era_vision'; python main.py"

Start-Sleep -Seconds 2

# 4. Voice Assistant UI
Write-Host "[4/4] Starting ERA Voice Assistant UI..." -ForegroundColor Green
Set-Location "$BaseDir\era-voice-assistant"
npm run dev
