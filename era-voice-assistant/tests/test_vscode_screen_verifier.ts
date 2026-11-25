import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  smartWriteCode,
  solveOrFixCode,
  checkFileSyntax,
  verifyAndCompleteTaskWithScreen,
} from "../server/codeAssistant";

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "era-verifier-test-"));
  console.log("[Verifier Test] Temp test dir:", tmpDir);

  try {
    // 1. Test smartWriteCode: writes valid python, checks syntax, generates verification
    const testPy = path.join(tmpDir, "calculator.py");
    const writeRes = await smartWriteCode({
      language: "python",
      filename: testPy,
      code: "def add(a, b):\n    return a + b\n\nif __name__ == '__main__':\n    print('SUM=', add(5, 7))\n",
      openInVscode: false,
    });

    assert.equal(writeRes.success, true, "smartWriteCode should succeed on valid Python");
    assert.equal(writeRes.verified, true, "smartWriteCode should verify valid code");
    assert.ok(fs.existsSync(testPy), "File must be written on disk");
    assert.ok(writeRes.visualVerification.includes("Screen capture verified"));
    assert.equal(writeRes.syntaxCheck?.valid, true, "Syntax check should be valid");
    console.log("[Node] smartWriteCode test PASSED!");

    // 2. Test solveOrFixCode with invalid syntax: must NEVER falsely claim success if syntax fails
    const badPy = path.join(tmpDir, "broken_calc.py");
    fs.writeFileSync(badPy, "def bad_func():\n    print('missing paren'\n", "utf8");

    const badSyntaxCheck = await checkFileSyntax(badPy, "python");
    assert.equal(badSyntaxCheck.valid, false, "Broken Python syntax must be detected as invalid");

    // If newContent is passed with intentional broken syntax, solveOrFixCode must report failure/syntax error
    const fixWithBadSyntax = await solveOrFixCode({
      instruction: "test syntax failure rejection",
      filepath: badPy,
      newContent: "def still_broken():\n    return (\n",
      openInVscode: false,
      applyToFile: true,
    });
    // Syntax check on still_broken() must be checked and invalid
    assert.equal(fixWithBadSyntax.syntaxCheck?.valid, false, "Syntax must be invalid");
    console.log("[Node] solveOrFixCode invalid syntax rejection test PASSED!");

    // 3. Test solveOrFixCode with valid fix & auto-run
    const fixWithValid = await solveOrFixCode({
      instruction: "Fix broken calculator function",
      filepath: badPy,
      newContent: "def bad_func():\n    return 'FIXED_AND_VERIFIED'\n\nprint(bad_func())\n",
      openInVscode: false,
      applyToFile: true,
      autoRun: true,
    });
    assert.equal(fixWithValid.success, true, "solveOrFixCode should succeed with valid code");
    assert.equal(fixWithValid.syntaxCheck?.valid, true, "Syntax should be valid");
    assert.equal(fixWithValid.runResult?.success, true, "Runtime execution should pass");
    assert.ok(fixWithValid.runResult?.stdout.includes("FIXED_AND_VERIFIED"));
    console.log("[Node] solveOrFixCode valid fix & autoRun test PASSED!");

    // 4. Test verifyAndCompleteTaskWithScreen on code fix result
    const verifyRes = await verifyAndCompleteTaskWithScreen({
      toolName: "fixOrWriteCodeFile",
      args: { instruction: "test verification" },
      initialResult: fixWithValid,
    });
    assert.equal(verifyRes.verified, true, "Verified flag must be true");
    assert.ok(verifyRes.visualVerification.includes("Screen capture verified"));
    console.log("[Node] verifyAndCompleteTaskWithScreen for code task PASSED!");

    // 5. Test verifyAndCompleteTaskWithScreen on failed deletion (strict no-lying)
    const delFailVerify = await verifyAndCompleteTaskWithScreen({
      toolName: "deleteText",
      args: { target: "nonexistent_word" },
      initialResult: { success: false, message: "Target word not found on screen" },
    });
    assert.equal(delFailVerify.verified, false, "Must reflect verified=false on failed delete");
    assert.ok(delFailVerify.visualVerification.includes("deletion not completed"));
    console.log("[Node] verifyAndCompleteTaskWithScreen strict no-lying delete PASSED!");

    // 6. Test Python agent system_commands: write_in_vscode and save_active_vscode_file registration
    const pyExe = "D:\\era_agent\\.venv\\Scripts\\python.exe";
    const pyCheckScript = [
      "import sys",
      "sys.path.insert(0, r'D:\\era_agent')",
      "from era_agent.commands import system_commands as sc",
      "from era_agent.commands.registry import registry",
      "",
      "assert callable(getattr(sc, 'write_in_vscode', None)), 'write_in_vscode missing'",
      "assert callable(getattr(sc, 'save_active_vscode_file', None)), 'save_active_vscode_file missing'",
      "assert registry.get('write_in_vscode') is not None, 'write_in_vscode not in registry'",
      "assert registry.get('writeInVSCode') is not None, 'writeInVSCode not in registry'",
      "assert registry.get('save_active_vscode_file') is not None, 'save_active_vscode_file not in registry'",
      "assert registry.get('saveActiveVSCodeFile') is not None, 'saveActiveVSCodeFile not in registry'",
      "print('PY_VSCODE_COMMANDS_REGISTERED_OK')",
    ].join("\n");

    const pyOut = execFileSync(pyExe, ["-c", pyCheckScript], { encoding: "utf8" });
    assert.ok(pyOut.includes("PY_VSCODE_COMMANDS_REGISTERED_OK"));
    console.log("[Python] era_agent write_in_vscode & save_active_vscode_file PASSED!");

    console.log("ALL SCREEN & CODE VERIFIER TESTS PASSED!");
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
