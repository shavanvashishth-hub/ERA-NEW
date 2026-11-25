# 🗺️ ERA — Complete Source Code Architecture & Directory Map

This document provides a comprehensive inventory of all source code files included in the **ERA (Electronic Responsive Assistant)** ecosystem.

---

## 📌 1. Subsystem Index

| Subsystem | Folder | Core Responsibilities |
| :--- | :--- | :--- |
| **Local Agent** | `era_agent/` | Native Windows controls, window management, Swiggy food ordering, WhatsApp adapter, hotkeys, intent parsing |
| **Vision Engine** | `era_vision/` | Screen capture, OCR extraction, element detection, multi-monitor scaling, Gemini vision integration |
| **Voice & Desktop**| `era-voice-assistant/`| Electron + React desktop frontend, audio streaming, VoiceGuard biometric gating |
| **Memory Engine** | `era_memory/` | Associative memory, persistent SQLite knowledge store, working session context, vector embeddings |
| **Bridge Gateway** | `era_bridge/` | FastAPI & WebSocket IPC message router, session security, client routing |
| **Unified Master** | `ERA_UNIFIED_MASTER.py` | Single-file runnable orchestrator uniting Agent, Vision, Memory, and Voice |
| **Workspace Tools**| `workspace_scripts/` | Autonomous helper scripts, calculators, face detection, security protocols |

---

## 🤖 2. Local Agent Files (`era_agent/`)
* **`api_server.py`**: Local Agent REST server exposing port 8000 for system execution.
* **`main.py`**: Standalone Agent entrypoint.
* **`commands/`**:
  * `system_commands.py`: Over 200 KB of native Windows command implementations (apps, explorer, browser, window snap).
  * `food_ordering_agent.py`: Autonomous Swiggy food ordering engine and cart checkout.
  * `window_manager.py`: Win32 window positioning, focus, and state tracking.
  * `background_controller.py`: Headless background task execution.
* **`controls/`**:
  * `audio.py`: Master audio & volume slider automation.
  * `display.py`: Resolution & multi-monitor display controllers.
  * `keyboard.py`: Low-level scan code simulation & typing.
  * `phone_link.py`: Windows Phone Link synchronization.
  * `intent_parser.py`: Natural language intent classifier.
* **`intelligence_core/`**:
  * `orchestrator.py`: Multi-step reasoning pipeline.
  * `context_engine.py`: Live environment state tracking.
  * `personal_vault.py`: Secure encrypted storage.
  * `goal_engine.py`: Autonomous goal decomposition.
* **`gestures/`**:
  * `gesture_controller.py` & `hud_renderer.py`: Camera-based hand gesture controls and HUD overlay.

---

## 👁️ 3. Vision Engine Files (`era_vision/`)
* **`main.py` & `app.py`**: Vision service server (Port 8766).
* **`vision/capture.py`**: High-speed desktop frame grabber.
* **`vision/ocr.py`**: Tesseract & Windows OCR text reader.
* **`vision/action_engine.py`**: Visual element detection & coordinate click resolver.
* **`vision/providers/gemini_provider.py`**: Multimodal visual grounding using Google Gemini.
* **`security/auth.py` & `security/privacy.py`**: Real-time screen redaction and API authentication.

---

## 🧠 4. Memory Engine Files (`era_memory/`)
* **`associative_memory.py`**: Semantic memory association across multiple conversation turns.
* **`memory_database.py`**: SQLite persistent relational store.
* **`memory_embeddings.py`**: Vector embeddings generator for nearest-neighbor semantic search.
* **`memory_extractor.py`**: Extracts user preferences, habits, and facts from natural dialogue.
* **`memory_retriever.py`**: Top-K memory relevance query engine.
* **`working_memory.py`**: In-RAM short-term buffer for ongoing user commands.
* **`era_memory_service.py`**: Standalone HTTP/RPC memory service.

---

## 🎙️ 5. Voice Assistant & Desktop App (`era-voice-assistant/`)
* **`src/`**:
  * `voiceguard/`: Biometric owner verification, voiceprint profiling, and acoustic visualizers.
  * `live/LiveSession.ts`: Real-time WebSocket audio bidirectional streaming.
  * `components/`: Futuristic HUD, wave visualizers, settings drawer, and console logs.
* **`electron/`**:
  * `main.cjs`: Electron window manager, tray icon, background daemon, and IPC bridges.
  * `preload.cjs`: Secure renderer-to-main IPC communication.
* **`server/server.ts`**: Web/WebSocket server linking UI to local services.

---

## ⚡ 6. Bridge Gateway (`era_bridge/`)
* **`bridge_server.py` & `main.py`**: Central IPC message broker (Port 8765).
* **`core/session_engine.py`**: Manages authenticated client connections across UI, Agent, and Vision.
* **`api/routes_telemetry.py`**: Hardware & service health metrics.
