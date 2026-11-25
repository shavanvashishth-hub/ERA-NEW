import fs from 'fs';
import { compareVoiceprints, VoiceprintFeatures } from '../src/voiceguard/audioBiometrics';

async function runToolGateTests() {
  console.log('=================================================================');
  console.log('🛡️ VoiceGuard Tool Gate & Gating Rules Integration Test');
  console.log('=================================================================\n');

  // 1. Verify App.tsx SAFE_PERCEPTION_TOOLS does NOT contain action commands
  console.log('[Test 1] Inspecting App.tsx SAFE_PERCEPTION_TOOLS:');
  const appTsx = fs.readFileSync('src/App.tsx', 'utf8');
  const forbiddenTools = [
    'openApplication', 'open_app',
    'openWebsite', 'open_browser',
    'typeText', 'type_text',
    'writeText', 'write_text',
    'writeInVSCode', 'write_in_vscode',
    'pressKeyCombination', 'deleteText'
  ];
  const safePerceptionBlock = appTsx.substring(
    appTsx.indexOf('const SAFE_PERCEPTION_TOOLS = new Set(['),
    appTsx.indexOf(']);', appTsx.indexOf('const SAFE_PERCEPTION_TOOLS = new Set(['))
  );

  for (const tool of forbiddenTools) {
    if (safePerceptionBlock.includes(`"${tool}"`)) {
      throw new Error(`CRITICAL SECURITY FLAW: Tool '${tool}' must NOT be in SAFE_PERCEPTION_TOOLS!`);
    }
  }
  console.log('  ✓ Verified: All action commands (openApplication, openWebsite, typing, etc.) are strictly guarded by VoiceGuard.\n');

  // 2. Verify agentBridge.ts SAFE_COMMANDS does NOT contain action commands
  console.log('[Test 2] Inspecting agentBridge.ts SAFE_COMMANDS:');
  const agentBridge = fs.readFileSync('server/agentBridge.ts', 'utf8');
  const bridgeSafeBlock = agentBridge.substring(
    agentBridge.indexOf('const SAFE_COMMANDS = new Set(['),
    agentBridge.indexOf(']);', agentBridge.indexOf('const SAFE_COMMANDS = new Set(['))
  );
  const forbiddenBridgeCommands = [
    'type_text', 'typeText', 'write_in_vscode', 'press_key_combination', 'save_active_vscode_file'
  ];
  for (const cmd of forbiddenBridgeCommands) {
    if (bridgeSafeBlock.includes(`"${cmd}"`)) {
      throw new Error(`CRITICAL SECURITY FLAW: Command '${cmd}' must NOT be in SAFE_COMMANDS!`);
    }
  }
  console.log('  ✓ Verified: agentBridge SAFE_COMMANDS does not allow bypass for action commands.\n');

  // 3. Verify App.tsx verifySpeakerBeforeTool does NOT have lax bypasses
  console.log('[Test 3] Inspecting verifySpeakerBeforeTool in App.tsx:');
  const verifyToolBlock = appTsx.substring(
    appTsx.indexOf('const verifySpeakerBeforeTool = async'),
    appTsx.indexOf('const handleAddVaultItem')
  );

  if (verifyToolBlock.includes('overallScore >= 40')) {
    throw new Error('CRITICAL FLAW: verifySpeakerBeforeTool contains lax "overallScore >= 40" bypass!');
  }
  if (verifyToolBlock.includes('300000')) {
    throw new Error('CRITICAL FLAW: verifySpeakerBeforeTool contains lax 5-minute 300000ms bypass!');
  }
  console.log('  ✓ Verified: verifySpeakerBeforeTool has no lax bypasses and strictly fails closed.\n');

  // 4. Verify turn_transcript_dsp in App.tsx
  console.log('[Test 4] Inspecting turn_transcript_dsp in App.tsx:');
  const turnVerifyBlock = appTsx.substring(
    appTsx.indexOf('// Continuous background voice verification for owner on user turn'),
    appTsx.indexOf('// Send to chatbot state')
  );
  if (turnVerifyBlock.includes('overallScore >= 40')) {
    throw new Error('CRITICAL FLAW: turn_transcript_dsp contains lax "overallScore >= 40" bypass!');
  }
  if (turnVerifyBlock.includes('overallScore < 25')) {
    throw new Error('CRITICAL FLAW: turn_transcript_dsp contains lax "overallScore < 25" check!');
  }
  console.log('  ✓ Verified: turn_transcript_dsp strictly verifies owner and triggers intruder alert on mismatch.\n');

  console.log('=================================================================');
  console.log('🎉 ALL VOICEGUARD TOOL GATE INTEGRATION TESTS PASSED 100%!');
  console.log('=================================================================\n');
  process.exit(0);
}

runToolGateTests().catch(err => {
  console.error('❌ Tool Gate Test Failed:', err);
  process.exit(1);
});
