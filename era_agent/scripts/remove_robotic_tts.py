with open(r"D:\era-voice-assistant\server.ts", "r", encoding="utf-8") as f:
    text = f.read()

old_block = """  // 2. Feed user turn into active Gemini Live session
  let spokenViaGemini = false;
  if (activeGeminiLiveSession) {
    try {
      await activeGeminiLiveSession.sendClientContent({
        turns: [{
          role: "user",
          parts: [{
            text: `[IMPORTANT NOTIFICATION]: Incoming phone call is ringing right now from "${caller}". Speak out loud immediately to the boss: "Boss, ${caller} ka call aa raha hai. Kya karna hai, accept ya reject?" and wait for their command.`
          }]
        }],
        turnComplete: true
      });
      spokenViaGemini = true;
    } catch (e: any) {
      console.warn("[PhoneLink] Could not send prompt to Gemini Live session:", e?.message);
    }
  }

  // 3. Fallback native Windows TTS speech if Gemini Live is not connected
  if (!spokenViaGemini) {
    try {
      const psCode = `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.Volume = 100; $synth.Speak('Boss, ${caller.replace(/'/g, "''")} ka call aa raha hai. Kya karna hai, accept ya reject?')`;
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCode], { detached: true, stdio: "ignore" }).unref();
    } catch (e) {}
  }"""

new_block = """  // 2. Feed user turn into active Gemini Live sessions so ERA announces with her natural voice
  const targets = new Set<any>();
  if (activeGeminiLiveSession) targets.add(activeGeminiLiveSession);
  for (const s of activeLiveSessions) {
    if (s) targets.add(s);
  }

  for (const session of targets) {
    try {
      await session.sendClientContent({
        turns: [{
          role: "user",
          parts: [{
            text: `[INCOMING PHONE CALL ALERT]: Phone Link is ringing right now with a call from "${caller}". Speak out immediately to the boss in your own natural voice: "Boss, ${caller} ka call aa raha hai. Kya karna hai, accept ya reject?" and listen for their voice command.`
          }]
        }],
        turnComplete: true
      });
      console.log(`[PhoneLink] Successfully sent incoming call voice alert to Gemini Live session`);
    } catch (e: any) {
      console.warn("[PhoneLink] Could not send prompt to Gemini Live session:", e?.message);
    }
  }"""

text_norm = text.replace("\r\n", "\n")
old_block_norm = old_block.replace("\r\n", "\n")

if old_block_norm in text_norm:
    updated = text_norm.replace(old_block_norm, new_block)
    with open(r"D:\era-voice-assistant\server.ts", "w", encoding="utf-8") as f:
        f.write(updated)
    print("Updated server.ts successfully - robotic TTS completely removed!")
else:
    print("Could not find old_block in server.ts")
