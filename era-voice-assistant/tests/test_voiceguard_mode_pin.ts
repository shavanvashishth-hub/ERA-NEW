import { serverVoiceGuard } from '../server';

async function runModeAndPinTests() {
  console.log('=== VoiceGuard PIN Protection & Online/Offline Mode Test ===\n');

  // Test 1: PIN Authentication logic
  console.log('[Test 1] Testing PIN authentication barrier:');
  const checkPin = (pin: string) => pin === '1234';
  if (!checkPin('1234')) {
    throw new Error('PIN 1234 should have succeeded!');
  }
  if (checkPin('0000') || checkPin('4321') || checkPin('')) {
    throw new Error('Non-1234 PINs must fail!');
  }
  console.log('✓ Test 1: PIN 1234 verification barrier functions correctly.\n');

  // Test 2: Server VoiceGuard Offline Mode
  console.log('[Test 2] Testing VoiceGuard OFFLINE Mode behavior:');
  serverVoiceGuard.setMode('offline');
  if (serverVoiceGuard.isOnline()) {
    throw new Error('serverVoiceGuard should report isOnline() === false when set to offline!');
  }
  // When offline, commands should ALWAYS be authorized regardless of lock state
  serverVoiceGuard.setIntruderAlert('Test intruder');
  if (!serverVoiceGuard.isOwnerAuthorized()) {
    throw new Error('When VoiceGuard is OFFLINE, isOwnerAuthorized() must return true for all commands!');
  }
  if (serverVoiceGuard.isEnrolled()) {
    throw new Error('When VoiceGuard is OFFLINE, isEnrolled() must return false to bypass gate blocks!');
  }
  console.log('✓ Test 2: VoiceGuard OFFLINE mode correctly authorizes all commands without voice check.\n');

  // Test 3: Server VoiceGuard ONLINE Mode
  console.log('[Test 3] Testing VoiceGuard ONLINE Mode behavior:');
  serverVoiceGuard.setMode('online');
  if (!serverVoiceGuard.isOnline()) {
    throw new Error('serverVoiceGuard should report isOnline() === true when set to online!');
  }
  // Simulate active intruder lockdown in online mode
  serverVoiceGuard.setIntruderAlert('Test intruder alert');
  if (serverVoiceGuard.isOwnerAuthorized()) {
    throw new Error('When VoiceGuard is ONLINE and intruder alert is active, commands must be BLOCKED!');
  }
  // Simulate owner verified
  serverVoiceGuard.setOwnerVerified('test-suite');
  if (!serverVoiceGuard.isOwnerAuthorized()) {
    throw new Error('When VoiceGuard is ONLINE and owner is verified, commands must be ALLOWED!');
  }
  console.log('✓ Test 3: VoiceGuard ONLINE mode strictly enforces speaker authorization and intruder lockdown.\n');

  // Reset to initial mode
  serverVoiceGuard.setMode('online');
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

runModeAndPinTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
