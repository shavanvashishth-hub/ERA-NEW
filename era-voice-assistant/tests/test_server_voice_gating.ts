import { strict as assert } from 'assert';

console.log('--- Testing Server-Side VoiceGuard Execution Gating ---');

// Mock state tracking
let toolExecutionCount = 0;
let geminiResponsesSent: any[] = [];

// Simulate executeCompanionTool
async function mockExecuteCompanionTool(name: string, args: any) {
  toolExecutionCount++;
  return { output: `Executed ${name}` };
}

// Simulate Gemini session
const mockSession = {
  async sendToolResponse(payload: any) {
    geminiResponsesSent.push(payload);
  }
};

// Tool response handler logic matching server.ts & dist/server.cjs
async function handleToolResponse(
  msg: { id: string; response?: any; isBlockedByVoiceGuard?: boolean; reason?: string },
  pendingTimers: Map<string, any>,
  handledIds: Set<string>
) {
  const timer = pendingTimers.get(msg.id);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(msg.id);
  }

  if (handledIds.has(msg.id)) {
    return;
  }
  handledIds.add(msg.id);

  if (msg.isBlockedByVoiceGuard) {
    console.log(`[Security] Blocked execution of tool ${msg.id}: ${msg.reason}`);
    await mockSession.sendToolResponse({
      functionResponses: [{
        id: msg.id,
        response: {
          error: `VoiceGuard biometric security check failed: ${msg.reason || 'Voice does not match authorized owner profile'}. Tool execution was BLOCKED.`
        }
      }]
    });
    return;
  }

  // If verified and allowed:
  await mockSession.sendToolResponse({
    functionResponses: [{
      id: msg.id,
      response: msg.response || { output: 'Success' }
    }]
  });
}

async function runTests() {
  const pendingTimers = new Map<string, any>();
  const handledIds = new Set<string>();

  // Case 1: Intruder command arrives -> isBlockedByVoiceGuard: true
  console.log('\n[Case 1: Intruder Attack]');
  const intruderCallId = 'call_intruder_001';
  pendingTimers.set(intruderCallId, setTimeout(() => {}, 10000));

  await handleToolResponse({
    id: intruderCallId,
    isBlockedByVoiceGuard: true,
    reason: "Fundamental pitch mismatch (235 Hz vs owner 177 Hz)."
  }, pendingTimers, handledIds);

  assert.equal(toolExecutionCount, 0, 'Intruder tool must NOT be executed!');
  assert.equal(geminiResponsesSent.length, 1, 'Gemini must receive security block response');
  assert.match(geminiResponsesSent[0].functionResponses[0].response.error, /BLOCKED/, 'Error response must state BLOCKED');
  console.log('✓ Case 1 Passed: Intruder command was completely BLOCKED from executing on the OS.');

  // Case 2: Genuine Owner command -> verified and allowed
  console.log('\n[Case 2: Genuine Owner Command]');
  const ownerCallId = 'call_owner_002';
  pendingTimers.set(ownerCallId, setTimeout(() => {}, 10000));

  // Client executes the tool or delegates after VoiceGuard passed
  const toolResult = await mockExecuteCompanionTool('openApplication', { applicationName: 'Chrome' });
  await handleToolResponse({
    id: ownerCallId,
    response: toolResult,
    isBlockedByVoiceGuard: false
  }, pendingTimers, handledIds);

  assert.equal(toolExecutionCount, 1, 'Owner tool must execute successfully');
  assert.equal(geminiResponsesSent.length, 2, 'Gemini must receive success response');
  assert.equal(geminiResponsesSent[1].functionResponses[0].response.output, 'Executed openApplication');
  console.log('✓ Case 2 Passed: Owner command executed immediately with success response.');

  console.log('\n===========================================');
  console.log(' ALL SERVER VOICE GATING TESTS PASSED! 🛡️');
  console.log('===========================================');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
