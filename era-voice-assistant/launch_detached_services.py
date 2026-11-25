"""
Detached Launcher for ERA Services.
Launches Local Agent (8000), Bridge Gateway (8100), Vision Agent (8200), UI Server (3000), and Desktop Screen Streamer
as independent detached background processes on Windows so no CLI task stays hung.
"""

import subprocess
import sys
import time

PYTHON_EXE = r"d:\era_agent\.venv\Scripts\python.exe"
NODE_EXE = r"C:\Program Files\nodejs\node.exe"

DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

SERVICES = [
    {
        "name": "Local Agent (8000)",
        "cmd": [PYTHON_EXE, "-m", "uvicorn", "api_server:app", "--host", "127.0.0.1", "--port", "8000"],
        "cwd": r"d:\era_agent",
    },
    {
        "name": "Bridge Gateway (8100)",
        "cmd": [PYTHON_EXE, "main.py"],
        "cwd": r"d:\era_bridge\era_bridge",
    },
    {
        "name": "Vision Agent (8200)",
        "cmd": [PYTHON_EXE, "main.py"],
        "cwd": r"d:\era_vision\era_vision_agent_phase2\era_vision_agent",
    },
    {
        "name": "UI Server (3000)",
        "cmd": [NODE_EXE, "dist/server.cjs"],
        "cwd": r"d:\era-voice-assistant",
    },
    {
        "name": "Screen Streamer",
        "cmd": [PYTHON_EXE, r"d:\era-voice-assistant\server\desktop_screen_streamer.py"],
        "cwd": r"d:\era-voice-assistant",
    },
]

for s in SERVICES:
    print(f"Starting {s['name']} in detached mode...")
    p = subprocess.Popen(
        s["cmd"],
        cwd=s["cwd"],
        creationflags=DETACHED,
        close_fds=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    print(f"Started {s['name']} (PID: {p.pid})")
    time.sleep(1)

print("All ERA services launched detached successfully.")
