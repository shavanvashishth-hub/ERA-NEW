# ERA AI — Build and Packaging Guide

This guide details the steps to compile, bundle, and package ERA AI as a production Windows desktop application.

---

## 1. Production Bundle Pipeline

The application build pipeline operates in two distinct compilation stages:

```
                  ┌──────────────────────┐
                  │   src/ (React 19)    │
                  └──────────┬───────────┘
                             │ vite build
                             ▼
                  ┌──────────────────────┐
                  │     dist/assets/     │
                  │   dist/index.html    │
                  └──────────────────────┘

                  ┌──────────────────────┐
                  │      server.ts       │
                  └──────────┬───────────┘
                             │ esbuild --bundle --platform=node
                             ▼
                  ┌──────────────────────┐
                  │   dist/server.cjs    │
                  └──────────────────────┘
```

### 1.1 Running the Build
Execute the standardized build script:
```powershell
cd d:\era-voice-assistant
npm run build
```

This performs:
1. `vite build`: Compiles `index.html`, resolves `src/main.tsx`, transpiles Tailwind and Motion CSS, and outputs minified static chunks to `dist/assets/`.
2. `esbuild server.ts`: Bundles the Express and WebSocket backend into a standalone CommonJS binary at `dist/server.cjs`.

### 1.2 Verification
Ensure both files exist and are populated:
- `d:\era-voice-assistant\dist\index.html` (~770 bytes)
- `d:\era-voice-assistant\dist\server.cjs` (~5.5 MB)

---

## 2. Desktop Packaging with Electron Builder

ERA AI is distributed as an installer or unpacked directory using `electron-builder`.

### 2.1 Packaging Scripts
```powershell
# Create an unpacked application directory (fast verification)
npm run pack

# Create a full NSIS installer executable
npm run dist
```

### 2.2 Embedded Python Runtime Architecture
The packaged Electron installer embeds a portable Python environment and service snapshots so that end-users do not need Python or Node.js pre-installed on their machines.

- **Embedded Runtime:** Packaged from `d:\era-voice-assistant\resources\python_runtime`
- **Embedded Services:** Packaged from `d:\era-voice-assistant\resources\era_services`
  - `resources/era_services/era_agent`
  - `resources/era_services/era_bridge`
  - `resources/era_services/era_vision`

When launched on an end-user machine, `electron/main.cjs` automatically checks:
```javascript
const RESOURCES_DIR = getResourcesDir();
const ERA_SERVICES_DIR = path.join(RESOURCES_DIR, 'era_services');
const PYTHON_RUNTIME_DIR = path.join(RESOURCES_DIR, 'python_runtime');
```
If packaged resources are detected, the embedded runtime is used; in development, it seamlessly falls back to `d:\era_agent\.venv\Scripts\python.exe`.

---

## 3. Pre-Deployment Quality Checklist

Before building any public or production distribution:
- [x] Run `npm run lint` (`tsc --noEmit`) $\to$ Must return 0 errors.
- [x] Run `npm run build` $\to$ Must output `dist/index.html` and `dist/server.cjs`.
- [x] Run `pytest d:\era_agent\tests` $\to$ 83/83 passing.
- [x] Run `pytest d:\era_bridge\era_bridge\tests` $\to$ 188/188 passing.
- [x] Run `pytest d:\era_vision\era_vision_agent_phase2\era_vision_agent\tests` $\to$ 46/46 passing.
- [x] Verify `.dashboard_backup` is absent so the legacy dashboard cannot be bundled.
