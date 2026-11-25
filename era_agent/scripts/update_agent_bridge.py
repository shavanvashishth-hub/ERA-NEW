with open(r"D:\era-voice-assistant\server\agentBridge.ts", "r", encoding="utf-8") as f:
    text = f.read()

old_block = """  // PHONE LINK DIRECT FALLBACKS
  if (cmd === "make_phone_call" || cmd === "make_call" || cmd === "call_phone") {
    const rawTarget = String(params?.phone || params?.number || params?.contact || params?.target || "").trim();
    const pyExe = [
      "d:\\\\era_agent\\\\.venv\\\\Scripts\\\\python.exe",
      "d:\\\\era-voice-assistant\\\\resources\\\\python_runtime\\\\python.exe"
    ].find(p => fs.existsSync(p)) || "python.exe";

    const pyCode = `import sys\\nsys.path.insert(0, r"d:\\\\era_agent")\\nfrom controls.phone_link import PhoneLinkControl\\nok, msg = PhoneLinkControl.make_call(${JSON.stringify(rawTarget)})\\nprint(msg)`;
    try {
      const proc = spawn(pyExe, ["-c", pyCode], { detached: true, stdio: "ignore" });
      proc.unref();
      return { success: true, message: `Dialing ${rawTarget} via Phone Link!` };
    } catch (e: any) {
      return { success: false, message: `Failed to initiate call: ${e.message}` };
    }
  }

  if (cmd === "answer_phone_call" || cmd === "accept_phone_call") {
    const pyExe = [
      "d:\\\\era_agent\\\\.venv\\\\Scripts\\\\python.exe",
      "d:\\\\era-voice-assistant\\\\resources\\\\python_runtime\\\\python.exe"
    ].find(p => fs.existsSync(p)) || "python.exe";

    const pyCode = `import sys\\nsys.path.insert(0, r"d:\\\\era_agent")\\nfrom controls.phone_link import PhoneLinkControl\\nok, msg = PhoneLinkControl.answer_call()\\nprint(msg)`;
    try {
      const proc = spawn(pyExe, ["-c", pyCode], { detached: true, stdio: "ignore" });
      proc.unref();
      return { success: true, message: "Incoming call accept ho gaya hai, boss." };
    } catch (e: any) {
      return { success: false, message: `Failed to answer call: ${e.message}` };
    }
  }

  if (cmd === "reject_phone_call" || cmd === "decline_phone_call") {
    const pyExe = [
      "d:\\\\era_agent\\\\.venv\\\\Scripts\\\\python.exe",
      "d:\\\\era-voice-assistant\\\\resources\\\\python_runtime\\\\python.exe"
    ].find(p => fs.existsSync(p)) || "python.exe";

    const pyCode = `import sys\\nsys.path.insert(0, r"d:\\\\era_agent")\\nfrom controls.phone_link import PhoneLinkControl\\nok, msg = PhoneLinkControl.reject_call()\\nprint(msg)`;
    try {
      const proc = spawn(pyExe, ["-c", pyCode], { detached: true, stdio: "ignore" });
      proc.unref();
      return { success: true, message: "Call reject kar diya hai, boss." };
    } catch (e: any) {
      return { success: false, message: `Failed to reject call: ${e.message}` };
    }
  }"""

new_block = """  // PHONE LINK DIRECT FALLBACKS
  const phonePyExeCandidates = [
    "C:\\\\Users\\\\MSI\\\\AppData\\\\Local\\\\Programs\\\\ERA AI Assistant\\\\resources\\\\python_runtime\\\\python.exe",
    "d:\\\\era-voice-assistant\\\\resources\\\\python_runtime\\\\python.exe",
    "d:\\\\era_agent\\\\.venv\\\\Scripts\\\\python.exe",
    "python.exe"
  ];
  const resolvedPhonePy = phonePyExeCandidates.find(p => fs.existsSync(p)) || "python.exe";
  const phoneImportPrefix = `import sys\\nsys.path.insert(0, r"C:\\\\Users\\\\MSI\\\\AppData\\\\Local\\\\Programs\\\\ERA AI Assistant\\\\resources\\\\era_services\\\\era_agent")\\nsys.path.insert(0, r"d:\\\\era_agent")\\nfrom controls.phone_link import PhoneLinkControl\\n`;

  if (cmd === "make_phone_call" || cmd === "make_call" || cmd === "call_phone") {
    const rawTarget = String(params?.phone || params?.number || params?.contact || params?.target || "").trim();
    const pyCode = `${phoneImportPrefix}ok, msg = PhoneLinkControl.make_call(${JSON.stringify(rawTarget)})\\nprint(msg)`;
    try {
      const proc = spawn(resolvedPhonePy, ["-c", pyCode], { detached: true, stdio: "ignore" });
      proc.unref();
      return { success: true, message: `Dialing ${rawTarget} via Phone Link!` };
    } catch (e: any) {
      return { success: false, message: `Failed to initiate call: ${e.message}` };
    }
  }

  if (cmd === "answer_phone_call" || cmd === "accept_phone_call") {
    const pyCode = `${phoneImportPrefix}ok, msg = PhoneLinkControl.answer_call()\\nprint(msg)`;
    try {
      const proc = spawn(resolvedPhonePy, ["-c", pyCode], { detached: true, stdio: "ignore" });
      proc.unref();
      return { success: true, message: "Incoming call accept ho gaya hai, boss." };
    } catch (e: any) {
      return { success: false, message: `Failed to answer call: ${e.message}` };
    }
  }

  if (cmd === "reject_phone_call" || cmd === "decline_phone_call") {
    const pyCode = `${phoneImportPrefix}ok, msg = PhoneLinkControl.reject_call()\\nprint(msg)`;
    try {
      const proc = spawn(resolvedPhonePy, ["-c", pyCode], { detached: true, stdio: "ignore" });
      proc.unref();
      return { success: true, message: "Call cut / reject kar diya gaya hai, boss." };
    } catch (e: any) {
      return { success: false, message: `Failed to reject call: ${e.message}` };
    }
  }"""

# Normalize \r\n to \n for matching
text_norm = text.replace("\r\n", "\n")
old_block_norm = old_block.replace("\r\n", "\n")

if old_block_norm in text_norm:
    updated = text_norm.replace(old_block_norm, new_block)
    with open(r"D:\era-voice-assistant\server\agentBridge.ts", "w", encoding="utf-8") as f:
        f.write(updated)
    print("Updated agentBridge.ts successfully!")
else:
    print("Could not find old_block in agentBridge.ts")
