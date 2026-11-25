# ERA AI — API & Interface Specification

This document provides complete documentation for the REST APIs, WebSockets, and inter-service contracts of the ERA AI ecosystem.

---

## 1. ERA Local Agent & Intelligence Core (Port 8000)

**Base URL:** `http://127.0.0.1:8000`  
**Authentication Header:** `X-Era-Agent-Key` (Optional in local desktop mode, required in managed mode)

### 1.1 `GET /status`
Returns general service health, version, and running mode.
- **Status:** `200 OK`
- **Response:**
  ```json
  {
    "status": "ready",
    "agent": "Era Local Agent",
    "version": "1.0.0",
    "commands_count": 52
  }
  ```

### 1.2 `GET /commands`
Returns all registered system automation commands with their descriptions and parameter schemas.
- **Status:** `200 OK`
- **Response:**
  ```json
  {
    "commands": [
      {
        "name": "set_display_brightness",
        "description": "Sets display brightness percentage (0-100)",
        "params": [
          {"name": "level", "type": "int", "description": "Brightness percentage (0-100)", "required": true}
        ]
      }
    ]
  }
  ```

### 1.3 `POST /execute`
Executes an automation command on the host operating system.
- **Request Headers:**
  - `Content-Type: application/json`
  - `X-Era-Agent-Key: era_internal_local_agent_key`
- **Request Body:**
  ```json
  {
    "command": "set_display_brightness",
    "params": {
      "level": 60
    }
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "message": "Display brightness set to 60%.",
    "output": "60"
  }
  ```

### 1.4 `GET /intelligence/status`
Returns live system perception and hardware metrics.
- **Status:** `200 OK`
- **Response:**
  ```json
  {
    "status": "active",
    "cpu": {"percent": 14.2, "cores": 8},
    "memory": {"percent": 48.6, "total_gb": 32.0, "available_gb": 16.4},
    "battery": {"percent": 95, "power_plugged": true},
    "gpu": {"name": "NVIDIA GeForce RTX 4070 Laptop GPU", "memory_total_mb": 8192}
  }
  ```

### 1.5 `POST /api/missions`
Creates and initializes an autonomous goal mission.
- **Request Body:**
  ```json
  {
    "goal": "Build an animated clock website in workspace",
    "context": {}
  }
  ```
- **Response:**
  ```json
  {
    "mission_id": "m_a1b2c3d4",
    "state": "EXECUTING",
    "goal": "Build an animated clock website in workspace",
    "steps_count": 4
  }
  ```

---

## 2. ERA Bridge Gateway (Port 8100)

**Base URL:** `http://127.0.0.1:8100`  
**Authentication Header:** `X-Era-Bridge-Key`

### 2.1 `GET /health`
Public liveness check for the gateway service.
- **Status:** `200 OK`
- **Response:**
  ```json
  {"status": "ok", "service": "era_bridge"}
  ```

### 2.2 `GET /v1/status`
Authenticated gateway status, database connection, and agent reachability probe.
- **Status:** `200 OK`
- **Response:**
  ```json
  {
    "status": "ready",
    "bridge_version": "1.0.0",
    "agent_connected": true,
    "memory_entries_count": 142
  }
  ```

### 2.3 `POST /v1/execute`
Session-managed command execution gateway. Supports multi-turn parameter collection and confirmation for sensitive actions.
- **Request Body:**
  ```json
  {
    "command": "open_notepad",
    "params": {}
  }
  ```
- **Response:**
  ```json
  {
    "state": "success",
    "session_id": "s_12345",
    "message": "Notepad opened successfully.",
    "command": "open_notepad"
  }
  ```
- **Response States:**
  - `success`: Command executed and completed.
  - `needs_input`: Command requires additional parameters. Missing parameter prompt included.
  - `needs_confirmation`: High-impact action (e.g., `shutdown_pc`) awaiting explicit user confirmation.
  - `not_enabled`: Command exists in catalog but is currently deactivated.
  - `error`: Execution failure with diagnostic message.

### 2.4 `POST /v1/memory/search`
Performs hybrid semantic (vector cosine distance) and keyword (SQLite FTS5) recall.
- **Request Body:**
  ```json
  {
    "query": "Where did the user want project files saved?",
    "limit": 5
  }
  ```
- **Response:**
  ```json
  {
    "results": [
      {
        "id": "mem_8f9a2",
        "category": "PREFERENCE",
        "content": "User prefers saving project files under D:\\era_projects.",
        "score": 0.94,
        "created_at": 1730612400
      }
    ]
  }
  ```

---

## 3. ERA Vision Agent (Port 8200)

**Base URL:** `http://127.0.0.1:8200`  
**Authentication Header:** `X-Era-Vision-Key`

### 3.1 `GET /v1/health`
Public health probe for vision perception daemon.
- **Status:** `200 OK`
- **Response:**
  ```json
  {"status": "ok", "service": "era_vision_agent"}
  ```

### 3.2 `GET /v1/status`
Returns active window tracking status, DPI awareness, and frame rate budget statistics.
- **Status:** `200 OK`
- **Response:**
  ```json
  {
    "vision_enabled": true,
    "active_window": "Visual Studio Code - era-voice-assistant",
    "calls_this_hour": 4,
    "max_calls_per_hour": 3600,
    "dpi_aware": true
  }
  ```

### 3.3 `GET /v1/context`
Returns the recent rolling visual observation context for active applications.
- **Status:** `200 OK`
- **Response:**
  ```json
  {
    "observations": [
      {
        "timestamp": 1730612450.2,
        "active_app": "Code.exe",
        "title": "server.ts - era-voice-assistant",
        "visual_summary": "User is editing TypeScript server file around line 1140.",
        "bounding_box": [120, 80, 1160, 640]
      }
    ]
  }
  ```

---

## 4. ERA Voice Assistant & UI Server (Port 3000)

**Base URL:** `http://127.0.0.1:3000`  
**WebSocket Endpoint:** `ws://127.0.0.1:3000/live`

### 4.1 `GET /api/health`
Liveness check for the Express backend.
- **Status:** `200 OK`
- **Response:**
  ```json
  {"status": "ok", "service": "era_voice_ui"}
  ```

### 4.2 `POST /api/screen/upload`
High-speed frame ingestion endpoint for the GDI screen streamer.
- **Request Body:**
  ```json
  {
    "image": "base64EncodedJpegData...",
    "mimeType": "image/jpeg"
  }
  ```
- **Response:**
  ```json
  {"success": true, "timestamp": 1730612455}
  ```

### 4.3 `WebSocket /live`
Bidirectional streaming bridge to Gemini Multimodal Live API.
- **Client to Server Messages:**
  - `realtime_input`: Audio chunks (PCM 16-bit 16kHz) and video frames.
  - `client_content`: Context turn markers and user text prompts.
- **Server to Client Messages:**
  - `audio`: Synthesized PCM 24kHz audio chunks.
  - `transcript`: Real-time spoken language transcription (Hindi, English, etc.).
  - `tool_call`: Live tool execution status notifications.
