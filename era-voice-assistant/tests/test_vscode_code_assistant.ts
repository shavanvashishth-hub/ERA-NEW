import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseVSCodeWindowTitle,
  detectLanguageFromPath,
  checkFileSyntax,
  editFileAtPathDirect,
  undoLastFileEdit,
  runAnyCode,
  solveOrFixCode,
} from "../server/codeAssistant";

const PORT = 3098;
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

async function runUnitChecks(tmpDir: string) {
  // 1. VS Code window title parsing
  const dirty = parseVSCodeWindowTitle("● app.py - myproject - Visual Studio Code");
  assert.equal(dirty.isDirty, true);
  assert.equal(dirty.filename, "app.py");
  assert.equal(dirty.project, "myproject");

  const workingTree = parseVSCodeWindowTitle("server.ts (Working Tree) - era-voice-assistant - Visual Studio Code");
  assert.equal(workingTree.isDirty, false);
  assert.equal(workingTree.filename, "server.ts");
  assert.equal(workingTree.project, "era-voice-assistant");

  const singleFile = parseVSCodeWindowTitle("test.cpp - Visual Studio Code");
  assert.equal(singleFile.filename, "test.cpp");
  assert.equal(singleFile.project, null);

  // 2. Language detection
  assert.equal(detectLanguageFromPath("main.py"), "python");
  assert.equal(detectLanguageFromPath("index.tsx"), "typescriptreact");
  assert.equal(detectLanguageFromPath("program.cpp"), "cpp");
  assert.equal(detectLanguageFromPath("App.java"), "java");

  // 3. Syntax check (broken Python vs valid Python, broken JS vs valid JS)
  const pyFile = path.join(tmpDir, "buggy.py");
  fs.writeFileSync(pyFile, "def greet():\n    print('hello'\n", "utf8");
  const badPySyntax = await checkFileSyntax(pyFile, "python");
  assert.equal(badPySyntax.checked, true);
  assert.equal(badPySyntax.valid, false);

  // 4. Edit file with CRLF tolerance + undo backup
  const jsFile = path.join(tmpDir, "calc.js");
  fs.writeFileSync(jsFile, "const a = 2;\r\nconst b = 3;\r\nconsole.log(a - b);\r\n", "utf8");
  const editRes = editFileAtPathDirect(jsFile, "console.log(a - b);", "console.log(a + b);");
  assert.equal(editRes.success, true);
  assert.ok(fs.readFileSync(jsFile, "utf8").includes("console.log(a + b);"));

  const runJs = await runAnyCode({ filepath: jsFile });
  assert.equal(runJs.success, true);
  assert.equal(runJs.stdout.trim(), "5");

  const undoRes = undoLastFileEdit(jsFile);
  assert.equal(undoRes.success, true);
  assert.ok(fs.readFileSync(jsFile, "utf8").includes("console.log(a - b);"));

  // 5. solveOrFixCode with direct replacement + autoRun on Python file
  const fixRes = await solveOrFixCode({
    instruction: "Fix missing closing parenthesis in greet()",
    filepath: pyFile,
    newContent: "def greet():\n    print('ERA_FIXED_PYTHON_OK')\n\ngreet()\n",
    openInVscode: false,
    autoRun: true,
  });
  assert.equal(fixRes.success, true);
  assert.equal(fixRes.applied, true);
  assert.equal(fixRes.canUndo, true);
  assert.equal(fixRes.syntaxCheck?.valid, true);
  assert.equal(fixRes.runResult?.success, true);
  assert.ok(fixRes.runResult?.stdout.includes("ERA_FIXED_PYTHON_OK"));

  // 6. Run inline PowerShell snippet
  const psRun = await runAnyCode({
    code: 'Write-Output "ERA_PS_OK"',
    language: "powershell",
  });
  assert.equal(psRun.success, true);
  assert.ok(psRun.stdout.includes("ERA_PS_OK"));

  console.log("[Unit] All VS Code Code Assistant unit tests PASSED!");
}

async function runE2EChecks(tmpDir: string) {
  const serverCjs = path.resolve(process.cwd(), "dist", "server.cjs");
  assert.ok(fs.existsSync(serverCjs), `Missing built server bundle: ${serverCjs}`);

  const env = {
    ...process.env,
    PORT: String(PORT),
    ERA_PORT: String(PORT),
    ERA_DISABLE_SCREEN_STREAMER: "1",
    NODE_ENV: "production",
    ERA_APP_DATA: tmpDir,
    ERA_CONFIG_DIR: path.join(tmpDir, "config"),
    ERA_WORKSPACE_DIR: path.join(tmpDir, "workspace"),
    ERA_DIST_DIR: path.resolve(process.cwd(), "dist"),
    ERA_AGENT_URL: "http://127.0.0.1:59996",
    ERA_BRIDGE_URL: "http://127.0.0.1:59995",
  };

  let logs = "";
  const child = spawn("node", [serverCjs], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => (logs += d.toString()));
  child.stderr?.on("data", (d) => (logs += d.toString()));

  try {
    await waitForHealth();
    console.log("[E2E] Server online on port", PORT);

    // 1. Create a broken JS file on disk and inspect it via /api/code-assistant/inspect
    const samplePath = path.join(tmpDir, "demo.js");
    fs.writeFileSync(samplePath, "function add(x, y) {\n  return x + ;\n}\nconsole.log(add(4, 6));\n", "utf8");

    const inspectRes = await fetch(`${BASE_URL}/api/code-assistant/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "check syntax error", filepath: samplePath }),
    }).then((r) => r.json());
    assert.equal(inspectRes.success, true);
    assert.equal(inspectRes.resolvedFilePath, samplePath);
    assert.equal(inspectRes.language, "javascript");
    assert.equal(inspectRes.syntaxCheck?.checked, true);
    assert.equal(inspectRes.syntaxCheck?.valid, false);

    // 2. Fix & auto-run via /api/code-assistant/fix
    const fixRes = await fetch(`${BASE_URL}/api/code-assistant/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "Fix syntax error in add()",
        filepath: samplePath,
        newContent: "function add(x, y) {\n  return x + y;\n}\nconsole.log('SUM=' + add(4, 6));\n",
        openInVscode: false,
        autoRun: true,
      }),
    }).then((r) => r.json());
    assert.equal(fixRes.success, true);
    assert.equal(fixRes.syntaxCheck?.valid, true);
    assert.equal(fixRes.runResult?.success, true);
    assert.ok(fixRes.runResult?.stdout.includes("SUM=10"));

    // 3. Run directly via /api/code-assistant/run
    const runRes = await fetch(`${BASE_URL}/api/code-assistant/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath: samplePath }),
    }).then((r) => r.json());
    assert.equal(runRes.success, true);
    assert.ok(runRes.stdout.includes("SUM=10"));

    // 4. Undo fix via /api/code-assistant/undo
    const undoRes = await fetch(`${BASE_URL}/api/code-assistant/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath: samplePath }),
    }).then((r) => r.json());
    assert.equal(undoRes.success, true);
    assert.ok(undoRes.restoredContent.includes("return x + ;"));

    // 5. Save & Read file endpoints
    const saveRes = await fetch(`${BASE_URL}/api/code-assistant/save-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath: samplePath, content: "console.log('SAVED_OK');\n" }),
    }).then((r) => r.json());
    assert.equal(saveRes.success, true);

    const readRes = await fetch(`${BASE_URL}/api/code-assistant/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath: samplePath }),
    }).then((r) => r.json());
    assert.equal(readRes.success, true);
    assert.ok(readRes.content.includes("SAVED_OK"));

    // 6. HTML preview endpoint
    const htmlPath = path.join(tmpDir, "preview.html");
    fs.writeFileSync(htmlPath, "<h1>Hello ERA</h1>", "utf8");
    const htmlRun = await fetch(`${BASE_URL}/api/code-assistant/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath: htmlPath }),
    }).then((r) => r.json());
    assert.equal(htmlRun.success, true);
    assert.ok(String(htmlRun.previewUrl).includes("/api/code-assistant/preview"));

    console.log("[E2E] All /api/code-assistant/* HTTP endpoints PASSED!");
  } catch (err) {
    console.error("[E2E Logs]\n", logs);
    throw err;
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "era-code-assistant-test-"));
  fs.mkdirSync(path.join(tmpDir, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "config"), { recursive: true });
  try {
    await runUnitChecks(tmpDir);
    await runE2EChecks(tmpDir);
    console.log("ALL VS CODE ASSISTANT TESTS PASSED!");
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
