# ERA AI — Multimodal Autonomous Personal Computer Assistant

[![Tests](https://img.shields.io/badge/Tests-317%20Passed%20%7C%200%20Failed-brightgreen)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%200%20Errors-blue)](#)
[![Architecture](https://img.shields.io/badge/Architecture-Standardized%20Modular-orange)](#)
[![Privacy](https://img.shields.io/badge/Privacy-Local--First-purple)](#)

ERA AI is a local-first, low-latency multimodal AI assistant built for deep Windows OS automation, real-time screen perception, conversational voice interaction, and autonomous multi-step task execution.

---

## 🌟 Key Capabilities

- **Bidirectional Conversational Voice:** Direct bidirectional streaming using Google Gemini 2.0 Multimodal Live API with live visual canvas voice orb and real-time multilingual transcript side panel.
- **Physical Screen Awareness:** High-speed continuous desktop video capture (1 FPS, 1280x720 JPEG) via Win32 GDI BitBlt combined with active-window tracking and bounding-box change detection.
- **OS & Hardware Control Layer:** 52 verified native automation commands covering display brightness, master volume and mute, keyboard backlight (OEM MSI, ASUS, Dell, Lenovo), Wi-Fi, Bluetooth, application launching, window manipulation, file exploration, and power controls (lock, shutdown, restart).
- **Autonomous Mission & Outcome Engine:** Full autonomous loop ($\text{OBSERVE} \to \text{PLAN} \to \text{ACT} \to \text{VERIFY} \to \text{RECOVER} \to \text{LEARN}$) for multi-step software synthesis, coding bug fixes, and file operations with checkpoint saving and recovery.
- **Semantic Local Memory:** Encrypted local SQLite persistence (`era_bridge.db`) with SQLite FTS5 full-text keyword indexing, vector cosine similarity embeddings, and privacy filter blocking confidential credentials.
- **Resilient Fallback Architecture:** 3-tier execution failover: Direct Agent REST (Port 8000) $\to$ Bridge Gateway (Port 8100) $\to$ Native Windows PowerShell / Win32 API direct fallback.

---

## 🚀 Quick Start

### Starting the System
Launch all 4 services and the real-time screen streamer automatically:

```powershell
# In PowerShell:
era
# Or using the master batch launcher:
d:\era-voice-assistant\start_unified_system.bat
```

### Checking Status
Inspect port bindings (8000, 8100, 8200, 3000) and live hardware telemetry:
```powershell
era-status
```

### Stopping Services
Cleanly terminate all ERA background processes:
```powershell
era-stop
```

### Running Tests
Execute the full regression test suite across services:
```powershell
era-test
```

---

## 🧭 Service Topology

| Service | Port | Endpoint | Description |
|---|---|---|---|
| **ERA Local Agent** | `8000` | `http://127.0.0.1:8000/status` | FastAPI local OS automation and autonomous mission engine |
| **ERA Bridge Gateway** | `8100` | `http://127.0.0.1:8100/health` | FastAPI session gateway and SQLite semantic memory store |
| **ERA Vision Agent** | `8200` | `http://127.0.0.1:8200/health` | FastAPI screen change detector and rate-limiting policy engine |
| **ERA Voice Assistant UI** | `3000` | `http://127.0.0.1:3000` | Express, WebSockets, Gemini Live API, React 19 UI |
| **Screen Streamer** | Daemon | `http://127.0.0.1:3000/api/screen/upload` | 1 FPS real-time physical screen capture via GDI BitBlt |

---

## 📚 Comprehensive Documentation Index

The following engineering documents provide in-depth technical details:

1. [**PROJECT_ARCHITECTURE.md**](file:///d:/era-voice-assistant/PROJECT_ARCHITECTURE.md) — Unified system topology, microservice interactions, execution flow, and security boundaries.
2. [**FOLDER_STRUCTURE.md**](file:///d:/era-voice-assistant/FOLDER_STRUCTURE.md) — Complete file trees of all four workspaces and cleanup audit.
3. [**PIPELINE_DOCUMENTATION.md**](file:///d:/era-voice-assistant/PIPELINE_DOCUMENTATION.md) — Specifications for voice, screen streamer, vision policy, command execution, autonomous mission, and memory pipelines.
4. [**API_DOCUMENTATION.md**](file:///d:/era-voice-assistant/API_DOCUMENTATION.md) — Complete REST endpoint and WebSocket interface schemas.
5. [**DEVELOPMENT_GUIDE.md**](file:///d:/era-voice-assistant/DEVELOPMENT_GUIDE.md) — Developer setup, Python venv, adding new commands, and coding standards.
6. [**BUILD_AND_DEPLOYMENT.md**](file:///d:/era-voice-assistant/BUILD_AND_DEPLOYMENT.md) — Production bundling (`vite build` + `esbuild`) and Electron desktop app packaging.
7. [**TESTING_REPORT.md**](file:///d:/era-voice-assistant/TESTING_REPORT.md) — Comprehensive before-and-after test execution matrix (317/317 passing).
8. [**CHANGELOG.md**](file:///d:/era-voice-assistant/CHANGELOG.md) — Chronological log of bug fixes, code removals, and refactorings.

---

## 🛡️ Privacy & Local-First Security

- **Strict Local Binding:** All services bind strictly to loopback interfaces (`127.0.0.1`).
- **Zero Hidden Telemetry:** Hardware perception runs locally; no private files or screenshots are transmitted externally without user interaction.
- **Secrets Sanitization:** Memory ingestion actively redacts passwords, tokens, API keys, and government IDs before writing to disk.
- **Rollback Safety:** Complete rollback archives maintained in `d:\era_backups\`.
