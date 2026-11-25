import { Type } from "@google/genai";

export const SCHEDULER_TOOL_DECLARATIONS = [
  {
    name: "buildWebsiteApp",
    description:
      "AUTONOMOUS WEBSITE, SOFTWARE & APP SYNTHESIZER (Production Studio Class): Autonomously synthesizes, codes, and launches a complete production-grade website, web app, SaaS dashboard, game, portfolio, or custom software on localhost and opens it directly in the user's browser on a single command. ALWAYS call this tool immediately whenever the user asks in voice or chat to create, build, or develop any website, software, app, or game (e.g. 'website banao', 'portfolio banao', 'snake game banao', 'crypto dashboard banao', 'ecommerce store banao', 'app bana do', 'ek website create karo').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description:
            "Full natural language description of the website, application, software, or game to build.",
        },
        projectName: {
          type: Type.STRING,
          description:
            "Optional short clean name for the project (e.g. 'SnakeGame', 'CryptoTracker', 'NovaStore').",
        },
        autoPreview: {
          type: Type.BOOLEAN,
          description: "Whether to automatically open the live preview in the browser (defaults to true).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "getCurrentIndianTime",
    description:
      "Returns the exact current Indian Standard Time (IST / Asia/Kolkata, UTC+05:30), date, weekday, 12-hour and 24-hour clock. ALWAYS call this when asked for current time/date or when computing exact IST schedules.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "scheduleTask",
    description:
      "MANDATORY ALARM-STYLE SCHEDULER: Schedules ANY task, PC shutdown/restart/sleep/lock, brightness/volume/Wi-Fi/Bluetooth change, app/website launch, WhatsApp/email/call, alarm/reminder, or arbitrary autonomous goal to execute AUTOMATICALLY after a relative delay OR at an exact Indian Standard Time (IST / Asia/Kolkata) wall-clock time. NEVER promise 'kar dungi' without calling this tool!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description:
            "Short clear label for the scheduled task (e.g., 'PC Shutdown', 'Set Screen Brightness 30%', 'Open YouTube', 'Alarm: Drink Water').",
        },
        actionType: {
          type: Type.STRING,
          enum: ["tool", "autonomous_goal", "alarm"],
          description:
            "Use 'tool' for a direct system/app/hardware/message tool (fastest & exact), 'autonomous_goal' for ANY custom or multi-step desktop/app task, or 'alarm' for an alarm/reminder ring & voice alert.",
        },
        toolName: {
          type: Type.STRING,
          description:
            "Required when actionType='tool'. Exact tool name, e.g., 'orderFoodAutonomous', 'systemControl', 'setDisplayBrightness', 'adjustDisplayBrightness', 'setAudioVolume', 'adjustAudioVolume', 'toggleAudioMute', 'setBluetoothState', 'setWifiState', 'setKeyboardBacklight', 'openApplication', 'openWebsite', 'openBrowser', 'closeBrowser', 'openFile', 'openFolder', 'searchFile', 'lockPC', 'minimizeAll', 'maximizeWindow', 'splitScreen', 'snapWindow', 'sendWhatsAppMessage', 'sendWhatsAppToMultiple', 'sendGmail', 'makePhoneCall', 'typeText', 'pressKeyCombination', 'executeLocalAgentCommand'.",
        },
        toolArgsJson: {
          type: Type.STRING,
          description:
            "JSON string of parameters for toolName. Examples: '{\"action\":\"shutdown\",\"confirmed\":true}', '{\"action\":\"restart\",\"confirmed\":true}', '{\"action\":\"sleep\",\"confirmed\":true}', '{\"level\":30}', '{\"appName\":\"notepad\"}', '{\"url\":\"https://www.youtube.com\"}', '{\"enable\":false}'.",
        },
        toolArgs: {
          type: Type.OBJECT,
          description: "Optional parameter object for toolName (alternative to toolArgsJson).",
        },
        objective: {
          type: Type.STRING,
          description:
            "Required when actionType='autonomous_goal'. Full natural-language instruction for ERA to autonomously execute at trigger time.",
        },
        alarmMessage: {
          type: Type.STRING,
          description: "Message to ring and speak aloud when actionType='alarm'.",
        },
        delaySeconds: {
          type: Type.NUMBER,
          description: "Relative delay in seconds from now (e.g., 60 for 1 minute, 30 for 30 seconds).",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Relative delay in minutes from now (e.g., 1 for 1 minute, 15 for 15 minutes).",
        },
        delayHours: {
          type: Type.NUMBER,
          description: "Relative delay in hours from now (e.g., 2 for 2 hours).",
        },
        targetTimeIst: {
          type: Type.STRING,
          description:
            "Exact target time in Indian Standard Time (IST / Asia/Kolkata, UTC+05:30). Supports '21:30', '9:30 PM', '2026-11-11T21:30:00+05:30', 'subah 7 baje', 'kal 8:00 AM', etc.",
        },
        recurrence: {
          type: Type.STRING,
          enum: ["once", "daily"],
          description: "Use 'daily' only if the user asked for every day / roz / daily; otherwise 'once'.",
        },
        runInBackground: {
          type: Type.BOOLEAN,
          description: "For autonomous_goal, set true if user asked to run silently in background.",
        },
      },
      required: ["title", "actionType"],
    },
  },
  {
    name: "listScheduledTasks",
    description:
      "Lists all scheduled tasks, countdown timers, and alarms with their exact IST execution time, status, and remaining seconds.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          enum: ["pending", "completed", "cancelled", "failed", "all"],
          description: "Filter by status (defaults to 'pending').",
        },
      },
    },
  },
  {
    name: "cancelScheduledTask",
    description:
      "Cancels a pending scheduled task, timer, or alarm by its taskId, keyword (e.g. 'shutdown', 'brightness', 'alarm'), 'last', or 'all'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskIdOrQuery: {
          type: Type.STRING,
          description: "Task ID (e.g. 'sched_...'), keyword (e.g. 'shutdown', 'brightness', 'alarm'), 'last', or 'all'.",
        },
      },
      required: ["taskIdOrQuery"],
    },
  },
  {
    name: "performResearch",
    description:
      "Performs exhaustive deep research on any topic, technology, company, news, person, or question. Call IMMEDIATELY when boss asks to 'research karo', 'reserch karo', 'research this', 'investigate', or asks for deep knowledge. Produces a 100% complete structured report with Overview, Technical Architecture, Real-World Data, Pros/Cons, Strategic Roadmap, and a concise spoken Hinglish summary.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: {
          type: Type.STRING,
          description: "Topic, technology, question, or domain to research.",
        },
        depth: {
          type: Type.STRING,
          enum: ["standard", "deep", "exhaustive"],
          description: "Research depth (defaults to 'deep').",
        },
        focusAreas: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Optional list of specific sub-angles to focus on.",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "generateDetailedSummary",
    description:
      "Creates an exhaustive, 100% complete, non-truncated structured summary on any topic, document, or context. Call IMMEDIATELY when boss asks to 'summary banao', 'summery banao', 'summarize this', or 'detailed summary do'. NEVER leaves sections half-finished.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: {
          type: Type.STRING,
          description: "Topic or title of the subject to summarize.",
        },
        content: {
          type: Type.STRING,
          description: "Optional text or article to summarize. If omitted, performs deep research on topic first.",
        },
        format: {
          type: Type.STRING,
          enum: ["executive", "bulleted", "detailed_report"],
          description: "Summary format style.",
        },
      },
      required: ["topic"],
    },
  },
];

export const CHATBOT_TOOL_DECLARATIONS = [
  ...SCHEDULER_TOOL_DECLARATIONS,
  {
    name: "systemControl",
    description:
      "Executes or schedules system power actions: shutdown, restart, sleep, lock, cancel_shutdown. If delaySeconds or targetTimeIst is given, automatically schedules it on the IST scheduler.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          enum: ["shutdown", "restart", "sleep", "lock", "cancel_shutdown", "cancel"],
        },
        confirmed: { type: Type.BOOLEAN },
        delaySeconds: { type: Type.NUMBER, description: "Optional delay in seconds before executing." },
        scheduledTimeIst: { type: Type.STRING, description: "Optional exact IST time to execute." },
      },
      required: ["action"],
    },
  },
  {
    name: "cancelShutdown",
    description: "Immediately cancels any pending or scheduled PC shutdown or restart.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "setDisplayBrightness",
    description: "Sets laptop screen brightness level percentage (0 to 100).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        level: { type: Type.INTEGER, description: "Brightness level 0 to 100." },
      },
      required: ["level"],
    },
  },
  {
    name: "adjustDisplayBrightness",
    description: "Adjusts screen brightness up or down by relative percentage delta (e.g., 20 or -20).",
    parameters: {
      type: Type.OBJECT,
      properties: { delta: { type: Type.INTEGER } },
      required: ["delta"],
    },
  },
  {
    name: "setAudioVolume",
    description: "Sets master audio volume percentage (0 to 100).",
    parameters: {
      type: Type.OBJECT,
      properties: { level: { type: Type.INTEGER } },
      required: ["level"],
    },
  },
  {
    name: "adjustAudioVolume",
    description: "Adjusts master audio volume by relative delta (e.g., 15 or -15).",
    parameters: {
      type: Type.OBJECT,
      properties: { delta: { type: Type.INTEGER } },
      required: ["delta"],
    },
  },
  {
    name: "toggleAudioMute",
    description: "Mutes or unmutes system audio.",
    parameters: {
      type: Type.OBJECT,
      properties: { mute: { type: Type.BOOLEAN } },
    },
  },
  {
    name: "setBluetoothState",
    description: "Turns Bluetooth on or off.",
    parameters: {
      type: Type.OBJECT,
      properties: { enable: { type: Type.BOOLEAN } },
      required: ["enable"],
    },
  },
  {
    name: "setWifiState",
    description: "Turns Wi-Fi on or off.",
    parameters: {
      type: Type.OBJECT,
      properties: { enable: { type: Type.BOOLEAN } },
      required: ["enable"],
    },
  },
  {
    name: "setKeyboardBacklight",
    description: "Sets keyboard backlight brightness percentage (0 to 100).",
    parameters: {
      type: Type.OBJECT,
      properties: { level: { type: Type.INTEGER } },
      required: ["level"],
    },
  },
  {
    name: "startGestureControl",
    description: "Starts the real-time camera hand gesture recognition intelligence engine to control display brightness, master volume, and PC tasks via camera hand gestures.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        camera: { type: Type.INTEGER, description: "Camera index (default 0)" },
        preview: { type: Type.BOOLEAN, description: "Whether to show visual HUD window (default true)" },
      },
    },
  },
  {
    name: "stopGestureControl",
    description: "Stops the real-time camera hand gesture recognition engine.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "getGestureStatus",
    description: "Checks whether the camera hand gesture intelligence engine is running.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "openApplication",
    description: "Opens a local desktop application (e.g., 'chrome', 'vscode', 'notepad', 'whatsapp', 'spotify', 'calculator').",
    parameters: {
      type: Type.OBJECT,
      properties: { appName: { type: Type.STRING } },
      required: ["appName"],
    },
  },
  {
    name: "openWebsite",
    description: "Opens a website URL in the browser (e.g. 'https://www.youtube.com').",
    parameters: {
      type: Type.OBJECT,
      properties: { url: { type: Type.STRING } },
      required: ["url"],
    },
  },
  {
    name: "closeBrowser",
    description: "Closes the currently active browser window.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "closeApplication",
    description: "Closes/terminates a running application by its friendly name (e.g., 'opera', 'notepad', 'chrome', 'whatsapp', 'spotify', 'vscode', 'calculator', 'telegram'). Use this when the boss asks to close, band karo, quit, or exit an app.",
    parameters: {
      type: Type.OBJECT,
      properties: { appName: { type: Type.STRING, description: "Friendly name of the app to close, e.g. 'opera', 'notepad', 'chrome'." } },
      required: ["appName"],
    },
  },
  {
    name: "lockPC",
    description: "Locks the Windows computer immediately.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "openFile",
    description: "Finds and opens a file on the laptop.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: { type: Type.STRING },
        openWith: { type: Type.STRING },
      },
      required: ["filename"],
    },
  },
  {
    name: "sendWhatsAppMessage",
    description:
      "Sends or schedules a WhatsApp message to a contact name or phone number. If delaySeconds/delayMinutes/scheduledTimeIst is provided, schedules it in IST instead of sending immediately.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        contactName: { type: Type.STRING },
        message: { type: Type.STRING },
        delaySeconds: { type: Type.NUMBER, description: "Optional delay in seconds before sending." },
        delayMinutes: { type: Type.NUMBER, description: "Optional delay in minutes before sending." },
        delayHours: { type: Type.NUMBER, description: "Optional delay in hours before sending." },
        scheduledTimeIst: { type: Type.STRING, description: "Optional exact IST time to send (e.g. '21:30', '9:30 PM')." },
      },
      required: ["contactName", "message"],
    },
  },
  {
    name: "sendWhatsAppToMultiple",
    description: "Sends or schedules WhatsApp messages sequentially to multiple contacts. Use recipients=[{contact, message}] whenever different people should receive different messages!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        recipients: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              contact: { type: Type.STRING },
              message: { type: Type.STRING },
            },
            required: ["contact", "message"],
          },
          description: "Per-recipient {contact, message} pairs for sending distinct messages to different contacts.",
        },
        contacts: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        message: { type: Type.STRING },
        delaySeconds: { type: Type.NUMBER, description: "Optional delay in seconds before sending." },
        delayMinutes: { type: Type.NUMBER, description: "Optional delay in minutes before sending." },
        delayHours: { type: Type.NUMBER, description: "Optional delay in hours before sending." },
        scheduledTimeIst: { type: Type.STRING, description: "Optional exact IST time to send." },
      },
    },
  },
  {
    name: "makePhoneCall",
    description: "Calls a contact or phone number via Windows Phone Link.",
    parameters: {
      type: Type.OBJECT,
      properties: { target: { type: Type.STRING } },
      required: ["target"],
    },
  },
  {
    name: "executeAutonomousGoal",
    description:
      "Autonomously executes any multi-step desktop or app objective (e.g., opening apps, typing, navigating, clicking, saving files).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        objective: { type: Type.STRING },
        autonomousWithoutConfirmation: { type: Type.BOOLEAN },
        runInBackground: { type: Type.BOOLEAN },
      },
      required: ["objective"],
    },
  },
  {
    name: "captureScreen",
    description:
      "Captures the user's real-time physical desktop screen and returns live visual analysis of what is open right now.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "inspectVSCodeScreen",
    description:
      "Inspects the user's VS Code window and desktop screen (even if VS Code is behind ERA), detects the open file and project, reads the exact source file from disk, checks syntax errors, and analyzes visible editor/terminal errors.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        focusInstruction: {
          type: Type.STRING,
          description: "What the user is stuck on or asking to check (e.g. 'fix syntax error', 'complete next logic').",
        },
        filepath: {
          type: Type.STRING,
          description: "Optional explicit file path if known.",
        },
      },
    },
  },
  {
    name: "fixOrWriteCodeFile",
    description:
      "Fixes bugs/errors or completes/writes code in ANY language for the active VS Code file or a new/specified file path (with automatic undo backup), optionally opening in VS Code and running it right away.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        instruction: {
          type: Type.STRING,
          description: "Clear description of the fix or next code to write.",
        },
        filepath: {
          type: Type.STRING,
          description: "Full path or workspace filename to fix/write. If omitted, uses the active VS Code file.",
        },
        filename: {
          type: Type.STRING,
          description: "Filename if creating a new file (e.g. 'app.py', 'index.ts').",
        },
        newContent: {
          type: Type.STRING,
          description: "Optional complete replacement code if already generated. If omitted, ERA AI generates the full fix automatically.",
        },
        language: {
          type: Type.STRING,
          description: "Programming language (e.g. 'python', 'javascript', 'typescript', 'cpp', 'java').",
        },
        openInVscode: {
          type: Type.BOOLEAN,
          description: "Whether to open/focus the updated file in VS Code (default true).",
        },
        autoRun: {
          type: Type.BOOLEAN,
          description: "Whether to run and verify the code immediately after saving.",
        },
      },
      required: ["instruction"],
    },
  },
  {
    name: "runAnyCode",
    description:
      "Runs ANY code file (from VS Code project path or ERA workspace) or inline code snippet in Python, JS, TS, C, C++, Java, Go, Rust, PowerShell, Bash, Ruby, PHP, or HTML and returns stdout, stderr, exitCode, and duration.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filepath: {
          type: Type.STRING,
          description: "Full path or workspace filename of the file to run.",
        },
        code: {
          type: Type.STRING,
          description: "Optional inline code snippet to execute if no file exists yet.",
        },
        language: {
          type: Type.STRING,
          description: "Language hint (e.g. 'python', 'javascript', 'typescript', 'cpp').",
        },
      },
    },
  },
  {
    name: "undoCodeEdit",
    description: "Restores the previous backup of the last edited code file.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filepath: { type: Type.STRING, description: "Optional filepath to undo." },
      },
    },
  },
  {
    name: "writeCode",
    description: "Writes computer code to a file in the ERA workspace directory.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        language: { type: Type.STRING },
        filename: { type: Type.STRING },
        code: { type: Type.STRING },
      },
      required: ["language", "filename", "code"],
    },
  },
  {
    name: "runCode",
    description: "Executes a code file from workspace or full path and returns console output.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: { type: Type.STRING },
      },
      required: ["filename"],
    },
  },
  {
    name: "editFileAtPath",
    description: "Modifies a local file on disk by replacing oldText with newText (with automatic backup).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filepath: { type: Type.STRING },
        oldText: { type: Type.STRING },
        newText: { type: Type.STRING },
      },
      required: ["filepath", "oldText", "newText"],
    },
  },
  {
    name: "typeText",
    description: "Types or writes text into the active input box / chatbot / editor on screen.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: "Text to write/type." },
        appName: { type: Type.STRING, description: "Optional app name to focus first (e.g. 'whatsapp', 'notepad', 'chrome', 'vscode')." },
      },
      required: ["text"],
    },
  },
  {
    name: "deleteText",
    description: "Deletes a particular word, phrase, drafted message, last word, last line, or all drafted text from the active input box or editor on screen, verifying the deletion honestly. NEVER claim a word/message was deleted unless this returns success: true!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: "Exact word, phrase, or message to delete (e.g. 'hello', 'kal milte hain')." },
        mode: {
          type: Type.STRING,
          enum: ["word", "phrase", "last_word", "last_line", "all"],
          description: "Use 'word'/'phrase' when deleting a specific word/message, 'last_word' for last word, 'last_line' for last line, or 'all' to clear the entire drafted message.",
        },
        appName: { type: Type.STRING, description: "Optional app name to focus (e.g. 'whatsapp', 'notepad', 'chrome', 'vscode')." },
        occurrence: {
          type: Type.STRING,
          enum: ["last", "first", "all"],
          description: "Which occurrence to remove (default 'last').",
        },
      },
    },
  },
  {
    name: "pressKeyCombination",
    description: "Presses a keyboard key or shortcut combination (e.g. ['enter'], ['backspace'], ['ctrl', 'z']).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        keys: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        appName: { type: Type.STRING, description: "Optional app name to focus first." },
      },
      required: ["keys"],
    },
  },
  {
    name: "orderFoodAutonomous",
    description:
      "AUTONOMOUS FOOD ORDERING: Autonomously searches Swiggy or Zomato for any dish or food item, evaluates items strictly within the user's budget range, matches the requested quantity, uses the PC's live location, adds items to cart, and navigates to the checkout screen with Cash on Delivery (COD). CALL THIS TOOL IMMEDIATELY whenever the user asks to order food, order a dish, buy food, or says 'kuch order karo' or gives a budget/dish/quantity! NEVER claim the order is placed if the cart is empty or login is pending!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        dish: {
          type: Type.STRING,
          description: "Name of the dish or food item (e.g. 'chicken biryani', 'paneer butter masala', 'margherita pizza', 'burger').",
        },
        quantity: {
          type: Type.NUMBER,
          description: "Quantity of the dish to order (e.g. 1, 2, 3, default: 1).",
        },
        maxBudget: {
          type: Type.NUMBER,
          description: "Maximum total budget or upper price limit in INR (e.g. 150, 200, 300, 400).",
        },
        minBudget: {
          type: Type.NUMBER,
          description: "Optional minimum price limit in INR.",
        },
        platform: {
          type: Type.STRING,
          enum: ["swiggy", "zomato", "auto"],
          description: "Which platform to use ('swiggy', 'zomato', or 'auto' for best available, default 'auto').",
        },
        location: {
          type: Type.STRING,
          description: "Optional delivery address or locality spoken by user. Defaults to live PC location.",
        },
        city: {
          type: Type.STRING,
          description: "Optional city or delivery address.",
        },
        runInBackground: {
          type: Type.BOOLEAN,
          description: "Whether to run browser invisibly in background (default false, so user can see ERA live in browser).",
        },
      },
      required: ["dish"],
    },
  },
  {
    name: "submitFoodOtp",
    description: "Submit or enter the One-Time Password (OTP) on the food delivery platform (Swiggy / Zomato) screen when requested during login or checkout.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        otp: {
          type: Type.STRING,
          description: "The 4-digit or 6-digit OTP code received on user's mobile phone (e.g. '482910'). Clean numeric digits.",
        },
      },
      required: ["otp"],
    },
  },
  {
    name: "completeFoodOrder",
    description: "Completes food ordering on Swiggy or Zomato: fills or confirms delivery address using user's phone live location (Bodla, Agra), selects Cash on Delivery, and places the order. Call this whenever the user says 'address fill karo', 'address dalo', 'order complete karo', 'confirm order', 'fill karo'!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        address: {
          type: Type.STRING,
          description: "Optional custom address string. If omitted, uses phone's live location (Bodla, Agra) automatically.",
        },
      },
    },
  },
  {
    name: "searchWebVerifiedInfo",
    description:
      "LIVE WEB SEARCH & BREAKING REAL-TIME UPDATES ONLY: Use this tool ONLY when the boss explicitly asks to search the web, search Google, or check today's live breaking news/events (e.g. 'Google pe search karo', 'web pe dhundho', 'aaj ka live update check karo'). DO NOT call this tool for general domain explanations, law, medical symptoms, physiotherapy rehab, science, or coding, because you already possess comprehensive native specialist knowledge in those disciplines.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Specific search query to look up on the web when explicitly asked.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "scrollScreen",
    description: "Smoothly scrolls the active screen or specified application window up or down with fluid, natural sinusoidal easing. Use whenever user asks to scroll ('scroll karo', 'upar scroll karo', 'neeche scroll karo', 'thoda neeche karo', 'scroll down', 'scroll up', etc.).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: {
          type: Type.STRING,
          description: "Scroll direction: 'down', 'up', 'top', 'bottom'. Defaults to 'down'.",
        },
        amount: {
          type: Type.STRING,
          description: "Scroll amount: 'gentle', 'normal', 'large', 'page'. Defaults to 'normal'.",
        },
        appName: {
          type: Type.STRING,
          description: "Application name to target (e.g. 'whatsapp', 'chrome', 'chatgpt', 'browser').",
        },
        smooth: {
          type: Type.BOOLEAN,
          description: "Whether to use smooth easing. Defaults to true.",
        },
      },
    },
  },
  {
    name: "smoothScroll",
    description: "Direct alias for scrollScreen. Smoothly scrolls the screen up or down.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: { type: Type.STRING },
        amount: { type: Type.STRING },
        appName: { type: Type.STRING },
      },
    },
  },
  {
    name: "readAndScrollWhatsApp",
    description: "Opens a WhatsApp chat with the specified contact, smoothly scrolls through the conversation up or down, and reads/summarizes the chat messages for the user.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        contactName: {
          type: Type.STRING,
          description: "Name or phone number of the WhatsApp contact to open and read.",
        },
        direction: {
          type: Type.STRING,
          description: "Scroll direction: 'up' (earlier messages) or 'down' (recent messages).",
        },
        scrollSteps: {
          type: Type.NUMBER,
          description: "Number of smooth scroll steps.",
        },
      },
    },
  },
  {
    name: "researchAndScroll",
    description: "Autonomously researches a topic on Google, ChatGPT, or the web, and smoothly scrolls through the results/responses to find, display, and read the specific requested item or answer for the user.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "The topic, question, or person to research or search for.",
        },
        targetItem: {
          type: Type.STRING,
          description: "The specific item, person detail, section, or answer to locate and scroll to.",
        },
        appName: {
          type: Type.STRING,
          description: "Application to use: 'chrome', 'browser', 'chatgpt'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "scrollToContent",
    description: "Autonomously and smoothly scrolls the active screen, web browser, Wikipedia page, or document until a specific requested topic, section, or heading (e.g. 'education', 'business', 'career', 'early life', 'net worth', 'awards', etc.) is fully in view, and reads/explains the visible content to the user in friendly Hindi/Hinglish. Use whenever the user asks to bring a specific topic or section into view or scroll until a topic is found ('iski education lao', 'business section samne lao', 'career tak scroll karo', 'scroll to [topic]', 'waha tak scroll karo jabtak ye na aaye', etc.).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: {
          type: Type.STRING,
          description: "The specific topic, section name, or heading to find and bring into view (e.g. 'education', 'business', 'career', 'early life', 'net worth', 'achievements', 'awards').",
        },
        appName: {
          type: Type.STRING,
          description: "Application name to target (e.g. 'chrome', 'msedge', 'opera', 'browser'). Defaults to active window.",
        },
        direction: {
          type: Type.STRING,
          description: "Scroll direction: 'down' (default) or 'up'.",
        },
        explain: {
          type: Type.BOOLEAN,
          description: "Whether to analyze the screen with Vision and explain the found section to the user. Defaults to true.",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "scrollToTarget",
    description: "Direct alias for scrollToContent. Smoothly scrolls until the requested target section or topic is visible on screen and explains it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: {
          type: Type.STRING,
          description: "Target section or topic to scroll to.",
        },
        appName: {
          type: Type.STRING,
          description: "Application name (e.g. 'chrome', 'browser').",
        },
      },
      required: ["target"],
    },
  },
];
