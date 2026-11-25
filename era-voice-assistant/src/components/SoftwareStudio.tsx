import React, { useState, useEffect, useRef } from "react";
import {
  Sparkles,
  Code2,
  RefreshCw,
  ExternalLink,
  Laptop,
  Tablet,
  Smartphone,
  Monitor,
  Copy,
  Check,
  FolderOpen,
  Send,
  Download,
  Zap,
  Layers,
  Wand2,
  Maximize2,
  Minimize2,
  Columns2,
  Globe,
  Compass,
  LayoutTemplate,
} from "lucide-react";

export interface StudioFile {
  name: string;
  path: string;
  content: string;
  size: number;
}

export interface StudioProject {
  id: string;
  title: string;
  description: string;
  prompt: string;
  appType: string;
  createdAt: string;
  updatedAt: string;
  previewUrl: string;
  files: StudioFile[];
  tags: string[];
}

interface SoftwareStudioProps {
  wsRef?: React.RefObject<WebSocket | null>;
  initialPrompt?: string;
}

export const SoftwareStudio: React.FC<SoftwareStudioProps> = ({ wsRef, initialPrompt = "" }) => {
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [activeProject, setActiveProject] = useState<StudioProject | null>(null);
  const [selectedFile, setSelectedFile] = useState<string>("index.html");
  const [prompt, setPrompt] = useState<string>(initialPrompt);
  const [isBuilding, setIsBuilding] = useState<boolean>(false);
  const [buildStage, setBuildStage] = useState<string>("");
  const [buildPercent, setBuildPercent] = useState<number>(0);
  const [viewport, setViewport] = useState<"desktop" | "laptop" | "tablet" | "mobile">("desktop");
  const [copied, setCopied] = useState<boolean>(false);
  const [modificationInput, setModificationInput] = useState<string>("");
  const [isModifying, setIsModifying] = useState<boolean>(false);
  const [iframeKey, setIframeKey] = useState<number>(0);
  const [layoutMode, setLayoutMode] = useState<"split" | "preview" | "code">("split");
  const [browserMenuOpen, setBrowserMenuOpen] = useState<boolean>(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // Quick Inspiration Templates
  const templates = [
    { label: "🚀 SaaS Analytics Dashboard", prompt: "Create a modern dark-mode SaaS analytics dashboard with interactive real-time velocity charts, active workflow metrics, task dispatcher, and sound effects." },
    { label: "🛍️ NextGen E-Commerce", prompt: "Build a sleek e-commerce storefront with reactive product catalog, instant cart drawer with quantity counters, filter chips, and simulated checkout." },
    { label: "🕹️ Cyberpunk Arcade Game", prompt: "Build an interactive arcade dodging game using HTML5 Canvas with keyboard controls, retro score tracker, and high-score persistence." },
    { label: "📝 Kanban Task Suite", prompt: "Build an interactive Kanban board with draggable columns (Backlog, In Progress, Completed), task creation, priority badges, and localStorage persistence." },
    { label: "💼 Dark Glassmorphism Portfolio", prompt: "Create a stunning developer portfolio website with interactive projects showcase, skill badges, live contact modal, and modern glassmorphism design." },
  ];

  // Load Projects on Mount
  useEffect(() => {
    fetchProjects();
  }, []);

  const fetchProjects = async () => {
    try {
      const res = await fetch("/api/studio/projects");
      if (res.ok) {
        const data: StudioProject[] = await res.json();
        setProjects(data);
        if (data.length > 0 && !activeProject) {
          setActiveProject(data[0]);
        }
      }
    } catch (e) {
      console.warn("Failed to fetch studio projects:", e);
    }
  };

  // Listen to WebSocket build progress
  useEffect(() => {
    if (!wsRef?.current) return;
    const ws = wsRef.current;

    const handleMessage = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === "studioBuildProgress") {
          setIsBuilding(true);
          setBuildStage(data.message || data.stage);
          setBuildPercent(data.percent || 50);
          if (data.stage === "COMPLETED") {
            setIsBuilding(false);
            if (data.project) {
              setActiveProject(data.project);
              fetchProjects();
            }
          }
        } else if (data.type === "studioProjectCreated") {
          setActiveProject(data.project);
          setIsBuilding(false);
          fetchProjects();
        }
      } catch (_) {}
    };

    ws.addEventListener("message", handleMessage);
    return () => {
      ws.removeEventListener("message", handleMessage);
    };
  }, [wsRef]);

  // Handle Build Request
  const handleBuild = async (customPrompt?: string) => {
    const textToBuild = customPrompt || prompt;
    if (!textToBuild.trim() || isBuilding) return;

    setIsBuilding(true);
    setBuildStage("Formulating architecture spec & design system...");
    setBuildPercent(15);

    try {
      const res = await fetch("/api/studio/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: textToBuild, autoPreview: false }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.project) {
          setActiveProject(data.project);
          setProjects((prev) => [data.project, ...prev.filter((p) => p.id !== data.project.id)]);
          setBuildStage("Application materialized successfully!");
          setBuildPercent(100);
          setIframeKey((prev) => prev + 1);
        }
      } else {
        const err = await res.json();
        setBuildStage(`Error: ${err.error || "Build failed"}`);
      }
    } catch (e: any) {
      setBuildStage(`Error: ${e.message}`);
    } finally {
      setIsBuilding(false);
    }
  };

  // Handle Iterative Modification
  const handleModify = async () => {
    if (!activeProject || !modificationInput.trim() || isModifying) return;
    setIsModifying(true);

    try {
      const res = await fetch("/api/studio/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProject.id,
          instruction: modificationInput,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.project) {
          setActiveProject(data.project);
          setProjects((prev) => prev.map((p) => (p.id === data.project.id ? data.project : p)));
          setModificationInput("");
          setIframeKey((prev) => prev + 1);
        }
      }
    } catch (e) {
      console.error("Modification failed:", e);
    } finally {
      setIsModifying(false);
    }
  };

  // Copy Code
  const handleCopyCode = () => {
    const currentFileObj = activeProject?.files.find((f) => f.name === selectedFile);
    if (currentFileObj?.content) {
      navigator.clipboard.writeText(currentFileObj.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Download project as file
  const handleDownload = () => {
    if (!activeProject) return;
    const currentFileObj = activeProject.files.find((f) => f.name === selectedFile) || activeProject.files[0];
    if (currentFileObj) {
      const blob = new Blob([currentFileObj.content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = currentFileObj.name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  // Open in Specific Browser (Default, Chrome, Edge)
  const openInBrowser = async (browserType: "default" | "chrome" | "edge" = "default") => {
    if (!activeProject) return;
    const url = `http://localhost:3000${activeProject.previewUrl}`;
    
    // Client open
    window.open(url, "_blank");

    // Trigger local OS launch command
    try {
      await fetch("/api/studio/open-browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, browser: browserType }),
      });
    } catch (_) {}
    setBrowserMenuOpen(false);
  };

  // Toggle Fullscreen on Container
  const toggleNativeFullscreen = () => {
    if (!document.fullscreenElement) {
      previewContainerRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  const currentFileContent =
    activeProject?.files.find((f) => f.name === selectedFile)?.content ||
    "// Select or build a project to view production code";

  // Viewport Container Widths
  const viewportWidthClass = {
    desktop: "w-full",
    laptop: "max-w-[1024px] w-full",
    tablet: "max-w-[768px] w-full",
    mobile: "max-w-[375px] w-full",
  }[viewport];

  return (
    <div className="flex-1 flex flex-col h-full bg-[#090D14] text-neutral-200 overflow-hidden select-none">
      
      {/* ── TOP ACTION BAR ────────────────────────────────────────── */}
      <header className="h-14 border-b border-neutral-800/80 bg-neutral-900/60 backdrop-blur-md px-5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-amber-500 to-yellow-400 flex items-center justify-center text-slate-950 font-bold shadow-md shadow-amber-500/20">
            <Sparkles size={16} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-white">ERA Software Studio</h2>
              <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1">
                <Zap size={9} /> Autonomous Builder
              </span>
            </div>
            <p className="text-[11px] text-neutral-400">Independent Website & App Synthesizer (Production Studio Class)</p>
          </div>
        </div>

        {/* Project Selector, Layout Modes, Viewports & Browser Launcher */}
        <div className="flex items-center gap-2">
          {projects.length > 0 && (
            <select
              value={activeProject?.id || ""}
              onChange={(e) => {
                const found = projects.find((p) => p.id === e.target.value);
                if (found) {
                  setActiveProject(found);
                  setIframeKey((k) => k + 1);
                }
              }}
              className="bg-neutral-950/80 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs text-neutral-300 focus:outline-none focus:border-amber-500/50 max-w-[180px] truncate"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          )}

          {/* Layout Mode Switcher (Split vs Full Preview vs Code Only) */}
          <div className="flex items-center gap-1 bg-neutral-950/90 p-1 rounded-lg border border-neutral-800">
            <button
              onClick={() => setLayoutMode("split")}
              className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 transition ${
                layoutMode === "split" ? "bg-amber-500 text-slate-950 font-bold" : "text-neutral-400 hover:text-white"
              }`}
              title="Split View (Code + Preview)"
            >
              <Columns2 size={13} />
              <span className="hidden sm:inline">Split</span>
            </button>
            <button
              onClick={() => setLayoutMode("preview")}
              className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 transition ${
                layoutMode === "preview" ? "bg-amber-500 text-slate-950 font-bold" : "text-neutral-400 hover:text-white"
              }`}
              title="Full Screen Preview (100% Width)"
            >
              <Maximize2 size={13} />
              <span className="hidden sm:inline">Full Preview</span>
            </button>
            <button
              onClick={() => setLayoutMode("code")}
              className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 transition ${
                layoutMode === "code" ? "bg-amber-500 text-slate-950 font-bold" : "text-neutral-400 hover:text-white"
              }`}
              title="Code Only"
            >
              <Code2 size={13} />
              <span className="hidden sm:inline">Code</span>
            </button>
          </div>

          {/* Viewport Toggles (Desktop, Laptop, Tablet, Mobile) */}
          {layoutMode !== "code" && (
            <div className="hidden xl:flex items-center gap-1 bg-neutral-950/80 p-1 rounded-lg border border-neutral-800/80">
              <button
                onClick={() => setViewport("desktop")}
                className={`p-1.5 rounded transition ${viewport === "desktop" ? "bg-amber-500 text-slate-950 font-bold" : "text-neutral-400 hover:text-white"}`}
                title="Desktop View (100%)"
              >
                <Monitor size={13} />
              </button>
              <button
                onClick={() => setViewport("laptop")}
                className={`p-1.5 rounded transition ${viewport === "laptop" ? "bg-amber-500 text-slate-950 font-bold" : "text-neutral-400 hover:text-white"}`}
                title="Laptop View (1024px)"
              >
                <Laptop size={13} />
              </button>
              <button
                onClick={() => setViewport("tablet")}
                className={`p-1.5 rounded transition ${viewport === "tablet" ? "bg-amber-500 text-slate-950 font-bold" : "text-neutral-400 hover:text-white"}`}
                title="Tablet View (768px)"
              >
                <Tablet size={13} />
              </button>
              <button
                onClick={() => setViewport("mobile")}
                className={`p-1.5 rounded transition ${viewport === "mobile" ? "bg-amber-500 text-slate-950 font-bold" : "text-neutral-400 hover:text-white"}`}
                title="Mobile View (375px)"
              >
                <Smartphone size={13} />
              </button>
            </div>
          )}

          {/* Browser Launch Dropdown (Chrome / Edge / Default) */}
          {activeProject && (
            <div className="relative">
              <div className="flex items-center rounded-lg border border-neutral-700/80 bg-neutral-900 overflow-hidden">
                <button
                  onClick={() => openInBrowser("default")}
                  className="px-2.5 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800 flex items-center gap-1.5 transition"
                  title="Open live preview in default browser"
                >
                  <Globe size={13} className="text-amber-400" />
                  <span className="hidden sm:inline">Open Browser</span>
                </button>
                <button
                  onClick={() => setBrowserMenuOpen(!browserMenuOpen)}
                  className="px-1.5 py-1.5 border-l border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-800 text-[10px]"
                  title="Choose browser"
                >
                  ▼
                </button>
              </div>

              {browserMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-48 bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl p-1 z-50 flex flex-col gap-1 backdrop-blur-xl">
                  <button
                    onClick={() => openInBrowser("chrome")}
                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-neutral-800 text-neutral-200 flex items-center gap-2"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    Open in Google Chrome
                  </button>
                  <button
                    onClick={() => openInBrowser("edge")}
                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-neutral-800 text-neutral-200 flex items-center gap-2"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-sky-500" />
                    Open in Microsoft Edge
                  </button>
                  <button
                    onClick={() => openInBrowser("default")}
                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-neutral-800 text-neutral-200 flex items-center gap-2"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                    Open in System Default
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => setIframeKey((k) => k + 1)}
            className="p-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition"
            title="Reload Preview"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </header>

      {/* ── MAIN STUDIO SPLIT WORKSPACE ───────────────────────────── */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
        
        {/* LEFT COLUMN: Prompt, Architecture & Code Inspector */}
        <div
          className={`${
            layoutMode === "preview"
              ? "hidden"
              : layoutMode === "code"
              ? "w-full"
              : "w-full lg:w-[40%]"
          } border-r border-neutral-800/80 flex flex-col h-full bg-neutral-950/40 transition-all duration-200`}
        >
          {/* Prompt Dispatch Bar */}
          <div className="p-4 border-b border-neutral-800/80 bg-neutral-900/30 space-y-3">
            <div className="relative">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleBuild();
                  }
                }}
                rows={2}
                placeholder="Describe any website, SaaS software, game, or web tool to build autonomously..."
                className="w-full bg-neutral-950/90 border border-neutral-800 rounded-xl px-3.5 py-2.5 text-xs text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-amber-500/60 transition resize-none font-sans"
              />
              <button
                onClick={() => handleBuild()}
                disabled={isBuilding || !prompt.trim()}
                className="absolute right-2.5 bottom-2.5 bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-950 font-bold px-3.5 py-1.5 rounded-lg text-xs flex items-center gap-1.5 transition shadow-md shadow-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isBuilding ? (
                  <>
                    <RefreshCw size={12} className="animate-spin" /> Synthesizing...
                  </>
                ) : (
                  <>
                    <Sparkles size={12} /> Build Software
                  </>
                )}
              </button>
            </div>

            {/* Quick Inspiration Chips */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 text-[11px] no-scrollbar">
              <span className="text-neutral-500 shrink-0 font-medium">Inspiration:</span>
              {templates.map((tpl) => (
                <button
                  key={tpl.label}
                  onClick={() => {
                    setPrompt(tpl.prompt);
                    handleBuild(tpl.prompt);
                  }}
                  className="shrink-0 bg-neutral-950 hover:bg-neutral-800 text-neutral-300 hover:text-amber-400 border border-neutral-800/80 rounded-full px-2.5 py-1 transition flex items-center gap-1 text-[11px]"
                >
                  {tpl.label}
                </button>
              ))}
            </div>

            {/* Live Build Status Alert */}
            {isBuilding && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-center gap-3">
                <RefreshCw size={16} className="text-amber-400 animate-spin shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold text-amber-300 truncate">{buildStage}</span>
                    <span className="text-amber-400 font-mono text-[10px]">{buildPercent}%</span>
                  </div>
                  <div className="w-full bg-neutral-800 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-amber-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${buildPercent}%` }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Multi-File Code Inspector */}
          <div className="flex-1 flex flex-col min-h-0">
            {/* File Tabs Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800/80 bg-neutral-900/40">
              <div className="flex items-center gap-1">
                {activeProject?.files.map((file) => (
                  <button
                    key={file.name}
                    onClick={() => setSelectedFile(file.name)}
                    className={`px-3 py-1 rounded-md text-xs font-mono font-medium transition flex items-center gap-1.5 ${
                      selectedFile === file.name
                        ? "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                        : "text-neutral-400 hover:text-neutral-200"
                    }`}
                  >
                    <Code2 size={12} /> {file.name}
                  </button>
                )) || (
                  <span className="text-xs text-neutral-500 font-mono flex items-center gap-1.5">
                    <FolderOpen size={12} /> No files loaded
                  </span>
                )}
              </div>

              {activeProject && (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleCopyCode}
                    className="text-neutral-400 hover:text-white p-1 rounded transition text-xs flex items-center gap-1"
                    title="Copy File Code"
                  >
                    {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  </button>
                  <button
                    onClick={handleDownload}
                    className="text-neutral-400 hover:text-white p-1 rounded transition text-xs"
                    title="Download File"
                  >
                    <Download size={12} />
                  </button>
                </div>
              )}
            </div>

            {/* Code Content Viewer */}
            <div className="flex-1 overflow-auto p-4 bg-[#070A0F] font-mono text-[11px] leading-relaxed text-slate-300">
              <pre className="whitespace-pre-wrap">{currentFileContent}</pre>
            </div>

            {/* Iterative Refinement Input */}
            {activeProject && (
              <div className="p-3 border-t border-neutral-800/80 bg-neutral-900/50 flex items-center gap-2">
                <input
                  type="text"
                  value={modificationInput}
                  onChange={(e) => setModificationInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleModify()}
                  placeholder="Ask ERA to edit or add a feature (e.g. 'Add dark mode toggle', 'Add export to CSV')..."
                  className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-amber-500/50 font-sans"
                />
                <button
                  onClick={handleModify}
                  disabled={isModifying || !modificationInput.trim()}
                  className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 transition disabled:opacity-40"
                >
                  {isModifying ? <RefreshCw size={11} className="animate-spin" /> : <Send size={11} />}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: Interactive Live Sandbox Preview */}
        <div
          ref={previewContainerRef}
          className={`${
            layoutMode === "code"
              ? "hidden"
              : layoutMode === "preview"
              ? "w-full"
              : "w-full lg:w-[60%]"
          } flex flex-col h-full bg-[#05070B] overflow-hidden transition-all duration-200`}
        >
          {/* Preview Navigation Header */}
          <div className="h-10 px-4 border-b border-neutral-800/80 bg-neutral-900/40 flex items-center justify-between text-xs text-neutral-400 shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-mono text-neutral-200 text-xs font-semibold">
                {activeProject ? `Live Preview: ${activeProject.title}` : "Interactive Web Sandbox"}
              </span>
              {layoutMode === "preview" && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold border border-emerald-500/30">
                  FULL SCREEN MODE
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Quick Browser Launch Buttons */}
              <div className="hidden sm:flex items-center gap-1.5">
                <button
                  onClick={() => openInBrowser("chrome")}
                  className="px-2 py-1 rounded bg-neutral-900 hover:bg-neutral-800 text-neutral-300 hover:text-white border border-neutral-700 text-[10px] flex items-center gap-1 transition"
                  title="Open in Google Chrome"
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400" /> Chrome
                </button>
                <button
                  onClick={() => openInBrowser("edge")}
                  className="px-2 py-1 rounded bg-neutral-900 hover:bg-neutral-800 text-neutral-300 hover:text-white border border-neutral-700 text-[10px] flex items-center gap-1 transition"
                  title="Open in Microsoft Edge"
                >
                  <span className="w-2 h-2 rounded-full bg-sky-400" /> Edge
                </button>
              </div>

              {/* Fullscreen / Split Toggle Button */}
              <button
                onClick={() => setLayoutMode(layoutMode === "preview" ? "split" : "preview")}
                className="px-2.5 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-medium flex items-center gap-1 transition border border-neutral-700"
                title={layoutMode === "preview" ? "Exit Fullscreen (Split View)" : "Full Screen Preview"}
              >
                {layoutMode === "preview" ? (
                  <>
                    <Minimize2 size={12} className="text-amber-400" /> Split View
                  </>
                ) : (
                  <>
                    <Maximize2 size={12} className="text-amber-400" /> Full Screen
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Interactive Sandbox Frame */}
          <div
            className={`flex-1 overflow-hidden bg-neutral-950 flex flex-col ${
              layoutMode === "preview" ? "p-0" : "p-3 sm:p-4"
            }`}
          >
            {activeProject ? (
              <div
                className={`h-full transition-all duration-300 overflow-hidden flex flex-col ${
                  layoutMode === "preview"
                    ? "w-full rounded-none border-0"
                    : `${viewportWidthClass} mx-auto rounded-2xl border border-neutral-800 bg-[#0B0F17] shadow-2xl`
                }`}
              >
                {/* Simulated Browser Address Bar */}
                <div className="h-9 bg-neutral-900 border-b border-neutral-800 px-3 flex items-center justify-between gap-3 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
                    <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
                    <span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
                  </div>
                  <div className="flex-1 max-w-lg bg-neutral-950 rounded-md px-3 py-1 text-[11px] font-mono text-neutral-300 truncate text-center border border-neutral-800/90 flex items-center justify-center gap-1.5">
                    <span className="text-emerald-400 font-bold">🔒</span>
                    http://localhost:3000{activeProject.previewUrl}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => openInBrowser("default")}
                      className="text-neutral-400 hover:text-amber-400 p-1 transition"
                      title="Open in new window"
                    >
                      <ExternalLink size={12} />
                    </button>
                    <button
                      onClick={() => setLayoutMode(layoutMode === "preview" ? "split" : "preview")}
                      className="text-neutral-400 hover:text-amber-400 p-1 transition"
                      title={layoutMode === "preview" ? "Exit Fullscreen" : "Full Screen Mode"}
                    >
                      {layoutMode === "preview" ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                    </button>
                    <button
                      onClick={() => setIframeKey((k) => k + 1)}
                      className="text-neutral-400 hover:text-white p-1 transition"
                      title="Reload Iframe"
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                </div>

                {/* Live Sandbox Iframe (Takes 100% full screen & height) */}
                <iframe
                  key={iframeKey}
                  ref={iframeRef}
                  src={activeProject.previewUrl}
                  title={activeProject.title}
                  className="w-full h-full flex-1 border-0 bg-transparent"
                  sandbox="allow-scripts allow-forms allow-same-origin allow-modals allow-downloads"
                />
              </div>
            ) : (
              <div className="m-auto text-center p-8 max-w-md space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mx-auto shadow-lg shadow-amber-500/10">
                  <Layers size={26} />
                </div>
                <h3 className="font-bold text-base text-white">No Application Generated Yet</h3>
                <p className="text-xs text-neutral-400 leading-relaxed">
                  Enter an objective or choose a template on the left. ERA will autonomously formulate the architecture, code the full production suite, and render the interactive preview in full screen!
                </p>
                <button
                  onClick={() => handleBuild(templates[0].prompt)}
                  className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-4 py-2.5 rounded-xl text-xs inline-flex items-center gap-1.5 transition shadow-lg shadow-amber-500/20"
                >
                  <Wand2 size={14} /> Generate Demo SaaS App
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SoftwareStudio;
