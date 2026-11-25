# ERA AI — Developer Guide

This guide describes how to develop, test, debug, and extend the ERA AI system across all four repositories.

---

## 1. Environment Setup & Prerequisites

### 1.1 Prerequisites
- **Operating System:** Windows 10 or 11 (64-bit).
- **Node.js:** v18.0.0 or later (Node 20+ recommended).
- **Python:** Python 3.10 to 3.14 (3.14.7 used by active environment).
- **C++ Build Tools:** Required for native Win32 audio and GDI dependencies.

### 1.2 Virtual Environment Configuration
All Python services share the centralized virtual environment located at `d:\era_agent\.venv`:

```powershell
# Verify Python virtual environment
d:\era_agent\.venv\Scripts\python.exe --version

# Install or update dependencies
d:\era_agent\.venv\Scripts\pip.exe install -r d:\era_agent\requirements.txt
```

### 1.3 Node.js Workspace Configuration
```powershell
cd d:\era-voice-assistant
npm install
```

---

## 2. Running the Unified System in Development

### 2.1 PowerShell Profile Integration
The local PowerShell profile provides native management commands:

| Command | Alias | Description |
|---|---|---|
| `Start-Era` | `era` | Launches all 4 services and the physical screen streamer automatically. |
| `Status-Era` | `era-status` | Probes all ports (8000, 8100, 8200, 3000) and displays live hardware telemetry. |
| `Stop-Era` | `era-stop` | Cleanly terminates all processes listening on ports 8000, 8100, 8200, and 3000. |
| `Test-Era` | `era-test` | Runs the full regression test suite across the services. |

### 2.2 Manual Service Launching (Individual Debugging)
To debug an individual service, open a terminal for that service:

```powershell
# Service 1: ERA Local Agent (Port 8000)
cd d:\era_agent
d:\era_agent\.venv\Scripts\python.exe -m uvicorn api_server:app --host 127.0.0.1 --port 8000 --reload

# Service 2: ERA Bridge Gateway (Port 8100)
cd d:\era_bridge\era_bridge
$env:PYTHONPATH="d:\era_bridge\era_bridge"
d:\era_agent\.venv\Scripts\python.exe main.py

# Service 3: ERA Vision Agent (Port 8200)
cd d:\era_vision\era_vision_agent_phase2\era_vision_agent
$env:PYTHONPATH="d:\era_vision\era_vision_agent_phase2\era_vision_agent"
d:\era_agent\.venv\Scripts\python.exe main.py

# Service 4: ERA Voice Assistant & UI Server (Port 3000)
cd d:\era-voice-assistant
npm run dev

# Service 5: Desktop Screen Streamer
d:\era_agent\.venv\Scripts\python.exe d:\era-voice-assistant\server\desktop_screen_streamer.py
```

---

## 3. How to Add a New System Command

All system commands are registered using the `@registry.register` decorator in `d:\era_agent\commands\system_commands.py`:

```python
from commands.registry import registry, CommandParam, CommandResult

@registry.register(
    name="my_new_action",
    description="Performs a specific OS automation task.",
    params=[
        CommandParam("target", "str", "The target parameter description", required=True)
    ]
)
def my_new_action(target: str = "") -> CommandResult:
    try:
        # Perform Win32, subprocess, or hardware operation
        result_text = f"Action successfully executed on {target}"
        return CommandResult(success=True, message=result_text)
    except Exception as exc:
        return CommandResult(success=False, message=f"Failed: {exc}")
```

### Automatic Cross-Service Sync:
Whenever a new command is added or modified in `d:\era_agent\commands\system_commands.py`:
Run `python d:\era-voice-assistant\add_aliases.py` to synchronize command handlers into `era_agent/commands` and packaged electron resources.

---

## 4. Code Quality & Formatting Rules

- **Type Safety:** Always run `npm run lint` (`tsc --noEmit`) before committing TypeScript code. Ensure zero compiler errors.
- **Python Quality:** All Python code must be compatible with Python 3.10–3.14. Maintain strict type annotations (`typing.Optional`, `Dict`, `List`, `Any`).
- **Zero Regression Rule:** Never alter existing command schemas or responses in a breaking way. Additive features only.
- **No Stale Code:** Never create scratch files or duplicate backup directories inside source trees. Use the designated `.checkpoints` and `workspace` directories.
