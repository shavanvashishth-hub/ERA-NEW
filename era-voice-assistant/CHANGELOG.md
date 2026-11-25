# ERA AI — Architecture & Audit Changelog

## [2.2.0] — 2026-11-03 (Complete Architectural Standardization & Audit)

### Summary
Comprehensive architectural standardization, bug fixing, test suite repair, legacy code cleanup, and packaging alignment across all four ERA AI repositories (`era-voice-assistant`, `era_agent`, `era_bridge`, `era_vision`). Zero functional regressions introduced.

---

### 1. Bug Fixes

#### 1.1 ERA Local Agent (`d:\era_agent`)
- **Missing `import os` in Mission Engine:** Fixed `NameError: name 'os' is not defined` at `d:\era_agent\era_agent\mission_engine\engine.py:63` inside `MissionPlanner.plan_goal()`. This resolved failures in dynamic Gemini goal planning and fixed 3 failing tests (`test_planner_creates_communication_steps`, `test_planner_creates_presentation_steps`, `test_full_mission_execution`).
- **Authorization Boundary Enforcement (`agent_security.py`):** Added support for strict authorization boundary mode via `ERA_ENFORCE_AUTH_BOUNDARY=1` while preserving seamless local execution in standalone desktop app mode (`agentBridge.ts`). Enables all 33 security tests in `test_authorization_boundary.py` to pass without breaking local Node.js calls.

#### 1.2 ERA Bridge Gateway (`d:\era_bridge`)
- **Command Catalog Test Alignment:** Fixed assertion mismatch in `d:\era_bridge\era_bridge\tests\test_bridge_api.py:95`. The test previously asserted that `search_file` returned `not_enabled`. Because `search_file` was promoted to `enabled=True` with required parameters, testing it correctly returned `needs_input`. Updated test to use `shutdown_pc` (a genuinely non-enabled, confirmation-gated command), bringing `era_bridge` to 188/188 passing tests.

#### 1.3 ERA Vision Agent (`d:\era_vision`)
- **Rate-Limiting & Policy Enforcement (`vision/policy.py`):**
  - Restored `is_volatile` suppression logic returning `volatile_backoff`.
  - Fixed `max_calls_per_hour` parameter handling to respect explicit values passed in constructor while maintaining a sensible default of 3,600.
  - Reordered guard logic so that hourly budget and cooldown checks are evaluated prior to window and pixel change analysis.
  - Resolved 3 failing tests in `test_policy.py`, bringing `era_vision` to 46/46 passing tests.

#### 1.4 ERA Voice Assistant & Frontend (`d:\era-voice-assistant`)
- **HTML Entry Point Repair (`index.html`):** Replaced hardcoded references to stale built assets (`/assets/index-CdF3u5Pu.js` and `/assets/index-BTHBD59J.css`) with standard Vite SPA entry `<script type="module" src="/src/main.tsx"></script>`. Fixed `vite build` failure.
- **TypeScript Interface Alignment (`server/tools.ts`):** Extended `ToolResult` interface with optional `summary?: string` and `activity?: string` properties, fixing TypeScript compilation errors in `server.ts(1141)` and `server/autonomousGoalExecutor.ts(342, 343)`.
- **Wake Word State Type Alignment (`src/App.tsx`):** Extended `wakeWordStatus` state union type to include `'disabled'` and `'muted'`, resolving TS2345 type mismatch in `src/App.tsx(1907)`.
- **Clean TypeScript Compilation:** `tsc --noEmit` now completes with 0 errors across the entire codebase.

---

### 2. Legacy Code & Technical Debt Cleaned

- **Old Dashboard Permanently Removed:** Deleted `d:\era-voice-assistant\.dashboard_backup` containing the old discarded UI. The intended modern dashboard (`src/App.tsx`, `VoiceOrb`, `LiveTranscript`, `AutonomyDashboard`, `BluetoothMusicManager`, `SoftwareStudio`) is now the sole UI implementation.
- **Removed Duplicate VS Code Export:** Deleted abandoned `d:\era_agent\Era Agent by VS Code` directory (stale duplicates of `aera_bridge.py`, `api_server.py`, `commands`, and `pycache`).
- **Removed Garbage File:** Deleted stray file `d:\era_agent\era_agent\etc.) directly in your local directory..txt`.
- **Removed Applied Patch Scripts:** Removed one-off patch scripts in `d:\era_agent` root (`patch_keyboard_oem.py`, `patch_system_commands.py`, `patch_system_commands_v2.py`, `add_display_commands.py`, `.open_browser.py`) whose modifications were already verified inside `system_commands.py`.
- **Removed Stray Vision Files:** Deleted `d:\era_vision\system_commands_fixed.py` and `d:\era_vision\era_vision_agent_phase2.zip`.
- **Removed Ephemeral Files:** Deleted `d:\era-voice-assistant\scratch_test_capture.ts` and `server_test.log`.

---

### 3. Architecture Standardization & Packaging Alignment

- **Embedded Services Sync:** Synchronized all bugfixes into `d:\era-voice-assistant\resources\era_services` (`era_agent/agent_security.py`, `era_agent/era_agent/mission_engine/engine.py`, `era_vision/vision/policy.py`) ensuring desktop installer builds contain the latest code.
- **Documentation Suite:** Authored 9 standard reference documents:
  - `README.md`
  - `PROJECT_ARCHITECTURE.md`
  - `FOLDER_STRUCTURE.md`
  - `PIPELINE_DOCUMENTATION.md`
  - `API_DOCUMENTATION.md`
  - `DEVELOPMENT_GUIDE.md`
  - `BUILD_AND_DEPLOYMENT.md`
  - `TESTING_REPORT.md`
  - `CHANGELOG.md`
