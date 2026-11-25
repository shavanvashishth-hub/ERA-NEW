/**
 * Node.js client & lifecycle supervisor for ERA's local Persistent Memory Service.
 *
 * Communicates strictly over loopback (127.0.0.1:8765) using the local per-user
 * bearer token. Never logs memory content or tokens, and degrades safely with
 * bounded timeouts so voice and chat loops are never blocked.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, ChildProcess } from "child_process";

const MEMORY_HOST = process.env.ERA_MEMORY_API_HOST || "127.0.0.1";
const MEMORY_PORT = Number(process.env.ERA_MEMORY_API_PORT || "8765");
const MEMORY_PREFIX = (process.env.ERA_MEMORY_API_PREFIX || "/memory").replace(/\/+$/, "");
const MEMORY_BASE_URL = `http://${MEMORY_HOST}:${MEMORY_PORT}${MEMORY_PREFIX}`;

let memoryChild: ChildProcess | null = null;
let startupPromise: Promise<boolean> | null = null;
let cachedToken: string | null = null;
let isShuttingDown = false;

export function getMemoryStorageDir(): string {
  const envDir = process.env.ERA_MEMORY_DIR;
  if (envDir && envDir.trim()) {
    return envDir.trim();
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "ERA", "memory");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "era", "memory");
}

function readLocalToken(forceRefresh = false): string {
  if (cachedToken && !forceRefresh) return cachedToken;
  const envTok = process.env.ERA_MEMORY_API_TOKEN;
  if (envTok && envTok.trim()) {
    cachedToken = envTok.trim();
    return cachedToken;
  }
  try {
    const tokenPath = path.join(getMemoryStorageDir(), "api_token");
    if (fs.existsSync(tokenPath)) {
      const tok = fs.readFileSync(tokenPath, "utf8").trim();
      if (tok) {
        cachedToken = tok;
        return tok;
      }
    }
  } catch {
    // Ignore read errors; caller handles missing token safely
  }
  return "";
}

function resolveServiceRoot(): { scriptPath: string; cwd: string } | null {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname),
    path.resolve(__dirname, ".."),
    (process as any).resourcesPath || "",
  ].filter(Boolean);

  for (const dir of candidates) {
    const script = path.join(dir, "era_memory_service.py");
    if (fs.existsSync(script)) {
      return { scriptPath: script, cwd: dir };
    }
  }
  return null;
}

function resolvePythonExe(serviceCwd: string): string {
  const resourcesPath = (process as any).resourcesPath || "";
  const candidates = [
    process.env.ERA_PYTHON_EXE || "",
    resourcesPath ? path.join(resourcesPath, "python_runtime", "python.exe") : "",
    path.join(serviceCwd, "python_runtime", "python.exe"),
    path.join(serviceCwd, "resources", "python_runtime", "python.exe"),
    path.join(process.cwd(), "resources", "python_runtime", "python.exe"),
    "D:\\era_agent\\.venv\\Scripts\\python.exe",
    "C:\\Users\\MSI\\AppData\\Local\\Programs\\ERA AI Assistant\\resources\\python_runtime\\python.exe",
  ].filter(Boolean);

  for (const exe of candidates) {
    try {
      if (fs.existsSync(exe)) return exe;
    } catch {
      // continue
    }
  }
  return "python";
}

async function isHealthy(timeoutMs = 350): Promise<boolean> {
  try {
    const res = await fetch(`${MEMORY_BASE_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureMemoryService(): Promise<boolean> {
  if (isShuttingDown) return false;
  if (await isHealthy(300)) {
    readLocalToken(true);
    return true;
  }
  if (startupPromise) {
    return startupPromise;
  }

  startupPromise = (async () => {
    try {
      if (await isHealthy(300)) {
        readLocalToken(true);
        return true;
      }

      const loc = resolveServiceRoot();
      if (!loc) {
        console.warn("[MemoryClient] era_memory_service.py not found; persistent memory disabled.");
        return false;
      }

      const pythonExe = resolvePythonExe(loc.cwd);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        ERA_MEMORY_API_HOST: MEMORY_HOST,
        ERA_MEMORY_API_PORT: String(MEMORY_PORT),
        ERA_MEMORY_API_PREFIX: MEMORY_PREFIX,
      };

      const child = spawn(pythonExe, [loc.scriptPath], {
        cwd: loc.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      memoryChild = child;

      child.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line && (line.includes("ERROR") || line.includes("Traceback"))) {
          console.warn("[MemoryService]", line.slice(0, 200));
        }
      });

      child.on("exit", () => {
        if (memoryChild === child) {
          memoryChild = null;
        }
      });

      const deadline = Date.now() + 4500;
      while (Date.now() < deadline) {
        if (await isHealthy(250)) {
          readLocalToken(true);
          console.log(`[MemoryClient] Connected to ERA Persistent Memory Engine on ${MEMORY_BASE_URL}`);
          return true;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      console.warn("[MemoryClient] Timed out waiting for ERA Memory Service startup.");
      return false;
    } catch (err: any) {
      console.warn(`[MemoryClient] Startup failed (${err?.name || "Error"})`);
      return false;
    } finally {
      startupPromise = null;
    }
  })();

  return startupPromise;
}

async function memRequest<T = any>(
  method: string,
  route: string,
  body?: Record<string, any>,
  timeoutMs = 1500
): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    let token = readLocalToken();
    if (!token) {
      await ensureMemoryService();
      token = readLocalToken(true);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    let res = await fetch(`${MEMORY_BASE_URL}${route}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 401) {
      token = readLocalToken(true);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
        res = await fetch(`${MEMORY_BASE_URL}${route}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      }
    }

    const data = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    // If service wasn't started yet or crashed, try starting once in background for next turn
    if (!isShuttingDown && err?.name !== "TimeoutError" && err?.name !== "AbortError") {
      void ensureMemoryService();
    }
    return { ok: false, status: 0, data: null };
  }
}

export async function getContextForPrompt(
  userText: string,
  sessionId = "default",
  projectId?: string,
  timeoutMs = 250,
  includeHistory?: boolean
): Promise<string> {
  if (!userText || !userText.trim()) return "";
  const r = await memRequest<{ rendered_text?: string }>(
    "POST",
    "/context-for",
    {
      query: userText,
      session_id: sessionId,
      project_id: projectId,
      include_history: includeHistory,
      timeout_ms: Math.max(80, timeoutMs - 25),
    },
    timeoutMs
  );
  return r.ok && r.data?.rendered_text ? r.data.rendered_text : "";
}

export async function getStartupBrief(sessionId?: string, timeoutMs = 350): Promise<string> {
  const r = await memRequest<{ rendered_text?: string }>(
    "POST",
    "/startup-brief",
    { session_id: sessionId, budget_tokens: 900 },
    timeoutMs
  );
  return r.ok && r.data?.rendered_text ? r.data.rendered_text : "";
}

export async function rememberTurn(
  userText: string,
  assistantText = "",
  sessionId = "default",
  channel: "chat" | "voice" = "chat",
  idempotencyKey?: string,
  projectId?: string
): Promise<boolean> {
  if (!userText?.trim() && !assistantText?.trim()) return false;
  const r = await memRequest<{ stored?: boolean }>(
    "POST",
    "/turn",
    {
      user_text: userText || "",
      assistant_text: assistantText || "",
      session_id: sessionId,
      channel,
      idempotency_key: idempotencyKey,
      project_id: projectId,
    },
    2000
  );
  return Boolean(r.ok && r.data?.stored);
}

export async function recallMemory(
  query: string,
  sessionId = "default",
  includeHistory = false
): Promise<{ rendered_text: string; items: any[] }> {
  const r = await memRequest<{ rendered_text?: string; items?: any[] }>(
    "POST",
    "/retrieve",
    {
      query,
      session_id: sessionId,
      include_history: includeHistory,
    },
    1200
  );
  return {
    rendered_text: r.ok && r.data?.rendered_text ? r.data.rendered_text : "",
    items: r.ok && Array.isArray(r.data?.items) ? r.data!.items : [],
  };
}

export async function rememberFact(
  text: string,
  sessionId = "default",
  channel = "voice"
): Promise<{ stored: boolean; episodic_id?: string }> {
  const r = await memRequest<{ stored?: boolean; episodic_id?: string }>(
    "POST",
    "/ingest",
    { text, role: "user", session_id: sessionId, channel },
    1500
  );
  return {
    stored: Boolean(r.ok && r.data?.stored),
    episodic_id: r.data?.episodic_id,
  };
}

export async function recordProcedure(
  task: string,
  steps: string[],
  outcome: "success" | "failure" | "partial" = "success",
  error?: string,
  recovery?: string,
  projectId?: string
): Promise<boolean> {
  const r = await memRequest<{ recorded?: boolean }>(
    "POST",
    "/procedure",
    { task, steps, outcome, error, recovery, project_id: projectId },
    1500
  );
  return Boolean(r.ok && r.data?.recorded);
}

export async function getHealth(): Promise<any> {
  const r = await memRequest("GET", "/health", undefined, 1500);
  return r.ok && r.data ? r.data : { status: "unavailable" };
}

export async function getStats(): Promise<any> {
  const r = await memRequest("GET", "/stats", undefined, 1500);
  return r.ok ? r.data : null;
}

export async function getProfile(): Promise<any> {
  const r = await memRequest("GET", "/profile", undefined, 1500);
  return r.ok ? r.data : null;
}

export async function getTasks(state?: string): Promise<any> {
  const q = state ? `?state=${encodeURIComponent(state)}` : "";
  const r = await memRequest("GET", `/tasks${q}`, undefined, 1500);
  return r.ok ? r.data : { tasks: [], procedures: [] };
}

export async function getTimeline(limit = 60, sessionId?: string): Promise<any> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (sessionId) params.set("session_id", sessionId);
  const r = await memRequest("GET", `/timeline?${params.toString()}`, undefined, 1500);
  return r.ok ? r.data : { timeline: [] };
}

export async function searchMemory(query: string, limit = 12, includeHistory = true): Promise<any> {
  const r = await memRequest(
    "POST",
    "/search",
    { query, limit, include_history: includeHistory },
    1500
  );
  return r.ok && r.data ? r.data : { results: [] };
}

export async function backupMemory(label = "manual"): Promise<any> {
  const r = await memRequest("POST", "/backup", { label }, 5000);
  return r.ok ? r.data : null;
}

export async function listBackups(): Promise<any> {
  const r = await memRequest("GET", "/backups", undefined, 1500);
  return r.ok && r.data ? r.data : { backups: [] };
}

export async function restoreMemory(backupId: string): Promise<any> {
  const r = await memRequest("POST", "/restore", { backup_id: backupId, confirm: true }, 8000);
  return r.ok ? r.data : null;
}

export async function consolidateMemories(): Promise<any> {
  const r = await memRequest("POST", "/consolidate", {}, 5000);
  return r.ok ? r.data : null;
}

export async function deleteMemory(memoryId: string, purge = false): Promise<any> {
  const q = purge ? "?purge=true" : "";
  const r = await memRequest("DELETE", `/memories/${encodeURIComponent(memoryId)}${q}`, undefined, 2000);
  return r.ok ? r.data : null;
}

export function shutdownMemoryService(): void {
  isShuttingDown = true;
  if (memoryChild) {
    try {
      memoryChild.kill("SIGTERM");
    } catch {
      // ignore
    }
    memoryChild = null;
  }
}
