class SecuritySoundEngine {
  public muted = true;

  // Sound effects permanently disabled to guarantee seamless voice conversation
  // without intrusive beeps or tones during biometric verification or alerts.
  playOwnerVerified() {
    // Completely silent — no beep sound played
    return;
  }

  playIntruderLockdown() {
    // Completely silent — no beep sound played
    return;
  }
}

export const soundEngine = new SecuritySoundEngine();
