/**

 * ERA Autonomous Goal Execution Engine

 * 

 * Enables ERA to accept ANY high-level objective, plan a multi-step strategy,

 * observe the desktop via the Vision feed, execute actions persistently

 * (clicks, typing, opening applications, navigation, commands), verify outcomes,

 * self-heal on errors, and run to completion autonomously.

 */



import { executeAgentCommand } from "./agentBridge";

import { captureScreen, captureBackgroundApp, inspectBackgroundApp, getBackgroundActivity, executeBackgroundAction, loadContacts } from "./tools";

import { submitOutcomeGoal } from "./outcomeEngineClient";

import { GoogleGenAI } from "@google/genai";

import * as fs from "fs";

import * as path from "path";

import { exec } from "child_process";

import { promisify } from "util";



const execAsync = promisify(exec);



export interface GoalStep {

  step_number: number;

  title: string;

  description: string;

  action: string;

  params: Record<string, any>;

  expected_outcome: string;

  status: "PENDING" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_WARNING" | "FAILED" | "RETRYING";

  result?: any;

  verification?: {

    verified: boolean;

    explanation: string;

  };

  retries?: number;

  critical?: boolean;

  phase?: string;

  dependencies?: number[];

}



export interface WhyTraceEntry {

  timestamp: string;

  stage: "PLAN" | "OBSERVE" | "ACT" | "VERIFY" | "RECOVER" | "COMPLETE";

  action: string;

  observed: string;

  decision: string;

}



export interface GoalExecutionState {

  goalId: string;

  objective: string;

  status: "PLANNING" | "EXECUTING" | "VERIFYING" | "COMPLETED" | "COMPLETED_WITH_WARNING" | "FAILED" | "STOPPED";

  steps: GoalStep[];

  currentStepIndex: number;

  startTime: number;

  completedTime?: number;

  whyTrace: WhyTraceEntry[];

  contextMemory?: Record<string, any>;

  finalReport?: {

    summary: string;

    completedStepsCount: number;

    failedStepsCount: number;

    totalStepsCount: number;

    durationSeconds: number;

    itemizedDetails?: Array<{ stepNumber: number; title: string; status: string; explanation: string }>;

  };

}



export interface GoalExecutionResult {

  success: boolean;

  goalId: string;

  objective: string;

  status: string;

  message: string;

  stepsCount: number;

  completedStepsCount: number;

  durationSeconds: number;

  summary: string;

  whyTrace: WhyTraceEntry[];

}



export class AutonomousGoalExecutor {

  private activeGoals: Map<string, GoalExecutionState> = new Map();

  private stoppedGoals: Set<string> = new Set();

  private static uiActionLock: Promise<void> = Promise.resolve();



  /**

   * Global serial lock for UI/PyAutoGUI automation to guarantee that

   * multiple actions or concurrent goals NEVER collide over Windows focus or clipboard.

   */

  public static async acquireUILock<T>(action: () => Promise<T>): Promise<T> {

    const previous = AutonomousGoalExecutor.uiActionLock;

    let release: () => void = () => {};

    AutonomousGoalExecutor.uiActionLock = new Promise<void>((resolve) => { release = resolve; });

    try {

      await previous;

      return await action();

    } finally {

      release();

    }

  }



  private softwareStudioEngineGetter?: () => any;



  constructor(

    private getGeminiAiClient: () => GoogleGenAI,

    softwareStudioEngineGetter?: () => any

  ) {

    this.softwareStudioEngineGetter = softwareStudioEngineGetter;

  }



  public getGoalStatus(goalId: string): GoalExecutionState | null {

    return this.activeGoals.get(goalId) || null;

  }



  public listActiveGoals(): GoalExecutionState[] {

    return Array.from(this.activeGoals.values());

  }



    /**

   * Dynamically interpolates template variables in step parameters using execution contextMemory.

   * Supports {{previous_result}}, {{step_X.output}}, {{step_X_result}}, etc.

   */

  private interpolateParams(params: Record<string, any>, context: Record<string, any>): Record<string, any> {

    if (!params || typeof params !== "object") return params;

    const result: Record<string, any> = {};



    for (const [key, val] of Object.entries(params)) {

      if (typeof val === "string") {

        let interpolated = val;

        interpolated = interpolated.replace(/\{\{([^}]+)\}\}/g, (_, varName) => {

          const trimmed = varName.trim();

          if (trimmed === "previous_result" || trimmed === "last_result") {

            const lr = context["last_result"];

            return typeof lr === "string" ? lr : (lr?.output || lr?.stdout || lr?.message || JSON.stringify(lr) || "");

          }

          if (context[trimmed] !== undefined) {

            const v = context[trimmed];

            return typeof v === "string" ? v : (v?.output || v?.stdout || v?.message || JSON.stringify(v) || "");

          }

          const parts = trimmed.split(".");

          if (parts.length === 2 && context[parts[0]]) {

            const obj = context[parts[0]];

            return obj[parts[1]] !== undefined ? String(obj[parts[1]]) : "";

          }

          return `{{${varName}}}`;

        });

        result[key] = interpolated;

      } else if (Array.isArray(val)) {

        result[key] = val.map((item) => (typeof item === "string" ? this.interpolateParams({ v: item }, context).v : item));

      } else if (typeof val === "object" && val !== null) {

        result[key] = this.interpolateParams(val, context);

      } else {

        result[key] = val;

      }

    }

    return result;

  }



  public stopGoal(goalId: string): boolean {

    const goal = this.activeGoals.get(goalId);

    if (goal) {

      this.stoppedGoals.add(goalId);

      goal.status = "STOPPED";

      goal.whyTrace.push({

        timestamp: new Date().toISOString(),

        stage: "COMPLETE",

        action: "Emergency Stop / User Cancellation",

        observed: "User issued stop command",

        decision: "Halted autonomous goal execution immediately.",

      });

      return true;

    }

    return false;

  }



  /**

   * Fire-and-forget wrapper: starts goal execution in background.

   * Returns goalId immediately so HTTP handler can return without blocking.

   */

  private getFastTextModels(): string[] {
    return ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"];
  }

  private getFastVisionModels(): string[] {
    return ["gemini-3-flash-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite-preview"];
  }

  private async generateWithModelFallback(
    models: string[],
    contents: any,
    timeoutMs: number = 10000
  ): Promise<string> {
    const ai = this.getGeminiAiClient();
    for (const modelName of models) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            abortSignal: AbortSignal.timeout(timeoutMs),
          },
        });
        const txt = response.text || "";
        if (txt.trim()) return txt;
      } catch (mErr: any) {
        console.warn(`[AutonomousGoalExecutor] Model '${modelName}' failed: ${mErr?.message || mErr}`);
      }
    }
    return "";
  }

  private async captureFreshScreenshotBase64(): Promise<{ base64: string; mimeType: string } | null> {
    const jpgPath = path.join(process.cwd(), "current_screen.jpg");
    const pngPath = path.join(process.cwd(), "current_screen.png");

    // Capture a fresh screenshot quickly via Python PIL/mss into current_screen.jpg
    const pyCandidates = [
      "d:\\era_agent\\.venv\\Scripts\\python.exe",
      "d:\\era-voice-assistant\\resources\\python_runtime\\python.exe",
      "python.exe",
    ];
    const pyExe = pyCandidates.find((p) => fs.existsSync(p)) || "python.exe";
    try {
      const escapedJpg = jpgPath.replace(/\\/g, "\\\\");
      const pyScript = [
        "import ctypes",
        "try: ctypes.windll.user32.SetProcessDPIAware()",
        "except Exception: pass",
        "from PIL import ImageGrab",
        `img = ImageGrab.grab().convert('RGB')`,
        `img.save(r'${escapedJpg}', 'JPEG', quality=78)`,
      ].join("; ");
      await execAsync(`"${pyExe}" -c "${pyScript}"`, { timeout: 3500, windowsHide: true });
    } catch {
      // Fall back to existing recent screenshot file if PIL capture had an issue
    }

    const candidates = [
      { p: jpgPath, mime: "image/jpeg" },
      { p: pngPath, mime: "image/png" },
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c.p) && Date.now() - fs.statSync(c.p).mtimeMs < 15000) {
          return { base64: fs.readFileSync(c.p).toString("base64"), mimeType: c.mime };
        }
      } catch {}
    }
    return null;
  }

  private async locateElementOnScreen(
    targetDescription: string,
    appName?: string
  ): Promise<{ found: boolean; x_norm: number; y_norm: number; label: string }> {
    const shot = await this.captureFreshScreenshotBase64();
    if (!shot) {
      return { found: false, x_norm: 0, y_norm: 0, label: "No desktop screenshot available" };
    }

    const prompt = `You are a precision UI element locator. Find the interactive UI element matching this description:
- Target element: "${targetDescription}"
${appName ? `- Expected application window: "${appName}"` : ""}

Return the CENTER point of the clickable input box/button in NORMALIZED coordinates from 0 to 1000 (where x=0..1000 left-to-right, y=0..1000 top-to-bottom).
Return ONLY valid JSON:
\`\`\`json
{
  "found": true,
  "x_norm": 500,
  "y_norm": 120,
  "label": "short description of located element"
}
\`\`\``;

    try {
      const text = await this.generateWithModelFallback(
        this.getFastVisionModels(),
        [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType: shot.mimeType, data: shot.base64 } },
            ],
          },
        ],
        9000
      );
      if (!text) return { found: false, x_norm: 0, y_norm: 0, label: "Vision model returned empty response" };
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
      const parsed = JSON.parse((jsonMatch[1] || text).trim());
      if (parsed?.found && typeof parsed.x_norm === "number" && typeof parsed.y_norm === "number") {
        return {
          found: true,
          x_norm: Math.max(0, Math.min(1000, Math.round(parsed.x_norm))),
          y_norm: Math.max(0, Math.min(1000, Math.round(parsed.y_norm))),
          label: String(parsed.label || targetDescription),
        };
      }
    } catch (err: any) {
      console.warn(`[AutonomousGoalExecutor] locateElementOnScreen failed: ${err?.message}`);
    }
    return { found: false, x_norm: 0, y_norm: 0, label: "Element not located" };
  }

  public startGoalAsync(

    objective: string,

    clientWs?: any,

    session?: any,

    options?: {
      autonomousConfirmed?: boolean;
      runInBackground?: boolean;
      onComplete?: (result: GoalExecutionResult) => void;
      getSession?: () => any;
    }

  ): string {

    const goalId = `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // Pre-register so status polling works immediately

    const startTime = Date.now();

    const state: GoalExecutionState = {

      goalId,

      objective,

      status: "PLANNING",

      steps: [],

      currentStepIndex: 0,

      startTime,

      whyTrace: [],

      contextMemory: {},

    };

    this.activeGoals.set(goalId, state);



    // Run asynchronously - do not await

    this.executeGoal(objective, clientWs, session, state, options).catch((err) => {

      console.error(`[AutonomousGoalExecutor] Goal ${goalId} crashed:`, err);

      state.status = "FAILED";

      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      const summary = `Goal failed with uncaught error: ${err?.message || err}`;

      state.finalReport = {

        summary,

        completedStepsCount: 0,

        failedStepsCount: state.steps.filter((s) => s.status === "FAILED").length,

        totalStepsCount: state.steps.length,

        durationSeconds,

      };

      try {
        options?.onComplete?.({
          success: false,
          goalId,
          objective,
          status: "FAILED",
          message: summary,
          stepsCount: state.steps.length,
          completedStepsCount: 0,
          durationSeconds,
          summary,
          whyTrace: state.whyTrace,
        });
      } catch {}

    });



    return goalId;

  }





  /**

   * Main entry-point: accepts any natural language high-level objective,

   * decomposes it into an action DAG, and executes persistently until completion.

   */

  public async executeGoal(

    objective: string,

    clientWs?: any,

    session?: any,

    existingState?: GoalExecutionState,

    options?: {
      autonomousConfirmed?: boolean;
      runInBackground?: boolean;
      onComplete?: (result: GoalExecutionResult) => void;
      getSession?: () => any;
    }

  ): Promise<GoalExecutionResult> {

    const goalId = existingState?.goalId || `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const startTime = existingState?.startTime || Date.now();



    console.log(`\n======================================================`);

    console.log(`[AutonomousGoalExecutor] Starting goal '${goalId}': "${objective}"`);

    console.log(`======================================================\n`);



    const state: GoalExecutionState = existingState || {

      goalId,

      objective,

      status: "PLANNING",

      steps: [],

      currentStepIndex: 0,

      startTime,

      whyTrace: [],

    };

    this.activeGoals.set(goalId, state);



    const broadcast = (payload: any) => {

      if (clientWs && clientWs.readyState === 1) {

        try {

          clientWs.send(JSON.stringify(payload));

        } catch (e) {

          // Ignore send errors

        }

      }

    };



    // ── STAGE 1: OBSERVE INITIAL SCREEN & DESKTOP CONTEXT ────────────────

    const isBackground = Boolean(

      options?.runInBackground ||

      /background|piche|bina\s*(?:screen|open|samne|focus|dekhe)|without\s*(?:screen|bringing|opening|focusing|disrupting|stealing)|silent(?:ly)?/i.test(objective)

    );

    let targetAppName = "";

    const appMatch = objective.match(/\b(notepad|calc(?:ulator)?|vscode|code|chrome|edge|opera|word|excel|terminal|cmd|powershell|spotify|whatsapp)\b/i);

    if (appMatch) {

      targetAppName = appMatch[1].toLowerCase();

    }

    state.whyTrace.push({

      timestamp: new Date().toISOString(),

      stage: "OBSERVE",

      action: "Initial Environment & Screen Observation",

      observed: "Inspecting current desktop, active window, and visible screen state.",

      decision: "Perceiving current state before formulating multi-step plan.",

    });



    let initialScreenAnalysis = isBackground ? "Background execution mode active." : "Desktop visible.";

    const needsInitialScreen =
      !isBackground &&
      /\b(screen|dekh|see|look|visible|analyze|read\s+this|what'?s\s+on|chart|error)\b/i.test(objective);

    try {

      if (needsInitialScreen) {

        const initialScreen = await captureScreen(0);

        if (initialScreen.success && initialScreen.data?.analysis) {

          initialScreenAnalysis = initialScreen.data.analysis;

        }

      }

    } catch (err: any) {

      console.warn(`[AutonomousGoalExecutor] Screen capture warning: ${err.message}`);

    }



    // ── STAGE 2: PLAN MULTI-STEP EXECUTION STRATEGY ───────────────────────

    broadcast({

      type: "goalPlanning",

      goalId,

      objective,

      message: `Analyzing objective and formulating step-by-step strategy for: "${objective}"...`,

    });



    const plannedSteps = await this.planGoal(objective, initialScreenAnalysis, isBackground);

    state.steps = plannedSteps;

    state.status = "EXECUTING";



    state.whyTrace.push({

      timestamp: new Date().toISOString(),

      stage: "PLAN",

      action: "Formulate Autonomous Plan",

      observed: `Generated ${plannedSteps.length} discrete execution steps.`,

      decision: `Plan breakdown: ${plannedSteps.map(s => `[${s.step_number}] ${s.title}`).join(" -> ")}`,

    });



    broadcast({

      type: "goalPlanCreated",

      goalId,

      objective,

      steps: plannedSteps,

      totalSteps: plannedSteps.length,

    });



    // ── STAGE 3: PERSISTENT EXECUTION LOOP (AGENTIC LOOP) ─────────────────

    let completedStepsCount = 0;



    for (let i = 0; i < state.steps.length; i++) {

      if (this.stoppedGoals.has(goalId)) {

        state.status = "STOPPED";

        break;

      }



      state.currentStepIndex = i;

      const step = state.steps[i];

      step.status = "RUNNING";



      // Dynamically interpolate variables from previous steps into parameters

      if (state.contextMemory) {

        step.params = this.interpolateParams(step.params || {}, state.contextMemory);

      }



      if (step.params?.app_name) {

        targetAppName = step.params.app_name;

      } else if (step.params?.name) {

        targetAppName = step.params.name;

      }



      console.log(`[AutonomousGoalExecutor] [Step ${step.step_number}/${state.steps.length}] ${step.title}`);



      broadcast({

        type: "goalStepStart",

        goalId,

        stepNumber: step.step_number,

        totalSteps: state.steps.length,

        title: step.title,

        description: step.description,

        action: step.action,

        params: step.params,

        expectedOutcome: step.expected_outcome,

      });



      state.whyTrace.push({

        timestamp: new Date().toISOString(),

        stage: "ACT",

        action: `Step ${step.step_number}: ${step.title}`,

        observed: `Target action: '${step.action}' with parameters: ${JSON.stringify(step.params)}`,

        decision: `Executing step to achieve: ${step.expected_outcome}`,

      });



      const actLower = (step.action || "").toLowerCase().trim();

      const isUIAction = ["open_app", "focus_window", "type_text", "press_key_combination", "click_screen", "click_element", "search_in_app", "scroll_screen", "send_whatsapp_message", "send_whatsapp_to_multiple"].includes(actLower);

      const focusKey = (app?: string) => String(app || "").toLowerCase().trim();
      const wasRecentlyFocused = (app?: string) => {
        const key = focusKey(app);
        return (
          Boolean(key) &&
          state.contextMemory?._focusedApp === key &&
          Date.now() - Number(state.contextMemory?._focusedAt || 0) < 3500
        );
      };

      // Auto-focus the target window before input actions (ONLY if NOT in background mode)

      if (!isBackground && ["type_text", "click_screen", "press_key_combination"].includes(actLower)) {

        const lastAppStep = state.steps.slice(0, i).reverse().find(

          (s) => s.action === "open_app" || (s.action === "open_browser" && s.params?.url)

        );

        const focusTarget = step.params?.app_name || (lastAppStep?.params?.app_name) || null;

        if (focusTarget && focusTarget !== "chrome" && focusTarget !== "browser" && !wasRecentlyFocused(focusTarget)) {

          try {

            const fRes = await executeAgentCommand("focus_window", { app_name: focusTarget });

            if (fRes?.success && state.contextMemory) {
              state.contextMemory._focusedApp = focusKey(focusTarget);
              state.contextMemory._focusedAt = Date.now();
            }

            await new Promise((r) => setTimeout(r, 300));

          } catch (_) {}

        }

      }



      // ── Execute Action (with Serial UI Mutex Lock to avoid PyAutoGUI collisions) ──

      let actionResult: any;

      if (actLower === "focus_window" && !isBackground && wasRecentlyFocused(step.params?.app_name || step.params?.name || targetAppName)) {
        actionResult = { success: true, message: `Window '${step.params?.app_name || targetAppName}' already focused.` };
      } else if (isUIAction && !isBackground) {

        actionResult = await AutonomousGoalExecutor.acquireUILock(async () => {

          return await this.executeStepAction(step, isBackground, targetAppName);

        });

      } else {

        actionResult = await this.executeStepAction(step, isBackground, targetAppName);

      }

      step.result = actionResult;



      // Update Context Memory for subsequent multi-step chaining

      if (!state.contextMemory) state.contextMemory = {};

      if (actionResult?.success && actLower === "open_app" && actionResult?._focused) {
        state.contextMemory._focusedApp = focusKey(step.params?.app_name || step.params?.name || targetAppName);
        state.contextMemory._focusedAt = Date.now();
      } else if (actionResult?.success && actLower === "focus_window") {
        state.contextMemory._focusedApp = focusKey(step.params?.app_name || step.params?.name || targetAppName);
        state.contextMemory._focusedAt = Date.now();
      }

      state.contextMemory["last_result"] = actionResult;

      state.contextMemory[`step_${step.step_number}_result`] = actionResult;

      state.contextMemory[`step_${step.step_number}_output`] = actionResult?.output || actionResult?.stdout || actionResult?.message || (typeof actionResult === "string" ? actionResult : JSON.stringify(actionResult));



      // Dynamic Settle time for GUI/system animations and page renders

      const isWhatsApp = actLower.includes("whatsapp");

      const isAppOpen = actLower === "open_app";

      const settleMs = isBackground
        ? 120
        : isWhatsApp
          ? 1200
          : isAppOpen
            ? 700
            : actLower === "wait"
              ? 0
              : 250;

      if (settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }



      // Fast-track verification for deterministic actions when execution reported success
      // (avoids expensive Vision + Gemini LLM verification on every single typing/focus/click/open step)
      const FAST_VERIFIABLE_ACTIONS = new Set([
        "background_type",
        "background_click",
        "background_send_keys",
        "background_close_window",
        "inspect_background_app",
        "open_app",
        "open_browser",
        "close_browser",
        "focus_window",
        "type_text",
        "press_key_combination",
        "press_key",
        "presskeycombination",
        "click_screen",
        "click",
        "click_element",
        "search_in_app",
        "scroll_screen",
        "scroll",
        "search_file",
        "open_file",
        "edit_file_at_path",
        "run_terminal_command",
        "create_or_write_file",
        "read_file_content",
        "http_request",
        "send_whatsapp_message",
        "whatsapp_send",
        "send_whatsapp_to_multiple",
        "whatsapp_send_multiple",
        "build_website_app",
        "build_software_app",
        "preview_website_app",
        "order_food",
        "order_food_autonomous",
        "wait",
      ]);

      if (!actionResult?.success && (actLower === "order_food" || actLower === "order_food_autonomous")) {
        step.status = "FAILED";
        step.verification = {
          verified: false,
          explanation: actionResult?.message || "Food ordering could not be completed within the specified budget.",
        };
        state.status = "FAILED";
        state.error = actionResult?.message || "Food ordering failed.";
        break;
      }

      if (actionResult?.success && FAST_VERIFIABLE_ACTIONS.has(actLower)) {

        step.verification = {

          verified: true,

          explanation: actionResult.message || "Action executed successfully.",

        };

        step.status = "COMPLETED";

        completedStepsCount++;

        state.whyTrace.push({

          timestamp: new Date().toISOString(),

          stage: "VERIFY",

          action: `Verify Step ${step.step_number}`,

          observed: actionResult.message || "Action executed successfully.",

          decision: `Instantly verified: ${step.expected_outcome}`,

        });

        broadcast({

          type: "goalStepCompleted",

          goalId,

          stepNumber: step.step_number,

          totalSteps: state.steps.length,

          title: step.title,

          verification: step.verification.explanation,

        });

        continue;

      }



      // ── STAGE 4: OBSERVE & VERIFY STEP OUTCOME (VISION VERIFICATION) ──────

      state.status = "VERIFYING";

      let stepScreenAnalysis = "";

      try {

        const targetApp = step.params?.app_name || step.params?.name || step.params?.target_app || targetAppName;

        if (isBackground && targetApp) {

          const bgAct = await getBackgroundActivity(targetApp);

          if (bgAct.success && bgAct.activity) {

            stepScreenAnalysis = `[BACKGROUND APP STATE: ${targetApp}]\n${bgAct.activity}`;

          } else {

            const bgCap = await captureBackgroundApp(targetApp, true);

            if (bgCap.success && bgCap.output) {

              stepScreenAnalysis = `[BACKGROUND APP VISUAL VERIFICATION: ${targetApp}]\n${bgCap.output}`;

            }

          }

        } else if (!isBackground) {

          const postCapture = await captureScreen(300);

          if (postCapture.success && postCapture.data?.analysis) {

            stepScreenAnalysis = postCapture.data.analysis;

          }

        }

      } catch (e) {}



      const verification = await this.verifyStepOutcome(step, actionResult, stepScreenAnalysis);

      step.verification = verification;



      if (verification.verified) {

        step.status = "COMPLETED";

        completedStepsCount++;



        state.whyTrace.push({

          timestamp: new Date().toISOString(),

          stage: "VERIFY",

          action: `Verify Step ${step.step_number}`,

          observed: stepScreenAnalysis || "Action completed with success status.",

          decision: `Verified: ${verification.explanation}`,

        });



        broadcast({

          type: "goalStepCompleted",

          goalId,

          stepNumber: step.step_number,

          totalSteps: state.steps.length,

          title: step.title,

          verification: verification.explanation,

        });

      } else {

        // ── STAGE 5: SELF-HEALING / RECOVERY ATTEMPT ──────────────────────

        console.warn(`[AutonomousGoalExecutor] Step ${step.step_number} verification unconfirmed: ${verification.explanation}. Attempting self-healing...`);

        step.status = "RETRYING";



        state.whyTrace.push({

          timestamp: new Date().toISOString(),

          stage: "RECOVER",

          action: `Self-Healing Recovery on Step ${step.step_number}`,

          observed: `Verification did not fully confirm expected outcome: ${verification.explanation}`,

          decision: "Applying adaptive remediation (re-focusing window / retry action).",

        });



        // Perform adaptive remediation - first re-focus the target window

        const healAppStep = state.steps.slice(0, i).reverse().find(

          (s) => s.action === "open_app"

        );

        const healFocusTarget = step.params?.app_name || healAppStep?.params?.app_name || null;

        if (healFocusTarget && !isBackground) {

          try {

            await executeAgentCommand("focus_window", { app_name: healFocusTarget });

            await new Promise((r) => setTimeout(r, 600));

          } catch (_) {}

        }

        await this.applySelfHealingRemedy(step, stepScreenAnalysis);

        await new Promise((resolve) => setTimeout(resolve, 1500));



        // Re-verify

        const postHealCapture = await captureScreen(300);

        const secondAnalysis = postHealCapture.data?.analysis || "";

        const secondVer = await this.verifyStepOutcome(step, actionResult, secondAnalysis);



        if (secondVer.verified) {

          step.status = "COMPLETED";

          step.verification = secondVer;

          completedStepsCount++;

          broadcast({

            type: "goalStepCompleted",

            goalId,

            stepNumber: step.step_number,

            totalSteps: state.steps.length,

            title: step.title,

            verification: `Self-healed & verified: ${secondVer.explanation}`,

          });

        } else {

          // If critical (default true), mark as FAILED and report honest outcome

          const isCritical = step.critical !== false;

          if (isCritical) {

            step.status = "FAILED";

            step.verification = secondVer;

            state.whyTrace.push({

              timestamp: new Date().toISOString(),

              stage: "ACT",

              action: `Step ${step.step_number} Failed`,

              observed: `Step execution failed after recovery: ${secondVer.explanation}`,

              decision: "Step marked as FAILED. Maintaining execution truthfulness.",

            });

            broadcast({

              type: "goalStepFailed",

              goalId,

              stepNumber: step.step_number,

              totalSteps: state.steps.length,

              title: step.title,

              error: secondVer.explanation,

            });

          } else {

            step.status = "COMPLETED_WITH_WARNING";

            step.verification = secondVer;

            completedStepsCount++;

            broadcast({

              type: "goalStepCompleted",

              goalId,

              stepNumber: step.step_number,

              totalSteps: state.steps.length,

              title: step.title,

              verification: `Proceeded with warning: ${secondVer.explanation}`,

            });

          }

        }

      }

    }



    // ── STAGE 6: GOAL COMPLETION & FINAL HONEST SUMMARY ──────────────────

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    state.completedTime = Date.now();



    const failedSteps = state.steps.filter((s) => s.status === "FAILED");

    const completedSteps = state.steps.filter((s) => s.status === "COMPLETED");

    const warningSteps = state.steps.filter((s) => s.status === "COMPLETED_WITH_WARNING");

    const totalCount = state.steps.length;



    const isSuccess = state.status !== "STOPPED" && failedSteps.length === 0 && (completedSteps.length + warningSteps.length) > 0;

    const isPartial = !isSuccess && state.status !== "STOPPED" && (completedSteps.length + warningSteps.length) > 0 && failedSteps.length > 0;



    state.status = isSuccess ? "COMPLETED" : (isPartial ? "COMPLETED_WITH_WARNING" : (state.status === "STOPPED" ? "STOPPED" : "FAILED"));



    let summary = "";

    if (isSuccess) {

      summary = `Goal successfully achieved: "${objective}". All ${totalCount} planned steps completed in ${durationSeconds} seconds.`;

    } else if (isPartial) {

      const succNames = completedSteps.concat(warningSteps).map(s => `Step ${s.step_number} (${s.title})`).join(", ");

      const failNames = failedSteps.map(s => `Step ${s.step_number} (${s.title}: ${s.verification?.explanation || "failed"})`).join("; ");

      summary = `Goal partially completed: "${objective}". Succeeded (${completedSteps.length + warningSteps.length}/${totalCount}): [${succNames}]. Failed (${failedSteps.length}/${totalCount}): [${failNames}]. Duration: ${durationSeconds}s.`;

    } else if (state.status === "STOPPED") {

      summary = `Goal stopped by user: "${objective}". Completed ${completedSteps.length}/${totalCount} steps before halting.`;

    } else {

      const failReasons = failedSteps.map(s => `${s.title}: ${s.verification?.explanation || "execution error"}`).join("; ");

      summary = `Goal execution failed: "${objective}". Failed steps: [${failReasons}]. Duration: ${durationSeconds}s.`;

    }



    state.finalReport = {

      summary,

      completedStepsCount: completedSteps.length + warningSteps.length,

      failedStepsCount: failedSteps.length,

      totalStepsCount: totalCount,

      durationSeconds,

      itemizedDetails: state.steps.map(s => ({

        stepNumber: s.step_number,

        title: s.title,

        status: s.status,

        explanation: s.verification?.explanation || ""

      }))

    };



    state.whyTrace.push({

      timestamp: new Date().toISOString(),

      stage: "COMPLETE",

      action: "Final Goal Synthesis",

      observed: `${completedSteps.length + warningSteps.length}/${totalCount} steps achieved, ${failedSteps.length} failed.`,

      decision: summary,

    });



    broadcast({

      type: "goalCompleted",

      goalId,

      objective,

      status: state.status,

      success: isSuccess,

      summary,

      durationSeconds,

      whyTrace: state.whyTrace,

    });



    console.log(`\n======================================================`);

    console.log(`[AutonomousGoalExecutor] Goal finished: ${summary}`);

    console.log(`======================================================\n`);



    const finalResult: GoalExecutionResult = {

      success: isSuccess,

      goalId,

      objective,

      status: state.status,

      message: summary,

      stepsCount: state.steps.length,

      completedStepsCount,

      durationSeconds,

      summary,

      whyTrace: state.whyTrace,

    };

    try {
      options?.onComplete?.(finalResult);
    } catch {}

    return finalResult;

  }



  /**

   * Plans the sequence of steps for any high-level objective using Gemini AI.

   */

  private async planGoal(objective: string, screenContext: string, isBackground: boolean = false): Promise<GoalStep[]> {

    // Deterministic zero-latency planner for clear app+action / WhatsApp / Email / Notepad patterns
    const fastDeterministicSteps = this.heuristicPlan(objective, isBackground, false);
    if (fastDeterministicSteps.length > 0) {
      console.log(`[AutonomousGoalExecutor] Fast deterministic plan (${fastDeterministicSteps.length} steps) matched for "${objective}".`);
      return fastDeterministicSteps;
    }

    try {

      const ai = this.getGeminiAiClient();

      const prompt = `You are ERA's Master Autonomous Computer Agent.

The boss has given you the following high-level objective to achieve autonomously on Windows:



OBJECTIVE:

"${objective}"



CURRENT DESKTOP / SCREEN CONTEXT:

${screenContext}



NEW OPERATIONAL PROTOCOL (MANDATORY):

1. PERSISTENT LONG-TERM EXECUTION: Plan and iterate systematically until the complete objective is achieved, without timing out. Break complex tasks down into clear, robust milestones.

2. EXTERNAL FEEDBACK OBSERVATION: If the task involves interacting with an AI/chatbot, dealing with system prompts, waiting for compiling/loading, or receiving terminal output, actively observe the response, analyze the input, and dynamically formulate the next logical response or action using 'observe_and_reply' or 'wait_for_response'.

3. CONTINUOUS SELF-CORRECTION & ADAPTATION: Anticipate potential state changes or errors, and specify precise expected outcomes so visual verification can detect deviations and trigger self-healing.

4. CONFIRMATION AWARENESS: Distinguish safe automated operations (e.g., launching, navigating, observing, drafting) from final destructive or irreversible actions.



AVAILABLE ATOMIC ACTIONS:
- open_app: { "app_name": string } (e.g. "chrome", "notepad", "calculator", "vscode", "whatsapp", "calc", "explorer")
- open_browser: { "url": string } (opens a web URL directly in default browser)
- close_browser: {} (closes active browser tab/window)
- run_terminal_command: { "command": string } (CRITICAL: runs PowerShell or CMD commands directly with stdout/stderr capture; use for builds, scripts, git, installs, automations)
- create_or_write_file: { "filepath": string, "content": string } (CRITICAL: writes code, scripts, config, markdown or data files to disk)
- read_file_content: { "filepath": string } (reads content of any file into memory for subsequent steps via {{last_result}})
- http_request: { "url": string, "method": "GET"|"POST", "body"?: any } (performs HTTP request to web APIs or endpoints)
- type_text: { "text": string } (types text letter-by-letter or pastes unicode into active cursor focus)
- press_key_combination: { "keys": string[] } (e.g. ["enter"], ["ctrl", "s"], ["ctrl", "c"], ["ctrl", "v"], ["alt", "tab"], ["esc"])
- click_screen: { "x": number, "y": number, "normalized"?: boolean } (clicks mouse at pixel coordinates, or 0..1000 when normalized=true)
- click_element: { "target": string, "app_name"?: string } (CRITICAL: uses AI Vision to find and click any visual button/search box/input field on screen, e.g. { "target": "search bar input box", "app_name": "canva" })
- search_in_app: { "app_name": string, "query": string, "press_enter"?: boolean } (CRITICAL: focuses the app, locates/focuses its search or prompt bar automatically, types the query, and submits Enter. ALWAYS prefer this after open_app+focus_window when searching or prompting inside an app!)
- scroll_screen: { "clicks": number } (scrolls mouse up/down)
- search_file: { "query": string } (searches disk for files)
- open_file: { "filename": string } (opens a file with default editor)
- edit_file_at_path: { "filepath": string, "oldText": string, "newText": string } (edits code/text file)
- submit_autonomous_goal: { "goal": string } (calls full Outcome Engine to build code/web apps on port 8080)
- wait: { "seconds": number } (waits for async loading, rendering, or animations)
- wait_for_response: { "seconds": number } (waits for external chatbot, compiler, or system response to appear)
- observe_and_reply: { "target_app": string, "prompt_instruction": string } (CRITICAL: actively observes external feedback from chatbot/terminal/system on screen, analyzes the message, and formulates & types the next logical response)
- focus_window: { "app_name": string } (CRITICAL: brings app window to foreground BEFORE typing/clicking to prevent focus-stealing - always add this step before type_text steps)
- background_type: { "app_name": string, "text": string, "press_enter": boolean } (SILENT: types directly into background window without bringing it to the front or stealing focus)
- background_click: { "app_name": string, "x": number, "y": number, "element_text": string } (SILENT: clicks background window or button without bringing to front)
- background_send_keys: { "app_name": string, "keys": string[] } (SILENT: sends keystrokes like ["enter"] or ["ctrl", "s"] to background window)
- capture_background_app: { "app_name": string } (SILENT: observes background window state using Win32 PrintWindow)
- inspect_background_app: { "app_name": string } (SILENT: inspects background window controls and text)
- background_close_window: { "app_name": string } (SILENT: closes background window)
- send_whatsapp_message: { "contact": string, "message": string } (sends a WhatsApp message to a contact name or phone number)
- send_whatsapp_to_multiple: { "recipients"?: Array<{ "contact": string, "message": string }>, "contacts"?: string[], "message"?: string } (sends WhatsApp messages to multiple contacts sequentially — supports distinct message per recipient via recipients array)
- build_website_app: { "prompt": string, "project_name": string, "auto_preview": boolean } (CRITICAL: autonomously creates, codes, and launches production-grade websites, web apps, SaaS dashboards, or software from scratch like Antigravity/Emergent AI and Google AI Studio)
- preview_website_app: { "project_id": string, "url": string } (opens interactive live preview of synthesized software/website in Studio and browser)
- order_food: { "dish": string, "max_budget"?: number, "min_budget"?: number, "platform"?: "swiggy"|"zomato"|"auto", "city"?: string } (CRITICAL: autonomously searches Swiggy or Zomato for any dish within budget range, evaluates menu prices, picks matching dish, adds to cart, and navigates to checkout)

Generate a precise, ordered JSON array of execution steps to achieve this objective from start to finish.

Keep each step focused, atomic, and clear.

CRITICAL FOR OPENING AN APP AND SEARCHING/TYPING INSIDE IT: Whenever the user wants to open an app and search/type a prompt inside it (e.g. Canva, ChatGPT, Spotify, Chrome, File Explorer, Settings), plan: Step 1 open_app(app_name), Step 2 focus_window(app_name), Step 3 search_in_app({ app_name, query, press_enter: true }) (or click_element + type_text + press_key_combination(["enter"])). NEVER plan bare type_text immediately after open_app for rich UI apps without focusing the search/input bar!

CRITICAL FOR MULTI-CONTACT MESSAGING: When sending messages to multiple contacts or people, ALWAYS decompose the task into separate sequential steps using action 'send_whatsapp_message' (one step per contact: Step 1 -> Contact 1, Step 2 -> Contact 2, etc.). If different people must receive DIFFERENT messages, preserve EACH person's exact distinct message on their step — NEVER reuse or copy one person's message to another contact!

Return ONLY valid JSON (enclosed in \`\`\`json ... \`\`\`):



\`\`\`json

{

  "steps": [

    {

      "step_number": 1,

      "title": "Short title",

      "description": "Clear step description",

      "action": "action_name",

      "params": { ... },

      "expected_outcome": "Specific visual or system state expected after this step"

    }

  ]

}

\`\`\``;



      const text = await this.generateWithModelFallback(this.getFastTextModels(), prompt, 10000);

      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];

      const parsed = JSON.parse(jsonMatch[1] ? jsonMatch[1].trim() : text.trim());



      if (parsed?.steps && Array.isArray(parsed.steps) && parsed.steps.length > 0) {

        return parsed.steps.map((s: any, idx: number) => ({

          step_number: s.step_number || idx + 1,

          title: s.title || `Step ${idx + 1}`,

          description: s.description || s.title || `Execute ${s.action}`,

          action: s.action || "wait",

          params: s.params || {},

          expected_outcome: s.expected_outcome || "Action performed successfully",

          status: "PENDING" as const,

        }));

      }

    } catch (err: any) {

      console.warn(`[AutonomousGoalExecutor] LLM planning fallback triggered: ${err.message}`);

    }



    // Heuristic Fallback Planner

    return this.heuristicPlan(objective, isBackground);

  }



  /**

   * Deterministic heuristic planner if Gemini call fails or is offline.

   */

  private heuristicPlan(objective: string, isBackground: boolean = false, allowGenericFallback: boolean = true): GoalStep[] {

    const lower = objective.toLowerCase();

    const steps: GoalStep[] = [];



    // ── Helper to extract text between keywords ──────────────────────────────

    const extractMsg = (after: string[]): string => {

      for (const kw of after) {

        const idx = lower.indexOf(kw);

        if (idx !== -1) return objective.substring(idx + kw.length).trim().replace(/^['":]/, "").trim();

      }

      return objective;

    };



    const extractContacts = (): string[] => {
      const cleanContact = (c: string) => {
        return c.replace(/\b(ko|whatsapp|ji|keliye|par|per|se|message|msg|bhejo|likho|bhaiya)\b/gi, "").trim();
      };

      // 1. Matches "to X, Y and Z", "to X and Y", "to X aur Y", "to X or Y"
      const m1 = objective.match(/(?:to)\s+([A-Za-z0-9_\s]+?(?:,\s*[A-Za-z0-9_\s]+?)*(?:\s+(?:and|aur|or)\s+[A-Za-z0-9_\s]+?))(?:\s+(?:saying|with message|message|bhejo|likho|ko|:)|$)/i);
      if (m1 && (m1[1].includes(",") || /\b(and|aur|or)\b/i.test(m1[1]))) {
        return m1[1].split(/\s+(?:and|aur|or)\s+|,\s*/i).map(cleanContact).filter((c) => c.length > 1);
      }

      // 2. Matches "X aur Y ko ...", "X and Y ko ...", "X, Y, Z ko ..."
      const m2 = objective.match(/(?:whatsapp\s+(?:par|pe|per)\s+)?([A-Za-z0-9_\s]+?(?:,\s*[A-Za-z0-9_\s]+?)*(?:\s+(?:and|aur|or)\s+[A-Za-z0-9_\s]+?))\s+ko\b/i);
      if (m2 && (m2[1].includes(",") || /\b(and|aur|or)\b/i.test(m2[1]))) {
        return m2[1].split(/\s+(?:and|aur|or)\s+|,\s*/i).map(cleanContact).filter((c) => c.length > 1 && !/^(send|karo|bhejo|message|ek|sath|unko|sab)$/i.test(c));
      }

      // 3. Matches "X, Y, Z ko" without and/aur/or (comma separated list with 'ko')
      const mCommaKo = objective.match(/([A-Za-z0-9_\s,]+?)\s+ko\s+(?:message|whatsapp|bhejo|msg)/i);
      if (mCommaKo && mCommaKo[1].includes(",")) {
        return mCommaKo[1].split(/,\s*/).map(cleanContact).filter((c) => c.length > 1 && !/^(send|karo|bhejo|message|ek|sath|unko|sab)$/i.test(c));
      }

      // Fallback: standard "to X and Y"
      const m3 = objective.match(/to\s+([^:]+?)(?:\s+(?:saying|with message|message|likho|bhejo|:)|$)/i);
      if (m3) {
        return m3[1].split(/\s+(?:and|aur|or)\s+|,\s*/i).map(cleanContact).filter(Boolean);
      }
      return [];
    };

    // ── 0A. AUTONOMOUS FOOD ORDERING (ZOMATO / SWIGGY) ──────────────────────────
    const isFoodOrder =
      /(?:order.*(?:food|khana|biryani|pizza|burger|roll|paneer|thali|momo|dish|pasta|sandwich|chowmein|noodles|dosa)|(?:zomato|swiggy).*(?:order|se|par|karo|mangwa|mangao)|(?:mangwa|mangao|mangva).*(?:do|khana|biryani|pizza|burger|food|dish)|khana.*order|(?:cheez|dish|kuch\s+khane).*order|kuch\s+order\s*(?:karo|kar\s*do|karna)|order\s*(?:karo|kar\s*do))/i.test(
        lower
      );

    if (isFoodOrder) {
      // Extract quantity
      let quantity = 1;
      const mQtyWord = lower.match(/\b(ek|do|teen|chaar|paanch|chheh|saat|aath|nau|das)\b/i);
      const wordToNum: Record<string, number> = { ek: 1, do: 2, teen: 3, chaar: 4, paanch: 5, chheh: 6, saat: 7, aath: 8, nau: 9, das: 10 };
      if (mQtyWord && wordToNum[mQtyWord[1].toLowerCase()]) {
        quantity = wordToNum[mQtyWord[1].toLowerCase()];
      } else {
        const mQtyDigit = lower.match(/\b([1-9]|10)\s*(?:x|quantity|piece|pieces|plate|burger|pizza|biryani|roll|sandwich|thali|momo|dosa)?\b/i);
        if (mQtyDigit && mQtyDigit[1]) {
          const val = parseInt(mQtyDigit[1], 10);
          if (val >= 1 && val <= 10) quantity = val;
        }
      }

      let dish = "burger";
      const dishKeywords = [
        "chicken dum biryani", "hyderabadi biryani", "mutton biryani", "chicken biryani", "veg biryani", "biryani",
        "paneer butter masala", "kadhai paneer", "shahi paneer", "butter paneer", "paneer",
        "margherita pizza", "cheese pizza", "farmhouse pizza", "veg pizza", "chicken pizza", "pizza", "pizzas",
        "crispy chicken burger", "crispy veg burger", "chicken burger", "veg burger", "cheese burger", "burger", "burgers",
        "dal makhani", "dal tadka", "special thali", "veg thali", "non veg thali", "thali",
        "paneer roll", "chicken roll", "egg roll", "kathi roll", "veg roll", "roll", "rolls", "wrap",
        "steamed momos", "fried momos", "veg momos", "chicken momos", "kurkure momos", "momos", "momo",
        "white sauce pasta", "red sauce pasta", "pasta",
        "grilled sandwich", "cheese sandwich", "veg sandwich", "sandwich", "sandwiches",
        "hakka noodles", "veg chowmein", "chicken chowmein", "chowmein", "noodles",
        "veg fried rice", "chicken fried rice", "fried rice",
        "masala dosa", "plain dosa", "mysore masala dosa", "dosa", "idli",
        "chole bhature", "pav bhaji", "vada pav", "samosa", "kachori", "jalebi", "gulab jamun",
        "garlic bread", "french fries", "fries", "paratha", "roti", "naan",
        "ice cream", "dessert", "cold coffee", "shake", "cake", "pastry"
      ];
      for (const dk of dishKeywords) {
        if (lower.includes(dk)) {
          dish = dk;
          break;
        }
      }
      if (dish === "burger" && !lower.includes("burger")) {
        const mDish = objective.match(/(?:mere\s+liye\s+)?([a-zA-Z\s]{2,30}?)\s+(?:order\s+(?:karo|kar\s+do|karna)|mangwa\s+do|mangao)/i) ||
                      objective.match(/(?:order\s+(?:karo\s+)?|mangwa\s+do\s+|mangao\s+|chahiye\s+)(?:mere\s+liye\s+)?([a-zA-Z\s]{2,30}?)(?:\s+(?:under|range|mein|mai|me|budget|amount|zomato|swiggy|ke\s+andar|se|par|\d+)|$)/i);
        if (mDish && mDish[1].trim()) {
          const candidate = mDish[1].replace(/\b(mere|liye|koi|bhi|ek|swiggy|zomato|se|par|karo|bhaiya|kuch|kisi|khana|jo|maine|bola|kaha|hai|itni|range|mai|me|mein|ho|usko|apne|aap|autonoumas|agent|ki|help|sai|order|mangwa|mangao|do|chahiye|bolunga|perticular|dish|uska|kitni|ki|website|khole|serch|find|kare|dheke|kya|utni|fir|bass|mari|single|command|per|fix|ammount|amount|diya|but|har|bar|is|hi|mount|show|karta|kitna|kyu|na|bol|range|mai|hi|serch|kare|or|nolu|bina)\b/gi, "").trim();
          if (candidate.length > 2) dish = candidate;
        }
      }

      let maxBudget: number | undefined = undefined;
      let minBudget: number | undefined = undefined;

      const mRange = lower.match(/(?:between|se)\s*(\d+)\s*(?:to|aur|and|se)\s*(\d+)/i) || lower.match(/(\d+)\s*(?:se|-)\s*(\d+)/i);
      if (mRange) {
        minBudget = Number(mRange[1]);
        maxBudget = Number(mRange[2]);
      } else {
        const mMax = lower.match(/(?:under|upto|below|less than|max|maximum|budget|range|limit|around|approx)\s*(?:rs\.?|₹|rupaye|rupees)?\s*(\d+)/i) ||
                     lower.match(/(\d+)\s*(?:rs\.?|₹|rupaye|rupees|inr)?\s*(?:tak|ke andar|andar|ke beech|se kam|below|under|me|mein|mai|ka|ke|ki|wala|wali|wale)/i) ||
                     lower.match(/(?:rs\.?|₹)\s*(\d+)/i) ||
                     lower.match(/(\d+)\s*(?:rs|rupaye|rupees|inr)\b/i) ||
                     lower.match(/(?:range|budget|amount)\s*(?:mai|me|mein|ka|ke)?\s*(?:ho\s*)?(\d+)/i) ||
                     lower.match(/(?:^|\s)(\d{2,4})\s*(?:ka|ke|ki|wala|wali|wale|me|mein|mai|tak|andar)\b/i);
        if (mMax && mMax[1]) {
          maxBudget = Number(mMax[1]);
        } else {
          // Fallback: look for any isolated 2-4 digit number (e.g., 60, 100, 150, 200, 300, 400)
          const mNum = lower.match(/\b([5-9]\d|[1-9]\d{2,3})\b/);
          if (mNum) {
            maxBudget = Number(mNum[1]);
          }
        }
      }

      let platform = "swiggy";
      const hasZomato = lower.includes("zomato") || lower.includes("zumato") || lower.includes("zomoto");
      const hasSwiggy = lower.includes("swiggy") || lower.includes("swiggi") || lower.includes("swigy") || lower.includes("swigi");
      if (hasZomato && hasSwiggy) {
        platform = "auto";
      } else if (hasZomato) {
        platform = "zomato";
      } else {
        platform = "swiggy";
      }

      // Extract delivery location
      let deliveryLocation: string | undefined = undefined;
      const mLocExplicit = lower.match(/(?:location|address|jagah)\s*[:=]?\s*([a-zA-Z0-9\s,]{3,40}?)(?:\s+(?:pe|par|per|me|mein|se|under|tak|budget|cash|cod|order)|$)/i);
      const mLocPrep = lower.match(/(?:at|near|pe|par|per|me|mein)\s+([a-zA-Z0-9\s,]{3,35}?)(?:\s+(?:par|pe|per|me|mein|order|delivery|mangwao|bhejo)|$)/i);
      if (mLocExplicit && mLocExplicit[1]) {
        deliveryLocation = mLocExplicit[1].trim();
      } else if (mLocPrep && mLocPrep[1]) {
        const candidateLoc = mLocPrep[1].replace(/\b(mere|liye|koi|bhi|swiggy|zomato|se|par|karo|bhaiya|cash|delivery|cod|order)\b/gi, "").trim();
        if (candidateLoc.length > 2 && !candidateLoc.includes(dish)) {
          deliveryLocation = candidateLoc;
        }
      }

      // Check payment method (default to 'cod' / Cash on Delivery as requested)
      let paymentMethod = "cod";
      if (lower.includes("online") || lower.includes("upi") || lower.includes("card") || lower.includes("netbanking")) {
        paymentMethod = "online";
      }

      const autoOrder = lower.includes("order") || lower.includes("mangwa") || lower.includes("buy") || lower.includes("kharid");

      steps.push({
        step_number: 1,
        title: `Order ${quantity > 1 ? `${quantity}x ` : ""}${dish} on ${platform.toUpperCase()} with Cash on Delivery`,
        description: `Autonomously search ${platform === "auto" ? "Swiggy / Zomato" : platform} for '${dish}' (Qty: ${quantity}) within price range (Max: ₹${maxBudget || "best value"}), use PC live location (${deliveryLocation || "live location"}), add to cart, and select Cash on Delivery checkout.`,
        action: "order_food",
        status: "pending",
        params: {
          dish,
          quantity,
          max_budget: maxBudget,
          min_budget: minBudget,
          platform,
          location: deliveryLocation,
          city: deliveryLocation,
          payment_method: paymentMethod,
          auto_order: autoOrder,
          headless: false,
        },
        expected_outcome: `'${dish}' (Qty: ${quantity}) found within price range on ${platform.toUpperCase()}, added to cart, and Cash on Delivery order checkout prepared for ${deliveryLocation || "live location"}.`,
      });

      return steps;
    }

    // ── 0. AUTONOMOUS SOFTWARE & WEBSITE SYNTHESIS ──────────────────────────

    if (/(?:website|software|web\s*app|app\s*banao|banao|build\s*(?:website|app|game|software)|create\s*(?:website|app|game|software)|make\s*(?:website|app|game|software)|portfolio|dashboard|landing\s*page|game\s*banao|snake|runner)/i.test(lower)) {

      steps.push({

        step_number: 1,

        title: "Autonomously Code Production Software & Website",

        description: `Synthesize complete production-grade application for: ${objective}`,

        action: "build_website_app",

        params: { prompt: objective, auto_preview: true },

        expected_outcome: "Application code synthesized and materialized to disk.",

        status: "PENDING",

      });

      steps.push({

        step_number: 2,

        title: "Launch Interactive Live Preview",

        description: "Serve application and open interactive live preview for the user",

        action: "preview_website_app",

        params: { url: "/api/studio/preview/latest/index.html" },

        expected_outcome: "Live preview accessible in browser and Studio UI.",

        status: "PENDING",

      });

      return steps;

    }



    // ── 1. WHATSAPP — sequential multi-contact (supports distinct per-recipient messages) ────

    const extractPerRecipientWhatsAppPairs = (): Array<{ contact: string; message: string }> => {
      if (!/\b(?:whatsapp|bhejo|send|message|msg|likho|karo)\b/i.test(lower)) return [];

      let cleanedObj = objective
        .replace(/^(?:please\s+|bhai\s+)?(?:send\s+(?:different\s+messages?\s+(?:to\s+)?)?|whatsapp\s+(?:par|pe|per|on)\s+)/i, "")
        .replace(/\s+(?:on\s+whatsapp|in\s+whatsapp|via\s+whatsapp|on\s+wa)\s*$/i, "")
        .trim();

      const segments = cleanedObj
        .split(/\s*(?:;|,(?!\s*(?:bhejo|likho|karo|send)\s*$)|\b(?:and|aur)\b)\s*/i)
        .map((s) => s.trim())
        .filter(Boolean);

      if (segments.length < 2) return [];

      const pairs: Array<{ contact: string; message: string }> = [];
      for (const seg of segments) {
        let m =
          // "Rahul ko bolo kal milte hain" / "Aman ko hello bhejo"
          seg.match(/^(?:whatsapp\s+(?:par|pe|per)\s+)?([A-Za-z0-9_. +()-]{2,35}?)\s+ko\s+(?:(?:bolo|kaho)(?:\s+ki)?\s+|(?:message|msg)\s+(?:karo|bhejo|likho)\s+)?(.+?)(?:\s+(?:bhejo|likho|likh\s*do|karo|send\s*karo|message\s*bhejo))?$/i) ||
          // "to Rahul saying hello" / "to Rahul message: hello"
          seg.match(/^(?:send\s+(?:to\s+)?|to\s+)([A-Za-z0-9_. +()-]{2,35}?)\s+(?:saying|with\s+message|message|msg|:)\s+(.+)$/i) ||
          // "send 'hello' to Rahul" / "hello to Rahul"
          seg.match(/^(?:send\s+)?["']?(.+?)["']?\s+to\s+([A-Za-z0-9_.+()-]{2,30})$/i) ||
          // "Rahul: hello" / "Rahul - hello"
          seg.match(/^([A-Za-z0-9_. ()-]{2,30}?)\s*[:\-]\s*(.+)$/);

        if (m) {
          const isReverseTo = /^(?:send\s+)?["']?.+?["']?\s+to\s+/i.test(seg);
          const rawContact = (isReverseTo ? m[2] : m[1]).replace(/^(?:whatsapp\s+(?:par|pe|per)|to|and|aur)\s+/i, "").trim();
          const rawMsg = (isReverseTo ? m[1] : m[2]).trim().replace(/^["']|["']$/g, "").trim();
          if (rawContact.length >= 2 && rawMsg.length >= 1 && !/^(?:bhejo|send|message|msg)$/i.test(rawContact)) {
            pairs.push({ contact: rawContact, message: rawMsg });
          }
        }
      }
      return pairs.length >= 2 ? pairs : [];
    };

    const perRecipientPairs = extractPerRecipientWhatsAppPairs();
    if (perRecipientPairs.length >= 2) {
      perRecipientPairs.forEach((pair, idx) => {
        steps.push({
          step_number: idx + 1,
          title: `Send WhatsApp message to ${pair.contact} (${idx + 1}/${perRecipientPairs.length})`,
          description: `Deliver personalized message to ${pair.contact}: "${pair.message}"`,
          action: "send_whatsapp_message",
          params: { contact: pair.contact, message: pair.message },
          expected_outcome: `Message "${pair.message}" delivered to ${pair.contact}`,
          status: "PENDING",
        });
      });
      return steps;
    }

    const isExplicitMulti =

      /\b(?:kisi\s*)?(\d+|five|ten|three|four|two)\s*(?:logo|log|people|contacts|persons)\b/i.test(lower) ||

      /(?:sab|sabhi|all|everyone|kafi\s*sare|multiple)\s*(?:logo|log|contacts|people)?(?:\s*ko)?/i.test(lower) ||

      /(?:send|bhejo|message)\s+(?:to\s+)?(?:all|everyone|multiple\s+contacts)/i.test(lower) ||

      /(?:send|bhejo|message)\s+(?:to\s+)?[A-Za-z]+\s+(?:and|aur)\s+[A-Za-z]+/i.test(lower) ||

      (/[A-Za-z]+\s+(?:and|aur)\s+[A-Za-z]+\s+ko\b/i.test(lower) && /\b(?:whatsapp|bhejo|message|msg|send|likho)\b/i.test(lower));



    if (isExplicitMulti) {

      let contacts = extractContacts();

      const countMatch = lower.match(/\b(?:kisi\s*)?(\d+)\s*(?:logo|log|people|contacts|persons)?\b/i);

      const requestedCount = countMatch ? parseInt(countMatch[1], 10) : 5;



      if (contacts.length === 0) {

        const namesMatch = objective.match(/(?:to|ko|karo|bhejo)\s*[:\-]?\s*([A-Za-z\s,]+)/i);

        if (namesMatch && namesMatch[1].includes(",")) {

          contacts = namesMatch[1].split(",").map(s => s.trim()).filter(Boolean);

        }

      }



      // If user requested count or general multi-person phrase ("kafi sare logo", "5 logo", "sabko"), get contacts from book

      if (contacts.length === 0) {

        const book = loadContacts();

        contacts = book.slice(0, requestedCount).map(c => c.name);

      }



      if (contacts.length > 0) {

        let message = extractMsg(["saying ", "message ", "msg ", "likho ", "bolo ", ": "]);

        if (message === objective) {
          const koTail = objective.match(/\bko\s+(?:(?:message|msg)\s+(?:bhejo|karo|likho)\s+)?(.+?)(?:\s+(?:bhejo|likho|likh\s*do|karo|send\s*karo|send))?$/i);
          if (koTail && koTail[1]) {
            message = koTail[1].trim();
          }
        } else {
          message = message.replace(/\s+(?:bhejo|likho|karo|send\s*karo|send)$/i, "").trim();
        }

        if (/^(bhejo|karo|send|message|likho)$/i.test(message.trim()) || message === objective || !message) {

          message = "Hello from ERA";

        }



        // CRITICAL DECOMPOSITION: Generate discrete sequential steps for EACH recipient!

        // This ensures the autonomous agent executes one by one (Person 1 -> Person 2 -> Person 3),

        // verifies each delivery, and never gets stuck in a loop on the same contact!

        contacts.forEach((contact, idx) => {

          steps.push({

            step_number: idx + 1,

            title: `Send WhatsApp message to ${contact} (${idx + 1}/${contacts.length})`,

            description: `Deliver message to ${contact}: "${message}"`,

            action: "send_whatsapp_message",

            params: { contact, message },

            expected_outcome: `Message delivered to ${contact}`,

            status: "PENDING",

          });

        });

        return steps;

      }

    }



    // ── 2. WHATSAPP — single contact or app opening ───────────────────────────

    if (lower.includes("whatsapp")) {

      const isJustOpening = /(?:open|kholo|launch|search for|search|find|chat kholo)\s+whatsapp/i.test(lower) ||

                            /(?:open|search for)\s+['"][^'"]+['"]\s+and\s+open/i.test(lower) ||

                            !/(?:saying|message|msg|likho|bhejo|bolo)/i.test(lower);



      if (isJustOpening) {

        // Boss just asked to open WhatsApp or view a chat — DO NOT send a message!

        steps.push({

          step_number: 1,

          title: "Open WhatsApp",

          description: "Launch WhatsApp Desktop",

          action: "open_app",

          params: { app_name: "whatsapp" },

          expected_outcome: "WhatsApp window open",

          status: "PENDING",

        });

        steps.push({

          step_number: 2,

          title: "Focus WhatsApp",

          description: "Ensure WhatsApp is in foreground",

          action: "focus_window",

          params: { app_name: "whatsapp" },

          expected_outcome: "WhatsApp focused",

          status: "PENDING",

        });

        return steps;

      }



      // Explicit message payload requested

      let message = extractMsg(["saying ", "message ", "msg ", ": "]);

      if (message === objective) {

        message = objective.replace(/whatsapp|send|message|to|bhejo|karo/gi, "").trim();

      }



      const contacts = extractContacts();

      const contact = contacts[0] || objective.replace(/whatsapp|send|message|to|bhejo|karo/gi, "").trim().split(" ")[0];



      if (contact && message) {

        steps.push({

          step_number: 1,

          title: `Send WhatsApp message to ${contact}`,

          description: `Deliver message to ${contact}: "${message}"`,

          action: "send_whatsapp_message",

          params: { contact, message },

          expected_outcome: `Message delivered to ${contact}`,

          status: "PENDING",

        });

        return steps;

      }

    }



    // ── 3. EMAIL / GMAIL ──────────────────────────────────────────────────────

    if (lower.includes("email") || lower.includes("gmail") || lower.includes("mail")) {

      const message = extractMsg(["saying ", "body ", "with message ", ": "]);

      const toMatch = objective.match(/to\s+([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/i) ||

        objective.match(/to\s+([A-Za-z][\w\s]+?)(?:\s+saying|\s+with|\s+message|$)/i);

      const recipient = toMatch ? toMatch[1].trim() : "";



      steps.push({

        step_number: 1,

        title: "Open Gmail",

        description: "Open Gmail in browser",

        action: "open_browser",

        params: { url: "https://mail.google.com" },

        expected_outcome: "Gmail loaded in browser",

        status: "PENDING",

      });

      steps.push({

        step_number: 2,

        title: "Wait for Gmail to load",

        description: "Wait for Gmail to fully load",

        action: "wait",

        params: { seconds: 3 },

        expected_outcome: "Gmail interface ready",

        status: "PENDING",

      });

      steps.push({

        step_number: 3,

        title: "Compose new email",

        description: "Click Compose button (keyboard shortcut c)",

        action: "press_key_combination",

        params: { keys: ["c"] },

        expected_outcome: "Compose window open",

        status: "PENDING",

      });

      steps.push({

        step_number: 4,

        title: "Enter recipient",

        description: `Type recipient: ${recipient}`,

        action: "type_text",

        params: { text: recipient },

        expected_outcome: "Recipient entered",

        status: "PENDING",

      });

      steps.push({

        step_number: 5,

        title: "Move to subject",

        description: "Tab to subject field",

        action: "press_key_combination",

        params: { keys: ["tab"] },

        expected_outcome: "Subject field focused",

        status: "PENDING",

      });

      steps.push({

        step_number: 6,

        title: "Enter subject",

        description: "Type email subject",

        action: "type_text",

        params: { text: `Message from ERA: ${objective.substring(0, 60)}` },

        expected_outcome: "Subject entered",

        status: "PENDING",

      });

      steps.push({

        step_number: 7,

        title: "Move to body",

        description: "Tab to email body",

        action: "press_key_combination",

        params: { keys: ["tab"] },

        expected_outcome: "Body field focused",

        status: "PENDING",

      });

      steps.push({

        step_number: 8,

        title: "Enter email body",

        description: "Type email message",

        action: "type_text",

        params: { text: message },

        expected_outcome: "Message body entered",

        status: "PENDING",

      });

      steps.push({

        step_number: 9,

        title: "Send email",

        description: "Send the email (Ctrl+Enter)",

        action: "press_key_combination",

        params: { keys: ["ctrl", "enter"] },

        expected_outcome: "Email sent successfully",

        status: "PENDING",

      });

      return steps;

    }



    // ── 4. NOTEPAD / WRITE / NOTE ─────────────────────────────────────────────

    if (lower.includes("notepad") || lower.includes("write") || lower.includes("note")) {

      let content = "";

      const quoted = objective.match(/['"“](.+?)['"”]/);

      if (quoted && quoted[1].trim()) {

        content = quoted[1].trim();

      } else {

        const m = objective.match(/(?:likho|likh kar|type karo|type|write|saying|content)[:\s]+(.+?)(?:\s+(?:aur save|save karo|in background)|$)/i);

        if (m && m[1].trim()) {

          content = m[1].trim();

        } else {

          let cleaned = objective

            .replace(/^(?:background\s+me|piche\s+hi|bina\s+screen\s+pe\s+laye)\s*/i, "")

            .replace(/^(?:notepad\s+me|note\s+me|file\s+me)\s*/i, "")

            .replace(/\s*(?:banao|karo|likho|likh kar save karo|save karo|in background)\s*$/i, "")

            .trim();

          content = (cleaned && cleaned.length > 2) ? cleaned : `Note: ${objective}\nRecorded by ERA.\nTime: ${new Date().toLocaleString()}`;

        }

      }



      if (isBackground) {

        steps.push({

          step_number: 1,

          title: "Open Notepad in background",

          description: "Launch Windows Notepad application silently without taking focus",

          action: "open_app",

          params: { app_name: "notepad", in_background: true },

          expected_outcome: "Notepad running in background",

          status: "PENDING",

        });

        steps.push({

          step_number: 2,

          title: "Wait for Notepad initialization",

          description: "Wait 2 seconds for Notepad process and window to be ready",

          action: "wait",

          params: { seconds: 2 },

          expected_outcome: "Notepad ready for background input",

          status: "PENDING",

        });

        steps.push({

          step_number: 3,

          title: "Write content into background Notepad",

          description: "Type text into Notepad directly via Win32 messages without stealing focus",

          action: "background_type",

          params: { app_name: "notepad", text: content, press_enter: true },

          expected_outcome: "Content typed into background Notepad",

          status: "PENDING",

        });

        if (lower.includes("save")) {

          steps.push({

            step_number: 4,

            title: "Save background Notepad file",

            description: "Send save shortcut to Notepad in background",

            action: "background_send_keys",

            params: { app_name: "notepad", keys: ["ctrl", "s"] },

            expected_outcome: "Save triggered in background",

            status: "PENDING",

          });

        }

        return steps;

      }



      steps.push({

        step_number: 1,

        title: "Open Notepad",

        description: "Launch Windows Notepad application",

        action: "open_app",

        params: { app_name: "notepad" },

        expected_outcome: "Notepad window active on screen",

        status: "PENDING",

      });

      steps.push({

        step_number: 2,

        title: "Focus Notepad",

        description: "Bring Notepad to foreground",

        action: "focus_window",

        params: { app_name: "notepad" },

        expected_outcome: "Notepad is focused",

        status: "PENDING",

      });

      steps.push({

        step_number: 3,

        title: "Type content into Notepad",

        description: "Type content into the active editor",

        action: "type_text",

        params: { text: content },

        expected_outcome: "Text typed into Notepad",

        status: "PENDING",

      });



      // Check if "save" is mentioned

      if (lower.includes("save")) {

        steps.push({

          step_number: 4,

          title: "Save file",

          description: "Save the Notepad file (Ctrl+S)",

          action: "press_key_combination",

          params: { keys: ["ctrl", "s"] },

          expected_outcome: "Save dialog opened",

          status: "PENDING",

        });

        steps.push({

          step_number: 5,

          title: "Confirm save",

          description: "Press Enter to confirm default filename",

          action: "press_key_combination",

          params: { keys: ["enter"] },

          expected_outcome: "File saved",

          status: "PENDING",

        });

      }

      return steps;

    }



    // ── 5. YOUTUBE / VIDEO / MUSIC ────────────────────────────────────────────

    if (lower.includes("youtube") || lower.includes("video") || lower.includes("music") || lower.includes("song")) {

      const query = objective.replace(/youtube|open|search|play|find|look\s+up|music|video|song/gi, "").trim() || "top music";

      steps.push({

        step_number: 1,

        title: "Open YouTube in Browser",

        description: "Launch default browser to YouTube",

        action: "open_browser",

        params: { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` },

        expected_outcome: "YouTube search results visible",

        status: "PENDING",

      });

      return steps;

    }



    // ── 6A. OPEN APP + SEARCH / TYPE / GENERATE / PROMPT ──────────────────────
    // MUST run BEFORE #6 GOOGLE SEARCH so "open Canva and search cat" or
    // "Canva open karo aur us pe cat search karo" stays inside the requested app!
    const openAndActMatch =
      // Hinglish prefix: "Canva open karo aur us pe cat search karo" / "Canva kholo aur cat likho"
      objective.match(/^([A-Za-z0-9_.\- ]{2,25}?)\s+(?:open\s*karo|open\s*kar\s*do|kholo|khol\s*do|chalu\s*karo|launch\s*karo|start\s*karo)\s+(?:aur|and|then|uske\s*baad)?\s*(?:us\s*par|us\s*pe|uspe|us\s*per|us\s*mein|usme|in\s*it|inside|on\s*it)?\s*(.+)$/i) ||
      // English prefix: "open Canva and search for cat" / "launch ChatGPT then type hi"
      objective.match(/^(?:please\s+)?(?:open|launch|start|kholo)\s+([A-Za-z0-9_.\- ]{2,25}?)\s+(?:and|aur|then|,)\s*(?:in\s*it|on\s*it|inside|us\s*pe|uspe|us\s*par)?\s*(.+)$/i);

    if (openAndActMatch) {
      const candidateApp = openAndActMatch[1].trim();
      const tailAction = openAndActMatch[2].trim();
      const appLower = candidateApp.toLowerCase();
      const isSearchTail = /\b(?:search|khoj|dhundo|dhoond|find)\b/i.test(tailAction);
      const isTypeOrPromptTail = /\b(?:type|likho|likh|write|prompt|generate|create|enter|ask|pucho)\b/i.test(tailAction);

      if (candidateApp && !["google", "whatsapp"].includes(appLower) && (isSearchTail || isTypeOrPromptTail)) {
        let queryText = tailAction
          .replace(/^(?:us\s*par|us\s*pe|uspe|us\s*per|us\s*mein|usme|in\s*it|on\s*it|inside)\s+/i, "")
          .replace(/^(?:for|about)\s+/i, "")
          .replace(/^(?:search\s*for|search|type|likho|likh|write|prompt|generate|create|find)\s+/i, "")
          .replace(/\s+(?:type\s*kar\s*ke\s*search\s*karo|type\s*karke\s*search\s*karo|search\s*karo|search\s*kar\s*do|search\s*kar|type\s*karo|type\s*kar\s*do|likho|likh\s*do|karo|kar\s*do|search|type)\s*$/i, "")
          .replace(/\s+type\s*kar\s*ke\s+/gi, " ")
          .replace(/^['"]|['"]$/g, "")
          .trim();
        if (!queryText) queryText = tailAction;

        const isPlainEditor = /^(?:notepad|notes|word|wordpad)$/i.test(appLower);

        steps.push({
          step_number: 1,
          title: `Open ${candidateApp}`,
          description: `Launch ${candidateApp}`,
          action: "open_app",
          params: { app_name: candidateApp },
          expected_outcome: `${candidateApp} window open`,
          status: "PENDING",
        });
        steps.push({
          step_number: 2,
          title: `Focus ${candidateApp}`,
          description: `Ensure ${candidateApp} is in foreground`,
          action: "focus_window",
          params: { app_name: candidateApp },
          expected_outcome: `${candidateApp} focused`,
          status: "PENDING",
        });

        if (isPlainEditor && !isSearchTail) {
          steps.push({
            step_number: 3,
            title: `Type in ${candidateApp}`,
            description: `Type: ${queryText}`,
            action: "type_text",
            params: { text: queryText, app_name: candidateApp },
            expected_outcome: `Typed "${queryText}" into ${candidateApp}`,
            status: "PENDING",
          });
        } else {
          steps.push({
            step_number: 3,
            title: `${isSearchTail ? "Search" : "Enter prompt"} in ${candidateApp}`,
            description: `Focus search/input bar in ${candidateApp}, type "${queryText}", and submit`,
            action: "search_in_app",
            params: { app_name: candidateApp, query: queryText, press_enter: true },
            expected_outcome: `Entered "${queryText}" and submitted inside ${candidateApp}`,
            status: "PENDING",
          });
        }
        return steps;
      }
    }

    // ── 6. GOOGLE SEARCH / BROWSER SEARCH ────────────────────────────────────

    const targetsDesktopApp = /\b(?:canva|chatgpt|spotify|explorer|settings|vscode|notepad|discord|whatsapp)\b/i.test(lower);
    if (

      allowGenericFallback &&
      !targetsDesktopApp && (
        lower.includes("search for") || lower.includes("look up") ||

        lower.includes("google") || lower.includes("find on") ||

        lower.includes("search ") || lower.includes("browse")
      )

    ) {

      const query = objective.replace(/search\s+for|look\s+up|google|find\s+on|search|browse/gi, "").trim() || objective;

      steps.push({

        step_number: 1,

        title: "Search in Browser",

        description: `Search for: ${query}`,

        action: "open_browser",

        params: { url: `https://www.google.com/search?q=${encodeURIComponent(query)}` },

        expected_outcome: "Search results loaded in browser",

        status: "PENDING",

      });

      return steps;

    }



    // ── 7. OPEN APP + GENERATE/CREATE/WRITE/PROMPT ───────────────────────────

    if (

      lower.includes("generate") || lower.includes("create") ||

      lower.includes("prompt") || (lower.includes("open") && (lower.includes("type") || lower.includes("search")))

    ) {

      // Try to extract app name — word after "open"

      const openMatch = objective.match(/open\s+([A-Za-z0-9_\-\. ]+?)(?:\s+and|\s+then|\s+to|,|$)/i);

      const appName = openMatch ? openMatch[1].trim() : "";

      const content = extractMsg(["type ", "write ", "generate ", "create ", "prompt ", "search "]) ||

        objective.replace(/open|and|then|type|write|generate|create|prompt|search/gi, "").trim();



      if (appName) {

        steps.push({

          step_number: 1,

          title: `Open ${appName}`,

          description: `Launch application: ${appName}`,

          action: "open_app",

          params: { app_name: appName },

          expected_outcome: `${appName} window visible`,

          status: "PENDING",

        });

        steps.push({

          step_number: 2,

          title: `Focus ${appName}`,

          description: `Ensure ${appName} is in foreground (waits up to 8s)`,

          action: "focus_window",

          params: { app_name: appName },

          expected_outcome: `${appName} focused`,

          status: "PENDING",

        });

        steps.push({

          step_number: 3,

          title: `Search / Enter input in ${appName}`,

          description: `Type content into ${appName}: ${content}`,

          action: "search_in_app",

          params: { app_name: appName, query: content, press_enter: true },

          expected_outcome: `Content "${content}" entered and submitted in ${appName}`,

          status: "PENDING",

        });

        return steps;

      }

    }



    // ── 8. OPEN SPECIFIC APP ──────────────────────────────────────────────────

    if (lower.includes("open ") && !lower.includes("whatsapp")) {

      const openMatch = objective.match(/open\s+([A-Za-z0-9_\-\. ]+?)(?:\s+and|\s+then|\s+to|,|$)/i);

      const appName = openMatch ? openMatch[1].trim() : "";

      if (appName) {

        steps.push({

          step_number: 1,

          title: `Open ${appName}`,

          description: `Launch ${appName}`,

          action: "open_app",

          params: { app_name: appName },

          expected_outcome: `${appName} open`,

          status: "PENDING",

        });

        steps.push({

          step_number: 2,

          title: `Focus ${appName}`,

          description: `Bring ${appName} to foreground`,

          action: "focus_window",

          params: { app_name: appName },

          expected_outcome: `${appName} focused`,

          status: "PENDING",

        });

        return steps;

      }

    }



    // ── 9. BUILD / GAME / WEBSITE — code engine ───────────────────────────────

    if (allowGenericFallback && (lower.includes("game") || lower.includes("website") || lower.includes("build"))) {

      steps.push({

        step_number: 1,

        title: "Autonomous Code Engine",

        description: "Plan, code, and launch software",

        action: "submit_autonomous_goal",

        params: { goal: objective },

        expected_outcome: "Application generated and running",

        status: "PENDING",

      });

      return steps;

    }



    // ── 10. DEFAULT FALLBACK ──────────────────────────────────────────────────

    if (!allowGenericFallback) {
      return [];
    }

    steps.push({

      step_number: 1,

      title: "Analyse current screen",

      description: "Observe active window and screen state",

      action: "wait",

      params: { seconds: 1 },

      expected_outcome: "Current screen state analysed",

      status: "PENDING",

    });

    steps.push({

      step_number: 2,

      title: "Search for information",

      description: `Search online for: ${objective}`,

      action: "open_browser",

      params: { url: "https://www.google.com/search?q=" + encodeURIComponent(objective) },

      expected_outcome: "Information displayed in browser",

      status: "PENDING",

    });



    return steps;

  }



    /**

   * Executes a single atomic action through system commands or tools.

   */

  private async executeStepAction(step: GoalStep, isBackground: boolean = false, targetAppName: string = ""): Promise<any> {

    const act = step.action.toLowerCase().trim();

    const p = step.params || {};



    try {

      if (act === "get_background_activity" || act === "getbackgroundactivity") {

        return await getBackgroundActivity(p.query || p.app_name || p.name);

      }

      if (act === "capture_background_app" || act === "capture_background_window") {

        return await captureBackgroundApp(p.app_name || p.name || "", true);

      }

      if (act === "inspect_background_app" || act === "inspect_background_window") {

        return await inspectBackgroundApp(p.app_name || p.name || "");

      }

      if (act === "background_click") {

        return await executeBackgroundAction(p.app_name || p.name || "", "click", p);

      }

      if (act === "background_type") {

        return await executeBackgroundAction(p.app_name || p.name || "", "type", p);

      }

      if (act === "background_send_keys" || act === "background_key") {

        return await executeBackgroundAction(p.app_name || p.name || "", "send_keys", p);

      }

      if (act === "background_close_window") {

        return await executeBackgroundAction(p.app_name || p.name || "", "close", p);

      }

      if (isBackground && (act === "focus_window" || act === "focuswindow")) {

        return {

          success: true,

          message: `Preserved user focus: skipped bringing '${p.app_name || targetAppName || "app"}' to the foreground in background mode.`

        };

      }

      if (isBackground && act === "type_text") {

        const app = p.app_name || targetAppName || "notepad";

        return await executeBackgroundAction(app, "type", {

          text: p.text || "",

          press_enter: p.press_enter ?? false,

        });

      }

      if (isBackground && (act === "press_key_combination" || act === "press_key" || act === "presskeycombination")) {

        const app = p.app_name || targetAppName || "notepad";

        const keys = Array.isArray(p.keys) ? p.keys : [p.key || p.keys || "enter"];

        return await executeBackgroundAction(app, "send_keys", { keys });

      }

      if (isBackground && (act === "click_screen" || act === "click")) {

        const app = p.app_name || targetAppName || "";

        if (app) {

          return await executeBackgroundAction(app, "click", p);

        }

      }

      if (act === "open_app") {

        const appTarget = p.app_name || p.name;
        const openRes = await executeAgentCommand("open_app", {
          app_name: appTarget,
          in_background: isBackground || Boolean(p.in_background),
        });
        let focusedOk = false;
        if (openRes?.success && !isBackground && appTarget) {
          // Wait until window is genuinely spawned & focused so subsequent typing/search won't race
          const fRes = await executeAgentCommand("focus_window", { app_name: appTarget });
          focusedOk = Boolean(fRes?.success);
          const heavyApps = /^(canva|chatgpt|openai|claude|spotify|whatsapp|discord|vscode|code|visual studio code|store|microsoft store)$/i;
          await new Promise((r) => setTimeout(r, heavyApps.test(String(appTarget).trim()) ? 1000 : 400));
        }
        return { ...openRes, _focused: focusedOk };

      }

      if (act === "open_browser") {

        return await executeAgentCommand("open_browser", { url: p.url || "https://www.google.com" });

      }

      if (act === "close_browser") {

        return await executeAgentCommand("close_browser");

      }

      if (act === "type_text") {

        return await executeAgentCommand("type_text", { text: p.text || "", app_name: p.app_name || targetAppName });

      }

      if (act === "press_key_combination" || act === "press_key" || act === "presskeycombination") {

        const keys = Array.isArray(p.keys) ? p.keys : [p.key || p.keys || "enter"];

        return await executeAgentCommand("press_key_combination", { keys });

      }

      if (act === "click_screen" || act === "click") {

        return await executeAgentCommand("click_screen", {
          x: Number(p.x || 0),
          y: Number(p.y || 0),
          normalized: Boolean(p.normalized),
        });

      }

      if (act === "click_element") {

        const targetDesc = String(p.target || p.element || p.description || "search input box").trim();
        const appRef = String(p.app_name || targetAppName || "").trim();
        if (appRef && !isBackground) {
          await executeAgentCommand("focus_window", { app_name: appRef });
          await new Promise((r) => setTimeout(r, 350));
        }
        const located = await this.locateElementOnScreen(targetDesc, appRef);
        if (!located.found) {
          return { success: false, message: `Could not visually locate element '${targetDesc}': ${located.label}` };
        }
        const clickRes = await executeAgentCommand("click_screen", {
          x: located.x_norm,
          y: located.y_norm,
          normalized: true,
        });
        return {
          ...clickRes,
          message: clickRes.success
            ? `Clicked '${located.label}' at normalized (${located.x_norm}, ${located.y_norm}).`
            : clickRes.message,
        };

      }

      if (act === "search_in_app") {

        const appRef = String(p.app_name || p.name || targetAppName || "").trim();
        const query = String(p.query || p.text || "").trim();
        if (!query) {
          return { success: false, message: "search_in_app requires a non-empty query." };
        }
        const appLower = appRef.toLowerCase();

        if (appRef && !isBackground) {
          await executeAgentCommand("focus_window", { app_name: appRef });
          await new Promise((r) => setTimeout(r, 400));
        }

        // Fast deterministic search shortcuts for known apps
        const shortcutMap: Record<string, string[]> = {
          chrome: ["ctrl", "l"],
          "google chrome": ["ctrl", "l"],
          browser: ["ctrl", "l"],
          edge: ["ctrl", "l"],
          msedge: ["ctrl", "l"],
          "microsoft edge": ["ctrl", "l"],
          opera: ["ctrl", "l"],
          operagx: ["ctrl", "l"],
          "opera gx": ["ctrl", "l"],
          brave: ["ctrl", "l"],
          firefox: ["ctrl", "l"],
          explorer: ["ctrl", "e"],
          "file explorer": ["ctrl", "e"],
          files: ["ctrl", "e"],
          spotify: ["ctrl", "k"],
          settings: ["ctrl", "f"],
          whatsapp: ["ctrl", "f"],
          vscode: ["ctrl", "shift", "f"],
          "vs code": ["ctrl", "shift", "f"],
          code: ["ctrl", "shift", "f"],
          "visual studio code": ["ctrl", "shift", "f"],
        };

        let inputFocused = false;
        let focusMethod = "";
        const directShortcut = shortcutMap[appLower];

        if (directShortcut) {
          const keyRes = await executeAgentCommand("press_key_combination", { keys: directShortcut });
          if (keyRes?.success) {
            inputFocused = true;
            focusMethod = `shortcut ${directShortcut.join("+")}`;
          }
        } else {
          // Rich UI / Electron / UWP apps (Canva, ChatGPT, Claude, Store, etc.): locate visually via Vision!
          await new Promise((r) => setTimeout(r, 600));
          const targetHint = /(chatgpt|claude|openai)/i.test(appLower)
            ? "main chat prompt message input box or Ask anything text area"
            : "search bar, search box, magnifying glass search button, or search templates input field";
          const located = await this.locateElementOnScreen(targetHint, appRef);
          if (located.found) {
            const clickRes = await executeAgentCommand("click_screen", {
              x: located.x_norm,
              y: located.y_norm,
              normalized: true,
            });
            if (clickRes?.success) {
              inputFocused = true;
              focusMethod = `vision click (${located.x_norm}, ${located.y_norm})`;
            }
          }
          if (!inputFocused) {
            const fallbackKeys = /(canva|chatgpt|claude|discord|slack|notion|store|microsoft store)/i.test(appLower)
              ? ["ctrl", "k"]
              : ["ctrl", "f"];
            const keyRes = await executeAgentCommand("press_key_combination", { keys: fallbackKeys });
            if (keyRes?.success) {
              inputFocused = true;
              focusMethod = `fallback shortcut ${fallbackKeys.join("+")}`;
            }
          }
        }

        await new Promise((r) => setTimeout(r, 300));
        await executeAgentCommand("press_key_combination", { keys: ["ctrl", "a"] });
        await new Promise((r) => setTimeout(r, 80));
        const typeRes = await executeAgentCommand("type_text", { text: query, app_name: appRef });
        if (!typeRes?.success) {
          return { success: false, message: `Failed to type search query '${query}' in '${appRef}': ${typeRes?.message}` };
        }
        if (p.press_enter !== false) {
          await new Promise((r) => setTimeout(r, 250));
          await executeAgentCommand("press_key_combination", { keys: ["enter"] });
        }
        return {
          success: true,
          message: `Typed and searched "${query}" in ${appRef || "app"} (${focusMethod || "active input"}).`,
        };

      }

      if (act === "scroll_screen" || act === "scroll") {

        return await executeAgentCommand("scroll_screen", { clicks: Number(p.clicks || 5) });

      }

      if (act === "search_file") {

        return await executeAgentCommand("search_file", { query: p.query || "" });

      }

      if (act === "open_file") {

        return await executeAgentCommand("open_file", { filename: p.filename || p.path });

      }

      if (act === "edit_file_at_path") {

        return await executeAgentCommand("edit_file_at_path", p);

      }

      if (act === "submit_autonomous_goal") {

        return await submitOutcomeGoal(p.goal || step.description);

      }

      if (act === "order_food" || act === "order_food_autonomous") {
        return await executeAgentCommand("order_food", {
          dish: p.dish || p.food || p.query || "",
          quantity: p.quantity ?? 1,
          max_budget: p.max_budget ?? p.maxBudget ?? p.budget ?? p.price,
          min_budget: p.min_budget ?? p.minBudget,
          platform: p.platform || "auto",
          city: p.city || p.location,
          location: p.location || p.city,
          payment_method: p.payment_method || p.paymentMethod || "cod",
          auto_order: p.auto_order ?? p.autoOrder ?? true,
          headless: isBackground || Boolean(p.headless),
        });
      }

      if (act === "build_website_app" || act === "build_software_app") {

        const studio = this.softwareStudioEngineGetter?.();

        if (studio) {

          return await studio.buildProject({

            prompt: p.prompt || step.description || "Production Web Application",

            projectName: p.project_name || p.name || "",

            autoPreview: p.auto_preview ?? true,

          });

        }

        return { success: false, message: "Software Studio Engine not available." };

      }

      if (act === "preview_website_app") {

        const studio = this.softwareStudioEngineGetter?.();

        const latestProj = studio?.getProjects()?.[0];

        const previewUrl = p.url && p.url !== "/api/studio/preview/latest/index.html" ? p.url : (latestProj?.previewUrl || "");

        if (previewUrl) {

          const fullUrl = previewUrl.startsWith("http") ? previewUrl : `http://localhost:3000${previewUrl}`;

          await executeAgentCommand("open_browser", { url: fullUrl });

          return { success: true, message: `Opened live interactive preview at ${fullUrl}` };

        }

        return { success: true, message: "Preview ready in Software Studio." };

      }

      if (act === "wait") {

        const secs = Number(p.seconds || 1);

        await new Promise((r) => setTimeout(r, secs * 1000));

        return { success: true, message: `Waited for ${secs} seconds.` };

      }



      if (act === "wait_for_response") {

        const secs = Number(p.seconds || 4);

        await new Promise((r) => setTimeout(r, secs * 1000));

        const postCap = await captureScreen(0);

        return {

          success: true,

          message: `Observed screen after waiting ${secs} seconds.`,

          analysis: postCap?.data?.analysis || ""

        };

      }



      if (act === "observe_and_reply" || act === "analyze_feedback") {

        if (p.target_app) {

          try {

            await executeAgentCommand("focus_window", { app_name: p.target_app });

            await new Promise((r) => setTimeout(r, 600));

          } catch (_) {}

        }

        const cap = await captureScreen(0);

        const screenText = cap?.data?.analysis || "Active window visible";

        const ai = this.getGeminiAiClient();

        const feedbackPrompt = `You are ERA's Autonomous Brain. You are monitoring external feedback from a chatbot, terminal, or system prompt.

CURRENT SCREEN OBSERVATION:

${screenText}



TASK / GOAL CONTEXT:

${step.description || p.goal_context || "Respond to external feedback logically"}



INSTRUCTION:

${p.prompt_instruction || "Analyze the last reply or state on screen, formulate the next logical response or action, and output the exact text to type or action to take."}



Output JSON in this format:

\`\`\`json

{

  "observed_feedback": "Summary of what the external chatbot/system replied",

  "logical_next_step": "Why this response is selected",

  "text_to_type": "The exact response to type (or empty if not typing)",

  "press_enter_after": true

}

\`\`\``;



        const respText = await this.generateWithModelFallback(this.getFastTextModels(), feedbackPrompt, 10000);

        const jsonMatch = respText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, respText];

        let analysisObj: any = {};

        try {

          analysisObj = JSON.parse(jsonMatch[1] ? jsonMatch[1].trim() : respText.trim());

        } catch (_) {

          analysisObj = { text_to_type: respText.trim(), press_enter_after: true };

        }



        if (analysisObj.text_to_type) {

          await executeAgentCommand("type_text", { text: analysisObj.text_to_type });

          if (analysisObj.press_enter_after !== false) {

            await new Promise((r) => setTimeout(r, 400));

            await executeAgentCommand("press_key_combination", { keys: ["enter"] });

          }

        }



        return {

          success: true,

          message: `Observed: ${analysisObj.observed_feedback || "screen feedback analyzed"}. Formulated: ${analysisObj.text_to_type || "action taken"}`,

          details: analysisObj

        };

      }



      if (act === "focus_window" || act === "focuswindow") {

        return await executeAgentCommand("focus_window", { app_name: p.app_name || p.name || "" });

      }

      // ── High-Level Autonomous Actions for Large Scale Tasks ──
      if (["run_terminal_command", "run_powershell_command", "execute_shell_command", "run_command", "terminal_command"].includes(act)) {
        const cmd = p.command || p.cmd || p.script || "";
        if (!cmd) return { success: false, message: "No command provided to execute." };
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            shell: "powershell.exe",
            timeout: Number(p.timeout_ms || p.timeout || 60000),
            maxBuffer: 10 * 1024 * 1024,
            cwd: p.cwd || process.cwd()
          });
          return {
            success: true,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            output: stdout.trim() || stderr.trim(),
            message: `Command executed: ${cmd.slice(0, 80)}. Output: ${stdout.slice(0, 150)}`
          };
        } catch (cmdErr: any) {
          return {
            success: false,
            stdout: cmdErr.stdout ? String(cmdErr.stdout).trim() : "",
            stderr: cmdErr.stderr ? String(cmdErr.stderr).trim() : cmdErr.message,
            output: cmdErr.stderr ? String(cmdErr.stderr).trim() : cmdErr.message,
            message: `Command failed: ${cmdErr.message}`
          };
        }
      }

      if (["create_or_write_file", "write_file", "save_file", "create_file"].includes(act)) {
        const filePath = p.filepath || p.path || p.file_path || p.filename;
        const fileContent = p.content !== undefined ? String(p.content) : (p.text || "");
        if (!filePath) return { success: false, message: "No file path provided." };
        try {
          const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
          const dir = path.dirname(resolvedPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(resolvedPath, fileContent, "utf8");
          return {
            success: true,
            path: resolvedPath,
            message: `File successfully saved at ${resolvedPath} (${fileContent.length} bytes)`
          };
        } catch (fErr: any) {
          return { success: false, message: `Failed to write file: ${fErr.message}` };
        }
      }

      if (["read_file_content", "read_file", "view_file"].includes(act)) {
        const filePath = p.filepath || p.path || p.file_path || p.filename;
        if (!filePath) return { success: false, message: "No file path provided." };
        try {
          const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
          if (!fs.existsSync(resolvedPath)) {
            return { success: false, message: `File does not exist: ${resolvedPath}` };
          }
          const fileText = fs.readFileSync(resolvedPath, "utf8");
          return {
            success: true,
            path: resolvedPath,
            output: fileText,
            message: `Read ${fileText.length} characters from ${resolvedPath}`
          };
        } catch (rfErr: any) {
          return { success: false, message: `Failed to read file: ${rfErr.message}` };
        }
      }

      if (["http_request", "fetch_url", "api_request"].includes(act)) {
        const url = p.url || p.endpoint;
        if (!url) return { success: false, message: "No URL provided for HTTP request." };
        try {
          const method = (p.method || "GET").toUpperCase();
          const headers = p.headers || {};
          const reqBody = p.body ? (typeof p.body === "string" ? p.body : JSON.stringify(p.body)) : undefined;
          const fetchRes = await fetch(url, {
            method,
            headers: { "Content-Type": "application/json", ...headers },
            body: ["POST", "PUT", "PATCH"].includes(method) ? reqBody : undefined,
          });
          const textData = await fetchRes.text();
          let parsedData = textData;
          try { parsedData = JSON.parse(textData); } catch {}
          return {
            success: fetchRes.ok,
            status: fetchRes.status,
            output: parsedData,
            message: `HTTP ${method} to ${url} returned status ${fetchRes.status}`
          };
        } catch (httpErr: any) {
          return { success: false, message: `HTTP request failed: ${httpErr.message}` };
        }
      }

      if (act === "send_whatsapp_to_multiple" || act === "whatsapp_send_multiple") {
        const rawRecipients = Array.isArray(p.recipients) ? p.recipients : undefined;
        if (rawRecipients && rawRecipients.length > 0) {
          return await AutonomousGoalExecutor.acquireUILock(async () => {
            return await executeAgentCommand("send_whatsapp_to_multiple", {
              recipients: rawRecipients,
              contacts: rawRecipients.map((r: any) => String(r?.contact || r?.name || r?.phone || "").trim()).filter(Boolean),
              messages: rawRecipients.map((r: any) => String(r?.message || r?.text || p.message || "Hello from ERA")),
              message: p.message || p.text || rawRecipients[0]?.message || "Hello from ERA",
            });
          });
        }
        const rawContacts = p.contacts || p.to || [];
        let contactsArr: string[] = [];
        if (Array.isArray(rawContacts)) {
          contactsArr = rawContacts.map(c => String(c).trim()).filter(Boolean);
        } else if (typeof rawContacts === "string") {
          contactsArr = rawContacts.split(/\s+(?:and|aur|or)\s+|[,;]/i).map(c => c.trim()).filter(Boolean);
        }
        if (contactsArr.length === 0) {
          contactsArr = loadContacts().slice(0, 5).map(c => c.name);
        }
        return await AutonomousGoalExecutor.acquireUILock(async () => {
          return await executeAgentCommand("send_whatsapp_to_multiple", {
            contacts: contactsArr,
            message: p.message || p.text || "Hello from ERA",
          });
        });
      }

      if (act === "send_whatsapp_message" || act === "whatsapp_send") {
        const target = p.contact || p.phone || p.to || p.contactName || "";
        return await AutonomousGoalExecutor.acquireUILock(async () => {
          return await executeAgentCommand("send_whatsapp_message", {
            contact: target,
            phone: target,
            message: p.message || p.text || "Hello from ERA",
          });
        });
      }

      // Fallback: generic agent command

      return await executeAgentCommand(step.action, p);

    } catch (err: any) {

      console.error(`[AutonomousGoalExecutor] Action execution error for '${step.action}':`, err);

      return { success: false, error: err.message };

    }

  }



  /**

   * Verifies step execution using Gemini vision analysis and action status.

   */

  private async verifyStepOutcome(

    step: GoalStep,

    actionResult: any,

    screenAnalysis: string

  ): Promise<{ verified: boolean; explanation: string }> {

    if (step.action.includes("whatsapp") && actionResult?.success) {

      return {

        verified: true,

        explanation: actionResult.message || "WhatsApp action dispatched successfully."

      };

    }



    if (!actionResult || actionResult.success === false) {

      return {

        verified: false,

        explanation: actionResult?.message || actionResult?.error || "Action returned failure.",

      };

    }



    // If screen analysis is available, perform vision verification

    if (screenAnalysis && step.expected_outcome) {

      try {

        const ai = this.getGeminiAiClient();

        const prompt = `You are ERA's Autonomous Verification Inspector.

Evaluate whether this step succeeded:



STEP TITLE: "${step.title}"

EXPECTED OUTCOME: "${step.expected_outcome}"

ACTION RESULT: ${JSON.stringify(actionResult)}

CURRENT PHYSICAL SCREEN STATE:

${screenAnalysis}



Did the action succeed and does the screen state match the expected outcome?

Reply in JSON:

\`\`\`json

{

  "verified": true or false,

  "explanation": "concise 1-sentence explanation"

}

\`\`\``;



        const text = await this.generateWithModelFallback(this.getFastTextModels(), prompt, 8000);

        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];

        const parsed = JSON.parse(jsonMatch[1] ? jsonMatch[1].trim() : text.trim());

        if (typeof parsed?.verified === "boolean") {

          return {

            verified: parsed.verified,

            explanation: parsed.explanation || "Step verified against visual state.",

          };

        }

      } catch (err: any) {

        // Fall through to basic verification

      }

    }



    // Default verification based on action execution success

    return {

      verified: actionResult?.success === true,

      explanation: actionResult?.message || "Action executed successfully.",

    };

  }



  /**

   * Adaptive remediation when a step verification is unconfirmed.

   */

  private async applySelfHealingRemedy(step: GoalStep, screenAnalysis: string): Promise<void> {

    try {

      // 1. If active window focus was lost, press Alt+Tab or re-trigger window focus

      if (step.action === "type_text") {

        // Retry typing

        await executeAgentCommand("type_text", step.params);

      } else if (step.action === "press_key_combination" || step.action === "press_key") {

        await executeAgentCommand("press_key_combination", step.params);

      } else if (step.action === "open_app") {

        await executeAgentCommand("open_app", step.params);

      }

    } catch (err: any) {

      console.warn(`[AutonomousGoalExecutor] Remediation warning: ${err.message}`);

    }

  }

}

