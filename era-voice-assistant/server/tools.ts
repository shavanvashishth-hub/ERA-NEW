import fs from "fs";
import path from "path";
import { exec, execFile } from "child_process";
import { GoogleGenAI } from "@google/genai";
import { loadKeys } from "./keys";
import { executeAgentCommand } from "./agentBridge";

const WORKSPACE_DIR = process.env.ERA_WORKSPACE_DIR || path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || process.cwd(), "ERA", "workspace");
const CONFIG_DIR = process.env.ERA_CONFIG_DIR || path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || process.cwd(), "ERA", "config");

// Ensure workspace and config directories exist
for (const dir of [WORKSPACE_DIR, CONFIG_DIR]) {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}

export interface ToolResult {
  success: boolean;
  message: string;
  output?: string;
  data?: any;
  summary?: string;
  activity?: string;
}

// 1. Write Code to Workspace
export function writeCode(language: string, filename: string, code: string): ToolResult {
  try {
    // Sanitize filename to prevent directory traversal
    const safeFilename = path.basename(filename);
    const filePath = path.join(WORKSPACE_DIR, safeFilename);
    
    fs.writeFileSync(filePath, code, "utf8");
    return {
      success: true,
      message: `Successfully wrote ${language} code to ${safeFilename}`,
      data: { filename: safeFilename, path: filePath, codeLength: code.length }
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to write code file: ${err.message}`
    };
  }
}

// 2. Run Code from Workspace or Full Path (Multi-Language Universal Runner)
export async function runCode(filename: string): Promise<ToolResult> {
  try {
    const { runAnyCode } = await import("./codeAssistant");
    const res = await runAnyCode({ filepath: filename, filename });
    return {
      success: res.success,
      message: res.message,
      output: res.output,
      data: {
        filepath: res.filepath,
        language: res.language,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        stdout: res.stdout,
        stderr: res.stderr,
        previewUrl: res.previewUrl,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to execute code: ${err.message}`,
    };
  }
}

// 3. Screen Capture + Continuous Real-Time Gemini Vision Analysis
const DEFAULT_VISION_AGENT_URL = process.env.VISION_AGENT_URL || "http://127.0.0.1:8200";
const DEFAULT_BRIDGE_URL = process.env.ERA_BRIDGE_URL || "http://127.0.0.1:8100";
const VISION_API_KEY = process.env.VISION_AGENT_API_KEY || "era_vision_secret_key_2026";
const BRIDGE_API_KEY = process.env.ERA_BRIDGE_API_KEY || "era_bridge_secret_key_2026";

async function fetchLiveVisionState(maxAgeSeconds: number = 3): Promise<any> {
  // 1. Try ERA Vision Agent directly (Port 8200 - Fastest, ~2ms)
  try {
    const res = await fetch(`${DEFAULT_VISION_AGENT_URL}/v1/vision/current-state`, {
      headers: { "X-Vision-Agent-Key": VISION_API_KEY },
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.current_state) {
        const entry = data.current_state;
        const analyzedAt = entry.analyzed_at || entry.timestamp || 0;
        const ageSeconds = analyzedAt ? (Date.now() / 1000 - analyzedAt) : 999;
        if (ageSeconds <= maxAgeSeconds) {
          return entry;
        }
        return null;
      }
    }
  } catch (e) {}

  // 2. Try ERA Bridge passthrough
  try {
    const res = await fetch(`${DEFAULT_BRIDGE_URL}/v1/vision/screen`, {
      headers: {
        "X-Era-Bridge-Key": BRIDGE_API_KEY,
        "Authorization": `Bearer ${BRIDGE_API_KEY}`,
      },
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.current_state) {
        const entry = data.current_state;
        const analyzedAt = entry.analyzed_at || entry.timestamp || 0;
        const ageSeconds = analyzedAt ? (Date.now() / 1000 - analyzedAt) : 999;
        if (ageSeconds <= maxAgeSeconds) {
          return entry;
        }
        return null;
      }
    }
  } catch (e) {}

  return null;
}

async function fetchLatestChartAnalysis(): Promise<any> {
  try {
    const res = await fetch(`${DEFAULT_BRIDGE_URL}/v1/vision/chart/latest`, {
      headers: {
        "X-Era-Bridge-Key": BRIDGE_API_KEY,
        "Authorization": `Bearer ${BRIDGE_API_KEY}`,
      },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.chart || null;
    }
  } catch (e) {}
  return null;
}

// In-memory browser frame cache (set by server.ts when streamer or browser uploads a frame)
let _browserFrameBase64: string = "";
let _browserFrameTimestamp: number = 0;
let _browserFrameWindow: { title: string; process: string } | null = null;
let _lastVisionAnalysisText: string = "";
let _lastVisionAnalysisTime: number = 0;
let _lastVisionWindowKey: string = "";
let _isBackgroundAnalyzing: boolean = false;

export function triggerBackgroundVisionAnalysis(base64DataUrl: string, windowInfo?: { title: string; process: string } | null) {
  if (_isBackgroundAnalyzing) return;
  const activeApp = (windowInfo?.process ? windowInfo.process.replace(".exe", "") : "") || "Desktop";
  const activeTitle = windowInfo?.title || "Main Display";
  const windowKey = `${activeApp}::${activeTitle}`;

  // If we analyzed this exact window in the last 6 seconds, don't re-run
  if (_lastVisionAnalysisText && windowKey === _lastVisionWindowKey && (Date.now() - _lastVisionAnalysisTime < 6000)) {
    return;
  }

  _isBackgroundAnalyzing = true;
  (async () => {
    try {
      const keys = loadKeys();
      const apiKey = keys.geminiApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey.startsWith("••••") || apiKey.length < 10) return;

      const base64Data = base64DataUrl.replace(/^data:image\/\w+;base64,/, "");
      const genAI = new GoogleGenAI({ apiKey });
      const response = await genAI.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Data,
                }
              },
              {
                text: `You are ERA's real-time desktop vision analyst. Briefly describe the active window '${activeTitle}' (${activeApp}): 1. What application or website is open. 2. What main content, documents, tabs, or code are visible. 3. Any active state or errors. Keep it concise, 100% accurate, in 1-2 sentences.`
              }
            ]
          }
        ]
      });

      if (response?.text) {
        _lastVisionAnalysisText = `[REAL-TIME SCREEN - LIVE DESKTOP]
- Active Application: ${activeApp}
- Window Title: ${activeTitle}
- Visual Details: ${response.text.trim()}`;
        _lastVisionAnalysisTime = Date.now();
        _lastVisionWindowKey = windowKey;
      }
    } catch (err: any) {
      // Ignore background analysis errors (quota, network, etc.)
    } finally {
      _isBackgroundAnalyzing = false;
    }
  })();
}

export function setBrowserScreenFrame(base64DataUrl: string, windowInfo?: { title: string; process: string } | null) {
  _browserFrameBase64 = base64DataUrl;
  _browserFrameTimestamp = Date.now();
  if (windowInfo) {
    _browserFrameWindow = windowInfo;
  }
  // Periodically refresh background vision
  triggerBackgroundVisionAnalysis(base64DataUrl, windowInfo);
}

export function getBrowserScreenFrame(): { data: string; ageMs: number; window?: { title: string; process: string } | null } | null {
  if (!_browserFrameBase64) return null;
  return { 
    data: _browserFrameBase64, 
    ageMs: Date.now() - _browserFrameTimestamp,
    window: _browserFrameWindow
  };
}

function getPythonExe(): string {
  const candidates = [
    "C:\\Users\\MSI\\AppData\\Local\\Programs\\ERA AI Assistant\\resources\\python_runtime\\python.exe",
    "d:\\era_agent\\.venv\\Scripts\\python.exe",
    path.join((process as any).resourcesPath || "", "python_runtime", "python.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "python";
}

function getStreamerScript(): string {
  const candidates = [
    path.join(process.cwd(), "server", "desktop_screen_streamer.py"),
    "d:\\era-voice-assistant\\server\\desktop_screen_streamer.py",
    path.join((process as any).resourcesPath || "", "server", "desktop_screen_streamer.py"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "d:\\era-voice-assistant\\server\\desktop_screen_streamer.py";
}

async function triggerNativeDesktopScreenshot(): Promise<boolean> {
  const screenPath = path.join(WORKSPACE_DIR, "current_screen.png");

  // Priority 1: Direct fast desktop GDI capture (attaches to user's interactive 'default' desktop, ~150ms)
  const pythonPath = getPythonExe();
  const streamerScript = getStreamerScript();
  if (fs.existsSync(pythonPath) && fs.existsSync(streamerScript)) {
    try {
      await new Promise<void>((resolve) => {
        execFile(pythonPath, [streamerScript, "--capture-once"], { timeout: 3000 }, () => resolve());
      });
      if (fs.existsSync(screenPath) && fs.statSync(screenPath).size > 5000) {
        return true;
      }
    } catch {}
  }

  // Priority 2: Use in-memory browser frame (from App.tsx getDisplayMedia via /api/screen/upload)
  const browserFrame = getBrowserScreenFrame();
  if (browserFrame && browserFrame.ageMs < 8000) {
    try {
      const base64Data = browserFrame.data.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      if (buffer.length > 5000) {
        const tmpPath = screenPath + ".tmp";
        fs.writeFileSync(tmpPath, buffer);
        try { if (fs.existsSync(screenPath)) fs.unlinkSync(screenPath); } catch {}
        fs.renameSync(tmpPath, screenPath);
        return true;
      }
    } catch {}
  }

  // Priority 2: Poll the server's /api/screen/current for a fresh browser-uploaded frame
  try {
    const res = await fetch("http://127.0.0.1:3000/api/screen/current", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      const image = data.image || data.frameData;
      const frameAge = data.timestamp ? Date.now() - data.timestamp : 0;
      if (image && (!data.timestamp || frameAge < 10000)) {
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length > 5000) {
          const tmpPath = screenPath + ".tmp";
          fs.writeFileSync(tmpPath, buffer);
          try { if (fs.existsSync(screenPath)) fs.unlinkSync(screenPath); } catch {}
          fs.renameSync(tmpPath, screenPath);
          return true;
        }
      }
    }
  } catch {}

  // Priority 3: Use existing file if fresh (< 5s old and non-trivial size)
  try {
    if (fs.existsSync(screenPath)) {
      const stats = fs.statSync(screenPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < 5000 && stats.size > 5000) {
        return true;
      }
    }
  } catch {}

  // Priority 4: Ask server to do a native capture (screenshot-desktop runs in server process)
  try {
    const res = await fetch("http://127.0.0.1:3000/api/screen/capture-native", {
      method: "POST",
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      if (data.success && data.size > 5000) {
        return fs.existsSync(screenPath);
      }
    }
  } catch {}

  // Priority 5: PowerShell fallback (often fails in non-interactive, but worth trying)
  return new Promise((resolve) => {
    const escapedPath = screenPath.replace(/'/g, "''");
    const psCmd = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; try { $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${escapedPath}',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose() } catch {}`;
    exec(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 4000 }, (err) => {
      resolve(fs.existsSync(screenPath));
    });
  });
}

// 3. Screen Capture + Continuous Real-Time Gemini Vision Analysis
// Connects to ERA Vision Agent (http://127.0.0.1:8200) & ERA Bridge Gateway (http://127.0.0.1:8100)
// for 100% accurate, live physical desktop screen awareness and trading chart technical analysis.
export async function captureScreen(postCommandDelayMs: number = 0): Promise<ToolResult> {
  // If called after a command execution, wait for the action to complete before capturing
  if (postCommandDelayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, postCommandDelayMs));
  }

  const browserFrame = getBrowserScreenFrame();
  const liveWindow = (browserFrame && browserFrame.ageMs < 8000) ? browserFrame.window : null;
  const activeApp = (liveWindow?.process ? liveWindow.process.replace(".exe", "") : "") || "Desktop";
  const activeTitle = liveWindow?.title || "Main Display";
  const windowKey = `${activeApp}::${activeTitle}`;

  // Check physical files on disk
  const jpgPath = path.join(WORKSPACE_DIR, "current_screen.jpg");
  const pngPath = path.join(WORKSPACE_DIR, "current_screen.png");
  let screenPath: string = "";
  const jpgAge = fs.existsSync(jpgPath) ? Date.now() - fs.statSync(jpgPath).mtimeMs : Infinity;
  const pngAge = fs.existsSync(pngPath) ? Date.now() - fs.statSync(pngPath).mtimeMs : Infinity;
  if (jpgAge < pngAge && jpgAge < 10000) {
    screenPath = jpgPath;
  } else if (pngAge < 10000) {
    screenPath = pngPath;
  }

  const hasPhysicalScreen = Boolean(screenPath) || Boolean(browserFrame && browserFrame.ageMs < 10000);

  // 1. Check live vision engine on port 8200 (strictly fresh, maxAge 3 seconds)
  try {
    const liveState = await fetchLiveVisionState(3);
    if (liveState && (liveState.state?.summary || liveState.state?.application)) {
      const s = liveState.state || {};
      const w = liveState.window || {};
      const app = liveWindow?.process || s.application || w.process_name || activeApp;
      const title = liveWindow?.title || s.window_title || w.title || activeTitle;
      const elements = (s.visible_elements || []).slice(0, 10).map((e: any) => `${e.label} (${e.element_type})`).join(", ");
      const text = (s.important_text || []).slice(0, 10).join("; ");
      let analysis = `[REAL-TIME DESKTOP SCREEN - 100% ACCURATE]
- Active Application: ${app}
- Window Title: ${title}
- Screen Summary: ${s.summary || "Desktop is visible."}
${s.current_activity ? `- Current Activity: ${s.current_activity}\n` : ""}${elements ? `- Key Elements: ${elements}\n` : ""}${text ? `- Text on Screen: ${text}\n` : ""}`;
      if (s.errors?.length) {
        analysis += `- Errors/Alerts: ${s.errors.join(", ")}\n`;
      }
      _lastVisionAnalysisText = analysis;
      _lastVisionAnalysisTime = Date.now();
      _lastVisionWindowKey = `${app}::${title}`;
      return {
        success: true,
        message: "Screen analyzed instantaneously from live vision engine.",
        data: {
          hasScreen: true,
          timestamp: new Date().toISOString(),
          analysis,
          liveState,
        }
      };
    }
  } catch {}

  // 2. If fresh background analysis exists for this active window (< 10s old):
  if (_lastVisionAnalysisText && (Date.now() - _lastVisionAnalysisTime < 10000) && (_lastVisionWindowKey === windowKey || !liveWindow)) {
    return {
      success: true,
      message: "Screen analyzed instantaneously from vision cache.",
      data: {
        hasScreen: true,
        timestamp: new Date().toISOString(),
        analysis: _lastVisionAnalysisText,
        screenPath: screenPath || undefined,
      }
    };
  }

  // 3. Trigger background update if not running
  if (browserFrame?.data) {
    triggerBackgroundVisionAnalysis(browserFrame.data, liveWindow);
  }

  // Strict Anti-Hallucination Guard
  if (!hasPhysicalScreen && !liveWindow) {
    return {
      success: false,
      message: "Boss, main abhi aapki screen nahi dekh pa rahi hoon.",
      data: {
        hasScreen: false,
        timestamp: new Date().toISOString(),
        analysis: "NO REAL-TIME SCREEN CAPTURE AVAILABLE. Do NOT invent or hallucinate what is on the screen.",
      }
    };
  }

  // 4. Instant (<2ms) ground-truth analysis with live window info
  const instantAnalysis = `[REAL-TIME SCREEN - ACTIVE FOREGROUND WINDOW]
- Active Application: ${activeApp}
- Window Title: ${activeTitle}
- Screen Status: Live physical desktop stream active.
- Current Context: User is currently working in '${activeTitle}' (${activeApp}).`;

  _lastVisionAnalysisText = instantAnalysis;
  _lastVisionAnalysisTime = Date.now();
  _lastVisionWindowKey = windowKey;

  return {
    success: true,
    message: "Screen analyzed successfully in real-time.",
    data: {
      hasScreen: true,
      timestamp: new Date().toISOString(),
      analysis: instantAnalysis,
      screenPath: screenPath || undefined,
    }
  };
}

// Convenience wrapper: call this after executing a command to give time for UI to update
export async function captureScreenFresh(delayMs: number = 2000): Promise<ToolResult> {
  return captureScreen(delayMs);
}

// Read chats after getting verbal confirmation
export async function readScreenChats(contactName?: string, confirmed?: boolean): Promise<ToolResult> {
  if (confirmed !== true) {
    return {
      success: false,
      message: "CONFIRMATION REQUIRED: Ask the user for confirmation before reading private chats: 'Boss, kya main aapki screen pe khuli chats padh kar bataoon?'",
    };
  }

  const screenRes = await captureScreen();
  const liveChats = loadWhatsAppChats();

  let chatSummary = "Chat Reading (Confirmed by Boss):\n\n";
  if (screenRes.success && screenRes.data?.analysis) {
    chatSummary += `[ON-SCREEN VISIBLE CHATS & TEXT]\n${screenRes.data.analysis}\n\n`;
  }

  if (liveChats.length > 0) {
    const filtered = contactName
      ? liveChats.filter(c => c.contactName.toLowerCase().includes(contactName.toLowerCase()))
      : liveChats.slice(0, 10);
    chatSummary += `[RECORDED MESSAGES]\n` + filtered.map(c => `[${c.timestamp}] ${c.contactName}: ${c.message}`).join("\n");
  }

  return {
    success: true,
    message: "Successfully read chat contents after boss confirmation.",
    data: { analysis: chatSummary }
  };
}

// 3.5. Open File Tool (Finds and opens a file or project folder across all laptop hard drives)
export async function openFile(filename: string, openWith?: string): Promise<ToolResult> {
  try {
    if (!filename || !filename.trim()) {
      return { success: false, message: "No filename was provided." };
    }
    const rawClean = filename.trim().replace(/^[\"\']|[\"\']$/g, "");
    let query = rawClean.toLowerCase().trim();
    query = query.replace(/\b(dund kar open karo|dund kar kholo|dhoondh kar kholo|search karke open karo|open karo|kholo|chalu karo|dekho|search karo|find karo)\b/gi, " ");
    query = query.replace(/\b(dund kar|dhoondh kar|dhund kar|search karke|dhoondho|dundo|dhundo)\b/gi, " ");
    query = query.replace(/\b(file|document|doc|folder|karo|khol|karna|de|do|mera|meri|mujhe|wala|wali|wale)\b/gi, " ");
    query = query.replace(/[^\w\s.-]/g, " ").replace(/\s+/g, " ").trim();
    const cleanName = query || rawClean;
    const resolvedOpenWith = (openWith || "default").toLowerCase().trim();
    const userProfile = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\User";

    // 1. Direct path check
    const safeFilename = path.basename(cleanName);
    const workspacePath = path.join(WORKSPACE_DIR, safeFilename);

    let targetPath: string | null = null;
    if (fs.existsSync(cleanName)) {
      targetPath = cleanName;
    } else if (fs.existsSync(workspacePath)) {
      targetPath = workspacePath;
    }

    const safeStart = (targetToOpen: string) => {
      const sanitized = targetToOpen.replace(/'/g, "''");
      exec(`powershell -NoProfile -NonInteractive -Command "Start-Process '${sanitized}'"`);
    };

    const launchTarget = (target: string, program: string): void => {
      const p = target;
      if (program.includes("vscode") || program.includes("code") || program.includes("vs")) {
        const localApp = process.env.LOCALAPPDATA || path.join(userProfile, "AppData", "Local");
        const codeCandidates = [
          path.join(localApp, "Programs", "Microsoft VS Code", "Code.exe"),
          path.join(localApp, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
          "C:\\Program Files\\Microsoft VS Code\\Code.exe",
          "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe"
        ];
        const codeExe = codeCandidates.find(c => fs.existsSync(c));
        if (codeExe && codeExe.toLowerCase().endsWith(".exe")) {
          exec(`"${codeExe}" -r "${p}"`, (err) => {
            if (err) safeStart(p);
          });
        } else if (codeExe) {
          exec(`"${codeExe}" -r "${p}"`, (err) => {
            if (err) safeStart(p);
          });
        } else {
          exec(`code -r "${p}"`, (err) => {
            if (err) safeStart(p);
          });
        }
      } else if (program.includes("notepad") || program.includes("editor") || program.includes("txt")) {
        exec(`notepad.exe "${p}"`, (err) => {
          if (err) safeStart(p);
        });
      } else if (program.includes("chrome") || program.includes("browser") || program.includes("edge")) {
        exec(`start chrome "${p}"`, (err) => {
          if (err) safeStart(p);
        });
      } else if (program.includes("explorer") || program.includes("folder") || program.includes("select")) {
        exec(`explorer.exe /select,"${p}"`);
      } else if (program.includes("word") || program.includes("doc")) {
        exec(`start winword "${p}"`, (err) => {
          if (err) safeStart(p);
        });
      } else if (program.includes("excel") || program.includes("sheet")) {
        exec(`start excel "${p}"`, (err) => {
          if (err) safeStart(p);
        });
      } else if (program.includes("powerpoint") || program.includes("ppt")) {
        exec(`start powerpnt "${p}"`, (err) => {
          if (err) safeStart(p);
        });
      } else {
        safeStart(p);
      }
    };

    if (targetPath) {
      launchTarget(targetPath, resolvedOpenWith);
      return {
        success: true,
        message: `Successfully opened "${path.basename(targetPath)}" on your laptop${resolvedOpenWith !== "default" ? ` in ${resolvedOpenWith}` : ""}.`,
        data: { filename: path.basename(targetPath), path: targetPath, openWith: resolvedOpenWith }
      };
    }

    // 2. Try Python Local Agent first (fast multi-drive indexed/scored search)
    const agentSearchRes = await executeAgentCommand("open_file", { file_name: cleanName, open_with: resolvedOpenWith });
    if (agentSearchRes && agentSearchRes.success) {
      return {
        success: true,
        message: agentSearchRes.message || `Found and opened "${cleanName}" on your laptop.`,
        data: (agentSearchRes as any).data || { filename: path.basename(cleanName), path: cleanName, openWith: resolvedOpenWith },
      };
    }

    // 3. Fallback: Fast Node.js search across primary user folders (skipping AppData & system files)
    const searchRoots: string[] = [];
    const userFolders = ["Downloads", "Desktop", "Documents", "Pictures", "Videos", "Music"];
    for (const f of userFolders) {
      const p = path.join(userProfile, f);
      if (fs.existsSync(p)) searchRoots.push(p);
    }
    // Drives D:, C:, etc.
    for (let i = 68; i <= 90; i++) {
      const driveLetter = String.fromCharCode(i) + ":\\";
      if (fs.existsSync(driveLetter) && !searchRoots.includes(driveLetter)) {
        searchRoots.push(driveLetter);
      }
    }
    if (fs.existsSync("C:\\") && !searchRoots.includes("C:\\")) {
      searchRoots.push("C:\\");
    }

    const searchName = safeFilename.toLowerCase();
    const skipDirs = new Set([
      "$recycle.bin", "system volume information", "windows", "appdata", "recovery",
      "node_modules", ".git", ".venv", "temp", "cache", ".cache", "local settings",
      "application data", ".vscode", ".gemini"
    ]);
    const skipFiles = new Set(["desktop.ini", "thumbs.db", "ntuser.dat", "ntuser.ini"]);

    // First pass: direct top-level check
    for (const root of searchRoots) {
      try {
        const items = fs.readdirSync(root);
        const match = items.find(item => {
          const l = item.toLowerCase();
          return !skipFiles.has(l) && (l === searchName || path.parse(l).name.toLowerCase() === searchName || l.includes(searchName));
        });
        if (match) {
          targetPath = path.join(root, match);
          break;
        }
      } catch (e) {}
    }

    // Second pass: bounded BFS scan (depth <= 3)
    if (!targetPath) {
      for (const root of searchRoots) {
        try {
          const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
          while (queue.length > 0 && !targetPath) {
            const current = queue.shift()!;
            if (current.depth > 3) continue;

            let entries: fs.Dirent[] = [];
            try {
              entries = fs.readdirSync(current.dir, { withFileTypes: true });
            } catch (e) {
              continue;
            }

            for (const entry of entries) {
              const nameLow = entry.name.toLowerCase();
              if (skipFiles.has(nameLow)) continue;

              if (entry.isFile() && (nameLow === searchName || path.parse(nameLow).name.toLowerCase() === searchName || nameLow.includes(searchName))) {
                targetPath = path.join(current.dir, entry.name);
                break;
              } else if (entry.isDirectory() && !skipDirs.has(nameLow) && !nameLow.startsWith(".")) {
                queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
              }
            }
          }
        } catch (e) {}
        if (targetPath) break;
      }
    }

    if (targetPath) {
      launchTarget(targetPath, resolvedOpenWith);
      return {
        success: true,
        message: `Successfully opened "${path.basename(targetPath)}" on your laptop${resolvedOpenWith !== "default" ? ` in ${resolvedOpenWith}` : ""}.`,
        data: { filename: path.basename(targetPath), path: targetPath, openWith: resolvedOpenWith }
      };
    }

    return {
      success: false,
      message: agentSearchRes?.message || `File "${cleanName}" not found on your laptop drives. Please check the file name.`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to open laptop file: ${err.message}`
    };
  }
}

// 4. WhatsApp Web Integration
const WHATSAPP_CHATS_FILE = path.join(CONFIG_DIR, "whatsapp_chats.json");

export interface WhatsAppMessage {
  contactName: string;
  message: string;
  timestamp: string;
  status: "sent" | "failed";
}

const WHATSAPP_CONTACTS_FILE = path.join(CONFIG_DIR, "whatsapp_contacts.json");

export interface Contact {
  name: string;
  aliases: string[];
  phone: string;
  shortPhone?: string;
}

export function loadContacts(): Contact[] {
  if (fs.existsSync(WHATSAPP_CONTACTS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(WHATSAPP_CONTACTS_FILE, "utf8"));
    } catch (err) {
      console.error("Error reading contacts file:", err);
    }
  }
  // Default fallback contacts without hardcoded numbers
  return [
    { name: "Bhaiya", aliases: ["bhaiya", "bhaiyya", "bhayya", "brother", "bro", "veerji"], phone: "" },
    { name: "Sakshi", aliases: ["sakshi", "sakshii", "sister", "sis"], phone: "" },
    { name: "Mom", aliases: ["mom", "mother", "mummy", "maa", "mommy", "mamma"], phone: "" },
    { name: "Dad", aliases: ["dad", "father", "papa", "daddy", "pop"], phone: "" },
    { name: "Bestie", aliases: ["bestie", "best friend"], phone: "" }
  ];
}

export function saveContacts(contacts: Contact[]): void {
  fs.writeFileSync(WHATSAPP_CONTACTS_FILE, JSON.stringify(contacts, null, 2), "utf8");
}

export function resolveContact(query: string): { name: string; phone: string } {
  if (!query) return { name: "Unknown", phone: "" };

  const contacts = loadContacts();
  const rawQuery = query.trim();
  // Strip common Hindi postpositions and honorifics (e.g. "Sakshi ko" -> "Sakshi", "Bhaiya ji" -> "Bhaiya", "Mohit ko" -> "Mohit")
  const cleanQuery = rawQuery.replace(/\s*\b(?:ko|se|par|per|ji|bhaiya|mama|sir|uncle|didi)\b\s*$/i, "").trim().toLowerCase();

  // 1. If the query consists of phone digits, try to find a contact that matches this number.
  const queryDigits = rawQuery.replace(/[^0-9]/g, '');
  if (queryDigits && queryDigits.length >= 7) {
    for (const contact of contacts) {
      if (contact.phone) {
        const cleanContactPhone = contact.phone.replace(/[^0-9]/g, '');
        const cleanShortPhone = (contact.shortPhone || "").replace(/[^0-9]/g, '') || cleanContactPhone.slice(-10);
        if (
          queryDigits === cleanContactPhone || 
          queryDigits === cleanShortPhone || 
          cleanContactPhone.endsWith(queryDigits) || 
          queryDigits.endsWith(cleanShortPhone)
        ) {
          return { name: contact.name, phone: cleanContactPhone };
        }
      }
    }
    // If not in contacts book, but is 10+ digits, treat as a direct phone number!
    if (queryDigits.length >= 10) {
      return { name: rawQuery, phone: queryDigits };
    }
  }

  // 2. Exact match by contact name or alias (case-insensitive, trimmed)
  for (const contact of contacts) {
    const cName = (contact.name || "").trim().toLowerCase();
    const cAliases = (contact.aliases || []).map(a => (a || "").trim().toLowerCase());
    if (cName === cleanQuery || cAliases.includes(cleanQuery) || cName === rawQuery.toLowerCase() || cAliases.includes(rawQuery.toLowerCase())) {
      const cleanPhone = (contact.phone || "").replace(/[^0-9]/g, '');
      return { name: contact.name.trim(), phone: cleanPhone };
    }
  }

  // 3. Prefix or word boundary match (e.g. "rohit" matches "rohit bhaiya", "deepak" matches "deepu mama" alias "deepak")
  for (const contact of contacts) {
    const cName = (contact.name || "").trim().toLowerCase();
    const cAliases = (contact.aliases || []).map(a => (a || "").trim().toLowerCase());
    for (const candidate of [cName, ...cAliases]) {
      if (!candidate) continue;
      const words = candidate.split(/\s+/);
      if (words.includes(cleanQuery) || candidate.startsWith(cleanQuery + " ") || cleanQuery.startsWith(candidate + " ")) {
        const cleanPhone = (contact.phone || "").replace(/[^0-9]/g, '');
        return { name: contact.name.trim(), phone: cleanPhone };
      }
    }
  }

  // Return raw query with cleaned phone if found in local book
  return { name: rawQuery, phone: "" };
}

export function sanitizeWhatsAppMessage(rawMessage: string, contactName: string): { clean: string; valid: boolean; reason?: string } {
  let msg = (rawMessage || "").trim();
  msg = msg.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();

  if (!msg) {
    return { clean: "", valid: false, reason: "Message content is empty." };
  }

  // Reject internal commands
  const commandPatterns = [
    /^(open\s+whatsapp|search\s+for|open\s+chat|go\s+to\s+whatsapp|launch\s+whatsapp)/i,
    /^(whatsapp\s+kholo|chat\s+kholo|search\s+karo)/i,
    /^(click\s+on|press\s+enter|type\s+message)/i,
  ];
  for (const p of commandPatterns) {
    if (p.test(msg)) {
      return { clean: "", valid: false, reason: "Message looks like an internal command rather than chat content." };
    }
  }

  // Strip conversational prefixes (Hindi & English)
  const prefixes = [
    /^(haan|ha|ji|theek hai|sure|ok|okay|yes|bilkul|zaroor)\s*(boss|sir)?\s*[,:!.-]*\s*/i,
    /^(boss|sir)\s*[,:!.-]*\s*/i,
    /^(main\s+abhi|abhi\s+main|main)?\s*([a-zA-Z0-9_\s]+(?:ko|pe))?\s*(?:message|whatsapp|msg)?\s*(?:bhej\s+raha\s+hoon|bhej\s+rahi\s+hoon|bhej\s+raha\s+hu|bhej\s+rahi\s+hu|bhej\s+raha|bhej\s+rahi|bol\s+raha\s+hoon|bol\s+rahi\s+hoon|bol\s+raha\s+hu|bol\s+rahi\s+hu|bol\s+raha|bol\s+rahi|keh\s+raha\s+hoon|keh\s+rahi\s+hoon|karta\s+hoon|karti\s+hoon)\s*[,:!.-]*\s*(?:ki\s*)?/i,
    /^(maine\s+([a-zA-Z0-9_\s]+(?:ko|pe))?\s*(?:message|whatsapp)?\s*(?:bhej\s+diya|send\s+kar\s+diya|bol\s+diya))\s*[,:!.-]*\s*(?:ki\s*)?/i,
    /^(i\s+am\s+(?:sending|telling)\s+(?:a\s+)?message\s+(?:to\s+[^:]+)?\s*(?:saying|that)?)\s*[:,-]*\s*/i,
    /^(sending\s+message\s+to\s+[^:]+)\s*[:,-]*\s*/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (p.test(msg)) {
        msg = msg.replace(p, "").trim();
        changed = true;
      }
    }
  }

  // Strip trailing conversational chatter
  const suffixes = [
    /\s*[,.-]*\s*(maine\s+message\s+bhej\s+diya\s*(hai)?\s*(boss|sir)?)$/i,
    /\s*[,.-]*\s*(bhej\s+diya\s*(hai)?\s*(boss|sir)?)$/i,
    /\s*[,.-]*\s*(message\s+sent\s*(successfully)?\s*(boss|sir)?)$/i,
  ];
  for (const s of suffixes) {
    msg = msg.replace(s, "").trim();
  }

  msg = msg.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!msg) {
    return { clean: "", valid: false, reason: "Message became empty after removing assistant conversational filler." };
  }

  return { clean: msg, valid: true };
}

let lastSentWhatsappTimestamp = 0;
let lastSentWhatsappFingerprint = "";

export async function sendWhatsAppMessage(contactName: string, message: string): Promise<ToolResult> {
  try {
    const rawMsg = (message || "").trim();
    const cleanContact = (contactName || "").trim();

    if (!cleanContact || /^(open|whatsapp|search|kholo|click|type)$/i.test(cleanContact)) {
      return { success: false, message: `Invalid contact name '${cleanContact}'. Please specify the exact recipient name or number.` };
    }
    if (!rawMsg) {
      return { success: false, message: "Message content is required." };
    }

    // Automatically check and sanitize message purity
    const sanitizeRes = sanitizeWhatsAppMessage(rawMsg, cleanContact);
    if (!sanitizeRes.valid) {
      return {
        success: false,
        message: `WhatsApp message blocked: ${sanitizeRes.reason}. Please provide the exact message text.`
      };
    }
    const cleanMsg = sanitizeRes.clean;

    // Deduplication guard: ignore duplicate identical calls within 30 seconds.
    // 30s covers slow UI automation (WhatsApp opening, URL loading, etc.)
    // and prevents double-sends when ERA retries after a seemingly-failed send.
    const fingerprint = `${cleanContact.toLowerCase().trim()}:::${cleanMsg.toLowerCase().trim()}`;
    const now = Date.now();
    if (fingerprint === lastSentWhatsappFingerprint && (now - lastSentWhatsappTimestamp) < 30000) {
      return {
        success: true,
        message: `WhatsApp message already dispatched to "${cleanContact}".`,
        data: { contactName: cleanContact, contact: cleanContact, message: cleanMsg, deduplicated: true },
      };
    }
    lastSentWhatsappFingerprint = fingerprint;
    lastSentWhatsappTimestamp = now;

    const resolved = resolveContact(cleanContact);

    // SAFETY CHECK: If the contact is not found by name AND is not a phone number,
    // we still attempt via WhatsApp search — but the Python agent will verify before sending.
    // Log the resolution clearly for debugging.
    const isPhoneNumber = /^\+?[\d\s\-().]{7,}$/.test(cleanContact);
    const hasResolvedPhone = resolved.phone && resolved.phone.replace(/\D/g, "").length >= 7;
    
    if (!isPhoneNumber && !hasResolvedPhone) {
      console.warn(`[WhatsApp] Contact '${cleanContact}' not found in contacts book and no phone number provided. Will attempt WhatsApp name search with strict verification.`);
    }

    const target = resolved.phone || cleanContact;

    // Dispatch via Agent Command and wait for TRUE outcome
    const agentRes = await executeAgentCommand("send_whatsapp_message", {
      contact: target,
      phone: target,
      contactName: resolved.name || cleanContact,
      message: cleanMsg,
    });

    if (agentRes.success) {
      // Record in whatsapp_chats.json only on genuine success
      try {
        let chats: WhatsAppMessage[] = [];
        if (fs.existsSync(WHATSAPP_CHATS_FILE)) {
          chats = JSON.parse(fs.readFileSync(WHATSAPP_CHATS_FILE, "utf8"));
        }
        chats.unshift({
          contactName: resolved.name || cleanContact,
          message: cleanMsg,
          timestamp: new Date().toISOString(),
          status: "sent"
        });
        if (chats.length > 50) chats = chats.slice(0, 50);
        fs.writeFileSync(WHATSAPP_CHATS_FILE, JSON.stringify(chats, null, 2), "utf8");
      } catch {}
    }

    return {
      success: agentRes.success,
      message: agentRes.message || (agentRes.success ? `WhatsApp message sent to ${resolved.name || cleanContact}: "${cleanMsg}"` : `Failed to send WhatsApp message to ${cleanContact}`),
      data: { contactName: resolved.name || cleanContact, contact: resolved.name || cleanContact, phone: target, message: cleanMsg }
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to send WhatsApp message: ${err.message}`
    };
  }
}

export async function sendWhatsAppFile(
  contactName: string,
  filePathOrName: string,
  caption?: string,
  fileContent?: string
): Promise<ToolResult> {
  try {
    const cleanContact = (contactName || "").trim();
    const cleanFile = (filePathOrName || "").trim();
    const cleanCaption = (caption || "").trim();
    const cleanContent = (fileContent || "").trim();

    if (!cleanContact || /^(open|whatsapp|search|kholo|click|type)$/i.test(cleanContact)) {
      return { success: false, message: `Invalid contact or recipient '${cleanContact}'. Please specify the exact recipient name or number.` };
    }
    if (!cleanFile) {
      return { success: false, message: "File name or file path is required to send a file." };
    }

    const resolved = resolveContact(cleanContact);
    const target = resolved.phone || cleanContact;

    console.log(`[sendWhatsAppFile] Sending file '${cleanFile}' to '${target}' (caption: '${cleanCaption}')`);

    // Dispatch via Agent Command and wait for TRUE outcome
    const agentRes = await executeAgentCommand("send_whatsapp_file", {
      contact: target,
      phone: target,
      contactName: resolved.name || cleanContact,
      file_path: cleanFile,
      filePath: cleanFile,
      fileName: cleanFile,
      file_name: cleanFile,
      message: cleanCaption,
      caption: cleanCaption,
      file_content: cleanContent,
      fileContent: cleanContent,
    });

    if (agentRes.success) {
      try {
        let chats: WhatsAppMessage[] = [];
        if (fs.existsSync(WHATSAPP_CHATS_FILE)) {
          chats = JSON.parse(fs.readFileSync(WHATSAPP_CHATS_FILE, "utf8"));
        }
        chats.unshift({
          contactName: resolved.name || cleanContact,
          message: `[Attachment: ${path.basename(cleanFile)}] ${cleanCaption}`.trim(),
          timestamp: new Date().toISOString(),
          status: "sent"
        });
        if (chats.length > 50) chats = chats.slice(0, 50);
        fs.writeFileSync(WHATSAPP_CHATS_FILE, JSON.stringify(chats, null, 2), "utf8");
      } catch {}
    }

    return {
      success: agentRes.success,
      message: agentRes.message || (agentRes.success ? `WhatsApp file '${path.basename(cleanFile)}' sent to ${resolved.name || cleanContact}.` : `Failed to send WhatsApp file to ${cleanContact}`),
      data: agentRes.data || { contact: resolved.name || cleanContact, file: cleanFile, caption: cleanCaption }
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to send WhatsApp file: ${err.message}`
    };
  }
}

function normalizeMultiRecipientInput(
  contactsInput: any,
  fallbackMessage?: string
): Array<{ contact: string; message: string }> {
  const sanitize = (msg: string, contact: string): string => {
    const trimmed = String(msg || "").trim();
    if (!trimmed) return "";
    const res = sanitizeWhatsAppMessage(trimmed, contact);
    return res.valid ? res.clean : "";
  };

  const extractEntry = (item: any, fb?: string): { contact: string; message: string } | null => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const contact = String(
        item.contact || item.contactName || item.name || item.phone || item.recipient || item.to || ""
      ).trim();
      const rawMsg = String(item.message ?? item.text ?? item.msg ?? fb ?? "").trim();
      const message = sanitize(rawMsg, contact);
      if (contact && message) return { contact, message };
      return null;
    }
    const contact = String(item || "").trim();
    const message = sanitize(String(fb || "").trim(), contact);
    if (contact && message) return { contact, message };
    return null;
  };

  if (contactsInput && typeof contactsInput === "object" && !Array.isArray(contactsInput)) {
    const obj = contactsInput as any;
    const objMsg = String(obj.message ?? fallbackMessage ?? "").trim();
    const objMessages = Array.isArray(obj.messages) ? obj.messages : undefined;
    if (Array.isArray(obj.recipients) && obj.recipients.length > 0) {
      return obj.recipients
        .map((r: any, idx: number) => extractEntry(r, objMessages?.[idx] ?? objMsg))
        .filter(Boolean) as Array<{ contact: string; message: string }>;
    }
    if (Array.isArray(obj.contacts) && obj.contacts.length > 0) {
      return obj.contacts
        .map((c: any, idx: number) => extractEntry(c, objMessages?.[idx] ?? objMsg))
        .filter(Boolean) as Array<{ contact: string; message: string }>;
    }
  }

  const fbRaw = String(fallbackMessage || "").trim();
  if (Array.isArray(contactsInput)) {
    const hasObjectEntries = contactsInput.some((c) => c && typeof c === "object");
    if (hasObjectEntries) {
      return contactsInput
        .map((c) => extractEntry(c, fbRaw))
        .filter(Boolean) as Array<{ contact: string; message: string }>;
    }
    let contactList = contactsInput.map((c) => String(c).trim()).filter(Boolean);
    if (contactList.length === 0 || (contactList.length === 1 && !isNaN(Number(contactList[0])))) {
      const count = contactList.length === 1 && !isNaN(Number(contactList[0])) ? Math.max(1, parseInt(contactList[0], 10)) : 5;
      const allContacts = loadContacts();
      contactList = allContacts.slice(0, count).map((c) => c.name);
    }
    return contactList.map((c) => extractEntry(c, fbRaw)).filter(Boolean) as Array<{ contact: string; message: string }>;
  }

  if (typeof contactsInput === "string" && contactsInput.trim()) {
    let contactList = contactsInput.split(/\s+and\s+|[,;]|\s+aur\s+/i).map((c) => c.trim()).filter(Boolean);
    if (contactList.length === 1 && !isNaN(Number(contactList[0]))) {
      const count = Math.max(1, parseInt(contactList[0], 10));
      contactList = loadContacts().slice(0, count).map((c) => c.name);
    }
    return contactList.map((c) => extractEntry(c, fbRaw)).filter(Boolean) as Array<{ contact: string; message: string }>;
  }

  return [];
}

export async function sendWhatsAppToMultiple(contactsInput: any, message?: string): Promise<ToolResult> {
  try {
    const pairs = normalizeMultiRecipientInput(contactsInput, message);

    if (pairs.length === 0) {
      const hasAnyMsg = Boolean((message || "").trim()) ||
        (Array.isArray(contactsInput) && contactsInput.some((c) => c?.message || c?.text)) ||
        Boolean(contactsInput?.recipients?.some((r: any) => r?.message || r?.text));
      if (!hasAnyMsg) {
        return { success: false, message: "Message content is required." };
      }
      return { success: false, message: "No contacts or recipients found to send WhatsApp message to." };
    }

    // Resolve each contact individually (preserving their exact distinct message)
    const resolvedPairs = pairs.map((p) => {
      const res = resolveContact(p.contact);
      return {
        rawContact: p.contact,
        contact: res.phone || res.name || p.contact,
        displayName: res.name || p.contact,
        message: p.message,
      };
    });

    console.log(
      `[sendWhatsAppToMultiple] Executing sequential multi-dispatch to ${resolvedPairs.length} recipients:`,
      resolvedPairs.map((p) => ({ contact: p.displayName, target: p.contact, message: p.message }))
    );

    const agentRes = await executeAgentCommand("send_whatsapp_to_multiple", {
      recipients: resolvedPairs.map((p) => ({ contact: p.contact, message: p.message })),
      contacts: resolvedPairs.map((p) => p.contact),
      messages: resolvedPairs.map((p) => p.message),
      message: resolvedPairs[0].message,
    });

    // Record each recipient's individual message in whatsapp_chats.json
    try {
      let chats: WhatsAppMessage[] = [];
      if (fs.existsSync(WHATSAPP_CHATS_FILE)) {
        chats = JSON.parse(fs.readFileSync(WHATSAPP_CHATS_FILE, "utf8"));
      }
      const succeededList: string[] = agentRes.data?.successful_contacts || (agentRes.success ? resolvedPairs.map((p) => p.contact) : []);
      resolvedPairs.forEach((p) => {
        if (succeededList.includes(p.contact) || succeededList.includes(p.rawContact) || succeededList.includes(p.displayName)) {
          chats.unshift({
            contactName: p.displayName,
            message: p.message,
            timestamp: new Date().toISOString(),
            status: "sent",
          });
        }
      });
      if (chats.length > 50) chats = chats.slice(0, 50);
      fs.writeFileSync(WHATSAPP_CHATS_FILE, JSON.stringify(chats, null, 2), "utf8");
    } catch {}

    return {
      success: agentRes.success,
      message:
        agentRes.message ||
        (agentRes.success
          ? `Successfully sent WhatsApp messages to all ${resolvedPairs.length} contacts.`
          : `WhatsApp multi-send completed with issues.`),
      data: agentRes.data || { recipients: resolvedPairs },
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to send WhatsApp message to multiple contacts: ${err.message}`,
    };
  }
}

export function loadWhatsAppChats(): WhatsAppMessage[] {
  if (!fs.existsSync(WHATSAPP_CHATS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WHATSAPP_CHATS_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function getContacts(): ToolResult {
  try {
    const contacts = loadContacts();
    return {
      success: true,
      message: "Successfully retrieved contacts list",
      data: contacts
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to retrieve contacts list: ${err.message}`
    };
  }
}

// 5. Windows Phone Link Device Integration
export async function makePhoneCall(target: string): Promise<ToolResult> {
  try {
    const resolved = resolveContact(target);
    const phoneToCall = resolved.phone || target;
    const res = await executeAgentCommand("make_phone_call", { phone: phoneToCall });
    return {
      success: res.success,
      message: res.message,
      data: { target, resolvedPhone: phoneToCall }
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to make phone call via Phone Link: ${err.message}`
    };
  }
}

export async function answerPhoneCall(): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("answer_phone_call", {});
    return {
      success: res.success,
      message: res.message
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to answer phone call via Phone Link: ${err.message}`
    };
  }
}

export async function rejectPhoneCall(): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("reject_phone_call", {});
    return {
      success: res.success,
      message: res.message
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to reject phone call via Phone Link: ${err.message}`
    };
  }
}

export async function readPhoneMessages(): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("read_phone_messages", { limit: 5 });
    return {
      success: res.success,
      message: res.message
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to read messages via Phone Link: ${err.message}`
    };
  }
}

export async function transferPhoneFiles(direction = "phone_to_laptop", fileName?: string): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("transfer_phone_files", { direction, file_name: fileName });
    return {
      success: res.success,
      message: res.message
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to transfer files via Phone Link: ${err.message}`
    };
  }
}

export async function getPhoneLinkStatus(): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("get_phone_link_status", {});
    return {
      success: res.success,
      message: res.message
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to check Phone Link status: ${err.message}`
    };
  }
}

import { submitOutcomeGoal, fetchOutcomeTaskStatus } from "./outcomeEngineClient";

export async function executeOutcomeGoal(goalPrompt: string): Promise<ToolResult> {
  try {
    const result = await submitOutcomeGoal(goalPrompt);
    if (!result || !result.success) {
      return {
        success: false,
        message: `Failed to submit outcome goal to Autonomous Engine: ${goalPrompt}`
      };
    }
    return {
      success: true,
      message: `ERA Autonomous Outcome Engine launched goal: "${result.objective}"`,
      data: result
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Autonomous Outcome Engine error: ${err.message}`
    };
  }
}





// ---------------------------------------------------------------------------
// Background Application Perception & Silent Control Tools
// Allows ERA to see and interact with background windows without bringing them
// to the front or interrupting the user's active foreground screen work.
// ---------------------------------------------------------------------------

const _bgCaptureCache = new Map<string, { output: string; data: any; timestamp: number }>();

export async function getBackgroundActivity(appName?: string): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("get_background_activity", { query: appName });
    return {
      success: res.success,
      message: res.message,
      output: res.message,
      data: { activity: res.message }
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to retrieve background activity: ${err.message}`
    };
  }
}

export async function listBackgroundApps(): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("list_background_apps", { include_minimized: true });
    return {
      success: res.success,
      message: res.message,
      output: res.message,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to list background applications: ${err.message}`,
    };
  }
}

export async function captureBackgroundApp(appName: string, analyzeWithAi: boolean = true): Promise<ToolResult> {
  const cacheKey = (appName || "all").toLowerCase().trim();
  const cached = _bgCaptureCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 4000)) {
    return {
      success: true,
      message: `Retrieved instant cached observation for '${appName}'.`,
      output: cached.output,
      data: cached.data
    };
  }
  try {
    const res = await executeAgentCommand("capture_background_window", { app_name: appName });
    if (!res.success) {
      return {
        success: false,
        message: `Could not capture background app '${appName}': ${res.message}`,
      };
    }

    // Extract file path from agent result
    const match = res.message.match(/Saved to:\s*([^\s(]+)/);
    const filePath = match ? match[1] : "";

    let visualAnalysis = "";
    if (analyzeWithAi && filePath && fs.existsSync(filePath)) {
      try {
        const keys = loadKeys();
        const apiKey = keys.geminiApiKey || process.env.GEMINI_API_KEY;
        if (apiKey && !apiKey.startsWith("••••") && apiKey.length > 10) {
          const imageBuffer = fs.readFileSync(filePath);
          const base64Image = imageBuffer.toString("base64");
          const ai = new GoogleGenAI({ apiKey });
          const visionPrompt = `You are ERA AI Assistant. This is a captured visual screenshot of the BACKGROUND application '${appName}', captured silently while the user continues working in foreground.
Describe what is visible in this background window:
1. Application name & title
2. Current view, screen state, or active conversation / document
3. Visible buttons, inputs, messages, or errors
4. Exactly what action should be taken next if executing a goal.
Be concise, clear, and factual.`;

          const candidateModels = ["gemini-3-flash-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash"];
          for (const modelName of candidateModels) {
            try {
              const response = await ai.models.generateContent({
                model: modelName,
                contents: [
                  {
                    role: "user",
                    parts: [
                      { text: visionPrompt },
                      {
                        inlineData: {
                          mimeType: "image/jpeg",
                          data: base64Image,
                        },
                      },
                    ],
                  },
                ],
                config: {
                  abortSignal: AbortSignal.timeout(10000),
                },
              });
              visualAnalysis = response.text || "";
              if (visualAnalysis) break;
            } catch (modelErr: any) {
              if (!visualAnalysis) visualAnalysis = `(Vision analysis failed on ${modelName}: ${modelErr.message})`;
            }
          }
        }
      } catch (aiErr: any) {
        visualAnalysis = `(Vision analysis failed: ${aiErr.message})`;
      }
    }

    const resultData = {
      appName,
      filePath,
      analysis: visualAnalysis,
      rawMessage: res.message,
    };
    _bgCaptureCache.set(cacheKey, { output: visualAnalysis || res.message, data: resultData, timestamp: Date.now() });

    return {
      success: true,
      message: `Captured background window for '${appName}'.`,
      output: visualAnalysis || res.message,
      data: {
        appName,
        filePath,
        analysis: visualAnalysis,
        rawMessage: res.message,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Background capture error for '${appName}': ${err.message}`,
    };
  }
}

export async function inspectBackgroundApp(appName: string): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("inspect_background_window", { app_name: appName });
    return {
      success: res.success,
      message: res.message,
      output: res.message,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to inspect background window '${appName}': ${err.message}`,
    };
  }
}

export async function executeBackgroundAction(
  appName: string,
  action: "click" | "type" | "send_keys" | "close" | string,
  params: Record<string, any> = {}
): Promise<ToolResult> {
  try {
    const act = action.toLowerCase().trim();
    if (act === "click") {
      const res = await executeAgentCommand("background_click", {
        app_name: appName,
        x: params.x,
        y: params.y,
        element_text: params.element_text || params.elementText,
        button: params.button || "left",
      });
      return { success: res.success, message: res.message };
    }

    if (act === "type") {
      const res = await executeAgentCommand("background_type", {
        app_name: appName,
        text: params.text || "",
        press_enter: params.press_enter ?? params.pressEnter ?? false,
      });
      return { success: res.success, message: res.message };
    }

    if (act === "send_keys" || act === "keys") {
      const keys = Array.isArray(params.keys) ? params.keys : [params.key || params.keys || "enter"];
      const res = await executeAgentCommand("background_send_keys", {
        app_name: appName,
        keys,
      });
      return { success: res.success, message: res.message };
    }

    if (act === "close") {
      const res = await executeAgentCommand("background_close_window", { app_name: appName });
      return { success: res.success, message: res.message };
    }

    return {
      success: false,
      message: `Unsupported background action '${action}'. Supported: click, type, send_keys, close.`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Background action error for '${appName}': ${err.message}`,
    };
  }
}

// 29. Autonomous Food Ordering (Swiggy / Zomato with Budget Filtering, Quantity & Cash on Delivery)
export async function orderFoodAutonomous(
  dish: string,
  quantity: number = 1,
  maxBudget?: number,
  minBudget?: number,
  platform?: "swiggy" | "zomato" | "auto",
  city?: string,
  location?: string,
  paymentMethod: string = "cod",
  autoOrder: boolean = true,
  runInBackground?: boolean
): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("order_food", {
      dish,
      quantity: Math.max(1, Number(quantity || 1)),
      max_budget: maxBudget,
      min_budget: minBudget,
      platform: platform || "auto",
      city: city || location,
      location: location || city,
      payment_method: paymentMethod || "cod",
      auto_order: autoOrder,
      headless: Boolean(runInBackground),
    });
    return {
      success: res.success,
      message: res.message,
      output: res.message,
      data: res.data,
      summary: res.message,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Food ordering error: ${err.message}`,
    };
  }
}

// 29.1. Submit Food OTP (Swiggy / Zomato Login & Checkout Verification)
export async function submitFoodOtp(otp: string): Promise<ToolResult> {
  try {
    const cleanOtp = String(otp || "").replace(/\D/g, "").trim();
    if (!cleanOtp) {
      return {
        success: false,
        message: "Invalid OTP code provided.",
      };
    }
    const res = await executeAgentCommand("submit_food_otp", { otp: cleanOtp });
    return {
      success: res.success,
      message: res.message || `OTP ${cleanOtp} enter kar diya gaya hai.`,
      output: res.message,
      data: res.data,
      summary: res.message,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `OTP submission error: ${err.message}`,
    };
  }
}

// 29.2. Complete Food Order / Fill Address (Swiggy / Zomato Checkout)
export async function completeFoodOrder(address?: string): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("complete_food_order", { address });
    return {
      success: res.success,
      message: res.message || "Address select karke Cash on Delivery par order place kar diya gaya hai.",
      output: res.message,
      data: res.data,
      summary: res.message,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Food order completion error: ${err.message}`,
    };
  }
}

// 8. Smooth Screen Scroll Tool
export async function scrollScreen(
  direction: string = "down",
  amount: string = "normal",
  appName: string = "",
  smooth: boolean = true,
  clicks?: number
): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("smooth_scroll", {
      direction,
      amount,
      app_name: appName,
      smooth,
      clicks,
    });
    return {
      success: res.success,
      message: res.message,
      output: res.message,
      data: res.data,
      summary: res.message,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Scroll error: ${err.message}`,
    };
  }
}

export const smoothScroll = scrollScreen;

// 9. Read and Scroll WhatsApp Tool
export async function readAndScrollWhatsApp(
  contactName: string = "",
  direction: string = "down",
  scrollSteps: number = 2
): Promise<ToolResult> {
  try {
    const res = await executeAgentCommand("read_and_scroll_whatsapp", {
      contact: contactName,
      direction,
      steps: scrollSteps,
    });
    return {
      success: res.success,
      message: res.message,
      output: res.message,
      data: res.data,
      summary: res.message,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `WhatsApp read and scroll error: ${err.message}`,
    };
  }
}

// 10. Autonomous Scroll to Target Content & Vision Explanation
export async function scrollToContent(
  target: string,
  appName: string = "",
  direction: string = "down",
  explain: boolean = true
): Promise<ToolResult> {
  const cleanTarget = String(target || "").trim();
  if (!cleanTarget) {
    return {
      success: false,
      message: "Boss, kripya batayein ki aapko kis topic ya section tak scroll karna hai.",
    };
  }

  try {
    // 1. Autonomously scroll until target content is in view
    const res = await executeAgentCommand("scroll_to_target", {
      target: cleanTarget,
      app_name: appName,
      direction,
      max_scrolls: 8,
      smooth: true,
    });

    let visualSummary = "";
    if (explain) {
      // 2. Wait 300ms for browser rendering to settle
      await new Promise((r) => setTimeout(r, 300));

      // 3. Inspect screenshot and perform Gemini Vision analysis
      const shotPath = res.data?.screenshot_path || path.join(WORKSPACE_DIR, "current_screen.jpg");
      let base64Image = "";
      if (fs.existsSync(shotPath)) {
        try {
          base64Image = fs.readFileSync(shotPath).toString("base64");
        } catch {}
      }

      // If not on disk, fallback to memory browser frame or captureScreen
      if (!base64Image) {
        const frame = getBrowserScreenFrame();
        if (frame?.data) {
          base64Image = frame.data.replace(/^data:image\/\w+;base64,/, "");
        }
      }

      if (base64Image) {
        try {
          const keys = loadKeys();
          const apiKey = keys.geminiApiKey || process.env.GEMINI_API_KEY;
          if (apiKey && !apiKey.startsWith("••••") && apiKey.length > 10) {
            const ai = new GoogleGenAI({ apiKey });
            const wasFound = res.data?.found !== false;
            const prompt = wasFound
              ? `You are ERA, an advanced AI Assistant looking at the user's active screen right now.
The user asked to see and understand the section about "${cleanTarget}".
Look at the screen:
1. Explain the key facts/summary of "${cleanTarget}" in friendly, natural spoken Hindi/Hinglish (e.g. "Boss, screen par inka ${cleanTarget} section open ho gaya hai. Isme bataya gaya hai ki..."). Mention specific facts, names, or degrees visible.
2. Keep the explanation concise (2 to 3 sentences), spoken-style, engaging, and 100% accurate to the screen.`
              : `You are ERA, an advanced AI Assistant looking at the user's active screen right now.
The user asked to see the section about "${cleanTarget}", but that section heading was not found after scanning the page.
Look at the visible page title and sections on screen right now:
Explain honestly and concisely in friendly Hindi/Hinglish that this specific page does not have a separate "${cleanTarget}" section, and mention what main sections or topics ARE visible (e.g. "Boss, is page par '${cleanTarget}' ka alag section nahi mila, yahan inki Early life aur Career sections samne hain.").
Keep it to 2 sentences, spoken-style.`;

            const candidateModels = ["gemini-3-flash-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash"];
            for (const model of candidateModels) {
              try {
                const aiResp = await ai.models.generateContent({
                  model,
                  contents: [
                    {
                      role: "user",
                      parts: [
                        { text: prompt },
                        {
                          inlineData: {
                            mimeType: "image/jpeg",
                            data: base64Image,
                          },
                        },
                      ],
                    },
                  ],
                  config: {
                    abortSignal: AbortSignal.timeout(9000),
                  },
                });
                if (aiResp?.text) {
                  visualSummary = aiResp.text.trim();
                  break;
                }
              } catch {}
            }
          }
        } catch {}
      }
    }

    const finalMessage = visualSummary || res.message || `Screen ko smoothly scroll karke "${cleanTarget}" samne la diya hai, boss!`;
    return {
      success: res.success !== false,
      message: finalMessage,
      output: finalMessage,
      data: {
        target: cleanTarget,
        explanation: visualSummary,
        agentData: res.data,
      },
      summary: finalMessage,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Scroll to content error: ${err.message}`,
    };
  }
}

export const scrollToTarget = scrollToContent;


