"""
ERA Core Services Monitor & Background Supervisor
Keeps Local Agent (8000), Bridge Gateway (8100), and Vision Agent (8200) alive continuously.
"""

import subprocess
import time
import sys
import os

PYTHON_EXE = r"d:\era_agent\.venv\Scripts\python.exe"
NODE_EXE = r"C:\Program Files\nodejs\node.exe"

SERVICES = [
    {
        "name": "Local Agent (8000)",
        "cmd": [PYTHON_EXE, "-m", "uvicorn", "api_server:app", "--host", "127.0.0.1", "--port", "8000"],
        "cwd": r"d:\era_agent",
        "port": 8000,
    },
    {
        "name": "Bridge Gateway (8100)",
        "cmd": [PYTHON_EXE, "main.py"],
        "cwd": r"d:\era_bridge\era_bridge",
        "port": 8100,
    },
    {
        "name": "Vision Agent (8200)",
        "cmd": [PYTHON_EXE, "main.py"],
        "cwd": r"d:\era_vision\era_vision_agent_phase2\era_vision_agent",
        "port": 8200,
    },
    {
        "name": "UI Server (3000)",
        "cmd": [NODE_EXE, "dist/server.cjs"],
        "cwd": r"d:\era-voice-assistant",
        "port": 3000,
    },
    {
        "name": "Screen Streamer (Continuous Feed)",
        "cmd": [PYTHON_EXE, r"d:\era-voice-assistant\server\desktop_screen_streamer.py"],
        "cwd": r"d:\era-voice-assistant",
        "port": None,
    },
]

procs = {}

def start_service(s):
    name = s["name"]
    print(f"[*] Starting {name}...")
    p = subprocess.Popen(
        s["cmd"],
        cwd=s["cwd"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    procs[name] = p
    print(f"[+] {name} started (PID: {p.pid})")

for s in SERVICES:
    start_service(s)
    time.sleep(2)

print("\nAll 3 ERA Python services are active and monitored.")
sys.stdout.flush()

try:
    while True:
        time.sleep(5)
        for s in SERVICES:
            name = s["name"]
            p = procs.get(name)
            if p is None or p.poll() is not None:
                print(f"[!] {name} died or exited. Restarting...")
                start_service(s)
                sys.stdout.flush()
except KeyboardInterrupt:
    print("\nShutting down all services...")
    for name, p in procs.items():
        try:
            p.terminate()
        except Exception:
            pass
