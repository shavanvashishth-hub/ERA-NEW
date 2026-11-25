import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { matchInstantCommand } from "../server/agentBridge";
import {
  formatIstDateTime,
  formatIstIso,
  getIstDateParts,
  getIstGreeting,
  hasExplicitSchedulePhrase,
  istWallClockToEpochMs,
  parseIstScheduleTime,
} from "../server/istTime";
import {
  buildScheduledTaskInputFromNaturalText,
  TaskScheduler,
} from "../server/taskScheduler";

async function runTests() {
  console.log("=== 1. Testing IST Clock Arithmetic (Asia/Kolkata, UTC+05:30) ===");
  // 2026-11-11T15:10:00Z == 2026-11-11T20:40:00+05:30 (8:40:00 PM IST)
  const fixedUtcMs = Date.UTC(2026, 10, 11, 15, 10, 0, 0);
  const parts = getIstDateParts(fixedUtcMs);
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 11);
  assert.equal(parts.day, 11);
  assert.equal(parts.hour24, 20);
  assert.equal(parts.hour12, 8);
  assert.equal(parts.ampm, "PM");
  assert.equal(parts.minute, 40);
  assert.equal(parts.second, 0);
  assert.equal(parts.isoIst, "2026-11-11T20:40:00+05:30");
  assert.equal(formatIstIso(fixedUtcMs), "2026-11-11T20:40:00+05:30");
  assert.equal(istWallClockToEpochMs(2026, 11, 11, 20, 40, 0), fixedUtcMs);
  assert.equal(getIstGreeting(istWallClockToEpochMs(2026, 11, 11, 8, 0, 0)), "Good morning");
  assert.equal(getIstGreeting(istWallClockToEpochMs(2026, 11, 11, 14, 0, 0)), "Good afternoon");
  assert.equal(getIstGreeting(istWallClockToEpochMs(2026, 11, 11, 20, 40, 0)), "Good night");

  console.log("=== 2. Testing hasExplicitSchedulePhrase & matchInstantCommand guard ===");
  const positiveScheduleInputs = [
    "era mera pc ek min kai bad shutdown kar dena",
    "1 min ke baad pc shutdown kar dena",
    "2 minute baad screen brightness 30% kar dena",
    "after 30 seconds restart pc",
    "in 5 minutes open youtube",
    "exact 9:30 PM pe brightness kam kar dena",
    "fix 21:15 pe notepad open kar dena",
    "raat ko 10 baj kar 15 minute pe bluetooth off kar dena",
    "kal subah 7 baje alarm laga dena",
    "subah 6:30 baje wifi on kar dena",
    "5 min baad volume 80 kar dena",
  ];
  for (const q of positiveScheduleInputs) {
    assert.equal(hasExplicitSchedulePhrase(q), true, `Expected schedule phrase true for: ${q}`);
    assert.equal(matchInstantCommand(q), null, `matchInstantCommand must NOT hijack scheduled command: ${q}`);
  }

  const negativeScheduleInputs = [
    "open chrome",
    "youtube kholo",
    "screen brightness 50 kar do",
    "kal kya baat hui thi",
    "abhi time kya hua hai",
    "battery kitni hai",
    "what did I ask yesterday",
  ];
  for (const q of negativeScheduleInputs) {
    assert.equal(hasExplicitSchedulePhrase(q), false, `Expected schedule phrase false for: ${q}`);
  }
  assert.notEqual(matchInstantCommand("open chrome"), null);
  assert.notEqual(matchInstantCommand("youtube kholo"), null);

  console.log("=== 3. Testing parseIstScheduleTime (Relative + Exact IST Clock) ===");
  const r1 = parseIstScheduleTime({ query: "era mera pc ek min ke baad shutdown kar dena" }, fixedUtcMs);
  assert.equal(r1.ok, true);
  assert.equal(r1.triggerAtMs, fixedUtcMs + 60_000);
  assert.equal(r1.scheduledForIsoIst, "2026-11-11T20:41:00+05:30");

  const r2 = parseIstScheduleTime({ query: "ek min kai bad screen brightness 35% kar dena" }, fixedUtcMs);
  assert.equal(r2.ok, true);
  assert.equal(r2.triggerAtMs, fixedUtcMs + 60_000);

  const r3 = parseIstScheduleTime({ query: "30 second baad volume 60 kar dena" }, fixedUtcMs);
  assert.equal(r3.ok, true);
  assert.equal(r3.triggerAtMs, fixedUtcMs + 30_000);

  // Ambiguous "exact 9 baje" at 20:40 IST should pick 21:00 IST today (NOT 09:00 AM tomorrow!)
  const r4 = parseIstScheduleTime({ query: "exact 9 baje brightness 25% kar dena" }, fixedUtcMs);
  assert.equal(r4.ok, true);
  assert.equal(r4.scheduledForIsoIst, "2026-11-11T21:00:00+05:30");

  // Explicit "kal subah 7:30 baje" at 20:40 IST on Nov 11 -> Nov 12 07:30:00+05:30
  const r5 = parseIstScheduleTime({ query: "kal subah 7:30 baje alarm laga dena" }, fixedUtcMs);
  assert.equal(r5.ok, true);
  assert.equal(r5.scheduledForIsoIst, "2026-11-12T07:30:00+05:30");

  // Naive ISO targetTimeIst must be treated strictly as IST (+05:30), NOT UTC!
  const r6 = parseIstScheduleTime({ targetTimeIst: "2026-11-11T21:15:00" }, fixedUtcMs);
  assert.equal(r6.ok, true);
  assert.equal(r6.scheduledForIsoIst, "2026-11-11T21:15:00+05:30");

  // "9 baj kar 15 minute pe" at 20:40 IST -> 21:15:00+05:30
  const r7 = parseIstScheduleTime({ query: "9 baj kar 15 minute pe wifi off kar dena" }, fixedUtcMs);
  assert.equal(r7.ok, true);
  assert.equal(r7.scheduledForIsoIst, "2026-11-11T21:15:00+05:30");

  console.log("=== 4. Testing buildScheduledTaskInputFromNaturalText ===");
  const b1 = buildScheduledTaskInputFromNaturalText("1 min ke baad pc shutdown kar dena", "chat", fixedUtcMs);
  assert.equal(b1.ok, true);
  if (b1.ok) {
    assert.equal(b1.input.toolName, "systemControl");
    assert.equal(b1.input.toolArgs?.action, "shutdown");
    assert.equal(b1.input.toolArgs?.confirmed, true);
  }

  const b2 = buildScheduledTaskInputFromNaturalText("2 min baad screen brightness 30% kar dena", "chat", fixedUtcMs);
  assert.equal(b2.ok, true);
  if (b2.ok) {
    assert.equal(b2.input.toolName, "setDisplayBrightness");
    assert.equal(b2.input.toolArgs?.level, 30);
  }

  const b3 = buildScheduledTaskInputFromNaturalText("exact 21:30 pe restart kar dena", "chat", fixedUtcMs);
  assert.equal(b3.ok, true);
  if (b3.ok) {
    assert.equal(b3.input.toolName, "systemControl");
    assert.equal(b3.input.toolArgs?.action, "restart");
  }

  const b4 = buildScheduledTaskInputFromNaturalText("1 min baad chrome me github khol ke login check karna", "chat", fixedUtcMs);
  assert.equal(b4.ok, true);
  if (b4.ok) {
    assert.equal(b4.input.taskType, "autonomous_goal");
    assert.ok(b4.input.objective?.includes("chrome"));
  }

  const b5 = buildScheduledTaskInputFromNaturalText("kal subah 7 baje alarm laga dena paani peene ka", "chat", fixedUtcMs);
  assert.equal(b5.ok, true);
  if (b5.ok) {
    assert.equal(b5.input.taskType, "alarm");
  }

  console.log("=== 5. Testing Real Alarm-Grade TaskScheduler Execution, Cancellation & Persistence ===");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "era-sched-test-"));
  const storeFile = path.join(tmpDir, "scheduled_tasks.json");

  const executedCalls: Array<{ type: string; name: string; args: any }> = [];
  const events: string[] = [];

  const scheduler = new TaskScheduler(storeFile);
  scheduler.setCallbacks({
    executeTool: async (toolName, args) => {
      executedCalls.push({ type: "tool", name: toolName, args });
      return { success: true, message: `Executed ${toolName}` };
    },
    executeAgentCommand: async (cmd, params) => {
      executedCalls.push({ type: "agent", name: cmd, args: params });
      return { success: true, message: `Executed ${cmd}` };
    },
    executeAutonomousGoal: async (obj, bg) => {
      executedCalls.push({ type: "goal", name: obj, args: { bg } });
      return { status: "COMPLETED", finalReport: { summary: "Goal done" } };
    },
    onEvent: (ev) => {
      events.push(`${ev.type}:${ev.task.id}:${ev.task.status}`);
    },
  });
  scheduler.start();

  // Schedule a tool execution 1 second from now and verify it fires automatically!
  const resBright = scheduler.scheduleTask({
    title: "Test Brightness 45%",
    taskType: "tool",
    toolName: "setDisplayBrightness",
    toolArgs: { level: 45 },
    delaySeconds: 1,
    source: "chat",
  });
  assert.equal(resBright.success, true);
  assert.ok(resBright.task?.id);

  // Schedule a shutdown task 60s out, verify it appears in list, then cancel it via cancelPendingPowerTasks!
  const resShutdown = scheduler.scheduleTask({
    title: "PC Shutdown",
    taskType: "tool",
    toolName: "systemControl",
    toolArgs: { action: "shutdown" },
    delaySeconds: 60,
    source: "voice",
  });
  assert.equal(resShutdown.success, true);
  assert.equal(resShutdown.task?.toolArgs?.confirmed, true);
  assert.equal(resShutdown.task?.toolArgs?.delay_seconds, 3);
  assert.equal(scheduler.listTasks("pending").length, 2);

  const cancelledPower = scheduler.cancelPendingPowerTasks();
  assert.equal(cancelledPower.length, 1);
  assert.equal(cancelledPower[0].status, "cancelled");
  assert.equal(scheduler.listTasks("pending").length, 1);

  // Wait 1.6s for the 1-second brightness task to fire automatically
  await new Promise((r) => setTimeout(r, 1600));

  assert.equal(executedCalls.length, 1);
  assert.equal(executedCalls[0].name, "setDisplayBrightness");
  assert.equal(executedCalls[0].args.level, 45);
  assert.equal(scheduler.listTasks("pending").length, 0);
  const completedList = scheduler.listTasks("completed");
  assert.equal(completedList.length, 1);
  assert.equal(completedList[0].id, resBright.task?.id);
  assert.ok(events.some((e) => e.startsWith("triggered:")));

  // Verify persistence & startup safety:
  // Write a simulated overdue shutdown task (overdue by 60s) + a valid future task, restart scheduler!
  scheduler.stop();
  const pastMs = Date.now() - 60_000;
  const futureMs = Date.now() + 30_000;
  fs.writeFileSync(
    storeFile,
    JSON.stringify({
      timezone: "Asia/Kolkata",
      tasks: [
        {
          id: "sched_missed_shutdown",
          title: "Missed Shutdown",
          taskType: "tool",
          toolName: "systemControl",
          toolArgs: { action: "shutdown", confirmed: true, delay_seconds: 3 },
          source: "voice",
          recurrence: "once",
          createdAtMs: pastMs - 60_000,
          createdAtIst: formatIstDateTime(pastMs - 60_000),
          triggerAtMs: pastMs,
          scheduledForIst: formatIstDateTime(pastMs),
          scheduledForIsoIst: formatIstIso(pastMs),
          status: "pending",
        },
        {
          id: "sched_survive_restart",
          title: "Future Volume Task",
          taskType: "tool",
          toolName: "setAudioVolume",
          toolArgs: { level: 55 },
          source: "chat",
          recurrence: "once",
          createdAtMs: Date.now() - 5000,
          createdAtIst: formatIstDateTime(Date.now() - 5000),
          triggerAtMs: futureMs,
          scheduledForIst: formatIstDateTime(futureMs),
          scheduledForIsoIst: formatIstIso(futureMs),
          status: "pending",
        },
      ],
    }),
    "utf8"
  );

  const scheduler2 = new TaskScheduler(storeFile);
  const afterRestartCalls: string[] = [];
  scheduler2.setCallbacks({
    executeTool: async (toolName) => {
      afterRestartCalls.push(toolName);
      return { success: true, message: "ok" };
    },
    executeAgentCommand: async () => ({ success: true, message: "ok" }),
    executeAutonomousGoal: async () => ({ status: "COMPLETED" }),
  });
  scheduler2.start();
  await new Promise((r) => setTimeout(r, 200));

  // Overdue shutdown MUST NOT fire unexpectedly on startup! It must be marked 'missed'.
  assert.equal(afterRestartCalls.length, 0);
  const missed = scheduler2.listTasks("missed");
  assert.equal(missed.length, 1);
  assert.equal(missed[0].id, "sched_missed_shutdown");
  // Future task survived restart and remains pending!
  const stillPending = scheduler2.listTasks("pending");
  assert.equal(stillPending.length, 1);
  assert.equal(stillPending[0].id, "sched_survive_restart");

  console.log("=== 5. Regression Tests: WhatsApp Natural Scheduling, Dedup & __fromScheduler ===");
  const waBuilt = buildScheduledTaskInputFromNaturalText(
    "1 min ke baad bhaiya ko whatsapp par hello likh kar bhej do",
    "voice",
    fixedUtcMs
  );
  assert.equal(waBuilt.ok, true);
  if (waBuilt.ok) {
    assert.equal(waBuilt.input.toolName, "sendWhatsAppMessage");
    assert.equal(waBuilt.input.toolArgs?.contactName?.toLowerCase(), "bhaiya");
    assert.equal(waBuilt.input.toolArgs?.message?.toLowerCase(), "hello");
  }

  const badMeBuilt = buildScheduledTaskInputFromNaturalText(
    "10 sec bad me pc shutdown kar do",
    "voice",
    fixedUtcMs
  );
  assert.equal(badMeBuilt.ok, true);
  if (badMeBuilt.ok) {
    assert.equal(badMeBuilt.input.toolName, "systemControl");
    assert.equal(badMeBuilt.input.toolArgs?.action, "shutdown");
  }

  // Test dedup: fuzzy autonomous_goal + exact sendWhatsAppMessage for same contact in same turn -> 1 pending task
  const fuzzyGoal = scheduler2.scheduleTask(
    {
      title: "Bhaiya ko WhatsApp par hello",
      taskType: "autonomous_goal",
      objective: "Bhaiya ko WhatsApp par hello bhej do",
      delaySeconds: 120,
      source: "voice",
    },
    fixedUtcMs
  );
  assert.equal(fuzzyGoal.success, true);

  const exactWa = scheduler2.scheduleTask(
    {
      title: "WhatsApp Bhaiya: hello",
      taskType: "tool",
      toolName: "sendWhatsAppMessage",
      toolArgs: { contactName: "Bhaiya", message: "hello" },
      delaySeconds: 121,
      source: "voice",
    },
    fixedUtcMs + 1000
  );
  assert.equal(exactWa.success, true);
  const waPending = scheduler2.listTasks("pending").filter((t) => t.id !== "sched_survive_restart");
  assert.equal(waPending.length, 1, "Expected fuzzy WhatsApp autonomous_goal to be superseded by exact tool task");
  assert.equal(waPending[0].toolName, "sendWhatsAppMessage");

  // Verify executeTask passes __fromScheduler: true and strips scheduling timing keys
  const execCheckArgs: any[] = [];
  const scheduler3 = new TaskScheduler(path.join(tmpDir, "sched3.json"));
  scheduler3.setCallbacks({
    executeTool: async (_name, args) => {
      execCheckArgs.push(args);
      return { success: true, message: "executed once" };
    },
    executeAgentCommand: async () => ({ success: true, message: "ok" }),
    executeAutonomousGoal: async () => ({ status: "COMPLETED" }),
  });
  scheduler3.start();
  const s3 = scheduler3.scheduleTask({
    title: "PC Shutdown",
    taskType: "tool",
    toolName: "systemControl",
    toolArgs: { action: "shutdown", confirmed: true, delaySeconds: 40, scheduledTimeIst: "23:59" },
    delaySeconds: 1,
    source: "voice",
  });
  assert.equal(s3.success, true);
  assert.equal(s3.task?.toolArgs?.delaySeconds, undefined);
  assert.equal(s3.task?.toolArgs?.scheduledTimeIst, undefined);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(execCheckArgs.length, 1);
  assert.equal(execCheckArgs[0].__fromScheduler, true);
  assert.equal(execCheckArgs[0].delaySeconds, undefined);
  scheduler3.stop();

  scheduler2.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log("ALL SCHEDULER & IST TESTS PASSED!");
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
