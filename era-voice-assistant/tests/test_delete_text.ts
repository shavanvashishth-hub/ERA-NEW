import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { CHATBOT_TOOL_DECLARATIONS } from "../server/schedulerToolDefs";

async function main() {
  // 1. Verify Chatbot tool declarations include typing, deleting, key combo, and VS Code copilot tools
  const toolNames = new Set(CHATBOT_TOOL_DECLARATIONS.map((t: any) => t.name));
  for (const requiredTool of [
    "typeText",
    "deleteText",
    "pressKeyCombination",
    "inspectVSCodeScreen",
    "fixOrWriteCodeFile",
    "runAnyCode",
    "undoCodeEdit",
    "editFileAtPath",
  ]) {
    assert.ok(toolNames.has(requiredTool), `Missing CHATBOT_TOOL_DECLARATIONS entry: ${requiredTool}`);
  }
  console.log("[Node] CHATBOT_TOOL_DECLARATIONS contains deleteText, typeText, and VS Code tools.");

  // 2. Verify Voice Live deleteText declaration + anti-lying prompt exist in server.ts
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), "server.ts"), "utf8");
  assert.ok(serverSource.includes('name: "deleteText"'), "server.ts missing Voice Live deleteText declaration");
  assert.ok(serverSource.includes('toolName === "deleteText"'), "server.ts missing deleteText execution handler");
  assert.ok(serverSource.includes("STRICT NO-LYING RULE"), "server.ts missing deleteText no-lying prompt rule");
  console.log("[Node] server.ts Voice Live & Chatbot deleteText wiring verified.");

  // 3. Verify agentBridge offline fallback never falsely claims word-specific deletion succeeded
  const prevUrl = process.env.ERA_AGENT_URL;
  process.env.ERA_AGENT_URL = "http://127.0.0.1:59994";
  try {
    const { executeAgentCommand } = await import("../server/agentBridge");
    const res = await executeAgentCommand("delete_text", {
      target: "galti",
      mode: "word",
    });
    assert.equal(res.success, false, "Offline fallback must NOT falsely succeed for specific word deletion");
  } finally {
    if (prevUrl === undefined) delete process.env.ERA_AGENT_URL;
    else process.env.ERA_AGENT_URL = prevUrl;
  }
  console.log("[Node] agentBridge honest failure verification PASSED!");

  // 4. Verify Python era_agent system_commands: _remove_target_from_text, delete_text, edit_file_at_path
  const pyExe = "D:\\era_agent\\.venv\\Scripts\\python.exe";
  assert.ok(fs.existsSync(pyExe), `Missing era_agent python interpreter at ${pyExe}`);

  const pyScript = [
    "import sys",
    "sys.path.insert(0, r'D:\\era_agent')",
    "from era_agent.commands import system_commands as sc",
    "from era_agent.commands.registry import registry",
    "",
    "# Word deletion: last occurrence, case-insensitive, whitespace cleanup",
    "updated, ok = sc._remove_target_from_text('hello bhai kaise hello ho', 'hello', 'last')",
    "assert ok and updated == 'hello bhai kaise ho', f'last fail: {updated!r}'",
    "",
    "# First occurrence",
    "updated, ok = sc._remove_target_from_text('hello bhai kaise hello ho', 'hello', 'first')",
    "assert ok and updated == 'bhai kaise hello ho', f'first fail: {updated!r}'",
    "",
    "# All occurrences",
    "updated, ok = sc._remove_target_from_text('test one test two test', 'test', 'all')",
    "assert ok and updated == 'one two', f'all fail: {updated!r}'",
    "",
    "# Punctuation adjacent word",
    "updated, ok = sc._remove_target_from_text('hi, sorry! all good', 'sorry', 'last')",
    "assert ok and 'sorry' not in updated.lower(), f'punct fail: {updated!r}'",
    "",
    "# Multi-word phrase",
    "updated, ok = sc._remove_target_from_text('please cancel my meeting tomorrow', 'cancel my meeting', 'last')",
    "assert ok and updated == 'please tomorrow', f'phrase fail: {updated!r}'",
    "",
    "# Missing target must return ok=False",
    "updated, ok = sc._remove_target_from_text('hello world', 'missingword', 'last')",
    "assert not ok and updated == 'hello world', f'missing target should fail: {ok} {updated!r}'",
    "",
    "# Commands registered",
    "assert callable(getattr(sc, 'delete_text', None))",
    "assert callable(getattr(sc, 'deleteText', None))",
    "assert registry.get('delete_text') is not None",
    "assert registry.get('deleteText') is not None",
    "print('PY_DELETE_TEXT_UNIT_OK')",
  ].join("\n");

  const pyOut = execFileSync(pyExe, ["-c", pyScript], { encoding: "utf8" });
  assert.ok(pyOut.includes("PY_DELETE_TEXT_UNIT_OK"), `Unexpected python output: ${pyOut}`);
  console.log("[Python] era_agent delete_text & _remove_target_from_text unit checks PASSED!");

  console.log("ALL DELETE TEXT TESTS PASSED!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
