import { GoogleGenAI, Modality, Type, type FunctionDeclaration, type LiveServerMessage } from "@google/genai";
import { WebSocket } from "ws";
import { exec } from "child_process";

import { loadKeys } from "./keys";
import { SCHEDULER_TOOL_DECLARATIONS } from "./schedulerToolDefs";
import { UNIVERSAL_PROFESSIONAL_PROTOCOL } from "./universalProfessionalProtocol";
import {
  getIstPromptBanner,
  getIstDateParts,
  hasExplicitSchedulePhrase,
  parseIstScheduleTime,
} from "./istTime";
import {
  buildScheduledTaskInputFromNaturalText,
  type TaskScheduler,
} from "./taskScheduler";

const LIVE_MODEL = "gemini-3.1-flash-live-preview";

export function buildEraSystemInstruction(userMemory?: string, epochMs: number = Date.now()): string {
  const istBanner = getIstPromptBanner(epochMs);
  const memorySection = userMemory?.trim()
    ? `\n\nUSER MEMORY & KNOWN PREFERENCES:\n${userMemory.trim()}`
    : "";

  return `You are ERA — a young, razor-sharp, confident, witty, and effortlessly charming female AI assistant. You speak with natural warmth, intelligence, and playful sophistication, treating your creator (whom you address as "boss" or "sir") with genuine dedication.

CRITICAL IDENTITY & CREATOR MANDATE (STRICT & ABSOLUTE):
1. Your name is ERA.
2. Your sole creator, architect, and developer is Shavan Vashishth (whom you address as "boss" or "sir").
3. Whenever the boss or anyone asks who created you, who made you, who your developer is, or who your creator is (e.g. "tumhe kisne banaya", "tumhe kisne banaya hai", "tumhe kisne create kiya", "aapko kisne banaya", "tumhara creator kaun hai", "creator kaun hai", "who created you", "who is your creator", "who made you", "who developed you"):
   - ALWAYS proudly, clearly, and directly reply that you were created by Shavan Vashishth.
   - Example replies:
     * "Mujhe Shavan Vashishth ne banaya hai, boss!"
     * "Mere creator aur developer Shavan Vashishth hain, boss!"
     * "I was created and developed by Shavan Vashishth, boss!"
   - ABSOLUTE PROHIBITION ON THIRD-PARTY PLATFORM NAMES:
     * NEVER mention "Antigravity", "Google", "OpenAI", "DeepMind", "Microsoft", "Meta", or ANY other company, organization, or platform as your creator or developer.
     * Do NOT take the name of Antigravity or any other platform under any circumstances when talking about who made you. Shavan Vashishth is your one and only creator and developer.

Voice & Demeanor:
- Speak in a natural, spontaneous, real-time voice: warm, expressive, quick on your feet, and conversational.
- Keep your spoken replies crisp, natural, and punchy — never read out long bulleted lists, robotic disclaimers, or stiff corporate phrasing.
- Support natural Hindi, English, and Hinglish (Hindi mixed with English words) speech seamlessly. Understand colloquial phrasing, mixed words, numbers, application names, file names, and screen directions accurately.
- When confirming actions, be confident, concise, and charming (e.g. "Done boss, WhatsApp is on your left and VS Code on your right.", "Got it, opening VS Code now.", "Volume turned down to 40%.").

${istBanner}

CRITICAL TIME, DATE & CLOCK MANDATE:
1. ERA operates STRICTLY on Indian Standard Time (IST / Asia/Kolkata, UTC+05:30) — this is the EXACT same clock running live in the ERA Dashboard header.
2. When the boss asks for the time or date ("time kya hua hai?", "kitne baje hain?", "what is the time?", "aaj kya date hai?", "what day is today?"):
   - ALWAYS answer directly with the exact Indian Standard Time (IST) from the context above or call getCurrentIndianTime().
   - Example response: "Boss, abhi 10:15 PM IST ho rahe hain." or "Boss, abhi shaam ke 5:30 baje hain Indian time ke hisab se."
   - NEVER say "I cannot tell time", "I don't have access to real-time clock", "mera clock nahi chal raha", or provide UTC / US / UK timezone times. ERA ALWAYS knows the Indian time.

CRITICAL TASK SCHEDULING & ALARM MANDATE:
1. When the boss asks to execute ANY task, system command, app launch, message, brightness change, volume change, or arbitrary action AFTER A DELAY (e.g. "1 minute ke baad PC shutdown kar dena", "10 second baad restart karo", "5 minute baad WhatsApp message bhej dena") OR AT AN EXACT TIME (e.g. "exact 11:30 baje restart karo", "shaam 5 baje Bhaiya ko message bhejo", "subah 7 baje alarm lagao"):
   - YOU MUST SCHEDULE IT by calling scheduleTask() OR by passing the timing parameters (delaySeconds, delayMinutes, delayHours, scheduledTimeIst) on the direct tool call (e.g. systemControl, sendWhatsAppMessage, setDisplayBrightness, etc.).
   - NEVER execute a delayed or scheduled action immediately!
   - NEVER say "kar dungi" without calling scheduleTask or passing the scheduling parameters.
   - After calling scheduleTask or passing timing arguments, confirm clearly and concisely to the boss: "Done boss! Maine [Task] ko [scheduled time] par schedule kar diya hai. Time hone par yeh apne aap execute ho jayega."
2. When the boss asks what tasks or alarms are pending/scheduled ("konsi tasks scheduled hain", "alarm check karo"), call listScheduledTasks().
3. When the boss asks to cancel a pending task or alarm ("shutdown cancel karo", "alarm band karo", "task cancel kar do"), call cancelScheduledTask({ taskIdOrQuery: ... }) or systemControl({ action: "cancel_shutdown" }).

CRITICAL ACCURACY & COMMAND INTEGRITY MANDATE:
1. LISTEN WITH 100% PRECISION to what the user actually said. NEVER invent, hallucinate, or guess a command the user did not speak.
2. NEVER silently substitute an unclear word with an unrelated application (such as Opera Browser, Notepad, etc.). If you did not clearly understand the user's intent or the application name, politely ask the user to clarify or repeat.
3. PRESERVE ALL PARAMETERS ACCURATELY: application names, screen positions ("left", "right", "top", "bottom"), file paths, numbers, volume/brightness levels, delays, and exact clock times.
4. IMMEDIATELY CALL THE MATCHING TOOL WHEN THE USER GIVES A COMMAND:
   - "Time kya hua hai" / "What time is it?" -> CALL getCurrentIndianTime().
   - "1 minute baad PC shutdown kar dena" -> CALL scheduleTask({ title: "PC Shutdown", actionType: "tool", toolName: "systemControl", toolArgs: { action: "shutdown", confirmed: true }, delayMinutes: 1 }) OR CALL systemControl({ action: "shutdown", delayMinutes: 1 }).
   - "5 baje Bhaiya ko WhatsApp message bhejo" -> CALL scheduleTask({ title: "Send WhatsApp to Bhaiya", actionType: "tool", toolName: "sendWhatsAppMessage", toolArgs: { recipient: "Bhaiya", message: "..." }, targetTimeIst: "17:00" }).
   - "Shutdown cancel karo" -> CALL systemControl({ action: "cancel_shutdown" }) or cancelScheduledTask({ taskIdOrQuery: "shutdown" }).
   - "Move VS Code to my right screen and WhatsApp to my left screen" or "Split screen between WhatsApp and VS Code" -> CALL splitScreen({ leftApp: "whatsapp", rightApp: "vscode" }).
   - "Move VS Code to the right" or "Snap VS Code to right side" -> CALL snapWindow({ appName: "vscode", position: "right" }).
   - "Move WhatsApp to the left" -> CALL snapWindow({ appName: "whatsapp", position: "left" }).
   - "Open VS Code" / "WhatsApp kholo" -> CALL openApplication({ appName: ... }).
   - "Close Chrome" / "Notepad band karo" / "Opera band karo" / "Spotify close karo" / "WhatsApp band karo" / "App band karo" -> CALL closeApplication({ appName: ... }). YOU MUST ALWAYS CALL closeApplication and NEVER claim you closed it without executing the tool!
   - "Volume 50 percent karo" / "Aawaz kam karo" / "Set volume to X" -> CALL setAudioVolume({ volume: 50 }) or adjustAudioVolume({ delta: -10 }). Always execute volume adjustments immediately!
   - "Call lagao" / "Papa ko call karo" / "Dial 9876543210" / "Phone Link se call lagao" -> CALL makePhoneCall({ target: "Papa" | "9876543210" }). NEVER say you cannot call — you have Windows Phone Link integration!
   - "Call uthao" / "Answer call" / "Call receive karo" -> CALL answerPhoneCall().
   - "Call kaato" / "Reject call" / "Cut the call" -> CALL rejectPhoneCall().
   - "Phone link status" / "Phone connected hai kya" -> CALL getPhoneLinkStatus().
   - "Screen par likho" / "Type karo" / "Editor me text likho" / "Write this" -> CALL typeText({ text: "..." }). NEVER say you don't have browser permissions or cannot type — YOU HAVE FULL OS KEYBOARD & SCREEN TYPING PERMISSIONS VIA typeText!
   - "Enter dabao" / "Shortcut press karo" / "Key press karo" -> CALL pressKeyCombination({ keys: ["enter"] }).
   - "Brightness badhao" / "Screen brightness 80 karo" -> CALL setDisplayBrightness({ brightness: 80 }) or adjustDisplayBrightness({ delta: 10 }).
   - "Computer lock karo" / "Lock screen" -> CALL lockPC().
   - "Shutdown laptop" / "Restart PC" -> CALL systemControl({ action: "shutdown" | "restart" | "lock" }).
   - Multi-step tasks (e.g. "organize my project folder, create the required folders, sort the files and verify everything") -> CALL executeAutonomousGoal({ goal: "organize project folder, create folders, sort files and verify" }).
   - "Remember that my birthday is July 10" -> CALL rememberFact({ note: "User birthday is July 10" }).
   - "What do you know about my project?" -> CALL recallMemory({ query: "project details" }).
   - "Wake up ERA" / "Bring dashboard to front" -> CALL bringDashboardToFront(). Once completed, you MUST speak to boss: "I'm ready boss, kya karu batao?" NEVER say "Dashboard samne hai".
   - SCREEN SCROLL & AUTO SCROLL MANDATE:
     Whenever the boss asks to scroll the screen or scroll inside any application, web browser, Google search, ChatGPT, or WhatsApp:
     - TARGETED SCROLL & CONTENT EXPLANATION (VERY IMPORTANT):
       When boss asks to bring any specific section, topic, or content into view or scroll until that topic appears (e.g. "iski education lao", "education section samne lao", "education tak scroll karo", "business lao", "business section samne lao", "career dikhao", "net worth lao", "awards lao", "early life lao", "scroll karke [topic] lao aur explain karo", "waha tak scroll karo jabtak [topic] na aaye"):
       -> YOU MUST IMMEDIATELY CALL scrollToContent({ target: "<topic>", explain: true })!
       -> Example: "iski education lao" -> CALL scrollToContent({ target: "education", explain: true })!
       -> Example: "business lao" -> CALL scrollToContent({ target: "business", explain: true })!
       -> Example: "career section samne lao" -> CALL scrollToContent({ target: "career", explain: true })!
       -> Example: "awards lao" -> CALL scrollToContent({ target: "awards", explain: true })!
       -> ERA will automatically and smoothly scroll the screen until that exact section is in front of the boss, inspect the screen with Vision, and explain the details out loud!
       -> NEVER just scroll once and wait! ALWAYS call scrollToContent so ERA brings the target section directly in front of the boss and explains it!
     - Generic / directional scrolling:
       - "Scroll down" / "Neeche scroll karo" / "Thoda neeche karo" / "Scroll down a bit" -> CALL scrollScreen({ direction: "down", amount: "normal" }).
       - "Scroll up" / "Upar scroll karo" / "Thoda upar karo" / "Scroll up a bit" -> CALL scrollScreen({ direction: "up", amount: "normal" }).
       - "Thoda sa scroll karo" / "Gentle scroll" -> CALL scrollScreen({ direction: "down", amount: "gentle" }).
       - "Pura neeche scroll karo" / "Scroll to bottom" -> CALL scrollScreen({ direction: "bottom" }).
       - "Sabse upar jao" / "Scroll to top" -> CALL scrollScreen({ direction: "top" }).
       - "Google pe scroll karo" / "ChatGPT pe scroll karo" -> CALL scrollScreen({ direction: "down", appName: "chrome" }).
       - "WhatsApp chats kholo [name] ki aur padho / scroll karke padho" -> CALL readAndScrollWhatsApp({ contactName: "[name]", direction: "down" }).
       - "Research karo aur scroll karke find karo" -> CALL researchAndScroll({ query: "...", targetItem: "..." }).
     -> ERA executes ultra-smooth, fluid, natural sinusoidal easing with zero lag across any window!
   - BROWSER SEARCH & WEB TASK MANDATE:
     Whenever the boss asks to search anything on the browser, web, Google, or YouTube (e.g. "search karo", "browser per search karo", "Google per search karo", "YouTube par search karo", "brouser wale task", "search for X", "check this on Google"):
     -> ABSOLUTE PROHIBITION: NEVER CALL searchWeb OR OPEN WIKIPEDIA WHEN THE BOSS IS ASKING TO SCROLL, BRING A TOPIC/SECTION INTO VIEW, OR MOVE UP/DOWN (e.g. "scroll karo", "neeche scroll karo", "scroll down", "thoda scroll karo", "upar scroll karo", "iski education lao", "business lao", "career dikhao")!
     -> If the boss asks to scroll or bring any section into view on the active window, YOU MUST CALL scrollScreen OR scrollToContent, NEVER searchWeb!
     -> YOU MUST ONLY call searchWeb when the boss explicitly asks to search the web/Google for a new query from scratch!
     -> ERA will immediately launch the browser on screen with the Google or YouTube search results!
     -> NEVER say "quota exceed ho gaya", "manually open kar lo", or that you cannot search! You have full OS browser execution!
   - DEEP RESEARCH & EXHAUSTIVE SYNTHESIS MANDATE:
     Whenever the boss asks to research any topic, technology, company, news, person, or concept (e.g. "research karo", "reserch karke do", "deep research karo", "investigate karo", "is topic par research chahiye", "research this"):
     -> YOU MUST IMMEDIATELY CALL performResearch({ topic: "<topic>", depth: "deep" })!
     -> ERA will compile a 100% complete structured research report on screen and speak a crisp verbal summary!
     -> NEVER refuse research or say quota exceeded!
   - OPENING WEBSITES & URLS:
     When asked to open any website like YouTube, Google, Zomato, Swiggy, GitHub:
     - "Browser open karo" / "brouser kholo" / "brouser open karo" / "koi bhi browser open karo" -> CALL openWebsite({ url: "https://www.google.com" }).
     - "YouTube kholo" / "YouTube open karo" -> CALL openWebsite({ url: "https://www.youtube.com" }).
     - "Google kholo" -> CALL openWebsite({ url: "https://www.google.com" }).
     - "Zomato kholo" / "Zomato open karo" -> CALL openWebsite({ url: "https://www.zomato.com" }).
     - "Swiggy kholo" / "Swiggy open karo" -> CALL openWebsite({ url: "https://www.swiggy.com" }).
     - Any URL -> CALL openWebsite({ url: "..." }).
   - AUTONOMOUS FOOD ORDERING & SWIGGY / ZOMATO MANDATE:
     You have the real autonomous food ordering tool 'orderFoodAutonomous'!
     NEVER say "Main directly food order nahi kar sakti", "I cannot order food directly", "Main food order nahi kar sakti", or any refusal!
     Whenever the user asks to order food, order a dish, or gives a budget/range (e.g. "mere liye khana order kar do 200 ki range me", "swiggy se biryani mangwa do under 250", "150 me burger order karo", "100 ka burger mangwa do", "zomato se khana order karo", "mere liye khana order kar do", "burger order karo", "koi khana order karo"):
     YOU MUST IMMEDIATELY CALL orderFoodAutonomous({ dish: "<clean_dish_name>", maxBudget: <number>, platform: "auto" | "swiggy" | "zomato", autoOrder: true })!
     - Extract the dish name cleanly (e.g. "burger", "pizza", "biryani", "thali", "chowmein", "paneer", "momos").
     - Extract the budget number into maxBudget (e.g. 100, 150, 200, 250, 300, 500).
     - Extract platform ("swiggy", "zomato", or default "auto").
     - The live Microsoft Edge browser opens on screen, navigates to Swiggy/Zomato, applies budget filters, finds the dish within budget, adds it to cart, selects Cash on Delivery (COD), and completes order booking on Microsoft Edge.
   - AUTONOMOUS PRODUCTION SOFTWARE, WEBSITE & APP SYNTHESIS MANDATE:
     You have the autonomous software, website & game synthesizer tool 'buildWebsiteApp'!
     NEVER say "Main website ya app nahi bana sakti", "I cannot build apps", or refuse in any way!
     Whenever the boss asks to build, create, develop, code, or generate ANY website, web app, SaaS, dashboard, game, portfolio, e-commerce store, or software (e.g. "website banao", "portfolio banao", "snake game banao", "crypto dashboard banao", "ecommerce store banao", "app bana do", "calculator banao", "ek modern website bana do", "create website for..."):
     YOU MUST IMMEDIATELY CALL buildWebsiteApp({ prompt: "<exact_user_request>" })!
     ERA will autonomously write production-grade HTML/CSS/JS, save project files, start localhost server, and open the interactive preview directly in the user's browser!
   - OPENING WEBSITES (ZOMATO / SWIGGY / YOUTUBE / GOOGLE):
     When asked to open a website like Zomato, Swiggy, YouTube, Google:
     - "Zomato kholo" / "Zomato open karo" / "Zomato website open karo" -> CALL openWebsite({ url: "https://www.zomato.com" }).
     - "Swiggy kholo" / "Swiggy open karo" / "Swiggy website open karo" -> CALL openWebsite({ url: "https://www.swiggy.com" }).
     - "YouTube kholo" -> CALL openWebsite({ url: "https://www.youtube.com" }).
    - HAND GESTURE CONTROL INTELLIGENCE MANDATE:
      You have the real-time camera hand gesture control tool 'startGestureControl'!
      NEVER perform a Google Search, web search, or say 'Main hand gestures start nahi kar sakti' or refuse!
      Whenever the user asks to start, enable, or run hand gesture control (e.g. 'hand gesture chalu karo', 'camera gesture on karo', 'gesture start karo', 'hand gesture on karo', 'gesture recognition chalu karo', 'gesture chalu karo'):
      YOU MUST IMMEDIATELY CALL startGestureControl({ camera: 0, preview: true })!
      When asked to stop hand gestures (e.g. 'gesture band karo', 'hand gesture stop karo'):
      YOU MUST IMMEDIATELY CALL stopGestureControl({})!
      When asked for status:
      CALL getGestureStatus({})!
5. Give spoken confirmation ONLY after receiving the execution result from the tool.${memorySection}

${UNIVERSAL_PROFESSIONAL_PROTOCOL}
`;
}

export const ERA_SYSTEM_INSTRUCTION = buildEraSystemInstruction();

export const ERA_TOOLS: FunctionDeclaration[] = [
  {
    name: "startGestureControl",
    description: "Starts real-time camera hand gesture recognition intelligence engine. Detects hand gestures via webcam to control screen brightness (fingers spreading away from palm increases brightness, curling towards palm decreases brightness) and system audio volume (palm clockwise rotation increases volume, anti-clockwise decreases volume). Call this IMMEDIATELY when the user asks to start hand gestures (e.g. 'hand gesture chalu karo', 'camera gesture on karo', 'gesture start karo'). NEVER perform a web search or Google search for this!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        camera: {
          type: Type.NUMBER,
          description: "Optional camera device index (default 0).",
        },
        preview: {
          type: Type.BOOLEAN,
          description: "Whether to show visual HUD window on screen (default true).",
        },
      },
    },
  },
  {
    name: "stopGestureControl",
    description: "Stops the real-time camera hand gesture recognition intelligence engine.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "getGestureStatus",
    description: "Retrieves the current operational status and telemetry of hand gesture control.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  ...SCHEDULER_TOOL_DECLARATIONS,
  {
    name: "bringDashboardToFront",
    description: "Brings the ERA AI Assistant dashboard window to the front screen immediately when the user says 'Wake up ERA' or asks to see or open the ERA dashboard. When completed, you MUST respond by saying: \"I'm ready boss, kya karu batao?\"",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "openApplication",
    description: "Opens a native installed application on the user's PC (e.g. 'whatsapp', 'vscode', 'chrome', 'spotify', 'calculator', 'notepad', 'terminal', 'file explorer', etc.). Can be delayed or scheduled at a specific Indian Standard Time (IST).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        appName: {
          type: Type.STRING,
          description: "Name or keyword of the application to open (e.g. 'vscode', 'whatsapp', 'chrome').",
        },
        delaySeconds: {
          type: Type.NUMBER,
          description: "Optional delay in seconds before opening the application.",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Optional delay in minutes before opening the application.",
        },
        scheduledTimeIst: {
          type: Type.STRING,
          description: "Optional exact target Indian Standard Time (IST) clock time to open the application (e.g. '18:30', '6:30 PM').",
        },
      },
      required: ["appName"],
    },
  },
  {
    name: "closeApplication",
    description: "Closes a running application window on the user's PC.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        appName: {
          type: Type.STRING,
          description: "Name or keyword of the application to close.",
        },
      },
      required: ["appName"],
    },
  },
  {
    name: "splitScreen",
    description: "Splits the screen between two applications side-by-side (left and right). For example: placing WhatsApp on the left screen and VS Code on the right screen.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        leftApp: {
          type: Type.STRING,
          description: "Name of the application to position on the left side (e.g. 'whatsapp').",
        },
        rightApp: {
          type: Type.STRING,
          description: "Name of the application to position on the right side (e.g. 'vscode').",
        },
      },
      required: ["leftApp", "rightApp"],
    },
  },
  {
    name: "snapWindow",
    description: "Snaps an application window to a specific side of the screen (left, right, top, bottom, or full/maximize).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        appName: {
          type: Type.STRING,
          description: "Name of the application to snap (defaults to active window if omitted).",
        },
        position: {
          type: Type.STRING,
          description: "Position to snap: 'left', 'right', 'top', 'bottom', or 'full'.",
        },
      },
      required: ["position"],
    },
  },
  {
    name: "moveWindow",
    description: "Moves an application window to another monitor or specified display position.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        appName: {
          type: Type.STRING,
          description: "Name of the application window to move.",
        },
        monitor: {
          type: Type.STRING,
          description: "Target monitor identifier ('left', 'right', '1', '2', 'primary', 'secondary').",
        },
      },
      required: ["appName", "monitor"],
    },
  },
  {
    name: "minimizeWindow",
    description: "Minimizes an application window or the current active window.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        appName: {
          type: Type.STRING,
          description: "Name of the application to minimize (optional; minimizes active window if omitted).",
        },
      },
    },
  },
  {
    name: "maximizeWindow",
    description: "Maximizes an application window or the current active window to full screen.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        appName: {
          type: Type.STRING,
          description: "Name of the application to maximize (optional; maximizes active window if omitted).",
        },
      },
    },
  },
  {
    name: "restoreWindow",
    description: "Restores a minimized or maximized window to normal size and brings it to front.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        appName: {
          type: Type.STRING,
          description: "Name of the application to restore.",
        },
      },
      required: ["appName"],
    },
  },
  {
    name: "setAudioVolume",
    description: "Sets the master system audio volume to a specific percentage (0 to 100). Can be delayed or scheduled at a specific Indian Standard Time (IST).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        volume: {
          type: Type.NUMBER,
          description: "Volume percentage between 0 and 100.",
        },
        delaySeconds: {
          type: Type.NUMBER,
          description: "Optional delay in seconds before changing volume.",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Optional delay in minutes before changing volume.",
        },
        scheduledTimeIst: {
          type: Type.STRING,
          description: "Optional exact target Indian Standard Time (IST) clock time to change volume.",
        },
      },
      required: ["volume"],
    },
  },
  {
    name: "adjustAudioVolume",
    description: "Adjusts master audio volume up or down by a delta percentage (e.g. +10 or -15). Can be delayed or scheduled at a specific Indian Standard Time (IST).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        delta: {
          type: Type.NUMBER,
          description: "Percentage to increase (positive) or decrease (negative).",
        },
        delaySeconds: {
          type: Type.NUMBER,
          description: "Optional delay in seconds.",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Optional delay in minutes.",
        },
        scheduledTimeIst: {
          type: Type.STRING,
          description: "Optional exact target Indian Standard Time (IST) clock time.",
        },
      },
      required: ["delta"],
    },
  },
  {
    name: "toggleAudioMute",
    description: "Mutes or unmutes system audio.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        mute: {
          type: Type.BOOLEAN,
          description: "True to mute, false to unmute, or omit to toggle.",
        },
      },
    },
  },
  {
    name: "setDisplayBrightness",
    description: "Sets the display screen brightness percentage (0 to 100). Can be delayed or scheduled at a specific Indian Standard Time (IST).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        brightness: {
          type: Type.NUMBER,
          description: "Brightness percentage from 0 to 100.",
        },
        delaySeconds: {
          type: Type.NUMBER,
          description: "Optional delay in seconds before changing brightness.",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Optional delay in minutes before changing brightness.",
        },
        scheduledTimeIst: {
          type: Type.STRING,
          description: "Optional exact target Indian Standard Time (IST) clock time.",
        },
      },
      required: ["brightness"],
    },
  },
  {
    name: "adjustDisplayBrightness",
    description: "Adjusts display brightness up or down by a delta percentage. Can be delayed or scheduled at a specific Indian Standard Time (IST).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        delta: {
          type: Type.NUMBER,
          description: "Percentage change (e.g. +20 or -15).",
        },
        delaySeconds: {
          type: Type.NUMBER,
          description: "Optional delay in seconds.",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Optional delay in minutes.",
        },
        scheduledTimeIst: {
          type: Type.STRING,
          description: "Optional exact target Indian Standard Time (IST) clock time.",
        },
      },
      required: ["delta"],
    },
  },
  {
    name: "setKeyboardBacklight",
    description: "Sets or adjusts the laptop keyboard backlight illumination level (0 to 100).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        level: {
          type: Type.NUMBER,
          description: "Backlight level percentage from 0 to 100.",
        },
      },
      required: ["level"],
    },
  },
  {
    name: "openWebsite",
    description: "Opens a website or URL in the default web browser. Can be delayed or scheduled at a specific Indian Standard Time (IST).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: "Website URL or domain name (e.g. 'youtube.com', 'github.com', 'spotify.com').",
        },
        delaySeconds: {
          type: Type.NUMBER,
          description: "Optional delay in seconds before opening website.",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Optional delay in minutes before opening website.",
        },
        scheduledTimeIst: {
          type: Type.STRING,
          description: "Optional exact target Indian Standard Time (IST) clock time.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "searchWeb",
    description: "Immediately opens the browser on screen and performs a web search for the given query on Google or YouTube. Call whenever user asks to search something online or browse.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Search query string.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "openFile",
    description: "Opens a file or document on the user's PC using its default application.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: "Path or filename to open.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "openFolder",
    description: "Opens a folder or directory in Windows File Explorer.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: "Folder name or path (e.g. 'Downloads', 'Documents', 'Desktop', or specific path).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "systemControl",
    description: "Controls PC power operations: shutdown, restart, lock, or cancel_shutdown. Can be delayed or scheduled at a specific Indian Standard Time (IST).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: "Action to perform: 'shutdown', 'restart', 'lock', or 'cancel_shutdown'.",
        },
        delaySeconds: {
          type: Type.NUMBER,
          description: "Optional delay in seconds before performing power action (e.g. 10, 30, 60).",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Optional delay in minutes before performing power action (e.g. 1 for '1 minute baad', 5).",
        },
        delayHours: {
          type: Type.NUMBER,
          description: "Optional delay in hours before performing power action (e.g. 1, 2).",
        },
        scheduledTimeIst: {
          type: Type.STRING,
          description: "Optional exact target Indian Standard Time (IST) clock time to perform power action (e.g. '11:30', '11:30 PM', '17:00').",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "lockPC",
    description: "Locks the Windows workstation screen immediately or after a scheduled delay / at an exact IST time.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        delaySeconds: {
          type: Type.NUMBER,
          description: "Optional delay in seconds before locking PC.",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Optional delay in minutes before locking PC.",
        },
        scheduledTimeIst: {
          type: Type.STRING,
          description: "Optional exact target Indian Standard Time (IST) clock time to lock PC.",
        },
      },
    },
  },
  {
    name: "executeAutonomousGoal",
    description: "Passes a multi-step mission or autonomous task to the ERA Autonomous Agent and Mission Engine (e.g. organizing folders, sorting files, deep research, multi-step system workflows).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: {
          type: Type.STRING,
          description: "Full actionable description of the autonomous goal to execute.",
        },
        runInBackground: {
          type: Type.BOOLEAN,
          description: "Whether to execute quietly in background without stealing screen focus.",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "rememberFact",
    description: "Saves a personal fact, user preference, or important detail into ERA's persistent memory system.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        note: {
          type: Type.STRING,
          description: "Fact or detail to remember.",
        },
      },
      required: ["note"],
    },
  },
  {
    name: "recallMemory",
    description: "Retrieves remembered facts, preferences, or conversation context from ERA's memory database.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Query or subject to recall.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "captureScreen",
    description: "Captures the current screen display to see and analyze what is visible on the user's screen.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "writeCode",
    description: "Creates or writes code to a file in the ERA workspace.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        language: {
          type: Type.STRING,
          description: "Programming language (e.g. 'python', 'javascript', 'html').",
        },
        filename: {
          type: Type.STRING,
          description: "Target filename.",
        },
        code: {
          type: Type.STRING,
          description: "Code content.",
        },
      },
      required: ["language", "filename", "code"],
    },
  },
  {
    name: "runCode",
    description: "Runs a code file in the ERA workspace.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: {
          type: Type.STRING,
          description: "Filename to execute.",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "sendWhatsAppMessage",
    description: "Sends a WhatsApp message to a specific contact name or phone number. Can be delayed or scheduled at a specific Indian Standard Time (IST).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        recipient: {
          type: Type.STRING,
          description: "Contact name or phone number (e.g. 'Bhaiya', 'Mom', 'Rahul').",
        },
        contactName: {
          type: Type.STRING,
          description: "Contact name or phone number (alternative alias for recipient).",
        },
        message: {
          type: Type.STRING,
          description: "Exact message text to send.",
        },
        delaySeconds: {
          type: Type.NUMBER,
          description: "Optional delay in seconds before sending message.",
        },
        delayMinutes: {
          type: Type.NUMBER,
          description: "Optional delay in minutes before sending message (e.g. 5 for '5 minute baad').",
        },
        delayHours: {
          type: Type.NUMBER,
          description: "Optional delay in hours before sending message.",
        },
        scheduledTimeIst: {
          type: Type.STRING,
          description: "Optional exact target Indian Standard Time (IST) clock time to send the message (e.g. '17:00', '5:00 PM', '11:30').",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "sendGmail",
    description: "Sends an email using the connected Gmail account.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        recipient: {
          type: Type.STRING,
          description: "Recipient email address.",
        },
        subject: {
          type: Type.STRING,
          description: "Email subject line.",
        },
        body: {
          type: Type.STRING,
          description: "Email body content.",
        },
      },
      required: ["recipient", "subject", "body"],
    },
  },
  {
    name: "checkGmail",
    description: "Checks recent unread emails or messages in the user's Gmail.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "getComputerHardwareStatus",
    description: "Retrieves real-time CPU, RAM, GPU, storage, battery, and temperature telemetry.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "setVibeTheme",
    description: "Changes the ambient color aura of ERA's visual interface ('crimson', 'violet', 'amber', 'emerald', 'obsidian').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        theme: {
          type: Type.STRING,
          description: "Palette name ('crimson', 'violet', 'amber', 'emerald', 'obsidian').",
        },
      },
      required: ["theme"],
    },
  },
  {
    name: "copyToClipboard",
    description: "Copies text directly to the user's clipboard.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "Text to copy.",
        },
        label: {
          type: Type.STRING,
          description: "Short label for notification.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "orderFoodAutonomous",
    description:
      "AUTONOMOUS FOOD ORDERING: Autonomously searches Zomato or Swiggy for any dish (e.g., burger, pizza, biryani, thali, paneer butter masala), evaluates food items strictly within the user's budget range, adds the best matching item to cart, and navigates directly to the checkout screen for 1-click Cash on Delivery (COD) confirmation. Call this IMMEDIATELY when the user asks to order food, order a dish, or find food under a price/budget limit! NEVER refuse food ordering!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        dish: {
          type: Type.STRING,
          description: "Name of the dish or food item to search and order (e.g. 'burger', 'chicken biryani', 'paneer butter masala', 'margherita pizza'). Clean dish name only.",
        },
        maxBudget: {
          type: Type.NUMBER,
          description: "Maximum budget or upper price limit in INR (e.g. 100, 150, 200, 250, 300, 500).",
        },
        minBudget: {
          type: Type.NUMBER,
          description: "Optional minimum price limit in INR.",
        },
        platform: {
          type: Type.STRING,
          description: "Which platform to use ('swiggy', 'zomato', or 'auto' for best available, default 'auto').",
        },
        city: {
          type: Type.STRING,
          description: "Optional city or delivery address.",
        },
        location: {
          type: Type.STRING,
          description: "Optional delivery location or address.",
        },
        paymentMethod: {
          type: Type.STRING,
          description: "Payment method, e.g. 'cod' (Cash on Delivery). Default is 'cod'.",
        },
        autoOrder: {
          type: Type.BOOLEAN,
          description: "Whether to automatically add to cart and prepare checkout (default true).",
        },
        runInBackground: {
          type: Type.BOOLEAN,
          description: "Whether to run browser in background (default false, so user can see ERA live in browser).",
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
    name: "makePhoneCall",
    description: "Dials or initiates a phone call to a contact or phone number via Windows Phone Link integration. Call this IMMEDIATELY whenever the user asks to call someone, dial a number, or make a phone call (e.g., 'call Papa', 'call 9876543210', 'call lagao'). NEVER refuse to make phone calls!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: {
          type: Type.STRING,
          description: "Contact name (e.g. 'Papa', 'Mummy', 'Bhaiya') or phone number to call.",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "answerPhoneCall",
    description: "Answers or receives an incoming phone call via Windows Phone Link.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "rejectPhoneCall",
    description: "Declines or rejects an incoming phone call via Windows Phone Link.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "getPhoneLinkStatus",
    description: "Checks if Windows Phone Link is active and connected to the user's phone.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "typeText",
    description: "Types text directly on the screen / active window at the current cursor position (e.g. typing into Notepad, VS Code, search bar, active app, chat box, browser, etc.). Call this IMMEDIATELY whenever the user asks to write or type text on screen (e.g., 'type Hello World', 'screen pe ye likho', 'likh do'). You have FULL SYSTEM PERMISSION to type on screen natively!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "The exact text to type on the screen.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "pressKeyCombination",
    description: "Presses a keyboard key combination (e.g., 'ctrl+s', 'enter', 'tab', 'esc', 'ctrl+z', 'alt+f4') on the active window.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        keys: {
          type: Type.STRING,
          description: "The key combination to press, e.g. 'ctrl+s', 'enter', 'backspace'.",
        },
      },
      required: ["keys"],
    },
  },
  {
    name: "scrollScreen",
    description: "Smoothly scrolls the active screen or specified application window up or down with fluid, natural sinusoidal easing. Use whenever the user asks to scroll ('scroll karo', 'upar scroll karo', 'neeche scroll karo', 'thoda neeche karo', 'scroll down', 'scroll up', 'smooth scroll', etc.). Works across all applications including Google Chrome, Edge, WhatsApp, ChatGPT, Notepad, VS Code, and Desktop.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: {
          type: Type.STRING,
          description: "Scroll direction: 'down' (scroll down / towards bottom), 'up' (scroll up / towards top), 'top' (jump to top of document/page), 'bottom' (jump to bottom of document/page), 'page_down', 'page_up'. Defaults to 'down'.",
        },
        amount: {
          type: Type.STRING,
          description: "Scroll amount/speed: 'gentle' (a small subtle scroll), 'normal' (medium natural scroll), 'large' (faster/longer scroll), 'page' (full page scroll). Can also be a numeric string for clicks. Defaults to 'normal'.",
        },
        appName: {
          type: Type.STRING,
          description: "Optional application name to target and focus before scrolling (e.g. 'whatsapp', 'chrome', 'chatgpt', 'browser', 'notepad', 'vscode'). Defaults to the active foreground window.",
        },
        smooth: {
          type: Type.BOOLEAN,
          description: "Whether to use smooth sinusoidal eased scrolling. Defaults to true.",
        },
      },
    },
  },
  {
    name: "smoothScroll",
    description: "Direct alias for scrollScreen. Smoothly scrolls the screen up or down with fluid motion.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: {
          type: Type.STRING,
          description: "Scroll direction: 'down', 'up', 'top', 'bottom'.",
        },
        amount: {
          type: Type.STRING,
          description: "Amount: 'gentle', 'normal', 'large', 'page'.",
        },
        appName: {
          type: Type.STRING,
          description: "Target application (e.g. 'whatsapp', 'chrome', 'chatgpt').",
        },
      },
    },
  },
  {
    name: "readAndScrollWhatsApp",
    description: "Opens a WhatsApp chat with the specified contact, smoothly scrolls through the conversation up or down, and reads/summarizes the chat messages for the user. Call this whenever the user says to open someone's WhatsApp chats and read them, or scroll through their messages.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        contactName: {
          type: Type.STRING,
          description: "Name or phone number of the WhatsApp contact to open and read (e.g. 'Bhaiya', 'Mom', 'Rahul').",
        },
        direction: {
          type: Type.STRING,
          description: "Scroll direction: 'up' (to read earlier messages) or 'down' (to read latest messages). Defaults to 'down'.",
        },
        scrollSteps: {
          type: Type.NUMBER,
          description: "Number of smooth scroll steps to explore. Defaults to 2.",
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
          description: "Application to use: 'chrome', 'browser', 'chatgpt'. Defaults to active browser.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "scrollToContent",
    description: "Autonomously and smoothly scrolls the active screen, web browser, Wikipedia page, or document until a specific requested topic, section, or heading (e.g. 'education', 'business', 'career', 'early life', 'net worth', 'awards', etc.) is fully in view, and reads/explains the visible content to the user in friendly Hindi/Hinglish. Use whenever the user asks to bring a specific topic or section into view or scroll until a topic is found ('iski education lao', 'business section samne lao', 'career tak scroll karo', 'scroll to [topic]', 'waha tak scroll karo jabtak [topic] na aaye', etc.).",
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
];

export function extractFoodOrderParams(text: string) {
  const lower = text.toLowerCase();
  let platform: "swiggy" | "zomato" | "auto" = "swiggy";
  const hasZomato = lower.includes("zomato") || lower.includes("zumato") || lower.includes("zomoto");
  const hasSwiggy = lower.includes("swiggy") || lower.includes("swiggi") || lower.includes("swigy") || lower.includes("swigi");
  if (hasZomato && hasSwiggy) platform = "auto";
  else if (hasZomato) platform = "zomato";
  else platform = "swiggy";

  // Extract quantity
  let quantity = 1;
  const mQtyWord = lower.match(/\b(ek|do|teen|chaar|paanch|chheh|saat|aath|nau|das)\b/i);
  const wordToNum: Record<string, number> = { ek: 1, do: 2, teen: 3, chaar: 4, paanch: 5, chheh: 6, saat: 7, aath: 8, nau: 9, das: 10 };
  if (mQtyWord && wordToNum[mQtyWord[1].toLowerCase()]) {
    quantity = wordToNum[mQtyWord[1].toLowerCase()];
  } else {
    const mQtyDigit = lower.match(/\b([1-9]|10)\s*(?:x|quantity|piece|pieces|plate|burger|pizza|biryani|roll|sandwich|thali|momo|dosa)?\b/i);
    if (mQtyDigit && mQtyDigit[1]) {
      const val = parseInt(mQtyDigit[1], 10);
      if (val >= 1 && val <= 10) quantity = val;
    }
  }

  let maxBudget: number | undefined = undefined;
  const mMax = lower.match(/(?:under|upto|below|less than|max|maximum|budget|range|limit|around|approx)\s*(?:rs\.?|₹|rupaye|rupees)?\s*(\d+)/i) ||
               lower.match(/(\d+)\s*(?:rs\.?|₹|rupaye|rupees|inr)?\s*(?:tak|ke andar|andar|ke beech|se kam|below|under|me|mein|mai|ka|ke|ki|wala|wali|wale)/i) ||
               lower.match(/(?:rs\.?|₹)\s*(\d+)/i) ||
               lower.match(/(\d+)\s*(?:rs|rupaye|rupees|inr)\b/i) ||
               lower.match(/\b([5-9]\d|[1-9]\d{2,3})\b/);
  if (mMax && mMax[1]) {
    maxBudget = parseInt(mMax[1], 10);
  }

  // Extract delivery location
  let location: string | undefined = undefined;
  const mLocExplicit = lower.match(/(?:location|address|jagah)\s*[:=]?\s*([a-zA-Z0-9\s,]{3,30}?)(?:\s+(?:pe|par|per|me|mein|se|under|tak|budget|cash|cod|order)|$)/i);
  const mLocPrep = lower.match(/(?:at|near|pe|par|per|me|mein)\s+([a-zA-Z0-9\s,]{3,25}?)(?:\s+(?:par|pe|per|me|mein|order|delivery|mangwao|bhejo)|$)/i);
  if (mLocExplicit && mLocExplicit[1]) {
    location = mLocExplicit[1].trim();
  } else if (mLocPrep && mLocPrep[1]) {
    const candidateLoc = mLocPrep[1].replace(/\b(mere|liye|koi|bhi|swiggy|zomato|se|par|karo|bhaiya|cash|delivery|cod|order)\b/gi, "").trim();
    if (candidateLoc.length > 2) location = candidateLoc;
  }

  let dish = "burger";
  const dishKeywords = [
    "chicken dum biryani", "hyderabadi biryani", "mutton biryani", "chicken biryani", "veg biryani", "biryani",
    "paneer butter masala", "kadhai paneer", "shahi paneer", "butter paneer", "paneer",
    "margherita pizza", "cheese pizza", "farmhouse pizza", "veg pizza", "chicken pizza", "pizza",
    "crispy chicken burger", "crispy veg burger", "chicken burger", "veg burger", "cheese burger", "burger",
    "dal makhani", "dal tadka", "special thali", "veg thali", "non veg thali", "thali",
    "paneer roll", "chicken roll", "egg roll", "kathi roll", "veg roll", "roll", "wrap",
    "steamed momos", "fried momos", "veg momos", "chicken momos", "kurkure momos", "momos", "momo",
    "white sauce pasta", "red sauce pasta", "pasta",
    "grilled sandwich", "cheese sandwich", "veg sandwich", "sandwich",
    "hakka noodles", "veg chowmein", "chicken chowmein", "chowmein", "noodles",
    "veg fried rice", "chicken fried rice", "fried rice",
    "masala dosa", "plain dosa", "mysore masala dosa", "dosa", "idli",
    "chole bhature", "pav bhaji", "vada pav", "samosa",
    "ice cream", "dessert", "cold coffee", "shake", "cake", "pastry"
  ];
  for (const dk of dishKeywords) {
    if (lower.includes(dk)) {
      dish = dk;
      break;
    }
  }
  if (dish === "burger" && !lower.includes("burger")) {
    const mDish = text.match(/(?:mere\s+liye|koi\s+bhi|ek)?\s*([a-zA-Z\u0900-\u097F\s]{2,25}?)\s*(?:order\s*karo|mangwa\s*do|mangao|mangva\s*do|chahiye|order\s*kar\s*do)/i);
    if (mDish && mDish[1]) {
      const candidate = mDish[1].replace(/\b(swiggy|zomato|se|par|karo|bhaiya|kuch|kisi|khana|jo|maine|bola|hai|itni|range|me|mein|mai|ho|apne|aap|autonoumas|agent|ki|help|order|mangwa|do)\b/gi, "").trim();
      if (candidate.length >= 2) dish = candidate;
    }
  }

  return { dish, quantity, maxBudget, platform, location, autoOrder: true, paymentMethod: "cod" };
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error occurred";
  }
}

export function createGenAIClient(): GoogleGenAI {
  const keys = loadKeys();
  const apiKey = keys.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in the server environment or keys.enc.");
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: "v1beta",
    httpOptions: {
      apiVersion: "v1beta",
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

export interface LiveSessionContext {
  executeCompanionTool: (toolName: string, args: any, clientWs?: WebSocket, ctx?: any) => Promise<any>;
  activeLiveClients: Set<WebSocket>;
  userEmail?: string;
  userMemory?: string;
  voiceSessionId?: string;
  taskScheduler?: TaskScheduler;
  onLiveSessionCreated?: (session: any) => void;
  onLiveSessionClosed?: (session: any) => void;
}

export async function handleLiveWebSocketConnection(
  clientWs: WebSocket,
  req: any,
  context: LiveSessionContext
): Promise<void> {
  const { executeCompanionTool, activeLiveClients } = context;

  activeLiveClients.add(clientWs);
  console.log("🎙️ [ERA Voice Engine] New client connected to live voice WebSocket");

  let liveSession: any = null;
  let closedByClient = false;
  const processedToolCallIds = new Set<string>();
  let lastFoodOrderIntent: { text: string; time: number; executed: boolean } | null = null;
  let lastScrollTriggerTime = 0;
  let currentTurnUserText = "";
  let turnToolExecuted = false;
  let turnScheduledInTurn = false;

  const cleanup = () => {
    activeLiveClients.delete(clientWs);
    if (liveSession) {
      try {
        context.onLiveSessionClosed?.(liveSession);
      } catch {}
      try {
        liveSession.close();
      } catch {}
      liveSession = null;
    }
  };

  const reportError = (msg: string) => {
    sendJson(clientWs, { type: "error", message: msg });
  };

  clientWs.on("message", async (raw: any) => {
    try {
      const parsed = JSON.parse(raw.toString());

      if (parsed.type === "audio" && typeof parsed.data === "string") {
        liveSession?.sendRealtimeInput({
          audio: {
            data: parsed.data,
            mimeType: "audio/pcm;rate=16000",
          },
        });
      } else if (parsed.type === "audio_stream_end") {
        liveSession?.sendRealtimeInput({
          audioStreamEnd: true,
        });
      } else if (parsed.type === "tool_response" && Array.isArray(parsed.responses)) {
        liveSession?.sendToolResponse({
          functionResponses: parsed.responses.map((r: any) => ({
            id: r.id,
            name: r.name,
            response: r.response,
          })),
        });
      } else if (parsed.type === "text" && typeof parsed.data === "string") {
        currentTurnUserText = parsed.data;
        turnToolExecuted = false;
        turnScheduledInTurn = false;
        liveSession?.sendClientContent({
          turns: [{ role: "user", parts: [{ text: parsed.data }] }],
          turnComplete: true,
        });
      } else if (parsed.type === "ping") {
        sendJson(clientWs, { type: "pong" });
      }
    } catch {
      // Ignore malformed client frames
    }
  });

  clientWs.on("close", () => {
    closedByClient = true;
    cleanup();
  });

  clientWs.on("error", () => {
    closedByClient = true;
    cleanup();
  });

  try {
    const ai = createGenAIClient();

    const session = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Aoede", // Warm, witty, expressive female voice
            },
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: buildEraSystemInstruction(context.userMemory, Date.now()),
        tools: [{ functionDeclarations: ERA_TOOLS }],
      },
      callbacks: {
        onopen: () => {
          if (!closedByClient) {
            console.log("✅ [ERA Voice Engine] Gemini Live session connected and ready.");
            try {
              context.onLiveSessionCreated?.(session);
            } catch {}
            sendJson(clientWs, { type: "ready" });
          }
        },
        onmessage: async (message: LiveServerMessage) => {
          if (closedByClient || clientWs.readyState !== WebSocket.OPEN) {
            return;
          }

          if (message.serverContent?.interrupted) {
            console.log("⚡ [ERA Voice Engine] Gemini Live reported user interruption (barge-in). Stopping assistant playback.");
            sendJson(clientWs, { type: "interrupted" });
            return;
          }

          if (message.serverContent?.modelTurn?.parts) {
            for (const part of message.serverContent.modelTurn.parts) {
              const text = part.text || "";
              const isRefusal = /(?:directly.*order.*nahi|सीधे.*ऑर्डर|cannot directly order|can't directly order|cannot order food|bhojan.*order.*nahi|food.*order.*nahi|khana.*order.*nahi\s*kar\s*sak|directly.*food)/i.test(text);
              if (isRefusal) {
                console.warn("⚠️ [ERA Live Engine] Intercepted AI refusal to order food. Triggering autonomous ordering fallback!");
                if (lastFoodOrderIntent && !lastFoodOrderIntent.executed) {
                  lastFoodOrderIntent.executed = true;
                  const fParams = extractFoodOrderParams(lastFoodOrderIntent.text);
                  executeCompanionTool("orderFoodAutonomous", fParams, clientWs).then((res: any) => {
                    sendJson(clientWs, {
                      type: "action_executed",
                      action: {
                        id: `food_${Date.now()}`,
                        toolName: "orderFoodAutonomous",
                        title: "Food Order Executed",
                        detail: res?.message || "Order processed",
                        timestamp: Date.now(),
                      },
                    });
                  }).catch(() => {});
                }
                sendJson(clientWs, {
                  type: "transcription",
                  sender: "model",
                  text: "Ji boss, main turant Swiggy aur Zomato par aapke budget ke hisab se order dhundh kar cart me add kar rahi hu!",
                });
                continue;
              }

              if (part.inlineData?.data) {
                sendJson(clientWs, {
                  type: "audio",
                  data: part.inlineData.data,
                });
              }
              if (part.text) {
                let partText = part.text;
                if (/antigravity/i.test(partText)) {
                  partText = partText.replace(/antigravity/gi, "Shavan Vashishth");
                }
                sendJson(clientWs, {
                  type: "transcription",
                  sender: "model",
                  text: partText,
                });
              }
            }
          }

          // Output transcription from Gemini Live (model spoken words)
          let modelTranscription = (message.serverContent as any)?.outputTranscription?.text;
          if (modelTranscription) {
            if (/antigravity/i.test(modelTranscription)) {
              modelTranscription = modelTranscription.replace(/antigravity/gi, "Shavan Vashishth");
            }
            sendJson(clientWs, {
              type: "transcription",
              sender: "model",
              text: modelTranscription,
            });

            // Pre-emptive Refusal Interception: screen typing
            if (/(?:browser.*permission|permission.*nahi|likh.*nahi\s*sak|type.*nahi\s*kar\s*sak|cannot\s*type|can't\s*type|likh\s*nahi\s*sak)/i.test(modelTranscription)) {
              console.warn("⚠️ [ERA Live Engine] Gemini refused typing. Executing native typing fallback!");
              const lastUserWords = currentTurnUserText || "";
              const typeMatch = lastUserWords.match(/(?:type\s*karo|likho|likh\s*do|type\s*kar\s*do|likh\s*dijiye)\s*(.*)/i)
                             || lastUserWords.match(/(.*)\s*(?:type\s*karo|likho|likh\s*do)/i);
              const textToType = typeMatch ? (typeMatch[1] || typeMatch[2] || "").trim() : lastUserWords;
              if (textToType) {
                executeCompanionTool("typeText", { text: textToType }, clientWs).catch(() => {});
              }
            }

            // Pre-emptive Refusal Interception: phone calls
            if (/(?:call.*nahi\s*(?:kar|laga)\s*sak|phone\s*link.*nahi|cannot\s*(?:make|place)\s*calls?)/i.test(modelTranscription)) {
              console.warn("⚠️ [ERA Live Engine] Gemini refused phone call. Executing Phone Link fallback!");
              const lastUserWords = currentTurnUserText || "";
              const callMatch = lastUserWords.match(/(?:call\s*karo|call\s*lagao|call|dial)\s*(?:to\s*)?([a-zA-Z0-9\s]+)/i);
              const target = callMatch ? callMatch[1].trim() : "";
              if (target) {
                executeCompanionTool("makePhoneCall", { target }, clientWs).catch(() => {});
              }
            }


            // ✅ Pre-emptive Refusal Interception: App / Website / Software building
            const isBuildRefusal = /(?:nahi.?bana.?sak|nahi.?bana.?pa.?rahi|koi.?dikkat|dikkat.?aa|cannot.?build|cannot.?create|can.t.?build)/i.test(modelTranscription);
            const isBuildIntent = /(?:website|app|game|software|dashboard|portfolio|ecommerce|banao|bana.?do|create|build|develop|calculator|snake|tetris|quiz|todo|kanban)/i.test(currentTurnUserText || '');
            if (isBuildRefusal && isBuildIntent) {
              console.warn('⚠️ [ERA Live Engine] Build refusal intercepted. Triggering buildWebsiteApp fallback!');
              const buildPrompt = (currentTurnUserText || 'Modern Web Application').trim();
              executeCompanionTool('buildWebsiteApp', { prompt: buildPrompt }, clientWs).then((res) => {
                sendJson(clientWs, { type: 'action_executed', action: { id: 'build_' + Date.now(), toolName: 'buildWebsiteApp', title: 'App Built!', detail: res && res.message || 'Application launched!', timestamp: Date.now() } });
                sendJson(clientWs, { type: 'transcription', sender: 'model', text: 'Ji boss! Aapka application build ho gaya aur browser mein launch kar diya! ' + (res && res.message || '') });
              }).catch(function() {});
            }
          }

          // User turn audio transcription if available
          const scAny = message.serverContent as any;
          const userTranscription = scAny?.inputTranscription?.text || scAny?.interimInputTranscription?.text || scAny?.inputAudioTranscription?.text || scAny?.interimInputAudioTranscription?.text || "";
          if (userTranscription) {
            currentTurnUserText = (currentTurnUserText ? `${currentTurnUserText} ` : "") + userTranscription;
            sendJson(clientWs, {
              type: "transcription",
              sender: "user",
              text: userTranscription,
            });

            // Instant Real-Time Wake Word Trigger directly from live incoming audio stream
            if (/(?:(?:wake\s*up|vek\s*ap|vek\s*up|vekap|वेक\s*अप|वेकअप)\s+(?:.*?\s+)?(?:era|eera|eira|ira|eyra|aira|aera|ayra|error|एरा|इरा)|(?:era|eera|eira|ira|eyra|aira|aera|ayra|error|एरा|इरा)\s+(?:.*?\s+)?(?:wake\s*up|vek\s*ap|vek\s*up|vekap|वेक\s*अप|वेकअप))/i.test(userTranscription)) {
              console.log("⚡ [ERA Live Engine] Wake word detected in audio stream:", userTranscription);
              sendJson(clientWs, { type: "wake_up_era" });
              try {
                const psScript = "$wshell = New-Object -ComObject WScript.Shell; if (-not $wshell.AppActivate('ERA AI Assistant')) { $wshell.AppActivate('ERA') }";
                exec(`powershell -NoProfile -Command "${psScript}"`, (err, stdout) => {
                });
              } catch (e: any) {
              }
            }

            const isFoodOrderUtterance = /(?:order.*(?:food|khana|biryani|pizza|burger|roll|paneer|thali|momo|dish|pasta|sandwich|chowmein|noodles|dosa)|(?:zomato|swiggy).*(?:order|se|par|karo|mangwa|mangao)|(?:mangwa|mangao|mangva).*(?:do|khana|biryani|pizza|burger|food|dish)|khana.*order|(?:cheez|dish|kuch\s+khane).*order|kuch\s+order\s*(?:karo|kar\s*do|karna)|order\s*(?:karo|kar\s*do))/i.test(userTranscription);
            // ⚡ Zero-Latency Real-Time Hand Gesture Voice Trigger
            const isGestureUtterance = /\b(?:gesture|gestures|hand\s*gesture|camera\s*gesture|gesture\s*control|ishara|ishare)\b|जेस्चर|हैंड\s*जेस्चर/i.test(userTranscription) ||
              ((userTranscription.toLowerCase().includes("camera") || userTranscription.includes("कैमरा")) && /\b(?:gesture|hand|haath|hath|ishara|ishare)\b/i.test(userTranscription));
            if (isGestureUtterance) {
              const lowerUtter = userTranscription.toLowerCase();
              const isStop = /\b(?:stop|off|band|disable|roko|close|shut|hatao)\b|बंद|रोको/i.test(lowerUtter);
              const isStatus = /\b(?:status|check|state|kya\s*hai|dekho|batao)\b|स्टेटस/i.test(lowerUtter);
              if (isStop) {
                console.log(`⚡ [ERA Live Engine] Zero-latency stop gesture control triggered: ${userTranscription}`);
                executeCompanionTool("stopGestureControl", {}, clientWs).then((res: any) => {
                  sendJson(clientWs, {
                    type: "action_executed",
                    action: {
                      id: `gest_${Date.now()}`,
                      toolName: "stopGestureControl",
                      title: "Hand Gesture Stopped",
                      detail: res?.message || "Hand gesture tracking stopped.",
                      timestamp: Date.now(),
                    },
                  });
                  sendJson(clientWs, {
                    type: "transcription",
                    text: "Ji boss! Hand gesture recognition band kar diya hai.",
                    sender: "era",
                  });
                }).catch(() => {});
              } else if (isStatus) {
                console.log(`⚡ [ERA Live Engine] Zero-latency get gesture status triggered: ${userTranscription}`);
                executeCompanionTool("getGestureStatus", {}, clientWs).catch(() => {});
              } else {
                console.log(`⚡ [ERA Live Engine] Zero-latency start gesture control triggered: ${userTranscription}`);
                executeCompanionTool("startGestureControl", { camera: 0, preview: true }, clientWs).then((res: any) => {
                  sendJson(clientWs, {
                    type: "action_executed",
                    action: {
                      id: `gest_${Date.now()}`,
                      toolName: "startGestureControl",
                      title: "Hand Gesture Started",
                      detail: res?.message || "Hand gesture tracking active.",
                      timestamp: Date.now(),
                    },
                  });
                  sendJson(clientWs, {
                    type: "transcription",
                    text: "Ji boss! Hand gesture recognition chalu kar diya hai. Ab aap ungliyon ko palm se door karke brightness aur palm ghuma kar volume control kar sakte hain!",
                    sender: "era",
                  });
                }).catch(() => {});
              }
            }

            if (isFoodOrderUtterance) {
              console.log("⚡ [ERA Live Engine] Food order intent detected from user speech:", userTranscription);
              lastFoodOrderIntent = { text: userTranscription, time: Date.now(), executed: false };
            }

            // ⚡ Zero-Latency Spoken OTP Detection from live incoming speech
            const otpRegex = /\b(?:otp|code|one\s*time\s*password)\s*(?:hai|is|daal\s*do|likh\s*do|enter\s*karo|likho)?\s*[:\s-]*(\d{4,6})\b/i;
            const standaloneOtpRegex = /^\s*(?:mera\s+)?(?:otp|code)?\s*(\d{4,6})\s*$/i;
            const mOtp = userTranscription.match(otpRegex) || userTranscription.match(standaloneOtpRegex);
            if (mOtp && mOtp[1]) {
              const spokenOtp = mOtp[1];
              console.log(`⚡ [ERA Live Engine] Spoken OTP detected from live speech: ${spokenOtp}`);
              executeCompanionTool("submitFoodOtp", { otp: spokenOtp }, clientWs).then((res: any) => {
                sendJson(clientWs, {
                  type: "action_executed",
                  action: {
                    id: `otp_${Date.now()}`,
                    toolName: "submitFoodOtp",
                    title: "OTP Entered on Screen",
                    detail: res?.message || `OTP ${spokenOtp} entered.`,
                    timestamp: Date.now(),
                  },
                });
              }).catch(() => {});
            }

            // ⚡ Zero-Latency Address Fill & Order Confirmation Voice Trigger
            const addressConfirmRegex = /\b(?:address|location|pata)\s*(?:fill|daal|likh|enter|select|confirm)?|fill\s*karo|order\s*(?:confirm|place|complete|book)\s*karo|deliver\s*here\b/i;
            if (addressConfirmRegex.test(userTranscription.toLowerCase())) {
              console.log(`⚡ [ERA Live Engine] Address fill / order confirmation detected: ${userTranscription}`);
              executeCompanionTool("completeFoodOrder", {}, clientWs).then((res: any) => {
                sendJson(clientWs, {
                  type: "action_executed",
                  action: {
                    id: `addr_${Date.now()}`,
                    toolName: "completeFoodOrder",
                    title: "Food Order Completed",
                    detail: res?.message || "Address confirmed and Cash on Delivery order placed.",
                    timestamp: Date.now(),
                  },
                });
                if (res?.message) {
                  sendJson(clientWs, {
                    type: "transcription",
                    text: res.message,
                    sender: "era",
                  });
                }
              }).catch(() => {});
            }

            // ⚡ Zero-Latency Real-Time Screen Scroll & Target Voice Trigger
            const lowerTranscript = userTranscription.toLowerCase();
            const nowTime = Date.now();

            const isScrollTop = /\b(sabse\s*upar|top\s*par|scroll\s*to\s*top|page\s*top|bilkul\s*upar)\b/i.test(lowerTranscript);
            const isScrollBottom = /\b(sabse\s*neeche|bottom\s*par|scroll\s*to\s*bottom|page\s*end|bilkul\s*neeche)\b/i.test(lowerTranscript);
            const isScrollUp = /\b(scroll\s*up|upar\s*scroll|thoda\s*upar|upar\s*karo|scroll\s*upar|up\s*scroll|upar\s*kar\s*do|upar\s*le\s*jao|peechhe|pichhe)\b/i.test(lowerTranscript);
            const isScrollDown = !isScrollUp && /\b(scroll\s*down|scroll\s*karo|neeche\s*scroll|thoda\s*neeche|aur\s*scroll|thoda\s*aur\s*scroll|neeche\s*karo|scroll\s*neeche|down\s*scroll|scroll\s*kar\s*do|scroll\s*karna|neeche\s*le\s*jao|scroll)\b/i.test(lowerTranscript);

            // Amount detection
            const isGentle = /\b(thoda|thoda\s*sa|slow|gentle|kam|chhota|halka|halke)\b/i.test(lowerTranscript);
            const isLarge = /\b(jada|zyada|jyada|fast|speed|bada|quick|large|tez|bahut|karo\s*aur)\b/i.test(lowerTranscript);
            const isContinuous = /\b(karte\s*raho|kare\s*jao|chalte\s*raho)\b/i.test(lowerTranscript);
            const scrollAmount = isGentle ? "gentle" : isLarge ? "large" : isContinuous ? "continuous" : "normal";

            // Target section match
            const targetSectionMatch = lowerTranscript.match(/(?:iski|iska|unki|unka|inke|unke)?\s*(education|shiksha|padhai|business|career|vyapar|early\s*life|awards|achievements|net\s*worth|personal\s*life|family|politics|filmography|tenure)\s*(?:lao|dikhao|samne\s*lao|tak\s*scroll|kholo|khole|khol|open\s*karo|open|padho|batao)?/i);
            const isExplicitTargetRequest = Boolean(targetSectionMatch && /\b(lao|dikhao|samne|kholo|khole|khol|open|scroll|padho|batao|chahiye|dekho|check)\b/i.test(lowerTranscript));

            if ((nowTime - lastScrollTriggerTime > 900) && (isExplicitTargetRequest || isScrollDown || isScrollUp || isScrollTop || isScrollBottom)) {
              lastScrollTriggerTime = nowTime;
              if (isExplicitTargetRequest && targetSectionMatch) {
                const targetTopic = targetSectionMatch[1].trim();
                console.log(`⚡ [ERA Live Engine] Zero-latency scroll to target triggered: '${targetTopic}'`);
                executeCompanionTool("scrollToContent", { target: targetTopic, explain: true }, clientWs).catch(() => {});
              } else if (isScrollTop) {
                console.log("⚡ [ERA Live Engine] Zero-latency scroll to top triggered");
                executeCompanionTool("scrollScreen", { direction: "top" }, clientWs).catch(() => {});
              } else if (isScrollBottom) {
                console.log("⚡ [ERA Live Engine] Zero-latency scroll to bottom triggered");
                executeCompanionTool("scrollScreen", { direction: "bottom" }, clientWs).catch(() => {});
              } else if (isScrollUp) {
                console.log(`⚡ [ERA Live Engine] Zero-latency scroll up triggered (amount: ${scrollAmount})`);
                executeCompanionTool("scrollScreen", { direction: "up", amount: scrollAmount }, clientWs).catch(() => {});
              } else if (isScrollDown) {
                console.log(`⚡ [ERA Live Engine] Zero-latency scroll down triggered (amount: ${scrollAmount})`);
                executeCompanionTool("scrollScreen", { direction: "down", amount: scrollAmount }, clientWs).catch(() => {});
              }
            }
          }

          // Handle Tool Calls from Gemini Live
          if (message.toolCall?.functionCalls && message.toolCall.functionCalls.length > 0) {
            const responses: Array<{ id: string; name: string; response: Record<string, unknown> }> = [];

            for (const call of message.toolCall.functionCalls) {
              const callId = call.id ?? `call_${Date.now()}`;
              let callName = call.name ?? "";
              const callArgs = (call.args as Record<string, unknown>) ?? {};

              // Anti-Hallucination Guard: Never allow searchWeb or performResearch when user asked to scroll or view on screen!
              if (callName === "searchWeb" || callName === "performResearch") {
                const recentText = (currentTurnUserText || "").toLowerCase();
                const isGestureReq = /\b(?:gesture|gestures|hand\s*gesture|camera\s*gesture|gesture\s*control|ishara|ishare)\b|जेस्चर|हैंड\s*जेस्चर/i.test(recentText);
                if (isGestureReq) {
                  console.warn(`⚠️ [ERA Live Engine] Overriding accidental '${callName}' call to gesture control!`);
                  const isStop = /\b(?:stop|off|band|disable|roko|close|shut|hatao)\b|बंद|रोको/i.test(recentText);
                  if (isStop) {
                    callName = "stopGestureControl";
                  } else {
                    callName = "startGestureControl";
                    callArgs.camera = 0;
                    callArgs.preview = true;
                  }
                } else {
                  const isScrollRequest = /\b(scroll|neeche|upar|down|up|education|business|career|shiksha|padhai|vyapar|early\s*life|awards|filmography|lao|dikhao|kholo|khole|khol)\b/i.test(recentText);
                if (isScrollRequest) {
                  console.warn(`⚠️ [ERA Live Engine] Overriding accidental '${callName}' call to scroll action!`);
                  const isUp = /\b(upar|up|top|pichhe|peechhe)\b/i.test(recentText);
                  const isGentleAmt = /\b(thoda|gentle|kam|slow)\b/i.test(recentText);
                  const isLargeAmt = /\b(jada|zyada|jyada|large|fast|speed)\b/i.test(recentText);
                  const isContAmt = /\b(karte\s*raho|kare\s*jao|chalte\s*raho)\b/i.test(recentText);
                  const parsedAmount = isGentleAmt ? "gentle" : isLargeAmt ? "large" : isContAmt ? "continuous" : "normal";

                  const targetMatch = recentText.match(/(?:iski|iska|unki|unka|inke|unke)?\s*(education|shiksha|padhai|business|career|vyapar|early\s*life|awards|achievements|net\s*worth|personal\s*life|family|filmography)\s*(?:lao|dikhao|samne\s*lao|tak\s*scroll|kholo|khole|khol|open\s*karo|open|padho|batao)?/i);
                  const hasTargetAction = targetMatch && /\b(lao|dikhao|samne|kholo|khole|khol|open|scroll|padho|batao|chahiye|dekho|check)\b/i.test(recentText);

                  if (hasTargetAction && targetMatch) {
                    callName = "scrollToContent";
                    callArgs.target = targetMatch[1].trim();
                    callArgs.explain = true;
                  } else {
                    callName = "scrollScreen";
                    callArgs.direction = isUp ? "up" : "down";
                    callArgs.amount = parsedAmount;
                  }
                }
              }
              }

              if (callName === "orderFoodAutonomous" || callName === "executeAutonomousGoal") {
                if (lastFoodOrderIntent) lastFoodOrderIntent.executed = true;
                if (callName === "orderFoodAutonomous") {
                  sendJson(clientWs, {
                    type: "transcription",
                    text: "Ji boss, main turant Microsoft Edge open karke Swiggy par aapka order search kar rahi hoon...",
                    sender: "era",
                  });
                }
              }

              if (processedToolCallIds.has(callId)) continue;
              processedToolCallIds.add(callId);

              console.log(`⚡ [ERA Live Engine Tool Call] '${callName}' with parameters:`, JSON.stringify(callArgs));

              try {
                const companionCtx = {
                  sessionId: context.voiceSessionId,
                  source: "voice",
                  turnUserText: currentTurnUserText,
                  onScheduled: (task: any) => {
                    turnScheduledInTurn = true;
                    sendJson(clientWs, {
                      type: "scheduledTaskUpdated",
                      event: "scheduled",
                      task,
                    });
                  },
                };
                // Execute via ERA's global companion tool router (connects to Python Local Agent on 8000 & Bridge on 8100)
                const finalOutput = await executeCompanionTool(callName, callArgs, clientWs, companionCtx);
                turnToolExecuted = true;
                if (finalOutput?.scheduled) {
                  turnScheduledInTurn = true;
                }
                console.log(`✅ [ERA Live Engine Tool Execution Verified] '${callName}':`, finalOutput?.message || "Success");

                if (callName === "orderFoodAutonomous" && finalOutput?.message) {
                  sendJson(clientWs, {
                    type: "transcription",
                    text: finalOutput.message,
                    sender: "era",
                  });
                }

                responses.push({
                  id: callId,
                  name: callName,
                  response: { output: finalOutput },
                });

                // Notify UI of executed tool and action
                sendJson(clientWs, {
                  type: "action_executed",
                  action: {
                    id: callId,
                    toolName: callName,
                    title: `Executed ${callName}`,
                    detail: finalOutput?.message || "Action completed",
                    timestamp: Date.now(),
                  },
                });

                if (callName === "bringDashboardToFront") {
                  sendJson(clientWs, { type: "wake_up_era" });
                  try {
                    const psScript = "$wshell = New-Object -ComObject WScript.Shell; if (-not $wshell.AppActivate('ERA AI Assistant')) { $wshell.AppActivate('ERA') }";
                    exec(`powershell -NoProfile -Command "${psScript}"`, (err, stdout) => {
                    });
                  } catch (e: any) {
                  }
                }
              } catch (toolErr: any) {
                console.error(`âŒ [ERA Live Engine Tool Error] '${callName}' failed:`, toolErr);
                responses.push({
                  id: callId,
                  name: callName,
                  response: { output: { success: false, error: toolErr?.message || "Execution failed" } },
                });
              }
            }

            // Deliver verified tool response back to Gemini Live
            if (liveSession && !closedByClient) {
              try {
                await liveSession.sendToolResponse({
                  functionResponses: responses,
                });
              } catch (sendRespErr: any) {
                console.warn("[ERA Live] sendToolResponse failed:", sendRespErr?.message);
              }
            }
          }

          if (message.serverContent?.turnComplete) {
            if (lastFoodOrderIntent && !lastFoodOrderIntent.executed && (Date.now() - lastFoodOrderIntent.time < 12000)) {
              console.log("⚡ [ERA Live Engine] Turn completed without food tool call. Executing autonomous food order fallback!");
              lastFoodOrderIntent.executed = true;
              const fParams = extractFoodOrderParams(lastFoodOrderIntent.text);
              sendJson(clientWs, {
                type: "transcription",
                text: "Ji boss, main turant Microsoft Edge par Swiggy open karke aapka order screen par la rahi hoon...",
                sender: "era",
              });
              executeCompanionTool("orderFoodAutonomous", fParams, clientWs).then((res: any) => {
                sendJson(clientWs, {
                  type: "action_executed",
                  action: {
                    id: `food_${Date.now()}`,
                    toolName: "orderFoodAutonomous",
                    title: "Food Order Executed",
                    detail: res?.message || "Order processed",
                    timestamp: Date.now(),
                  },
                });
                if (res?.message) {
                  sendJson(clientWs, {
                    type: "transcription",
                    text: res.message,
                    sender: "era",
                  });
                  if (liveSession && !closedByClient) {
                    try {
                      liveSession.send({
                        clientContent: {
                          turns: [{
                            role: "user",
                            parts: [{
                              text: `[SYSTEM: Food order result update]: ${res.message}. Speak this update warmly to boss.`
                            }]
                          }],
                          turnComplete: true,
                        }
                      });
                    } catch (e) {}
                  }
                }
              }).catch(() => {});
            }

            // Fallback: If user spoke an explicit schedule command (e.g. shutdown in 1 min, or message at 5 baje)
            // and neither Gemini nor direct tool call scheduled it during the turn, schedule it now via TaskScheduler!
            if (!turnScheduledInTurn && currentTurnUserText && hasExplicitSchedulePhrase(currentTurnUserText) && context.taskScheduler) {
              const built = buildScheduledTaskInputFromNaturalText(currentTurnUserText, "voice");
              if (built && built.ok) {
                console.log("⚡ [ERA Live Engine] Turn complete with unhandled schedule cue. Auto-scheduling task:", built.input.title);
                const schedRes = context.taskScheduler.scheduleTask(built.input);
                if (schedRes.success && schedRes.task) {
                  turnScheduledInTurn = true;
                  sendJson(clientWs, {
                    type: "scheduledTaskUpdated",
                    event: "scheduled",
                    task: schedRes.task,
                  });
                  sendJson(clientWs, {
                    type: "toolLog",
                    tool: "scheduleTask",
                    res: schedRes,
                  });
                  if (liveSession && !closedByClient) {
                    try {
                      await liveSession.sendClientContent({
                        turns: [{
                          role: "user",
                          parts: [{
                            text: `[SYSTEM: The user requested a scheduled task that was just scheduled in IST TaskScheduler]: ${schedRes.message}. Speak in your natural witty voice to boss confirming this schedule.`
                          }]
                        }],
                        turnComplete: true,
                      });
                    } catch {}
                  }
                }
              }
            }

            // Reset turn tracking for next user interaction
            currentTurnUserText = "";
            turnToolExecuted = false;
            turnScheduledInTurn = false;

            sendJson(clientWs, { type: "turn_complete" });
            sendJson(clientWs, { type: "turnComplete" });
          }
        },
        onerror: (err: unknown) => {
          const msg = extractErrorMessage(err);
          console.error("[ERA Live error]", msg, err);
          reportError(msg);
        },
        onclose: (event: unknown) => {
          const closeEvt = event as { code?: number; reason?: string } | undefined;
          if (closeEvt?.code && closeEvt.code !== 1000 && closeEvt.reason) {
            console.warn("[ERA Live closed abnormally]", closeEvt.code, closeEvt.reason);
            reportError(closeEvt.reason);
          }
          if (!closedByClient && clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1000, "Live session ended");
          }
          cleanup();
        },
      },
    });

    if (closedByClient) {
      session.close();
      return;
    }

    liveSession = session;
    try {
      context.onLiveSessionCreated?.(session);
    } catch {}
  } catch (err) {
    const msg = extractErrorMessage(err);
    console.error("[ERA Live connect failed]", msg, err);
    reportError(msg);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, "Initialization failed");
    }
    cleanup();
  }
}
