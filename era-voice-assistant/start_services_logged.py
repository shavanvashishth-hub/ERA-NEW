"""
ERA Services Runner with Logs
"""
import subprocess
import os
import sys
import time

PYTHON_EXE = r"d:\era_agent\.venv\Scripts\python.exe"
NODE_EXE = r"C:\Program Files\nodejs\node.exe"
LOGS_DIR = r"d:\era-voice-assistant\logs_services"
os.makedirs(LOGS_DIR, exist_ok=True)

SERVICES = [
    {
        "name": "Local Agent (8000)",
        "cmd": [PYTHON_EXE, "-m", "uvicorn", "api_server:app", "--host", "127.0.0.1", "--port", "8000"],
        "cwd": r"d:\era_agent",
        "log": os.path.join(LOGS_DIR, "local_agent.log")
    },
    {
        "name": "Bridge Gateway (8100)",
        "cmd": [PYTHON_EXE, "main.py"],
        "cwd": r"d:\era_bridge\era_bridge",
        "log": os.path.join(LOGS_DIR, "bridge_gateway.log")
    },
    {
        "name": "Vision Agent (8200)",
        "cmd": [PYTHON_EXE, "main.py"],
        "cwd": r"d:\era_vision\era_vision_agent_phase2\era_vision_agent",
        "log": os.path.join(LOGS_DIR, "vision_agent.log")
    },
    {
        "name": "Screen Streamer",
        "cmd": [PYTHON_EXE, r"d:\era-voice-assistant\server\desktop_screen_streamer.py"],
        "cwd": r"d:\era-voice-assistant",
        "log": os.path.join(LOGS_DIR, "screen_streamer.log")
    },
]

DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

for s in SERVICES:
    log_f = open(s["log"], "a", encoding="utf-8")
    p = subprocess.Popen(
        s["cmd"],
        cwd=s["cwd"],
        creationflags=DETACHED,
        close_fds=True,
        stdout=log_f,
        stderr=log_f
    )
    print(f"Started {s['name']} (PID: {p.pid}) -> {s['log']}")
    time.sleep(1)

print("Services launched.")
