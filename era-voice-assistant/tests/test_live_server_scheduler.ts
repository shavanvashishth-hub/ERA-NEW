import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";

const PORT = 3099;
const MOCK_AGENT_PORT = 59998;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForHealth(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Timed out waiting for test server health.");
}

async function run() {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), "era-live-e2e-"));
  const serverCjs = path.resolve(process.cwd(), "dist", "server.cjs");
  assert.ok(fs.existsSync(serverCjs), `Missing built server bundle: ${serverCjs}`);

  const env = {
    ...process.env,
    PORT: String(PORT),
    ERA_PORT: String(PORT),
    ERA_DISABLE_SCREEN_STREAMER: "1",
    NODE_ENV: "production",
    ERA_APP_DATA: tmpAppData,
    ERA_CONFIG_DIR: path.join(tmpAppData, "config"),
    ERA_WORKSPACE_DIR: path.join(tmpAppData, "workspace"),
    ERA_DIST_DIR: path.resolve(process.cwd(), "dist"),
    ERA_AGENT_URL: "http://127.0.0.1:59998", // ensure test does not accidentally hit live PC shutdown
    ERA_BRIDGE_URL: "http://127.0.0.1:59997",
  };

  let logs = "";
  const mockAgentCalls: Array<{ command: string; params: any }> = [];
  const mockAgentServer = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "online" }));
      return;
    }
    if (req.method === "POST" && req.url === "/execute") {
      let body = "";
      req.on("data", (c) => {
        body += c.toString();
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          mockAgentCalls.push({ command: parsed.command, params: parsed.params });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              message: `MOCKED execution of ${parsed.command}`,
              data: parsed.params,
            })
          );
        } catch (e: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, message: e?.message || "bad json" }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockAgentServer.listen(MOCK_AGENT_PORT, "127.0.0.1", resolve));

  const child = spawn("node", [serverCjs], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => {
    logs += d.toString();
  });
  child.stderr?.on("data", (d) => {
    logs += d.toString();
  });

  const wsEvents: any[] = [];
  let ws: WebSocket | null = null;

  try {
    await waitForHealth();
    console.log("[E2E] Server online on port", PORT);

    // Connect WebSocket client to observe real-time scheduler broadcasts
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/live?conn=true`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS connect timeout")), 5000);
      ws!.on("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws!.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    ws.on("message", (raw) => {
      try {
        wsEvents.push(JSON.parse(raw.toString()));
      } catch {}
    });

    // 1. Check IST clock endpoint
    const timeRes = await fetch(`${BASE_URL}/api/scheduler/time`).then((r) => r.json());
    assert.equal(timeRes.success, true);
    assert.equal(timeRes.timezone, "Asia/Kolkata (IST, UTC+05:30)");
    assert.ok(String(timeRes.isoIst).endsWith("+05:30"), `Expected +05:30 ISO, got ${timeRes.isoIst}`);
    console.log("[E2E] IST Time Verified:", timeRes.fullIstLabel);

    // 2. Test Chatbot IST time query
    const chatTime = await fetch(`${BASE_URL}/api/chatbot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "abhi kitne baje hain?" }),
    }).then((r) => r.json());
    assert.equal(chatTime.success, true);
    assert.ok(chatTime.text.includes("IST"), `Expected IST in time reply, got: ${chatTime.text}`);
    console.log("[E2E] Chatbot IST Time Reply:", chatTime.text);

    // 3. Test Chatbot delayed shutdown scheduling (will NOT shut down because we cancel it)
    const chatShutdown = await fetch(`${BASE_URL}/api/chatbot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "era mera pc 1 min ke baad shutdown kar dena" }),
    }).then((r) => r.json());
    assert.equal(chatShutdown.success, true);
    console.log("[E2E] Chatbot Shutdown Schedule Reply:", chatShutdown.text);

    let pendingRes = await fetch(`${BASE_URL}/api/scheduler/tasks?status=pending`).then((r) => r.json());
    assert.equal(pendingRes.tasks.length, 1, "Expected 1 pending shutdown task in scheduler");
    assert.match(pendingRes.tasks[0].title, /shutdown/i);
    assert.ok(pendingRes.tasks[0].scheduledForIsoIst.endsWith("+05:30"));

    // 4. Test listing scheduled tasks via chatbot
    const chatList = await fetch(`${BASE_URL}/api/chatbot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "scheduled tasks dikhao" }),
    }).then((r) => r.json());
    assert.equal(chatList.success, true);
    assert.match(chatList.text, /PC Shutdown/i);

    // 5. Test cancelling shutdown via chatbot
    const chatCancel = await fetch(`${BASE_URL}/api/chatbot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "cancel shutdown" }),
    }).then((r) => r.json());
    assert.equal(chatCancel.success, true);

    pendingRes = await fetch(`${BASE_URL}/api/scheduler/tasks?status=pending`).then((r) => r.json());
    assert.equal(pendingRes.tasks.length, 0, "Expected 0 pending tasks after cancel shutdown");
    console.log("[E2E] Shutdown scheduling & cancellation verified!");

    // 6. Test Chatbot brightness scheduling + exact time restart scheduling
    const chatBright = await fetch(`${BASE_URL}/api/chatbot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "2 min ke baad screen brightness 40% kar dena" }),
    }).then((r) => r.json());
    assert.equal(chatBright.success, true);

    const chatExactRestart = await fetch(`${BASE_URL}/api/chatbot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "exact 11:55 PM pe restart kar dena" }),
    }).then((r) => r.json());
    assert.equal(chatExactRestart.success, true);

    pendingRes = await fetch(`${BASE_URL}/api/scheduler/tasks?status=pending`).then((r) => r.json());
    assert.equal(pendingRes.tasks.length, 2, `Expected 2 pending tasks, got ${JSON.stringify(pendingRes.tasks)}`);
    assert.ok(pendingRes.tasks.some((t: any) => /brightness/i.test(t.title)));
    assert.ok(pendingRes.tasks.some((t: any) => /restart/i.test(t.title) && t.scheduledForIsoIst.includes("23:55:00+05:30")));

    // Cancel all via API
    await fetch(`${BASE_URL}/api/scheduler/cancel/all`, { method: "POST" });
    pendingRes = await fetch(`${BASE_URL}/api/scheduler/tasks?status=pending`).then((r) => r.json());
    assert.equal(pendingRes.tasks.length, 0);
    console.log("[E2E] Brightness & exact 11:55 PM IST restart scheduling verified!");

    // 7. REAL EXECUTION TEST: Schedule a 2-second task and verify it triggers automatically on its own!
    const schedExec = await fetch(`${BASE_URL}/api/scheduler/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Live Execution Clock Check",
        actionType: "tool",
        toolName: "getCurrentIndianTime",
        delaySeconds: 2,
      }),
    }).then((r) => r.json());
    assert.equal(schedExec.success, true);
    const execId = schedExec.task.id;

    // Wait 3.3s for real autonomous execution
    await new Promise((r) => setTimeout(r, 3300));

    const completedRes = await fetch(`${BASE_URL}/api/scheduler/tasks?status=completed`).then((r) => r.json());
    const found = completedRes.tasks.find((t: any) => t.id === execId);
    assert.ok(found, `Expected task ${execId} in completed list`);
    assert.equal(found.status, "completed");
    assert.ok(found.executedAtIst, "Expected executedAtIst timestamp");
    assert.match(found.resultMessage || "", /IST/i);

    const triggeredWs = wsEvents.find((e) => e.type === "scheduledTaskTriggered" && e.task?.id === execId);
    assert.ok(triggeredWs, "Expected WebSocket scheduledTaskTriggered broadcast");
    console.log("[E2E] Real autonomous execution & WebSocket trigger verified:", found.executedAtIst);

    // 8. REGRESSION TEST (Bug #1): Scheduled PC Shutdown executes ONCE at trigger time and NEVER loops!
    const mockCountBeforeShutdown = mockAgentCalls.length;
    const schedShutdownOnce = await fetch(`${BASE_URL}/api/scheduler/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "PC Shutdown",
        actionType: "tool",
        toolName: "systemControl",
        toolArgs: { action: "shutdown", confirmed: true, delay_seconds: 3 },
        delaySeconds: 1,
      }),
    }).then((r) => r.json());
    assert.equal(schedShutdownOnce.success, true);

    // Wait 5 seconds (> 1s delay + > 3s loop period) and verify shutdown_pc ran EXACTLY ONCE and NO new shutdown was re-scheduled!
    await new Promise((r) => setTimeout(r, 5000));

    const shutdownCalls = mockAgentCalls.slice(mockCountBeforeShutdown).filter((c) => c.command === "shutdown_pc");
    assert.equal(shutdownCalls.length, 1, `Expected shutdown_pc to execute ONCE, got ${shutdownCalls.length}`);
    assert.equal(shutdownCalls[0].params?.confirm, "yes");
    assert.equal(shutdownCalls[0].params?.delay_seconds, 3);

    pendingRes = await fetch(`${BASE_URL}/api/scheduler/tasks?status=pending`).then((r) => r.json());
    assert.equal(pendingRes.tasks.length, 0, `Shutdown must NOT re-schedule itself! Pending: ${JSON.stringify(pendingRes.tasks)}`);
    const allCompletedAfterShutdown = await fetch(`${BASE_URL}/api/scheduler/tasks?status=completed`).then((r) => r.json());
    const shutdownCompletedCount = allCompletedAfterShutdown.tasks.filter((t: any) => t.toolName === "systemControl").length;
    assert.equal(shutdownCompletedCount, 1, `Expected exactly 1 completed shutdown task, got ${shutdownCompletedCount}`);
    console.log("[E2E] Shutdown single-shot non-looping regression verified!");

    // 9. REGRESSION TEST (Bug #2): Delayed WhatsApp request MUST NOT execute immediately!
    const mockCountBeforeWa = mockAgentCalls.length;
    const chatWaDelay = await fetch(`${BASE_URL}/api/chatbot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "1 min ke baad bhaiya ko whatsapp par hello likh kar bhej do" }),
    }).then((r) => r.json());
    assert.equal(chatWaDelay.success, true);

    await new Promise((r) => setTimeout(r, 500));
    const immediateWaCalls = mockAgentCalls
      .slice(mockCountBeforeWa)
      .filter((c) => c.command === "send_whatsapp_message" || c.command === "open_whatsapp");
    assert.equal(immediateWaCalls.length, 0, "Delayed WhatsApp message MUST NOT execute immediately!");

    pendingRes = await fetch(`${BASE_URL}/api/scheduler/tasks?status=pending`).then((r) => r.json());
    assert.equal(pendingRes.tasks.length, 1, `Expected 1 pending WhatsApp task, got ${JSON.stringify(pendingRes.tasks)}`);
    assert.equal(pendingRes.tasks[0].toolName, "sendWhatsAppMessage");
    assert.equal(String(pendingRes.tasks[0].toolArgs?.contactName || "").toLowerCase(), "bhaiya");
    await fetch(`${BASE_URL}/api/scheduler/cancel/all`, { method: "POST" });
    console.log("[E2E] Delayed WhatsApp non-immediate scheduling regression verified!");

    console.log("ALL LIVE E2E SERVER SCHEDULER TESTS PASSED!");
  } catch (err) {
    console.error("[E2E] Server logs on failure:\n", logs.slice(-3000));
    throw err;
  } finally {
    try {
      ws?.close();
    } catch {}
    try {
      mockAgentServer.close();
    } catch {}
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.rmSync(tmpAppData, { recursive: true, force: true });
    } catch {}
  }
}

run().catch((err) => {
  console.error("E2E TEST FAILED:", err);
  process.exit(1);
});
