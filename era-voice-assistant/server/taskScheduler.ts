/**
 * Persistent Alarm-Grade Task Scheduler for ERA (strictly Indian Standard Time / IST).
 *
 * Supports:
 * - Relative delays ("1 min ke baad", "30 seconds later", "2 ghante baad")
 * - Exact IST wall-clock times ("exact 9:30 PM", "21:15", "subah 7 baje", "kal raat 10 baje")
 * - Daily recurring alarms/tasks ("roz subah 7 baje")
 * - Executing ANY ERA tool, local agent command, autonomous multi-step goal, or alarm reminder
 * - Disk persistence across restarts with safe recovery for overdue power actions
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  formatHumanDuration,
  formatIstDateTime,
  formatIstIso,
  getIstDateParts,
  istWallClockToEpochMs,
  parseIstScheduleTime,
} from "./istTime";

export type ScheduledTaskType = "tool" | "agent_command" | "autonomous_goal" | "alarm";
export type ScheduledTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "missed";
export type ScheduledTaskRecurrence = "once" | "daily";

export interface ScheduledTask {
  id: string;
  title: string;
  taskType: ScheduledTaskType;
  toolName?: string;
  toolArgs?: Record<string, any>;
  command?: string;
  commandParams?: Record<string, any>;
  objective?: string;
  runInBackground?: boolean;
  alarmMessage?: string;
  source: "voice" | "chat" | "api";
  recurrence: ScheduledTaskRecurrence;
  createdAtMs: number;
  createdAtIst: string;
  triggerAtMs: number;
  scheduledForIst: string;
  scheduledForIsoIst: string;
  status: ScheduledTaskStatus;
  warningSent?: boolean;
  executedAtMs?: number;
  executedAtIst?: string;
  resultMessage?: string;
  error?: string;
}

export interface CreateScheduledTaskInput {
  title: string;
  taskType: ScheduledTaskType;
  toolName?: string;
  toolArgs?: Record<string, any>;
  command?: string;
  commandParams?: Record<string, any>;
  objective?: string;
  runInBackground?: boolean;
  alarmMessage?: string;
  source?: "voice" | "chat" | "api";
  recurrence?: ScheduledTaskRecurrence;
  delaySeconds?: number;
  delayMinutes?: number;
  delayHours?: number;
  targetTimeIst?: string;
  query?: string;
}

export interface TaskSchedulerCallbacks {
  executeTool: (toolName: string, args: Record<string, any>) => Promise<any>;
  executeAgentCommand: (command: string, params: Record<string, any>) => Promise<{ success: boolean; message: string; data?: any }>;
  executeAutonomousGoal: (objective: string, runInBackground?: boolean) => Promise<any>;
  onEvent?: (event: {
    type: "created" | "warning" | "triggered" | "cancelled" | "updated";
    task: ScheduledTask;
    result?: { success: boolean; message: string; data?: any };
    allTasks: ScheduledTask[];
  }) => void | Promise<void>;
}

const MAX_SHORT_TIMER_MS = 60_000;
const MAX_STORED_HISTORY = 60;

export function resolveSchedulerStoragePath(overridePath?: string): string {
  if (overridePath) return overridePath;
  const appData =
    (process.env.ERA_APP_DATA && process.env.ERA_APP_DATA.trim()) ||
    path.join(os.homedir(), "AppData", "Local", "ERA");
  return path.join(appData, "scheduled_tasks.json");
}

function isPowerActionTask(task: ScheduledTask): boolean {
  if (task.taskType === "tool" && task.toolName === "systemControl") {
    const act = String(task.toolArgs?.action || "").toLowerCase();
    return act === "shutdown" || act === "restart";
  }
  if (task.taskType === "agent_command") {
    const cmd = String(task.command || "").toLowerCase();
    return cmd === "shutdown_pc" || cmd === "restart_pc";
  }
  return false;
}

export class TaskScheduler {
  private readonly storagePath: string;
  private tasks: ScheduledTask[] = [];
  private callbacks: TaskSchedulerCallbacks | null = null;
  private tickHandle: NodeJS.Timeout | null = null;
  private shortTimers = new Map<string, NodeJS.Timeout>();
  private executingIds = new Set<string>();
  private started = false;

  constructor(storagePath?: string) {
    this.storagePath = resolveSchedulerStoragePath(storagePath);
  }

  public setCallbacks(callbacks: TaskSchedulerCallbacks): void {
    this.callbacks = callbacks;
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.loadFromDisk();
    this.recoverOnStartup();

    this.tickHandle = setInterval(() => {
      void this.tick();
    }, 1000);
    if (typeof this.tickHandle.unref === "function") {
      this.tickHandle.unref();
    }
  }

  public stop(): void {
    this.started = false;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    for (const timer of this.shortTimers.values()) {
      clearTimeout(timer);
    }
    this.shortTimers.clear();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.storagePath)) {
        this.tasks = [];
        return;
      }
      const raw = fs.readFileSync(this.storagePath, "utf8");
      const parsed = JSON.parse(raw);
      this.tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    } catch (err: any) {
      console.warn("[TaskScheduler] Failed to load scheduled tasks from disk:", err?.message);
      this.tasks = [];
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Retain all active (pending/running) tasks plus latest MAX_STORED_HISTORY finished tasks
      const active = this.tasks.filter((t) => t.status === "pending" || t.status === "running");
      const finished = this.tasks
        .filter((t) => t.status !== "pending" && t.status !== "running")
        .sort((a, b) => (b.executedAtMs || b.createdAtMs) - (a.executedAtMs || a.createdAtMs))
        .slice(0, MAX_STORED_HISTORY);
      const trimmed = [...active, ...finished].sort((a, b) => a.triggerAtMs - b.triggerAtMs);
      this.tasks = trimmed;

      const tmpPath = `${this.storagePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ timezone: "Asia/Kolkata", tasks: trimmed }, null, 2), "utf8");
      fs.renameSync(tmpPath, this.storagePath);
    } catch (err: any) {
      console.warn("[TaskScheduler] Failed to persist scheduled tasks:", err?.message);
    }
  }

  private recoverOnStartup(): void {
    const now = Date.now();
    let changed = false;

    for (const task of [...this.tasks]) {
      if (task.status === "running") {
        task.status = "failed";
        task.error = "Interrupted by server restart while running.";
        task.executedAtMs = now;
        task.executedAtIst = formatIstDateTime(now);
        changed = true;
        continue;
      }

      if (task.status !== "pending") continue;

      const overdueMs = now - task.triggerAtMs;
      if (overdueMs > 0) {
        if (isPowerActionTask(task) && overdueMs > 20_000) {
          task.status = "missed";
          task.resultMessage = "Missed scheduled power window while ERA was offline (skipped for safety).";
          task.executedAtMs = now;
          task.executedAtIst = formatIstDateTime(now);
          changed = true;
          this.maybeScheduleNextDaily(task);
        } else if (overdueMs <= 60_000) {
          // Within 60s grace window: run right away
          void this.executeTask(task.id);
        } else {
          task.status = "missed";
          task.resultMessage = "Missed scheduled time while ERA was offline.";
          task.executedAtMs = now;
          task.executedAtIst = formatIstDateTime(now);
          changed = true;
          this.maybeScheduleNextDaily(task);
        }
      } else {
        this.armShortTimerIfClose(task, now);
      }
    }

    if (changed) {
      this.saveToDisk();
    }
  }

  private armShortTimerIfClose(task: ScheduledTask, nowMs: number = Date.now()): void {
    if (task.status !== "pending") return;
    if (this.shortTimers.has(task.id)) return;

    const remainingMs = task.triggerAtMs - nowMs;
    if (remainingMs <= MAX_SHORT_TIMER_MS) {
      const delay = Math.max(0, remainingMs);
      const timer = setTimeout(() => {
        this.shortTimers.delete(task.id);
        void this.executeTask(task.id);
      }, delay);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.shortTimers.set(task.id, timer);
    }
  }

  public scheduleTask(input: CreateScheduledTaskInput, nowMs: number = Date.now()): {
    success: boolean;
    message: string;
    task?: ScheduledTask;
    error?: string;
  } {
    if (!this.started) {
      this.start();
    }

    const parsedTime = parseIstScheduleTime(
      {
        delaySeconds: input.delaySeconds,
        delayMinutes: input.delayMinutes,
        delayHours: input.delayHours,
        targetTimeIst: input.targetTimeIst,
        query: input.query,
      },
      nowMs
    );

    if (!parsedTime.ok || !parsedTime.triggerAtMs) {
      return {
        success: false,
        error: parsedTime.error || "Invalid schedule time.",
        message: parsedTime.error || "Could not parse schedule time in IST.",
      };
    }

    const triggerAtMs = parsedTime.triggerAtMs;
    const recurrence: ScheduledTaskRecurrence = input.recurrence || parsedTime.recurrence || "once";

    // Normalize shutdown/restart args so scheduled execution fires promptly at trigger time
    let normalizedToolArgs = input.toolArgs ? { ...input.toolArgs } : undefined;
    if (input.taskType === "tool" && input.toolName === "systemControl" && normalizedToolArgs) {
      const act = String(normalizedToolArgs.action || "").toLowerCase();
      if (act === "shutdown" || act === "restart") {
        normalizedToolArgs.confirmed = true;
        if (normalizedToolArgs.delay_seconds === undefined && normalizedToolArgs.delaySeconds === undefined) {
          normalizedToolArgs.delay_seconds = 3;
        }
      }
      delete normalizedToolArgs.delaySeconds;
      delete normalizedToolArgs.scheduledTimeIst;
      delete normalizedToolArgs.targetTimeIst;
    }

    // Semantic deduplication: prevent duplicate parallel tasks or fuzzy autonomous_goal + exact tool on same turn
    const newWhatsAppContact = String(normalizedToolArgs?.contactName || normalizedToolArgs?.contact || "").trim().toLowerCase();
    const isNewWhatsAppTool =
      input.taskType === "tool" &&
      (input.toolName === "sendWhatsAppMessage" || input.toolName === "sendWhatsAppToMultiple" || input.toolName === "sendWhatsAppFile");
    const isNewPowerTool =
      (input.taskType === "tool" && input.toolName === "systemControl" &&
        ["shutdown", "restart", "sleep"].includes(String(normalizedToolArgs?.action || "").toLowerCase())) ||
      (input.taskType === "agent_command" && ["shutdown_pc", "restart_pc"].includes(String(input.command || "").toLowerCase()));

    const nearbyPending = this.tasks.filter(
      (t) =>
        t.status === "pending" &&
        Math.abs(nowMs - t.createdAtMs) <= 15_000 &&
        Math.abs(triggerAtMs - t.triggerAtMs) <= 15_000
    );

    for (const existing of nearbyPending) {
      // Case 1: Duplicate power action scheduled in the same turn/window
      if (isNewPowerTool && isPowerActionTask(existing)) {
        const delaySec = Math.max(1, Math.round((existing.triggerAtMs - nowMs) / 1000));
        return {
          success: true,
          task: existing,
          message: `Already scheduled "${existing.title}" for ${existing.scheduledForIst} (in ${formatHumanDuration(delaySec)}). Task ID: ${existing.id}`,
        };
      }
      // Case 2: Exact duplicate tool call
      if (
        input.taskType === "tool" &&
        existing.taskType === "tool" &&
        existing.toolName === input.toolName &&
        JSON.stringify(existing.toolArgs || {}) === JSON.stringify(normalizedToolArgs || {})
      ) {
        const delaySec = Math.max(1, Math.round((existing.triggerAtMs - nowMs) / 1000));
        return {
          success: true,
          task: existing,
          message: `Already scheduled "${existing.title}" for ${existing.scheduledForIst} (in ${formatHumanDuration(delaySec)}). Task ID: ${existing.id}`,
        };
      }
      // Case 3: Upgrade fuzzy WhatsApp autonomous_goal -> exact sendWhatsAppMessage tool (or vice versa skip duplicate goal)
      if (isNewWhatsAppTool && existing.taskType === "autonomous_goal" && /\bwhatsapp\b/i.test(existing.objective || existing.title)) {
        const objLower = (existing.objective || existing.title).toLowerCase();
        if (!newWhatsAppContact || objLower.includes(newWhatsAppContact)) {
          const timer = this.shortTimers.get(existing.id);
          if (timer) {
            clearTimeout(timer);
            this.shortTimers.delete(existing.id);
          }
          existing.status = "cancelled";
          existing.executedAtMs = nowMs;
          existing.executedAtIst = formatIstDateTime(nowMs);
          existing.resultMessage = "Superseded by exact scheduled WhatsApp tool task.";
        }
      } else if (
        input.taskType === "autonomous_goal" &&
        /\bwhatsapp\b/i.test(input.objective || input.title) &&
        existing.taskType === "tool" &&
        (existing.toolName === "sendWhatsAppMessage" || existing.toolName === "sendWhatsAppToMultiple" || existing.toolName === "sendWhatsAppFile")
      ) {
        const delaySec = Math.max(1, Math.round((existing.triggerAtMs - nowMs) / 1000));
        return {
          success: true,
          task: existing,
          message: `Already scheduled "${existing.title}" for ${existing.scheduledForIst} (in ${formatHumanDuration(delaySec)}). Task ID: ${existing.id}`,
        };
      }
    }

    const id = `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const task: ScheduledTask = {
      id,
      title: (input.title || "Scheduled Task").trim(),
      taskType: input.taskType,
      toolName: input.toolName,
      toolArgs: normalizedToolArgs,
      command: input.command,
      commandParams: input.commandParams,
      objective: input.objective,
      runInBackground: input.runInBackground,
      alarmMessage: input.alarmMessage,
      source: input.source || "voice",
      recurrence,
      createdAtMs: nowMs,
      createdAtIst: formatIstDateTime(nowMs),
      triggerAtMs,
      scheduledForIst: formatIstDateTime(triggerAtMs),
      scheduledForIsoIst: formatIstIso(triggerAtMs),
      status: "pending",
      warningSent: false,
    };

    this.tasks.push(task);
    this.saveToDisk();
    this.armShortTimerIfClose(task, nowMs);

    void this.emitEvent("created", task);

    const delaySec = Math.max(1, Math.round((triggerAtMs - nowMs) / 1000));
    return {
      success: true,
      task,
      message: `Scheduled "${task.title}" for ${task.scheduledForIst} (in ${formatHumanDuration(delaySec)})${recurrence === "daily" ? " [Daily]" : ""}. Task ID: ${task.id}`,
    };
  }

  public listTasks(statusFilter?: ScheduledTaskStatus | "all", nowMs: number = Date.now()): Array<ScheduledTask & { remainingSeconds: number }> {
    if (!this.started) {
      this.start();
    }
    const filtered =
      !statusFilter || statusFilter === "all"
        ? this.tasks
        : this.tasks.filter((t) => t.status === statusFilter);

    return filtered
      .slice()
      .sort((a, b) => a.triggerAtMs - b.triggerAtMs)
      .map((t) => ({
        ...t,
        remainingSeconds: t.status === "pending" ? Math.max(0, Math.round((t.triggerAtMs - nowMs) / 1000)) : 0,
      }));
  }

  public cancelTask(idOrQuery: string): {
    success: boolean;
    cancelledCount: number;
    cancelledTasks: ScheduledTask[];
    message: string;
  } {
    if (!this.started) {
      this.start();
    }
    const q = (idOrQuery || "").trim().toLowerCase();
    const now = Date.now();
    const pending = this.tasks.filter((t) => t.status === "pending");

    let targets: ScheduledTask[] = [];
    if (!q || q === "all" || q === "sab" || q === "everything") {
      targets = pending;
    } else if (q === "last" || q === "latest" || q === "recent") {
      const sorted = pending.slice().sort((a, b) => b.createdAtMs - a.createdAtMs);
      if (sorted.length > 0) targets = [sorted[0]];
    } else {
      const exact = pending.filter((t) => t.id.toLowerCase() === q);
      if (exact.length > 0) {
        targets = exact;
      } else {
        targets = pending.filter((t) => {
          const hay = `${t.title} ${t.toolName || ""} ${t.command || ""} ${t.objective || ""} ${t.alarmMessage || ""} ${JSON.stringify(t.toolArgs || {})}`.toLowerCase();
          return hay.includes(q);
        });
      }
    }

    if (targets.length === 0) {
      return {
        success: false,
        cancelledCount: 0,
        cancelledTasks: [],
        message: pending.length === 0
          ? "Abhi koi pending scheduled task ya alarm nahi hai."
          : `"${idOrQuery}" se match karta hua koi pending scheduled task nahi mila.`,
      };
    }

    for (const t of targets) {
      const timer = this.shortTimers.get(t.id);
      if (timer) {
        clearTimeout(timer);
        this.shortTimers.delete(t.id);
      }
      t.status = "cancelled";
      t.executedAtMs = now;
      t.executedAtIst = formatIstDateTime(now);
      t.resultMessage = "Cancelled by user.";
    }

    this.saveToDisk();
    for (const t of targets) {
      void this.emitEvent("cancelled", t);
    }

    const labels = targets.map((t) => `"${t.title}" (${t.scheduledForIst})`).join(", ");
    return {
      success: true,
      cancelledCount: targets.length,
      cancelledTasks: targets,
      message: `Cancelled ${targets.length} scheduled task(s): ${labels}.`,
    };
  }

  public cancelPendingPowerTasks(): ScheduledTask[] {
    if (!this.started) {
      this.start();
    }
    const now = Date.now();
    const targets = this.tasks.filter((t) => t.status === "pending" && isPowerActionTask(t));
    if (targets.length === 0) return [];

    for (const t of targets) {
      const timer = this.shortTimers.get(t.id);
      if (timer) {
        clearTimeout(timer);
        this.shortTimers.delete(t.id);
      }
      t.status = "cancelled";
      t.executedAtMs = now;
      t.executedAtIst = formatIstDateTime(now);
      t.resultMessage = "Cancelled via shutdown abort.";
    }
    this.saveToDisk();
    for (const t of targets) {
      void this.emitEvent("cancelled", t);
    }
    return targets;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const task of [...this.tasks]) {
      if (task.status !== "pending") continue;

      const remainingMs = task.triggerAtMs - now;

      // T-10s warning for scheduled shutdown/restart tasks with >=25s total duration
      if (
        isPowerActionTask(task) &&
        !task.warningSent &&
        task.triggerAtMs - task.createdAtMs >= 25_000 &&
        remainingMs > 2_000 &&
        remainingMs <= 11_000
      ) {
        task.warningSent = true;
        this.saveToDisk();
        void this.emitEvent("warning", task);
      }

      if (remainingMs <= 250) {
        void this.executeTask(task.id);
      } else if (remainingMs <= MAX_SHORT_TIMER_MS) {
        this.armShortTimerIfClose(task, now);
      }
    }
  }

  public async executeTask(taskId: string): Promise<void> {
    if (this.executingIds.has(taskId)) return;
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== "pending") return;

    this.executingIds.add(taskId);
    const existingTimer = this.shortTimers.get(taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.shortTimers.delete(taskId);
    }

    task.status = "running";
    this.saveToDisk();

    let execResult: { success: boolean; message: string; data?: any } = {
      success: true,
      message: "Task executed.",
    };

    try {
      if (task.taskType === "alarm") {
        const msg = task.alarmMessage || task.title || "Alarm triggered!";
        execResult = {
          success: true,
          message: `Alarm triggered at ${formatIstDateTime(Date.now())}: ${msg}`,
          data: { alarmMessage: msg },
        };
      } else if (task.taskType === "tool" && task.toolName) {
        if (!this.callbacks?.executeTool) {
          throw new Error("Tool executor callback is not registered.");
        }
        const args: Record<string, any> = { ...(task.toolArgs || {}) };
        // Always strip schedule timing fields so the tool executes now and NEVER re-schedules itself
        delete args.delaySeconds;
        delete args.delayMinutes;
        delete args.delayHours;
        delete args.scheduledTimeIst;
        delete args.targetTimeIst;

        if (task.toolName === "systemControl") {
          const act = String(args.action || "").toLowerCase();
          if (act === "shutdown" || act === "restart" || act === "sleep") {
            args.confirmed = true;
            if (args.delay_seconds === undefined) {
              args.delay_seconds = 3;
            }
          }
        } else {
          delete args.delay_seconds;
        }
        args.__fromScheduler = true;
        const res = await this.callbacks.executeTool(task.toolName, args);
        execResult = {
          success: res?.success !== false,
          message: res?.message || res?.output || `Executed ${task.toolName}`,
          data: res,
        };
      } else if (task.taskType === "agent_command" && task.command) {
        if (!this.callbacks?.executeAgentCommand) {
          throw new Error("Agent command executor callback is not registered.");
        }
        execResult = await this.callbacks.executeAgentCommand(task.command, task.commandParams || {});
      } else if (task.taskType === "autonomous_goal" || task.objective) {
        if (!this.callbacks?.executeAutonomousGoal) {
          throw new Error("Autonomous goal executor callback is not registered.");
        }
        const obj = task.objective || task.title;
        const res = await this.callbacks.executeAutonomousGoal(obj, task.runInBackground ?? false);
        execResult = {
          success: res?.status !== "FAILED",
          message: res?.finalReport?.summary || res?.message || `Executed autonomous objective: ${obj}`,
          data: res,
        };
      } else {
        throw new Error(`Unsupported scheduled task configuration (${task.taskType}).`);
      }

      const doneMs = Date.now();
      task.status = execResult.success ? "completed" : "failed";
      task.executedAtMs = doneMs;
      task.executedAtIst = formatIstDateTime(doneMs);
      task.resultMessage = execResult.message;
      if (!execResult.success) {
        task.error = execResult.message;
      }
    } catch (err: any) {
      const doneMs = Date.now();
      task.status = "failed";
      task.executedAtMs = doneMs;
      task.executedAtIst = formatIstDateTime(doneMs);
      task.error = err?.message || String(err);
      task.resultMessage = `Execution failed: ${task.error}`;
      execResult = { success: false, message: task.resultMessage };
    } finally {
      this.executingIds.delete(taskId);
      this.maybeScheduleNextDaily(task);
      this.saveToDisk();
      await this.emitEvent("triggered", task, execResult);
    }
  }

  private maybeScheduleNextDaily(completedTask: ScheduledTask): void {
    if (completedTask.recurrence !== "daily") return;
    if (completedTask.status === "cancelled") return;

    const origIst = getIstDateParts(completedTask.triggerAtMs);
    const nextDate = new Date(Date.UTC(origIst.year, origIst.month - 1, origIst.day + 1, 0, 0, 0));
    const nextTriggerMs = istWallClockToEpochMs(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      origIst.hour24,
      origIst.minute,
      origIst.second
    );

    const nowMs = Date.now();
    if (nextTriggerMs <= nowMs) return;

    const nextTask: ScheduledTask = {
      ...completedTask,
      id: `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      createdAtMs: nowMs,
      createdAtIst: formatIstDateTime(nowMs),
      triggerAtMs: nextTriggerMs,
      scheduledForIst: formatIstDateTime(nextTriggerMs),
      scheduledForIsoIst: formatIstIso(nextTriggerMs),
      status: "pending",
      warningSent: false,
      executedAtMs: undefined,
      executedAtIst: undefined,
      resultMessage: undefined,
      error: undefined,
    };

    this.tasks.push(nextTask);
    this.armShortTimerIfClose(nextTask, nowMs);
  }

  private async emitEvent(
    type: "created" | "warning" | "triggered" | "cancelled" | "updated",
    task: ScheduledTask,
    result?: { success: boolean; message: string; data?: any }
  ): Promise<void> {
    if (!this.callbacks?.onEvent) return;
    try {
      await this.callbacks.onEvent({
        type,
        task: { ...task },
        result,
        allTasks: this.listTasks("all"),
      });
    } catch (err: any) {
      console.warn("[TaskScheduler] Event handler error:", err?.message);
    }
  }
}

/**
 * Deterministic natural-language extractor for scheduled tasks in English & Hinglish.
 * Maps clear OS/hardware/app/alarm commands directly to fast tools, and maps any arbitrary
 * or multi-step instruction to `autonomous_goal` so ANYTHING the user schedules executes automatically.
 */
export function buildScheduledTaskInputFromNaturalText(
  query: string,
  source: "voice" | "chat" | "api" = "chat",
  nowMs: number = Date.now()
): { ok: true; input: CreateScheduledTaskInput; parsedTime: ReturnType<typeof parseIstScheduleTime> } | { ok: false; error: string } {
  const parsedTime = parseIstScheduleTime({ query }, nowMs);
  if (!parsedTime.ok || !parsedTime.triggerAtMs) {
    return { ok: false, error: parsedTime.error || "Could not detect schedule time." };
  }

  const rawRemainder = (parsedTime.remainderText || query || "").trim();
  const cleanActionText = rawRemainder
    .replace(/\b(?:hey\s+era|hey\s+eira|era|eira|please|plz|boss|sir|apne\s+aap|automatically|auto|khud\s+se|khud)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lower = cleanActionText.toLowerCase();
  const fullLower = query.toLowerCase();

  // Helper to return structured input
  const wrap = (partial: Omit<CreateScheduledTaskInput, "source" | "delaySeconds" | "targetTimeIst" | "query" | "recurrence">): {
    ok: true;
    input: CreateScheduledTaskInput;
    parsedTime: ReturnType<typeof parseIstScheduleTime>;
  } => ({
    ok: true,
    parsedTime,
    input: {
      ...partial,
      source,
      recurrence: parsedTime.recurrence || "once",
      // Pass exact resolved IST time so scheduleTask doesn't re-parse relative to a later ms
      targetTimeIst: parsedTime.scheduledForIsoIst,
    },
  });

  // 1. Shutdown / Restart / Sleep / Lock
  if (/\b(shutdown|shut\s*down)\b/i.test(lower) || /\b(?:pc|laptop|computer|system)\s+band\b/i.test(lower)) {
    return wrap({
      title: "PC Shutdown",
      taskType: "tool",
      toolName: "systemControl",
      toolArgs: { action: "shutdown", confirmed: true, delay_seconds: 3 },
    });
  }

  if (/\b(restart|reboot)\b/i.test(lower)) {
    return wrap({
      title: "PC Restart",
      taskType: "tool",
      toolName: "systemControl",
      toolArgs: { action: "restart", confirmed: true, delay_seconds: 3 },
    });
  }

  if (/\b(sleep|hibernate)\b/i.test(lower) && /\b(pc|laptop|computer|system|kar|karo|kardo|karna)\b/i.test(lower)) {
    return wrap({
      title: "PC Sleep",
      taskType: "tool",
      toolName: "systemControl",
      toolArgs: { action: "sleep", confirmed: true },
    });
  }

  if (/\b(lock\s*(?:screen|pc|laptop|computer)|(?:screen|pc|laptop|computer)\s*lock)\b/i.test(lower)) {
    return wrap({
      title: "Lock PC",
      taskType: "tool",
      toolName: "lockPC",
      toolArgs: {},
    });
  }

  // 2. Display Brightness
  if (/\b(brightness|screen\s*light)\b/i.test(lower)) {
    const pctMatch = lower.match(/\b(\d{1,3})\s*%?/);
    if (pctMatch) {
      const level = Math.max(0, Math.min(100, parseInt(pctMatch[1], 10)));
      return wrap({
        title: `Set Screen Brightness to ${level}%`,
        taskType: "tool",
        toolName: "setDisplayBrightness",
        toolArgs: { level },
      });
    }
    if (/\b(full|max|maximum|100)\b/i.test(lower)) {
      return wrap({
        title: "Set Screen Brightness to 100%",
        taskType: "tool",
        toolName: "setDisplayBrightness",
        toolArgs: { level: 100 },
      });
    }
    if (/\b(increase|up|badha|badhao|brighter|tez|zyada|high)\b/i.test(lower)) {
      return wrap({
        title: "Increase Screen Brightness",
        taskType: "tool",
        toolName: "adjustDisplayBrightness",
        toolArgs: { delta: 20 },
      });
    }
    if (/\b(decrease|down|dim|lower|kam|ghata|ghatao|low)\b/i.test(lower)) {
      return wrap({
        title: "Decrease Screen Brightness",
        taskType: "tool",
        toolName: "adjustDisplayBrightness",
        toolArgs: { delta: -20 },
      });
    }
  }

  // 3. Audio Volume / Mute
  if (/\b(unmute)\b/i.test(lower)) {
    return wrap({
      title: "Unmute Audio",
      taskType: "tool",
      toolName: "toggleAudioMute",
      toolArgs: { mute: false },
    });
  }
  if (/\b(mute|awaz\s*band|sound\s*band)\b/i.test(lower)) {
    return wrap({
      title: "Mute Audio",
      taskType: "tool",
      toolName: "toggleAudioMute",
      toolArgs: { mute: true },
    });
  }
  if (/\b(volume|sound|audio|awaz|awaaz)\b/i.test(lower)) {
    const pctMatch = lower.match(/\b(\d{1,3})\s*%?/);
    if (pctMatch) {
      const level = Math.max(0, Math.min(100, parseInt(pctMatch[1], 10)));
      return wrap({
        title: `Set Audio Volume to ${level}%`,
        taskType: "tool",
        toolName: "setAudioVolume",
        toolArgs: { level },
      });
    }
    if (/\b(full|max|maximum)\b/i.test(lower)) {
      return wrap({
        title: "Set Audio Volume to 100%",
        taskType: "tool",
        toolName: "setAudioVolume",
        toolArgs: { level: 100 },
      });
    }
    if (/\b(increase|up|badha|badhao|louder|tez)\b/i.test(lower)) {
      return wrap({
        title: "Increase Audio Volume",
        taskType: "tool",
        toolName: "adjustAudioVolume",
        toolArgs: { delta: 15 },
      });
    }
    if (/\b(decrease|down|lower|kam|ghata|dheema)\b/i.test(lower)) {
      return wrap({
        title: "Decrease Audio Volume",
        taskType: "tool",
        toolName: "adjustAudioVolume",
        toolArgs: { delta: -15 },
      });
    }
  }

  // 4. Bluetooth & Wi-Fi & Keyboard Backlight
  if (/\b(bluetooth)\b/i.test(lower)) {
    const enable = !/\b(off|disable|band|disconnect|stop)\b/i.test(lower);
    return wrap({
      title: `Turn ${enable ? "ON" : "OFF"} Bluetooth`,
      taskType: "tool",
      toolName: "setBluetoothState",
      toolArgs: { enable },
    });
  }
  if (/\b(wifi|wi-fi)\b/i.test(lower)) {
    const enable = !/\b(off|disable|band|disconnect|stop)\b/i.test(lower);
    return wrap({
      title: `Turn ${enable ? "ON" : "OFF"} Wi-Fi`,
      taskType: "tool",
      toolName: "setWifiState",
      toolArgs: { enable },
    });
  }
  if (/\b(keyboard\s*light|key\s*light|backlight)\b/i.test(lower)) {
    const pctMatch = lower.match(/\b(\d{1,3})\s*%?/);
    const level = pctMatch ? Math.max(0, Math.min(100, parseInt(pctMatch[1], 10))) : /\b(off|band|bujha)\b/i.test(lower) ? 0 : 100;
    return wrap({
      title: `Set Keyboard Backlight to ${level}%`,
      taskType: "tool",
      toolName: "setKeyboardBacklight",
      toolArgs: { level },
    });
  }

  // 5. Close Browser / Minimize All
  if (/\b(close\s+browser|browser\s+band|chrome\s+band)\b/i.test(lower)) {
    return wrap({
      title: "Close Browser",
      taskType: "tool",
      toolName: "closeBrowser",
      toolArgs: {},
    });
  }
  if (/\b(minimize\s+all|show\s+desktop)\b/i.test(lower)) {
    return wrap({
      title: "Minimize All Windows",
      taskType: "tool",
      toolName: "minimizeAll",
      toolArgs: {},
    });
  }

  // 5b. Scheduled WhatsApp Text Message (single recipient)
  if (
    /\bwhatsapp\b/i.test(lower) &&
    /\b(bhej|bhejo|bhej\s*do|bhej\s*dena|send|likh\s*kar|likhkar|likh\s*ke|message|msg|bol|bolo)\b/i.test(lower) &&
    !/\b(file|pdf|document|doc|script|photo|image|video|\.py|\.txt|\.docx|\.xlsx)\b/i.test(lower)
  ) {
    // Pattern 1: "<contact> ko [whatsapp par/pe/per] [message/msg] <msg> [likhkar/bhej do/send karo]"
    const koMatch = cleanActionText.match(
      /(?:^|\b(?:karo|karna|kardo|to|for)\s+)([A-Za-z0-9_+.-]{2,30}(?:\s+[A-Za-z0-9_+.-]{2,20})?)\s+ko\s+(?:(?:whatsapp\s+(?:par|pe|per)\s+)|(?:message|msg)\s+)*(.+?)(?:\s+(?:likh\s*(?:kar|ke)|likhkar|bol\s*kar|karke|kar\s*ke)?\s*(?:bhej(?:\s*do|\s*dena|o)?|send(?:\s*karo|\s*kar\s*do|\s*kardo)?|kar\s*do|kardo|karna))?\s*$/i
    );
    // Pattern 2: "send [whatsapp message] <msg> to <contact>"
    const sendToMatch = !koMatch
      ? cleanActionText.match(
          /\bsend\s+(?:whatsapp\s+)?(?:message\s+|msg\s+)?(?:["']([^"']+)["']|(.+?))\s+to\s+([A-Za-z0-9_+.-]{2,30}(?:\s+[A-Za-z0-9_+.-]{2,20})?)(?:\s+on\s+whatsapp)?\s*$/i
        )
      : null;

    let waContact = koMatch?.[1]?.trim() || sendToMatch?.[3]?.trim() || "";
    let waMsg = (koMatch?.[2] || sendToMatch?.[1] || sendToMatch?.[2] || "").trim();
    waContact = waContact.replace(/^(?:achha|acha|ek\s+kaam\s+karo|whatsapp|par|pe|per)\s+/gi, "").trim();
    waMsg = waMsg
      .replace(/^(?:par|pe|per|mein|me|mai|ki|ka|ke|message|msg|text)\s+/gi, "")
      .replace(/^["']|["']$/g, "")
      .trim();

    if (waContact && waMsg && !/\b(aur|and)\b/i.test(waContact)) {
      return wrap({
        title: `WhatsApp ${waContact}: ${waMsg.slice(0, 28)}`,
        taskType: "tool",
        toolName: "sendWhatsAppMessage",
        toolArgs: { contactName: waContact, message: waMsg },
      });
    }
  }

  // 6. Simple App / Website Launch (when not a multi-step command like "notepad me ... likho" or "chrome me github khol ke login check karna")
  const isCompoundTask =
    /\b(likho|likh|write|type|send|bhej|bhejo|play|chalao\s+song|search|khojo|build|banao|check|login|click|scroll|run|download|install|copy|paste|karke|kar\s+ke|khol\s+ke|open\s+karke)\b/i.test(lower) ||
    lower.split(/\s+/).filter(Boolean).length > 5;
  if (!isCompoundTask) {
    if (/\b(youtube|yt)\b/i.test(lower) && /\b(open|khol|kholo|chalu|launch|start)\b/i.test(lower)) {
      return wrap({
        title: "Open YouTube",
        taskType: "tool",
        toolName: "openWebsite",
        toolArgs: { url: "https://www.youtube.com" },
      });
    }
    const urlMatch = cleanActionText.match(/(https?:\/\/[^\s]+|(?:www\.)?[a-z0-9-]+\.(?:com|in|org|io|net|ai|dev)(?:\/[^\s]*)?)/i);
    if (urlMatch && /\b(open|khol|kholo|launch|visit)\b/i.test(lower)) {
      const u = urlMatch[1].startsWith("http") ? urlMatch[1] : `https://${urlMatch[1]}`;
      return wrap({
        title: `Open ${urlMatch[1]}`,
        taskType: "tool",
        toolName: "openWebsite",
        toolArgs: { url: u },
      });
    }
    const simpleApps: Record<string, string> = {
      chrome: "chrome",
      "google chrome": "chrome",
      vscode: "vscode",
      "vs code": "vscode",
      notepad: "notepad",
      calculator: "calculator",
      calc: "calculator",
      whatsapp: "whatsapp",
      spotify: "spotify",
      explorer: "explorer",
      "file explorer": "explorer",
      camera: "camera",
      terminal: "terminal",
      cmd: "cmd",
      settings: "settings",
      paint: "paint",
    };
    if (/\b(open|khol|kholo|chalu|launch|start)\b/i.test(lower)) {
      for (const [k, appName] of Object.entries(simpleApps)) {
        if (new RegExp(`\\b${k}\\b`, "i").test(lower)) {
          return wrap({
            title: `Open ${appName}`,
            taskType: "tool",
            toolName: "openApplication",
            toolArgs: { appName },
          });
        }
      }
    }
  }

  // 7. Pure Alarm / Reminder (only if no execution verbs for desktop automation)
  const isPureAlarm =
    /\b(alarm|timer|remind|reminder|yaad\s+dila(?:na|o|dena|do))\b/i.test(fullLower) &&
    !/\b(shutdown|restart|brightness|volume|wifi|bluetooth|open|khol|send|bhej|type|likh|lock|sleep|click|play|call)\b/i.test(lower);

  if (isPureAlarm) {
    const cleanedMsg = cleanActionText
      .replace(/\b(?:alarm|timer|set|laga|lagao|laga\s*do|kar\s*do|kar\s*dena|kardo|karna|remind|reminder|me|mujhe|yaad\s+dila(?:na|o|dena|do)|ka|ki|ke|baja|bajao|baja\s*dena)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const label = cleanedMsg ? `Alarm: ${cleanedMsg}` : "Scheduled Alarm";
    return wrap({
      title: label,
      taskType: "alarm",
      alarmMessage: cleanedMsg || "Aapka set kiya hua alarm baj raha hai!",
    });
  }

  // 8. Arbitrary / Multi-step Task -> Autonomous Goal Executor!
  const goalObjective = cleanActionText || query;
  const runInBg = /\b(background|piche|bina\s+screen)\b/i.test(fullLower);
  return wrap({
    title: goalObjective.length > 64 ? `${goalObjective.slice(0, 61)}...` : goalObjective,
    taskType: "autonomous_goal",
    objective: goalObjective,
    runInBackground: runInBg,
  });
}
