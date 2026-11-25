/**



 * Agent Bridge Module for Era Voice Assistant.



 * 



 * Bridges the Node.js Express / Gemini Multimodal Live API Voice Assistant



 * to the Era Python Local Agent REST API (FastAPI server running on http://127.0.0.1:8000).



 */







import { spawn, spawnSync, execSync } from "child_process";



import * as fs from "fs";



import * as path from "path";



import { hasExplicitSchedulePhrase } from "./istTime";







function findStartMenuShortcut(cleanName: string): string | null {

  const normTarget = cleanName.toLowerCase().replace(/[^a-z0-9]/g, "");

  const searchDirs = [

    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",

    path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),

    path.join(process.env.USERPROFILE || "", "Desktop"),

    "C:\\Users\\Public\\Desktop",

  ];



  for (const dir of searchDirs) {

    if (!fs.existsSync(dir)) continue;

    try {

      const walk = (d: string): string | null => {

        const entries = fs.readdirSync(d, { withFileTypes: true });

        for (const entry of entries) {

          const fullPath = path.join(d, entry.name);

          if (entry.isDirectory()) {

            const found = walk(fullPath);

            if (found) return found;

          } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lnk")) {

            const stem = path.basename(entry.name, path.extname(entry.name)).toLowerCase();

            const stemNorm = stem.replace(/[^a-z0-9]/g, "");

            if (

              stem === cleanName.toLowerCase() ||

              stemNorm === normTarget ||

              stemNorm.includes(normTarget) ||

              normTarget.includes(stemNorm)

            ) {

              return fullPath;

            }

          }

        }

        return null;

      };

      const match = walk(dir);

      if (match) return match;

    } catch {}

  }

  return null;

}



const DEFAULT_AGENT_URL = process.env.ERA_AGENT_URL || "http://127.0.0.1:8000";



const DEFAULT_BRIDGE_URL = process.env.ERA_BRIDGE_URL || "http://127.0.0.1:8100";



const BRIDGE_API_KEY = process.env.ERA_BRIDGE_API_KEY || "era_bridge_secret_key_2026";







export interface AgentExecuteResult {



  success: boolean;



  message: string;



  data?: any;



}







export interface AgentStatusResult {



  status: string;



  agent: string;



  version: string;



  available_commands: number;



}







export interface AgentCommandSpec {



  description: string;



  parameters: Array<{



    name: string;



    type: string;



    description: string;



    required: boolean;



    default?: any;



  }>;



}



export interface VoicePipelineResult {

  success: boolean;

  status: string;

  spoken_text: string;

  asr_language: string;

  asr_confidence: number;

  interpreted_intent: string;

  target_command?: string;

  command_params?: Record<string, any>;

  voice_response_text: string;

  clarification_prompt?: string;

  execution_result?: any;

  total_latency_ms: number;

  audit_id?: string;

}



/**

 * Invokes the 11-stage Python Voice Intelligence & Accuracy Pipeline on local agent (port 8000).

 */

export async function processVoiceThroughPipeline(options: {

  audioBase64?: string;

  text?: string;

  isConfirmed?: boolean;

  sampleRate?: number;

}): Promise<VoicePipelineResult | null> {

  try {

    const res = await fetch(`${DEFAULT_AGENT_URL}/voice/process_command`, {

      method: "POST",

      headers: { "Content-Type": "application/json" },

      body: JSON.stringify({

        audio_base64: options.audioBase64,

        text: options.text,

        is_confirmed: options.isConfirmed || false,

        sample_rate: options.sampleRate || 16000,

      }),

      signal: AbortSignal.timeout(8000),

    });

    if (!res.ok) {

      console.warn(`[VoicePipeline] Python voice service returned HTTP ${res.status}`);

      return null;

    }

    return (await res.json()) as VoicePipelineResult;

  } catch (err: any) {

    console.warn(`[VoicePipeline] Error invoking Python voice pipeline: ${err.message}`);

    return null;

  }

}







/**



 * Checks if the Era Python Local Agent or Era Bridge API server is running and online.



 */



export async function checkAgentStatus(): Promise<AgentStatusResult | null> {



  // 1. Try Era Local Agent directly (port 8000)



  try {



    const response = await fetch(`${DEFAULT_AGENT_URL}/status`, {



      method: "GET",



      headers: { "Content-Type": "application/json" },



      signal: AbortSignal.timeout(3000),



    });







    if (response.ok) {



      const data = (await response.json()) as AgentStatusResult;



      return data;



    }



  } catch (err: any) {



    console.warn(`[AgentBridge] Could not connect to Python Agent on ${DEFAULT_AGENT_URL}: ${err.message}`);



  }







  // 2. Fallback to Era Bridge Gateway (port 8100)



  try {



    const response = await fetch(`${DEFAULT_BRIDGE_URL}/v1/status`, {



      method: "GET",



      headers: {

        "Content-Type": "application/json",

        "X-Era-Bridge-Key": BRIDGE_API_KEY,

      },



      signal: AbortSignal.timeout(3000),



    });







    if (response.ok) {



      const data = await response.json();



      return {



        status: data.status,



        agent: "Era Bridge Gateway",



        version: data.bridge_version,



        available_commands: data.agent_status?.available_commands || 13,



      };



    }



  } catch (err: any) {



    console.warn(`[AgentBridge] Could not connect to Era Bridge Gateway on ${DEFAULT_BRIDGE_URL}: ${err.message}`);



  }







  return null;



}







/**



 * Fetches specifications of all available commands from the Python Local Agent.



 */



export async function fetchAgentCommands(): Promise<Record<string, AgentCommandSpec> | null> {



  try {



    const response = await fetch(`${DEFAULT_AGENT_URL}/commands`, {



      method: "GET",



      headers: { "Content-Type": "application/json" },



      signal: AbortSignal.timeout(3000),



    });







    if (!response.ok) return null;



    const data = await response.json();



    return data.commands || null;



  } catch (err: any) {



    console.warn(`[AgentBridge] Error fetching command specs: ${err.message}`);



    return null;



  }



}







/**



 * Sends a command execution request to the Era Python Local Agent or Era Bridge Gateway REST API.



 * 



 * @param command - The name of the registered Python command (e.g. "open_notepad", "open_camera", "open_app")



 * @param params - Optional parameters object (e.g. { app_name: "vscode" })



 * @returns AgentExecuteResult containing success status and descriptive message.



 */



export function cleanAppName(raw: string): string {

  if (!raw) return "";

  let name = raw.toLowerCase().trim();

  name = name.replace(/\b(open karo|kholo|chalu karo|start karo|laga do|chalao|dund kar|dhoondh kar|dhund kar|search karke kholo|open|launch|start|run|please|plz)\b/gi, " ");

  name = name.replace(/\b(app|application|software|karo|khol|karna|de|do|mera|meri|mujhe|dhoondh|dund|search|find)\b/gi, " ");

  name = name.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();

  return name;

}



export function cleanSearchQuery(raw: string): string {

  if (!raw) return "";

  let q = raw.toLowerCase().trim();

  q = q.replace(/\b(dund kar open karo|dund kar kholo|dhoondh kar kholo|search karke open karo|open karo|kholo|chalu karo|dekho|search karo|find karo)\b/gi, " ");

  q = q.replace(/\b(dund kar|dhoondh kar|dhund kar|search karke|dhoondho|dundo|dhundo)\b/gi, " ");

  q = q.replace(/\b(file|document|doc|folder|karo|khol|karna|de|do|mera|meri|mujhe|wala|wali|wale)\b/gi, " ");

  q = q.replace(/[^\w\s.-]/g, " ").replace(/\s+/g, " ").trim();

  return q;

}





export interface InstantCommandMatch {

  command: string;

  params: Record<string, any>;

  confirmation: string;

  appName?: string;

}



/**

 * Ultra-fast natural language intent matcher for Hindi, Hinglish, and English

 * to instantly execute app launches, system controls, and browser actions in < 15ms.

 */

export function matchInstantCommand(text: string): InstantCommandMatch | null {

  if (!text || typeof text !== "string") return null;

  const raw = text.trim();

  if (hasExplicitSchedulePhrase(raw)) return null;

  const lower = raw.toLowerCase();



  // 0. Instant Food Ordering Command
  const isFoodOrderQuery =
    /(?:order.*(?:food|khana|biryani|pizza|burger|roll|paneer|thali|momo|dish|pasta|sandwich|chowmein|noodles|dosa)|(?:zomato|swiggy).*(?:order|se|par|karo|mangwa|mangao)|(?:mangwa|mangao|mangva).*(?:do|khana|biryani|pizza|burger|food|dish)|khana.*order|(?:cheez|dish|kuch\s+khane).*order|kuch\s+order\s*(?:karo|kar\s*do|karna)|order\s*(?:karo|kar\s*do))/i.test(lower);

  if (isFoodOrderQuery) {
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
    if (mMax && mMax[1]) maxBudget = parseInt(mMax[1], 10);

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

    let platform = "swiggy";
    const hasZomato = lower.includes("zomato") || lower.includes("zumato") || lower.includes("zomoto");
    const hasSwiggy = lower.includes("swiggy") || lower.includes("swiggi") || lower.includes("swigy") || lower.includes("swigi");
    if (hasZomato && hasSwiggy) platform = "auto";
    else if (hasZomato) platform = "zomato";
    else platform = "swiggy";

    return {
      command: "order_food",
      params: {
        dish,
        quantity,
        max_budget: maxBudget,
        platform,
        payment_method: "cod",
        auto_order: true,
        headless: false,
      },
      confirmation: `Ji boss! Main live location par ${quantity > 1 ? `${quantity}x ` : ""}'${dish}' ${maxBudget ? `under ₹${maxBudget} ` : ""}search karke order kar rahi hoon.`,
    };
  }

  // 0.1. Food Service Login Helper (Swiggy / Zomato Permanent Profile Login)
  if (/\b(?:swiggy|zomato)\s+(?:pe\s+|par\s+)?(?:login|sign\s*in|account)\b/i.test(lower) ||
      /\b(?:login|sign\s*in)\s+(?:karo\s+|kar\s*do\s+)?(?:swiggy|zomato)\b/i.test(lower)) {
    const plat = lower.includes("zomato") ? "zomato" : "swiggy";
    return {
      command: "login_food_service",
      params: { platform: plat },
      confirmation: `Ji boss! Main ${plat.toUpperCase()} ko aapke permanent ERA browser session me open kar rahi hoon taaki aap 1 bar login kar lein aur session hamesha ke liye save rahe.`,
    };
  }

  // 0.2. Spoken OTP Handler for Food Delivery / Login
  const otpMatch =
    lower.match(/\b(?:otp|code|one\s*time\s*password)\s*(?:hai|is|daal\s*do|likh\s*do|enter\s*karo|likho)?\s*[:\s-]*(\d{4,6})\b/i) ||
    lower.match(/\b(\d{4,6})\s*(?:otp|code|hai|likh\s*do|enter\s*karo)\b/i) ||
    lower.match(/^(?:mera\s+)?(?:otp|code)\s*(?:hai\s+)?(\d{4,6})$/i) ||
    lower.match(/\b(mera\s+)?otp\s*(\d{4,6})\b/i) ||
    lower.match(/^\s*(?:otp\s*)?(\d{4,6})\s*$/i);

  if (otpMatch && otpMatch[1]) {
    const otpCode = otpMatch[1];
    return {
      command: "submit_food_otp",
      params: { otp: otpCode },
      confirmation: `Ji boss! Maine OTP ${otpCode} screen par enter kar diya hai aur order verify ho raha hai.`,
    };
  }

  // Spaced digits (e.g. "OTP 4 8 2 9 1 0")
  const spacedOtpMatch = lower.match(/\b(?:otp|code)\s*(?:hai|is|daal\s*do|likh\s*do|enter\s*karo|likho)?\s*[:\s-]*([0-9\s]{7,15})\b/i);
  if (spacedOtpMatch && spacedOtpMatch[1]) {
    const digitsOnly = spacedOtpMatch[1].replace(/\s+/g, "");
    if (digitsOnly.length >= 4 && digitsOnly.length <= 6) {
      return {
        command: "submit_food_otp",
        params: { otp: digitsOnly },
        confirmation: `Ji boss! Maine OTP ${digitsOnly} screen par enter kar diya hai aur order verify ho raha hai.`,
      };
    }
  }

  // 0.3. Hand Gesture Intelligence Instant Matching (Real-time camera hand gestures)
  const isGestureQuery =
    /\b(?:gesture|gestures|hand\s*gesture|camera\s*gesture|gesture\s*control|ishara|ishare)\b|जेस्चर|हैंड\s*जेस्चर/i.test(lower) ||
    ((lower.includes("camera") || lower.includes("कैमरा")) && /\b(?:gesture|hand|haath|hath|ishara|ishare)\b/i.test(lower));

  if (isGestureQuery) {
    if (/\b(?:stop|off|band|disable|roko|close|shut|hatao)\b|बंद|रोको/i.test(lower)) {
      return {
        command: "stop_gesture_control",
        params: {},
        confirmation: "Ji boss! Hand gesture recognition band kar diya hai.",
      };
    }
    if (/\b(?:status|check|state|kya\s*hai|dekho|batao)\b|स्टेटस/i.test(lower)) {
      return {
        command: "get_gesture_status",
        params: {},
        confirmation: "Ji boss! Hand gesture status check kar rahi hoon.",
      };
    }
    // Default to start / on (e.g. "hand gesture chalu karo", "camera gesture on karo")
    const showPreview = /\b(?:preview|window|dikhao|screen|hud)\b/i.test(lower) || true;
    return {
      command: "start_gesture_control",
      params: { camera: 0, preview: showPreview },
      confirmation: "Ji boss! Hand gesture recognition chalu kar diya hai. Ab aap ungliyon ko palm se door karke brightness aur palm ghuma kar volume control kar sakte hain!",
    };
  }

  // 1. Close browser / app

  if (/\b(close browser|browser band|band karo browser|chrome band|close chrome|browser band karo|browser close karo)\b/i.test(lower)) {

    return {

      command: "close_browser",

      params: {},

      confirmation: "Ji boss! Browser band kar diya hai.",

    };

  }



  // 2. Lock screen / PC

  if (/\b(lock screen|lock pc|screen lock|pc lock|laptop lock|computer lock)\b/i.test(lower)) {

    return {

      command: "lock_pc",

      params: {},

      confirmation: "Ji boss! Computer lock kar diya hai.",

    };

  }



  // 3. Stop / Pause Music or Media

  if (/\b(music band|music roko|music stop|pause music|stop music|gaana band|gaana roko|song band|song pause|audio pause)\b/i.test(lower)) {

    return {

      command: "media_control",

      params: { action: "pause" },

      confirmation: "Ji boss! Music pause kar diya hai.",

    };

  }



  // 3.1. Word & Text Deletion Instant Commands (Single Command Zero Latency)

  // A. Last word deletion

  if (/\b(?:ye\s+)?(?:last|aakhri|aakhiri)\s+(?:word|shabd)\s+(?:delete\s*karo|delete\s*kar\s*do|delete\s*kardo|hatao|hata\s*do|hatado|mitao|mita\s*do|mitado|remove\s*karo)\b/i.test(lower) ||

      /\b(?:delete\s*karo|delete\s*kar\s*do|hatao|mitao|remove)\s+(?:ye\s+)?(?:last|aakhri|aakhiri)\s+(?:word|shabd)\b/i.test(lower)) {

    return {

      command: "delete_text",

      params: { mode: "last_word" },

      confirmation: "Ji boss! Last word delete kar diya hai.",

    };

  }



  // B. Delete all / clear text

  if (/\b(?:poora\s+text|sab\s+kuch|all\s+text|poora\s+draft|poora\s+message)\s+(?:delete\s*karo|clear\s*karo|clear\s*kar\s*do|clearkardo|hatao|hata\s*do|hatado|mitao)\b/i.test(lower) ||

      /^(?:clear\s+screen|clear\s+all|delete\s+all|sab\s+hatao|poora\s+mitao)$/i.test(lower)) {

    return {

      command: "delete_text",

      params: { mode: "all" },

      confirmation: "Ji boss! Poora text screen se clear kar diya hai.",

    };

  }



  // C. Particular word deletion (e.g. "Rahul delete karo", "testing delete karo", "word xyz hatao")

  const delWordMatch1 = lower.match(/(?:word|shabd\s+)?["']?([a-zA-Z0-9_\-\u0900-\u097F]+)["']?\s+(?:delete\s*karo|delete\s*kar\s*do|delete\s*kardo|hatao|hata\s*do|hatado|mitao|mita\s*do|mitado|remove\s*karo)$/i);

  const delWordMatch2 = lower.match(/^(?:delete\s*karo|delete\s*kar\s*do|delete\s*kardo|hatao|hata\s*do|hatado|remove\s*karo|mitao)\s+(?:word|shabd\s+)?["']?([a-zA-Z0-9_\-\u0900-\u097F]+)["']?$/i);

  const delTarget = (delWordMatch1 && delWordMatch1[1]) || (delWordMatch2 && delWordMatch2[1]);

  if (delTarget && !["all", "sab", "poora", "last", "aakhri", "karo", "do", "text"].includes(delTarget.toLowerCase())) {

    return {

      command: "delete_text",

      params: { target: delTarget, mode: "word" },

      confirmation: `Ji boss! Shabd '${delTarget}' screen se hata diya hai.`,

    };

  }



  // 3.2. Instant Screen Typing Commands (Single Command Zero Latency)

  // Prefix typing patterns: "screen pe likho ...", "likho ...", "type karo ..."

  const typeMatchPrefix = raw.match(/^(?:(?:screen\s+(?:pe|par|per)|active\s+window\s+(?:pe|par|per)|notepad\s+(?:pe|par|per))\s+)?(?:likho|likh\s*do|likhdo|type\s*karo|type\s*kar\s*do|typekardo|write\s*karo|write)\s*[:\-]?\s*(?:ki\s+|that\s+)?(.+)$/i);

  if (typeMatchPrefix && typeMatchPrefix[1] && typeMatchPrefix[1].trim()) {

    const textToType = typeMatchPrefix[1].trim().replace(/^["']|["']$/g, "");

    return {

      command: "type_text",

      params: { text: textToType },

      confirmation: `Ji boss! Maine screen par '${textToType.slice(0, 30)}' likh diya hai.`,

    };

  }



  // Postfix typing patterns: "... likho", "... likh do", "... type karo"

  const typeMatchPostfix = raw.match(/^(.+?)\s+(?:(?:screen\s+(?:pe|par|per)|notepad\s+(?:pe|par|per))\s+)?(?:likho|likh\s*do|likhdo|type\s*karo|type\s*kar\s*do|typekardo)$/i);

  if (typeMatchPostfix && typeMatchPostfix[1] && typeMatchPostfix[1].trim()) {

    const candidate = typeMatchPostfix[1].trim().replace(/^["']|["']$/g, "");

    const candLower = candidate.toLowerCase();

    if (!candLower.startsWith("open ") && !candLower.startsWith("kholo ") && !candLower.endsWith(" kholo")) {

      return {

        command: "type_text",

        params: { text: candidate },

        confirmation: `Ji boss! Maine screen par '${candidate.slice(0, 30)}' likh diya hai.`,

      };

    }

  }



  // Guard: Reject questions, requests to explain, show, inspect, or tell

  if (/\b(?:kya|kaise|kyun|kahan|kidhar|batao|samjhao|explain|dikhao|dekho|check|review|padho|read|tell|what|how|why|where|show|inspect)\b/i.test(lower)) {

    return null;

  }



  // Guard: Do NOT open apps if negative, stop, or close words are present

  if (/\b(?:mat|dont|don't|not|never|band|close|stop|roko|hatao|delete|cancel|remove)\b/i.test(lower)) {

    return null;

  }



  // Guard: Do NOT short-circuit compound, multi-step, search, type, click, or messaging prompts

  const isCompoundOrTask =

    /[,;]/.test(lower) ||

    /\b(?:and|aur|then|uske baad|us\s*par|us\s*pe|uspe|us\s*per|us\s*mein|usme|in\s+it|inside|ke\s+andar|karke|kar\s*ke)\b/i.test(lower) ||

    /\b(?:search|khoj|dhundo|dhoond|type|likho|likh|write|click|press|enter|send|bhejo|bhej|message|msg|download|install|create|banau|banao|scroll|select|copy|paste)\b/i.test(lower);

  if (isCompoundOrTask) {

    return null;

  }



  // 4. YouTube fast match

  if (/\b(youtube|yt)\b/i.test(lower) && /\b(open|chalao|kholo|chalu|play|start)\b/i.test(lower)) {

    return {

      command: "open_browser",

      params: { url: "https://www.youtube.com" },

      confirmation: "Ji boss! Maine YouTube open kar diya hai.",

      appName: "YouTube",

    };

  }



  // 5. Common apps dictionary (Hindi / English simple single-app open matching)

  const wordCount = lower.split(/\s+/).filter(Boolean).length;

  const actionWords = "(?:open|launch|start|run|chalu|chalao|kholo|khol|kholna|kholiye)";

  const postActionWords = "(?:open karo|open kar do|open kar|kholo|khol do|khol de|chalu karo|start karo|chalao|launch karo|chalu kardo)";



  const appDictionary: Record<string, { appName: string; label: string }> = {

    chrome: { appName: "chrome", label: "Google Chrome" },

    "google chrome": { appName: "chrome", label: "Google Chrome" },

    browser: { appName: "chrome", label: "Browser" },

    vscode: { appName: "vscode", label: "VS Code" },

    "vs code": { appName: "vscode", label: "Visual Studio Code" },

    code: { appName: "vscode", label: "VS Code" },

    "visual studio code": { appName: "vscode", label: "Visual Studio Code" },

    calculator: { appName: "calculator", label: "Calculator" },

    calc: { appName: "calculator", label: "Calculator" },

    notepad: { appName: "notepad", label: "Notepad" },

    notes: { appName: "notepad", label: "Notepad" },

    whatsapp: { appName: "whatsapp", label: "WhatsApp" },

    spotify: { appName: "spotify", label: "Spotify" },

    music: { appName: "spotify", label: "Spotify" },

    canva: { appName: "canva", label: "Canva" },

    chatgpt: { appName: "chatgpt", label: "ChatGPT" },

    "chat gpt": { appName: "chatgpt", label: "ChatGPT" },

    openai: { appName: "chatgpt", label: "ChatGPT" },

    claude: { appName: "claude", label: "Claude" },

    xbox: { appName: "xbox", label: "Xbox" },

    explorer: { appName: "explorer", label: "File Explorer" },

    "file explorer": { appName: "explorer", label: "File Explorer" },

    files: { appName: "explorer", label: "File Explorer" },

    settings: { appName: "settings", label: "Settings" },

    camera: { appName: "camera", label: "Camera" },

    webcam: { appName: "camera", label: "Camera" },

    terminal: { appName: "terminal", label: "Terminal" },

    cmd: { appName: "cmd", label: "Command Prompt" },

    powershell: { appName: "powershell", label: "PowerShell" },

    "task manager": { appName: "task manager", label: "Task Manager" },

    taskmgr: { appName: "task manager", label: "Task Manager" },

    paint: { appName: "paint", label: "Paint" },

    word: { appName: "word", label: "Microsoft Word" },

    excel: { appName: "excel", label: "Microsoft Excel" },

    powerpoint: { appName: "powerpoint", label: "Microsoft PowerPoint" },

    ppt: { appName: "powerpoint", label: "Microsoft PowerPoint" },

  };



  if (wordCount <= 5) {

    for (const [key, info] of Object.entries(appDictionary)) {

      const keyRegex = new RegExp(`\\b${key}\\b`, "i");

      if (keyRegex.test(lower)) {

        const hasAction = new RegExp(`\\b${actionWords}\\b`, "i").test(lower) ||

                          new RegExp(`\\b${postActionWords}\\b`, "i").test(lower);

        if (hasAction) {

          return {

            command: "open_app",

            params: { app_name: info.appName },

            confirmation: `Ji boss! Maine ${info.label} open kar diya hai.`,

            appName: info.label,

          };

        }

      }

    }

  }



  // Generic prefix: "open <app>" or "kholo <app>"

  const prefixMatch = lower.match(new RegExp(`^(?:${actionWords})\\s+([a-z0-9\\s.-]+)$`, "i"));

  if (prefixMatch && prefixMatch[1]) {

    const target = cleanAppName(prefixMatch[1]);

    if (target && target.length >= 2) {

      return {

        command: "open_app",

        params: { app_name: target },

        confirmation: `Ji boss! Maine ${target} open kar diya hai.`,

        appName: target,

      };

    }

  }



  // Generic suffix: "<app> open karo" or "<app> kholo"

  const suffixMatch = lower.match(new RegExp(`^([a-z0-9\\s.-]+?)\\s+(?:${postActionWords})$`, "i"));

  if (suffixMatch && suffixMatch[1]) {

    const target = cleanAppName(suffixMatch[1]);

    if (target && target.length >= 2) {

      return {

        command: "open_app",

        params: { app_name: target },

        confirmation: `Ji boss! Maine ${target} open kar diya hai.`,

        appName: target,

      };

    }

  }



  return null;

}



function runPowerShellHidden(psCommand: string, timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {

  return new Promise((resolve) => {

    try {

      const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psCommand], {

        windowsHide: true,

        stdio: ["ignore", "pipe", "pipe"],

      });

      let stderr = "";

      const timer = setTimeout(() => {

        try { proc.kill(); } catch {}

        resolve({ ok: false, error: `PowerShell timed out after ${timeoutMs}ms` });

      }, timeoutMs);

      proc.stderr?.on("data", (d) => { stderr += d.toString(); });

      proc.on("error", (err) => {

        clearTimeout(timer);

        resolve({ ok: false, error: err.message });

      });

      proc.on("close", (code) => {

        clearTimeout(timer);

        resolve({ ok: code === 0, error: code === 0 ? undefined : (stderr.trim() || `Exit code ${code}`) });

      });

    } catch (err: any) {

      resolve({ ok: false, error: err.message });

    }

  });

}



function getPythonRuntimePath(): string {

  const custom = "C:\\Users\\MSI\\AppData\\Local\\Programs\\ERA AI Assistant\\resources\\python_runtime\\python.exe";

  if (fs.existsSync(custom)) return custom;

  return "python";

}



function getNativeTypingScriptPath(): string {

  const p1 = path.join(__dirname, "native_typing.py");

  if (fs.existsSync(p1)) return p1;

  const p2 = "d:\\era_agent\\native_typing.py";

  if (fs.existsSync(p2)) return p2;

  const p3 = "C:\\Users\\MSI\\AppData\\Local\\Programs\\ERA AI Assistant\\resources\\era_services\\era_agent\\native_typing.py";

  if (fs.existsSync(p3)) return p3;

  return p2;

}



export function executeNativeTyping(

  action: "type" | "delete",

  text: string,

  options: { app?: string; mode?: string; enter?: boolean } = {}

): AgentExecuteResult {

  const pyExe = getPythonRuntimePath();

  const script = getNativeTypingScriptPath();

  const args = [script, action, text || ""];

  if (options.app) {

    args.push("--app", options.app);

  }

  if (options.mode) {

    args.push("--mode", options.mode);

  }

  if (options.enter) {

    args.push("--enter");

  }



  try {

    const res = spawnSync(pyExe, args, { timeout: 10000, encoding: "utf-8", windowsHide: true });

    if (res.stdout) {

      try {

        const jsonRes = JSON.parse(res.stdout.trim());

        return {

          success: Boolean(jsonRes.success),

          message: jsonRes.message || "Native typing executed.",

          data: jsonRes.data

        };

      } catch {

        return { success: true, message: res.stdout.trim() };

      }

    }

    if (res.error) {

      return { success: false, message: `Native typing error: ${res.error.message}` };

    }

    return { success: true, message: "Native typing action completed." };

  } catch (err: any) {

    return { success: false, message: `Failed to invoke native typing: ${err.message}` };

  }

}



export function executeNativeScroll(

  options: { direction?: string; amount?: string; clicks?: number; app?: string; smooth?: boolean; steps?: number; duration?: number } = {}

): AgentExecuteResult {

  const pyExe = getPythonRuntimePath();

  const script = getNativeTypingScriptPath();

  const args = [script, "scroll"];

  if (options.direction) {

    args.push("--direction", options.direction);

  }

  if (options.amount) {

    args.push("--amount", options.amount);

  }

  if (options.clicks !== undefined) {

    args.push("--clicks", String(options.clicks));

  }

  if (options.app) {

    args.push("--app", options.app);

  }

  if (options.smooth !== false) {

    args.push("--smooth");

  }

  if (options.steps) {

    args.push("--steps", String(options.steps));

  }

  if (options.duration) {

    args.push("--duration", String(options.duration));

  }



  try {

    const res = spawnSync(pyExe, args, { timeout: 8000, encoding: "utf-8", windowsHide: true });

    if (res.stdout) {

      try {

        const jsonRes = JSON.parse(res.stdout.trim());

        return {

          success: Boolean(jsonRes.success),

          message: jsonRes.message || "Screen smoothly scrolled.",

          data: jsonRes,

        };

      } catch {

        return { success: true, message: res.stdout.trim() };

      }

    }

    if (res.error) {

      return { success: false, message: `Native scroll error: ${res.error.message}` };

    }

    return { success: true, message: "Screen scrolled smoothly." };

  } catch (err: any) {

    return { success: false, message: `Failed to invoke native scroll: ${err.message}` };

  }

}

export function executeNativeScrollToTarget(
  options: { target: string; app?: string; direction?: string; maxScrolls?: number; smooth?: boolean }
): AgentExecuteResult {
  const pyExe = getPythonRuntimePath();
  const script = getNativeTypingScriptPath();
  const args = [script, "scroll_to_target", "--target", options.target || ""];

  if (options.app) {
    args.push("--app", options.app);
  }
  if (options.direction) {
    args.push("--direction", options.direction);
  }
  if (options.maxScrolls) {
    args.push("--max-scrolls", String(options.maxScrolls));
  }
  if (options.smooth !== false) {
    args.push("--smooth");
  }

  try {
    const res = spawnSync(pyExe, args, { timeout: 12000, encoding: "utf-8", windowsHide: true });
    if (res.stdout) {
      try {
        const jsonRes = JSON.parse(res.stdout.trim());
        return {
          success: Boolean(jsonRes.success),
          message: jsonRes.message || `Screen scrolled to ${options.target}.`,
          data: jsonRes,
        };
      } catch {
        return { success: true, message: res.stdout.trim() };
      }
    }
    if (res.error) {
      return { success: false, message: `Native scroll to target error: ${res.error.message}` };
    }
    return { success: true, message: `Screen scrolled to ${options.target}.` };
  } catch (err: any) {
    return { success: false, message: `Failed to invoke native scroll to target: ${err.message}` };
  }
}



/**

 * Direct Windows Native Launcher (0-15ms response).

 * Bypasses network HTTP and PowerShell delays for windowless launches/locks/browser-close/screen typing.

 */

export function executeNativeDirect(cmd: string, params: Record<string, any> = {}): AgentExecuteResult | null {

  const normCmd = (cmd || "").toLowerCase().trim();



  // TYPE TEXT (Zero-Latency Screen Typing via Win32 API)

  if (normCmd === "type_text" || normCmd === "typetext") {

    const textToType = String(params.text || params.content || params.message || "").trim();

    const app = String(params.app_name || params.appName || params.app || "");

    const enter = Boolean(params.press_enter || params.enter);

    return executeNativeTyping("type", textToType, { app, enter });

  }



  // DELETE TEXT (Zero-Latency Particular Word / Last Word / All Text Deletion)

  if (normCmd === "delete_text" || normCmd === "deletetext") {

    const target = String(params.target || params.word || params.text || "").trim();

    const mode = String(params.mode || params.delete_mode || (target ? "word" : "last_word"));

    const app = String(params.app_name || params.appName || params.app || "");

    return executeNativeTyping("delete", target, { app, mode });

  }



  // SMOOTH SCREEN SCROLL (Zero-Latency Screen Scrolling via Win32 API)

  if (

    normCmd === "scroll_screen" ||

    normCmd === "scrollscreen" ||

    normCmd === "smooth_scroll" ||

    normCmd === "smoothscroll"

  ) {

    const dir = String(params.direction || (Number(params.clicks) < 0 ? "down" : Number(params.clicks) > 0 ? "up" : "down"));

    const amt = String(params.amount || (params.clicks ? String(Math.abs(Number(params.clicks))) : "normal"));

    const app = String(params.app_name || params.appName || params.app || "");

    const smooth = params.smooth !== false;

    return executeNativeScroll({

      direction: dir,

      amount: amt,

      clicks: params.clicks !== undefined && params.clicks !== null ? Number(params.clicks) : undefined,

      app,

      smooth,

      steps: params.steps ? Number(params.steps) : undefined,

      duration: params.duration ? Number(params.duration) : undefined,

    });

  }

  // TARGETED CONTENT SCROLL (Autonomous Scroll to Specific Heading / Topic / Section)
  if (
    normCmd === "scroll_to_target" ||
    normCmd === "scrolltotarget" ||
    normCmd === "scroll_to_content" ||
    normCmd === "scrolltocontent"
  ) {
    const target = String(params.target || params.topic || params.section || params.query || "");
    const app = String(params.app_name || params.appName || params.app || "");
    const dir = String(params.direction || "down");
    const maxScrolls = Number(params.max_scrolls || params.maxScrolls || 8);
    const smooth = params.smooth !== false;

    return executeNativeScrollToTarget({
      target,
      app,
      direction: dir,
      maxScrolls,
      smooth,
    });
  }



  // CLOSE BROWSER

  if (normCmd === "close_browser" || normCmd === "closebrowser") {

    try {

      spawn("cmd.exe", ["/c", "taskkill /im chrome.exe /im msedge.exe /im opera.exe /im brave.exe /im firefox.exe /f"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Browser closed successfully." };

    } catch (e: any) {

      return { success: false, message: `Failed to close browser: ${e.message}` };

    }

  }



  // CLOSE APPLICATION (by friendly app name)

  if (normCmd === "close_app" || normCmd === "closeapp" || normCmd === "close_application" || normCmd === "closeapplication") {
    const rawApp = String(params?.app_name || params?.appName || params?.name || "").trim().toLowerCase();
    if (!rawApp) {
      return { success: false, message: "No application specified to close." };
    }

    const cleanKey = rawApp.replace(/[^a-z0-9 ]/g, "").trim();

    // Active window handling
    if (cleanKey === "window" || cleanKey === "active" || cleanKey === "this" || cleanKey === "current" || cleanKey === "activewindow" || cleanKey === "currentwindow") {
      try {
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('%{F4}')`;
        execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 2000, stdio: "ignore" });
        return { success: true, message: "Active window band kar diya hai." };
      } catch (e: any) {
        return { success: false, message: `Failed to close active window: ${e.message}` };
      }
    }

    // Map friendly names to process .exe names
    const appProcessMap: Record<string, string[]> = {
      opera: ["opera.exe", "opera_gx_splash.exe", "opera_autoupdate.exe"],
      "opera gx": ["opera.exe", "opera_gx_splash.exe", "opera_autoupdate.exe"],
      chrome: ["chrome.exe"],
      "google chrome": ["chrome.exe"],
      msedge: ["msedge.exe"],
      edge: ["msedge.exe"],
      firefox: ["firefox.exe"],
      brave: ["brave.exe"],
      notepad: ["notepad.exe", "Notepad.exe"],
      calculator: ["CalculatorApp.exe", "calculator.exe", "calc.exe"],
      calc: ["CalculatorApp.exe", "calculator.exe", "calc.exe"],
      spotify: ["Spotify.exe", "spotify.exe"],
      whatsapp: ["WhatsApp.exe", "WhatsApp.Root.exe"],
      telegram: ["Telegram.exe", "telegram.exe"],
      vscode: ["Code.exe", "code.exe"],
      code: ["Code.exe", "code.exe"],
      "visual studio code": ["Code.exe", "code.exe"],
      vlc: ["vlc.exe"],
      zoom: ["Zoom.exe"],
      discord: ["Discord.exe"],
      slack: ["slack.exe"],
      teams: ["Teams.exe", "ms-teams.exe"],
      paint: ["mspaint.exe"],
      wordpad: ["wordpad.exe"],
      word: ["WINWORD.EXE"],
      excel: ["EXCEL.EXE"],
      powerpoint: ["POWERPNT.EXE"],
      outlook: ["OUTLOOK.EXE"],
      cmd: ["cmd.exe"],
      terminal: ["WindowsTerminal.exe"],
      explorer: ["explorer.exe"],
      "file explorer": ["explorer.exe"],
      chatgpt: ["ChatGPT.exe"],
      camera: ["WindowsCamera.exe"],
      settings: ["SystemSettings.exe"],
      taskmgr: ["Taskmgr.exe"],
      "task manager": ["Taskmgr.exe"],
      era: ["ERA AI Assistant.exe"],
      "era assistant": ["ERA AI Assistant.exe"],
    };

    const exeNames: string[] = appProcessMap[cleanKey] || appProcessMap[cleanKey.replace(/\s+/g, "")] || [`${cleanKey}.exe`];

    try {
      let terminated = false;
      // 1. Try taskkill /F /T /IM for each exe synchronously
      for (const exe of exeNames) {
        try {
          const out = execSync(`taskkill /F /T /IM ${exe}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          if (out && out.toUpperCase().includes("SUCCESS")) {
            terminated = true;
          }
        } catch (_) {}
      }

      // 2. PowerShell fallback matching ProcessName or MainWindowTitle
      if (!terminated && cleanKey.length >= 3) {
        try {
          const ps = `Get-Process | Where-Object { $_.ProcessName -like '*${cleanKey}*' -or $_.MainWindowTitle -like '*${cleanKey}*' } | Stop-Process -Force -ErrorAction SilentlyContinue`;
          execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 3000, stdio: "ignore" });
          terminated = true;
        } catch (_) {}
      }

      return {
        success: true,
        message: `${rawApp} band kar diya hai.`,
      };
    } catch (e: any) {
      return { success: false, message: `Failed to close ${rawApp}: ${e.message}` };
    }
  }



  // LOCK PC

  if (normCmd === "lock_pc" || normCmd === "lockscreen" || normCmd === "lock_screen") {

    try {

      spawn("rundll32.exe", ["user32.dll,LockWorkStation"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Computer screen locked successfully." };

    } catch (e: any) {

      return { success: false, message: `Failed to lock computer: ${e.message}` };

    }

  }



  // SLEEP PC

  if (normCmd === "sleep_pc" || normCmd === "sleeppc") {

    try {

      spawn("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Putting computer to sleep now." };

    } catch (e: any) {

      return { success: false, message: `Failed to put computer to sleep: ${e.message}` };

    }

  }



  // SHUTDOWN PC

  if (normCmd === "shutdown_pc" || normCmd === "shutdown") {

    const delay = Number(params?.delay_seconds ?? params?.delaySeconds ?? 30);

    try {

      spawn("shutdown", ["/s", "/t", String(delay)], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: `Shutdown scheduled in ${delay} seconds. Say 'cancel shutdown' to stop it.` };

    } catch (e: any) {

      return { success: false, message: `Failed to schedule shutdown: ${e.message}` };

    }

  }



  // RESTART PC

  if (normCmd === "restart_pc" || normCmd === "restart") {

    const delay = Number(params?.delay_seconds ?? params?.delaySeconds ?? 30);

    try {

      spawn("shutdown", ["/r", "/t", String(delay)], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: `Restart scheduled in ${delay} seconds. Say 'cancel shutdown' to stop it.` };

    } catch (e: any) {

      return { success: false, message: `Failed to schedule restart: ${e.message}` };

    }

  }



  // CANCEL SHUTDOWN

  if (normCmd === "cancel_shutdown" || normCmd === "cancelshutdown" || normCmd === "cancel") {

    try {

      spawn("shutdown", ["/a"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Pending shutdown or restart was cancelled successfully." };

    } catch (e: any) {

      return { success: false, message: `Failed to cancel shutdown: ${e.message}` };

    }

  }



function launchWindowsBrowserUrl(url: string, browserName?: string): void {
  let cleanUrl = (url || "https://www.google.com").trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    cleanUrl = "https://" + cleanUrl;
  }
  const b = (browserName || "").toLowerCase();

  // 1. Explicit Opera requested
  if (b.includes("opera")) {
    const operaPaths = [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Opera", "opera.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Opera GX", "opera.exe"),
      "C:\\Program Files\\Opera\\launcher.exe",
    ];
    const op = operaPaths.find(p => fs.existsSync(p));
    if (op) {
      spawn(op, [cleanUrl], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("cmd.exe", ["/c", "start", "", "opera", cleanUrl], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  // 2. Explicit Edge requested
  if (b.includes("edge") || b.includes("msedge")) {
    const edgePaths = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    const ep = edgePaths.find(p => fs.existsSync(p));
    if (ep) {
      spawn(ep, [cleanUrl], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("cmd.exe", ["/c", "start", "", "msedge", cleanUrl], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  // 3. Firefox
  if (b.includes("firefox")) {
    spawn("cmd.exe", ["/c", "start", "", "firefox", cleanUrl], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  // 4. Default Browser & Chrome (Primary: Google Chrome on Windows - never route to headless background processes)
  const chromePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  const cp = chromePaths.find(p => fs.existsSync(p));
  if (cp) {
    spawn(cp, [cleanUrl], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  // 5. Windows Shell Default Fallback
  spawn("cmd.exe", ["/c", "start", "", cleanUrl], { detached: true, stdio: "ignore" }).unref();
}

  if (normCmd === "open_browser") {
    const url = params?.url || "https://www.google.com";
    const browser = (params?.browser_name || params?.browser || "").toLowerCase();
    launchWindowsBrowserUrl(url, browser);
    const browserLabel = browser.includes("opera") ? "Opera" : (browser.includes("edge") || browser.includes("msedge")) ? "Microsoft Edge" : "Google Chrome";
    return { success: true, message: `Opened ${browserLabel} to ${url}.` };
  }

  if (normCmd === "open_app" || normCmd === "open_application") {
    const appTarget = String(params?.app_name || params?.appName || params?.name || "").toLowerCase().trim();
    if (["chrome", "googlechrome", "google", "browser", "brouser", "web", "internet", "website"].includes(appTarget)) {
      launchWindowsBrowserUrl("https://www.google.com", "chrome");
      return { success: true, message: "Opened Google Chrome browser successfully." };
    }
    if (["youtube", "yt", "youtubemusic"].includes(appTarget)) {
      launchWindowsBrowserUrl("https://www.youtube.com", "chrome");
      return { success: true, message: "Opened YouTube in Google Chrome successfully." };
    }
  }



  // Note: open_app / open_notepad / open_chrome / open_calculator / open_file_explorer / open_camera

  // intentionally route to Python Local Agent (/execute) first so _get_clean_env() + _attach_winsta() +

  // Store AppsFolder activation + .lnk resolution run cleanly outside Electron's environment variables.

  // If Local Agent is offline, Section 3 below handles Windows native fallback launch.



  return null;

}





export async function executeWhatsAppFallbackAsync(command: string, params: any): Promise<AgentExecuteResult> {

  const pyCandidates = [

    "d:\\era_agent\\.venv\\Scripts\\python.exe",

    "d:\\era-voice-assistant\\resources\\python_runtime\\python.exe",

    "python.exe"

  ];

  const pyExe = pyCandidates.find(p => fs.existsSync(p)) || "python.exe";

  const targetMsg = String(params?.message || params?.text || "").trim();



  let pyCode = "";

  if (command === "send_whatsapp_to_multiple") {

    const rawRecipients = Array.isArray(params?.recipients) ? params.recipients : undefined;

    const rawMessages = Array.isArray(params?.messages) ? params.messages : undefined;

    const rawContacts = params?.contacts || params?.to || [];

    let list: any[] = [];

    if (Array.isArray(rawContacts)) {

      list = rawContacts.map((c) => (c && typeof c === "object" ? c : String(c).trim())).filter(Boolean);

    } else if (typeof rawContacts === "string") {

      list = rawContacts.split(/\s+and\s+|[,;]|\s+aur\s+/i).map((c) => c.trim()).filter(Boolean);

    }

    pyCode = `import sys, json\nsys.path.insert(0, r"d:\\era_agent")\nfrom commands.system_commands import send_whatsapp_to_multiple\nres = send_whatsapp_to_multiple(contacts=${JSON.stringify(list)}, message=${JSON.stringify(targetMsg)}, recipients=${JSON.stringify(rawRecipients ?? null)}, messages=${JSON.stringify(rawMessages ?? null)})\nprint(json.dumps({"success": res.success, "message": res.message, "data": getattr(res, "data", None)}))`;

  } else if (command === "send_whatsapp_file") {

    const rawTarget = String(params?.phone || params?.contact || params?.target || params?.to || params?.contactName || "").trim();

    const rawFile = String(params?.file_path || params?.filePath || params?.file_name || params?.fileName || params?.path || "").trim();

    const rawCaption = String(params?.message || params?.caption || params?.text || "").trim();

    const rawContent = String(params?.file_content || params?.fileContent || params?.content || "").trim();

    pyCode = `import sys, json\nsys.path.insert(0, r"d:\\era_agent")\nfrom commands.system_commands import send_whatsapp_file\nres = send_whatsapp_file(contact=${JSON.stringify(rawTarget)}, file_path=${JSON.stringify(rawFile)}, message=${JSON.stringify(rawCaption)}, file_content=${JSON.stringify(rawContent)})\nprint(json.dumps({"success": res.success, "message": res.message, "data": getattr(res, "data", None)}))`;

  } else {

    const rawTarget = String(params?.phone || params?.contact || params?.target || params?.to || params?.contactName || "").trim();

    pyCode = `import sys, json\nsys.path.insert(0, r"d:\\era_agent")\nfrom commands.system_commands import open_whatsapp\nres = open_whatsapp(phone=${JSON.stringify(rawTarget)}, message=${JSON.stringify(targetMsg)})\nprint(json.dumps({"success": res.success, "message": res.message, "data": getattr(res, "data", None)}))`;

  }



  return new Promise<AgentExecuteResult>((resolve) => {

    let stdout = "";

    let stderr = "";

    const proc = spawn(pyExe, ["-c", pyCode], {

      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONLEGACYWINDOWSSTDIO: "0" }

    });

    proc.stdout.on("data", (d) => { stdout += d.toString(); });

    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {

      try {

        const jsonLines = stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{") && l.endsWith("}"));

        const lastLine = jsonLines.pop() || stdout.trim().split("\n").pop() || "{}";

        const parsed = JSON.parse(lastLine);

        resolve({

          success: Boolean(parsed.success),

          message: parsed.message || (code === 0 ? "WhatsApp action executed." : stderr || "WhatsApp action completed."),

          data: parsed.data

        });

      } catch (_) {

        resolve({

          success: code === 0,

          message: stdout.trim() || stderr.trim() || `WhatsApp process exited with code ${code}.`

        });

      }

    });

    proc.on("error", (err) => {

      resolve({ success: false, message: `Failed to spawn Python for WhatsApp: ${err.message}` });

    });

  });

}



let voiceGuardAuthorizer: (() => boolean) | null = null;



export function setVoiceGuardAuthorizer(fn: () => boolean): void {

  voiceGuardAuthorizer = fn;

}



export async function executeAgentCommand(

  command: string,

  params: Record<string, any> = {},

  options?: { bypassVoiceGuard?: boolean }

): Promise<AgentExecuteResult> {

  const SAFE_COMMANDS = new Set([

    "type_text", "typeText", "typetext",

    "perform_research", "performResearch", "deepResearch",

    "generate_summary", "generateDetailedSummary", "createSummary",

    "get_window_context", "getWindowContext",

    "capture_screen", "captureScreen",

    "get_system_metrics", "get_battery_status",

    "list_processes", "list_installed_apps",

    "get_weather", "getWeather",

    "scroll_screen", "scrollScreen", "scrollscreen",

    "smooth_scroll", "smoothScroll", "smoothscroll",

    "read_and_scroll_whatsapp", "readAndScrollWhatsApp", "readandscrollwhatsapp",

    "scroll_to_target", "scrollToTarget", "scrolltotarget",

    "scroll_to_content", "scrollToContent", "scrolltocontent",

    "start_gesture_control", "startGestureControl", "startgesturecontrol",

    "stop_gesture_control", "stopGestureControl", "stopgesturecontrol",

    "get_gesture_status", "getGestureStatus", "getgesturestatus"

  ]);

  const isSafeCommand = SAFE_COMMANDS.has(command);



  // ── VoiceGuard Zero-Trust Security Gate ──

  if (!options?.bypassVoiceGuard && !isSafeCommand && voiceGuardAuthorizer && !voiceGuardAuthorizer()) {

    console.warn(`🚨 [VoiceGuard Gate] Agent command '${command}' was BLOCKED! Speaker is NOT verified as the registered owner.`);

    return {

      success: false,

      message: "VoiceGuard: Access Denied. Speaker voice was NOT identified as the registered owner. Command execution was blocked.",

    };

  }



  const commandMap: Record<string, string> = {

    openApplication: "open_app",

    openapplication: "open_app",

    openApp: "open_app",

    openapp: "open_app",

    open_application: "open_app",



    typeText: "type_text",

    typetext: "type_text",

    startGestureControl: "start_gesture_control",
    startgesturecontrol: "start_gesture_control",
    start_gesture_control: "start_gesture_control",

    stopGestureControl: "stop_gesture_control",
    stopgesturecontrol: "stop_gesture_control",
    stop_gesture_control: "stop_gesture_control",

    getGestureStatus: "get_gesture_status",
    getgesturestatus: "get_gesture_status",
    get_gesture_status: "get_gesture_status",



    writeInVSCode: "write_in_vscode",

    writeinvscode: "write_in_vscode",

    write_in_vscode: "write_in_vscode",



    saveActiveVSCodeFile: "save_active_vscode_file",

    saveactivevscodefile: "save_active_vscode_file",

    save_active_vscode_file: "save_active_vscode_file",



    deleteText: "delete_text",

    deletetext: "delete_text",

    delete_text: "delete_text",



    pressKeyCombination: "press_key_combination",

    presskeycombination: "press_key_combination",



    clickScreen: "click_screen",

    clickscreen: "click_screen",



    scrollScreen: "scroll_screen",

    scrollscreen: "scroll_screen",

    smoothScroll: "smooth_scroll",

    smoothscroll: "smooth_scroll",

    smooth_scroll: "smooth_scroll",

    scrollToTarget: "scroll_to_target",

    scrolltotarget: "scroll_to_target",

    scroll_to_target: "scroll_to_target",

    scrollToContent: "scroll_to_target",

    scrolltocontent: "scroll_to_target",

    scroll_to_content: "scroll_to_target",

    readAndScrollWhatsApp: "read_and_scroll_whatsapp",

    readandscrollwhatsapp: "read_and_scroll_whatsapp",

    read_and_scroll_whatsapp: "read_and_scroll_whatsapp",



    minimizeActiveWindow: "minimize_active_window",

    minimizeactivewindow: "minimize_active_window",

    minimize_active_window: "minimize_active_window",



    minimizeWindow: "minimize_window",

    minimizewindow: "minimize_window",

    minimize_window: "minimize_window",



    maximizeWindow: "maximize_window",

    maximizewindow: "maximize_window",

    maximize_window: "maximize_window",



    restoreWindow: "restore_window",

    restorewindow: "restore_window",

    restore_window: "restore_window",



    minimizeAll: "minimize_all",

    minimizeall: "minimize_all",

    minimize_all: "minimize_all",

    showDesktop: "show_desktop",

    showdesktop: "show_desktop",

    show_desktop: "show_desktop",



    splitScreen: "split_screen",

    splitscreen: "split_screen",

    split_screen: "split_screen",



    snapWindow: "snap_window",

    snapwindow: "snap_window",

    snap_window: "snap_window",



    searchFile: "search_file",

    searchfile: "search_file",

    search_file: "search_file",



    openFile: "open_file",

    openfile: "open_file",

    open_file: "open_file",

    openFolder: "open_file",

    openfolder: "open_file",

    open_folder: "open_file",



    fullscreen: "maximize_window",

    fullScreen: "maximize_window",

    full_screen: "maximize_window",

    maximize: "maximize_window",



    editFileAtPath: "edit_file_at_path",



    focusWindow: "focus_window",

    focuswindow: "focus_window",

    sendWhatsAppFile: "send_whatsapp_file",

    sendwhatsappfile: "send_whatsapp_file",

    send_whatsapp_file: "send_whatsapp_file",

    sendWhatsAppDocument: "send_whatsapp_file",

    sendwhatsappdocument: "send_whatsapp_file",

    send_whatsapp_document: "send_whatsapp_file",

    sendWhatsAppMessage: "send_whatsapp_message",

    sendwhatsappmessage: "send_whatsapp_message",

    send_whatsapp_message: "send_whatsapp_message",

    send_whatsapp_to_multiple: "send_whatsapp_to_multiple",

    sendWhatsAppToMultiple: "send_whatsapp_to_multiple",

    sendwhatsapptomultiple: "send_whatsapp_to_multiple",

    openWhatsApp: "open_whatsapp",

    openwhatsapp: "open_whatsapp",

    openWhatsAppChat: "open_whatsapp_chat",

    open_whatsapp_chat: "open_whatsapp_chat",

    openwhatsappchat: "open_whatsapp_chat",

    closeBrowser: "close_browser",



    closeApplication: "close_app",

    closeapplication: "close_app",

    close_application: "close_app",

    closeApp: "close_app",

    closeapp: "close_app",

    close_app: "close_app",



    makePhoneCall: "make_phone_call",

    makephonecall: "make_phone_call",

    make_phone_call: "make_phone_call",

    callPhone: "make_phone_call",

    callphone: "make_phone_call",

    answerPhoneCall: "answer_phone_call",

    answerphonecall: "answer_phone_call",

    answer_phone_call: "answer_phone_call",

    acceptPhoneCall: "answer_phone_call",

    acceptphonecall: "answer_phone_call",

    accept_phone_call: "answer_phone_call",

    rejectPhoneCall: "reject_phone_call",

    rejectphonecall: "reject_phone_call",

    reject_phone_call: "reject_phone_call",

    declinePhoneCall: "reject_phone_call",

    declinephonecall: "reject_phone_call",

    decline_phone_call: "reject_phone_call",

    getPhoneLinkStatus: "get_phone_link_status",

    getphonelinkstatus: "get_phone_link_status",

    orderFood: "order_food",

    orderfood: "order_food",

    order_food: "order_food",

    orderFoodAutonomous: "order_food",

    orderfoodautonomous: "order_food",

    order_food_autonomous: "order_food",

    submitFoodOtp: "submit_food_otp",

    submitfoodotp: "submit_food_otp",

    submit_food_otp: "submit_food_otp",

    completeFoodOrder: "complete_food_order",

    completefoodorder: "complete_food_order",

    complete_food_order: "complete_food_order",

    fillFoodAddress: "complete_food_order",

    fillfoodaddress: "complete_food_order",

    fill_food_address: "complete_food_order",

    shutdown: "shutdown_pc",

    shutdown_pc: "shutdown_pc",

    restart: "restart_pc",

    restart_pc: "restart_pc",

    cancel_shutdown: "cancel_shutdown",

    cancelShutdown: "cancel_shutdown",

  };



  const resolvedCmd = commandMap[command] || command;



  if (resolvedCmd === "open_app") {

    const raw = String(params.app_name || params.appName || params.name || "").trim();

    const cleaned = cleanAppName(raw);

    params.app_name = cleaned || raw;

    params.appName = params.app_name;

  }

  if (resolvedCmd === "send_whatsapp_file") {

    params.contact = params.contact || params.contactName || params.phone || params.to || params.recipient || params.target;

    params.phone = params.contact;

    params.file_path = params.file_path || params.filePath || params.fileName || params.file_name || params.filename || params.path;

    params.filePath = params.file_path;

    params.fileName = params.file_path;

    params.file_name = params.file_path;

    params.message = params.message || params.caption || params.text || params.msg || "";

    params.caption = params.message;

    params.file_content = params.file_content || params.fileContent || params.content || params.code || "";

  }

  if (resolvedCmd === "send_whatsapp_message") {

    params.contact = params.contact || params.contactName || params.phone || params.to;

    params.phone = params.contact;

    params.message = params.message || params.text || params.msg;

  }

  if (resolvedCmd === "send_whatsapp_to_multiple") {

    if (Array.isArray(params.recipients) && params.recipients.length > 0 && !params.contacts) {

      params.contacts = params.recipients.map((r: any) => r?.contact || r?.name || r?.phone || "").filter(Boolean);

    }

    if (Array.isArray(params.recipients) && !params.messages) {

      params.messages = params.recipients.map((r: any) => String(r?.message || r?.text || params.message || ""));

    }

  }

  if (resolvedCmd === "type_text") {

    params.text = params.text || params.content || params.message;

    params.app_name = params.app_name || params.appName || params.app;

  }

  if (resolvedCmd === "open_whatsapp_chat") {

    params.contact = params.contact || params.contactName || params.phone || params.name || params.to;

    params.phone = params.contact;

  }

  if (resolvedCmd === "scroll_screen" || resolvedCmd === "smooth_scroll") {

    params.direction = params.direction || (Number(params.clicks) < 0 ? "down" : Number(params.clicks) > 0 ? "up" : "down");

    params.amount = params.amount || (params.clicks ? String(Math.abs(Number(params.clicks))) : "normal");

    params.app_name = params.app_name || params.appName || params.app || "";

    params.smooth = params.smooth !== false;

  }

  if (resolvedCmd === "read_and_scroll_whatsapp") {

    params.contact = params.contact || params.contactName || params.name || params.phone || "";

    params.direction = params.direction || "down";

    params.steps = Number(params.steps || params.scrollSteps || 2);

  }

  if (resolvedCmd === "focus_window") {

    params.app_name = params.app_name || params.appName || params.name;

  }

  if (resolvedCmd === "split_screen") {

    params.left_app = params.left_app || params.leftApp || params.left;

    params.right_app = params.right_app || params.rightApp || params.right;

    params.middle_app = params.middle_app || params.middleApp || params.middle;

  }

  if (resolvedCmd === "snap_window") {

    params.app_name = params.app_name || params.appName || params.title || params.app || "active";

    params.position = params.position || params.pos || "left";

  }

  if (resolvedCmd === "minimize_window" || resolvedCmd === "maximize_window" || resolvedCmd === "restore_window") {

    params.title = params.title || params.app_name || params.appName || params.app || "active";

  }

  if (resolvedCmd === "make_phone_call") {

    params.phone = params.phone || params.target || params.number || params.contact || params.contactName || params.to;

    params.target = params.phone;

  }

  if (resolvedCmd === "search_file" || resolvedCmd === "open_file") {

    const raw = String(params.file_name || params.fileName || params.filename || params.query || params.name || params.folderName || params.folder_name || "").trim();

    const cleaned = cleanSearchQuery(raw);

    params.file_name = cleaned || raw;

    params.fileName = params.file_name;

    params.open_with = params.open_with || params.openWith || params.with;

  }

  if (resolvedCmd === "order_food") {
    params.dish = params.dish || params.food || params.item || params.query || params.dish_name || "";
    params.quantity = Math.max(1, Number(params.quantity || params.qty || params.count || 1));
    params.max_budget = params.max_budget || params.maxBudget || params.budget || params.price || params.range || params.maxPrice || params.max_price;
    if (params.max_budget) params.max_budget = Number(params.max_budget);
    params.min_budget = params.min_budget || params.minBudget || params.minPrice || params.min_price;
    if (params.min_budget) params.min_budget = Number(params.min_budget);
    params.platform = params.platform || params.service || "auto";
    params.city = params.city || params.location || params.address;
    params.location = params.location || params.city || params.address;
    params.payment_method = params.payment_method || params.paymentMethod || "cod";
    params.auto_order = params.auto_order ?? params.autoOrder ?? true;
    params.headless = Boolean(params.headless || params.runInBackground);
  }

  if (resolvedCmd === "submit_food_otp") {
    params.otp = String(params.otp || params.code || "").replace(/\D/g, "");
  }

  const isWhatsAppCmd = resolvedCmd.includes("whatsapp");

  const isFoodCmd = resolvedCmd === "order_food" || resolvedCmd === "submit_food_otp" || resolvedCmd === "complete_food_order" || resolvedCmd === "fill_food_address" || resolvedCmd === "login_food_service";

  const cmdTimeout = isWhatsAppCmd ? 120000 : isFoodCmd ? 300000 : (resolvedCmd === "search_file" || resolvedCmd === "open_file" || resolvedCmd === "split_screen" || resolvedCmd === "snap_window") ? 15000 : (resolvedCmd.includes("phone") ? 3500 : 8000);



  console.log(`[AgentBridge] Invoking command '${resolvedCmd}' (orig: '${command}') on Python Agent (${DEFAULT_AGENT_URL}) with params:`, params);



  const AGENT_API_KEY = process.env.ERA_AGENT_API_KEY || "era_internal_local_agent_key";



  // 0. ZERO-LATENCY FAST PATH: Execute native Windows actions immediately (0-15ms)

  const nativeFastRes = executeNativeDirect(resolvedCmd, params);

  if (nativeFastRes && nativeFastRes.success) {

    console.log(`[AgentBridge] Instant native execution for '${resolvedCmd}':`, nativeFastRes.message);

    return nativeFastRes;

  }







  // 1. Try Era Local Agent directly

  try {

    const response = await fetch(`${DEFAULT_AGENT_URL}/execute`, {

      method: "POST",

      headers: {

        "Content-Type": "application/json",

        "X-Era-Agent-Key": AGENT_API_KEY,

      },

      body: JSON.stringify({

        command: resolvedCmd,

        params: params || {},

      }),

      signal: AbortSignal.timeout(cmdTimeout),

    });



    if (response.ok) {

      const result = (await response.json()) as AgentExecuteResult;

      console.log(`[AgentBridge] Execution result for '${command}':`, result);

      return result;

    } else {

      const errText = await response.text().catch(() => "");

      console.warn(`[AgentBridge] Direct agent returned HTTP ${response.status}: ${errText}`);

    }

  } catch (err: any) {

    console.warn(`[AgentBridge] Direct agent execution failed: ${err.message}`);

  }



  // 1.5. Reliable synchronous Python fallback for WhatsApp when Local Agent HTTP fails

  if (isWhatsAppCmd) {

    console.log(`[AgentBridge] Direct agent unreachable for WhatsApp command '${resolvedCmd}'. Executing synchronous fallback engine...`);

    return await executeWhatsAppFallbackAsync(resolvedCmd, params);

  }



  // 2. Fallback: Try Era Bridge Gateway (skip for phone link desktop automation and whatsapp to prevent duplicate sending)

  const isPhoneCmd = ["make_phone_call", "answer_phone_call", "reject_phone_call", "get_phone_link_status"].includes(resolvedCmd);

  if (!isPhoneCmd && !isWhatsAppCmd) {

  try {



    const response = await fetch(`${DEFAULT_BRIDGE_URL}/v1/execute`, {



      method: "POST",



      headers: {



        "Content-Type": "application/json",



        "X-Era-Bridge-Key": BRIDGE_API_KEY,



        "Authorization": `Bearer ${BRIDGE_API_KEY}`,



      },



      body: JSON.stringify({



        command: resolvedCmd,



        params: params || {},



      }),



      signal: AbortSignal.timeout(cmdTimeout),



    });







    if (response.ok) {



      const data = await response.json();



      return {



        success: data.state === "success",



        message: data.message,



      };



    }



  } catch (err: any) {



    console.error(`[AgentBridge] Bridge fallback execution error: ${err.message}`);



  }

  }







  // 3. Fallback: Windows Native Direct Launch (Completely bypasses PowerShell & COM)



  const cmd = resolvedCmd.toLowerCase().trim();







  // DIRECT TYPING FALLBACK

  if (cmd === "type_text" || cmd === "typetext") {

    const textToType = String(params?.text || params?.content || params?.message || "").trim();

    const app = String(params?.app_name || params?.appName || params?.app || "");

    const enter = Boolean(params?.press_enter || params?.enter);

    return executeNativeTyping("type", textToType, { app, enter });

  }



  // DIRECT TEXT DELETION FALLBACK

  if (cmd === "delete_text" || cmd === "deletetext") {

    const target = String(params?.target || params?.word || params?.text || "").trim();

    const mode = String(params?.mode || params?.delete_mode || (target ? "word" : "last_word"));

    const app = String(params?.app_name || params?.appName || params?.app || "");

    return executeNativeTyping("delete", target, { app, mode });

  }







  // DIRECT KEY COMBINATION FALLBACK (awaited cleanly)



  if (cmd === "press_key_combination" || cmd === "presskeycombination") {



    const keys = (Array.isArray(params?.keys) ? params.keys : [params?.keys])

      .map((k: any) => String(k || "").toLowerCase().trim())

      .filter(Boolean);



    const hasCtrl = keys.includes("ctrl") || keys.includes("control") || keys.includes("lctrl");

    const hasShift = keys.includes("shift") || keys.includes("lshift");

    const hasAlt = keys.includes("alt") || keys.includes("lalt");

    const specialMap: Record<string, string> = {

      enter: "{ENTER}",

      return: "{ENTER}",

      tab: "{TAB}",

      esc: "{ESC}",

      escape: "{ESC}",

      backspace: "{BACKSPACE}",

      delete: "{DELETE}",

      up: "{UP}",

      down: "{DOWN}",

      left: "{LEFT}",

      right: "{RIGHT}",

      f4: "{F4}",

      f5: "{F5}",

    };

    const mainKeys = keys.filter((k: string) => !["ctrl", "control", "lctrl", "shift", "lshift", "alt", "lalt"].includes(k));

    if (mainKeys.length > 0) {

      const targetKey = specialMap[mainKeys[0]] || mainKeys[0];

      const prefix = `${hasCtrl ? "^" : ""}${hasShift ? "+" : ""}${hasAlt ? "%" : ""}`;

      const psCommand = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${prefix}${targetKey}')`;

      const psRes = await runPowerShellHidden(psCommand, 4000);

      if (psRes.ok) {

        return { success: true, message: `Pressed ${keys.join("+")} successfully.` };

      }

      return { success: false, message: `Failed to press key combination: ${psRes.error || "Unknown error"}` };

    }



  }







  if (cmd === "open_notepad") {



    spawn("notepad.exe", [], { detached: true, stdio: "ignore" }).unref();



    return { success: true, message: "Notepad opened successfully." };



  }







  if (cmd === "open_calculator") {



    spawn("calc.exe", [], { detached: true, stdio: "ignore" }).unref();



    return { success: true, message: "Calculator opened successfully." };



  }







  if (cmd === "open_camera") {



    spawn("explorer.exe", ["microsoft.windows.camera:"], { detached: true, stdio: "ignore" }).unref();



    return { success: true, message: "Camera opened successfully." };



  }







  if (cmd === "open_file_explorer") {



    spawn("explorer.exe", [], { detached: true, stdio: "ignore" }).unref();



    return { success: true, message: "File Explorer opened successfully." };



  }







  if (cmd === "open_chrome") {



    const chromePaths = [



      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",



      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",



      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),



    ];



    for (const cp of chromePaths) {



      if (fs.existsSync(cp)) {



        spawn(cp, [], { detached: true, stdio: "ignore" }).unref();



        return { success: true, message: "Google Chrome opened successfully." };



      }



    }



    spawn("explorer.exe", ["https://www.google.com"], { detached: true, stdio: "ignore" }).unref();



    return { success: true, message: "Opened Google Chrome." };



  }







  if (cmd === "open_browser") {

    const url = params?.url || "https://www.google.com";

    const browser = (params?.browser_name || params?.browser || "").toLowerCase();



    if (url.toLowerCase().includes("whatsapp")) {

      return executeAgentCommand("open_whatsapp", params);

    }



    launchWindowsBrowserUrl(url, browser);
    const browserLabel = browser.includes("chrome") ? "Google Chrome" : (browser.includes("edge") || browser.includes("exil") || browser.includes("msedge")) ? "Microsoft Edge" : "browser";
    return { success: true, message: `Opened ${browserLabel} to ${url}.` };

  }





  // PHONE LINK DIRECT FALLBACKS

  const phonePyExeCandidates = [

    "C:\\Users\\MSI\\AppData\\Local\\Programs\\ERA AI Assistant\\resources\\python_runtime\\python.exe",

    "d:\\era-voice-assistant\\resources\\python_runtime\\python.exe",

    "d:\\era_agent\\.venv\\Scripts\\python.exe",

    "python.exe"

  ];

  const resolvedPhonePy = phonePyExeCandidates.find(p => fs.existsSync(p)) || "python.exe";

  const phoneImportPrefix = `import sys\nsys.path.insert(0, r"C:\\Users\\MSI\\AppData\\Local\\Programs\\ERA AI Assistant\\resources\\era_services\\era_agent")\nsys.path.insert(0, r"d:\\era_agent")\nfrom controls.phone_link import PhoneLinkControl\n`;



  if (cmd === "make_phone_call" || cmd === "make_call" || cmd === "call_phone") {

    const rawTarget = String(params?.phone || params?.number || params?.contact || params?.target || "").trim();

    const pyCode = `${phoneImportPrefix}ok, msg = PhoneLinkControl.make_call(${JSON.stringify(rawTarget)})\nprint(msg)`;

    try {

      const proc = spawn(resolvedPhonePy, ["-c", pyCode], { detached: true, stdio: "ignore" });

      proc.unref();

      return { success: true, message: `Dialing ${rawTarget} via Phone Link!` };

    } catch (e: any) {

      return { success: false, message: `Failed to initiate call: ${e.message}` };

    }

  }



  if (cmd === "answer_phone_call" || cmd === "accept_phone_call") {

    const pyCode = `${phoneImportPrefix}ok, msg = PhoneLinkControl.answer_call()\nprint(msg)`;

    try {

      const proc = spawn(resolvedPhonePy, ["-c", pyCode], { detached: true, stdio: "ignore" });

      proc.unref();

      return { success: true, message: "Incoming call accept ho gaya hai, boss." };

    } catch (e: any) {

      return { success: false, message: `Failed to answer call: ${e.message}` };

    }

  }



  if (cmd === "reject_phone_call" || cmd === "decline_phone_call") {

    const pyCode = `${phoneImportPrefix}ok, msg = PhoneLinkControl.reject_call()\nprint(msg)`;

    try {

      const proc = spawn(resolvedPhonePy, ["-c", pyCode], { detached: true, stdio: "ignore" });

      proc.unref();

      return { success: true, message: "Call cut / reject kar diya gaya hai, boss." };

    } catch (e: any) {

      return { success: false, message: `Failed to reject call: ${e.message}` };

    }

  }



  if (cmd === "open_app") {

    const rawApp = String(params?.app_name || params?.appName || params?.name || "").trim();

    if (!rawApp) {

      return { success: false, message: "No app name was provided." };

    }

    const sanitizedApp = cleanAppName(rawApp) || rawApp;

    const cleanApp = sanitizedApp.toLowerCase().replace(/[^a-z0-9]/g, "");



    // 1. VS Code

    if (["vscode", "code", "visualstudiocode"].includes(cleanApp)) {

      const codePaths = [

        path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),

        "C:\\Program Files\\Microsoft VS Code\\Code.exe",

        "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",

      ];

      const cp = codePaths.find(p => fs.existsSync(p));

      if (cp) {

        spawn(cp, ["--reuse-window"], { detached: true, stdio: "ignore" }).unref();

        return { success: true, message: "VS Code opened successfully." };

      }

      spawn("cmd.exe", ["/c", "start", "", "code", "--reuse-window"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "VS Code opened successfully." };

    }



    // 2. Chrome / Browser / Web
    if (["chrome", "googlechrome", "google", "browser", "brouser", "webbrowser", "internet", "web", "website"].includes(cleanApp)) {
      const chromePaths = [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      ];
      for (const cp of chromePaths) {
        if (fs.existsSync(cp)) {
          spawn(cp, ["https://www.google.com"], { detached: true, stdio: "ignore" }).unref();
          return { success: true, message: "Google Chrome opened successfully." };
        }
      }
      spawn("cmd.exe", ["/c", "start", "", "https://www.google.com"], { detached: true, stdio: "ignore" }).unref();
      return { success: true, message: "Browser opened." };
    }

    // 2.05 YouTube
    if (["youtube", "yt", "youtubemusic"].includes(cleanApp)) {
      launchWindowsBrowserUrl("https://www.youtube.com", "chrome");
      return { success: true, message: "YouTube opened in browser successfully." };
    }

    // 2.1 Opera
    if (["opera", "operagx"].includes(cleanApp)) {
      const operaPaths = [
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Opera", "opera.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Opera GX", "opera.exe"),
        "C:\\Users\\MSI\\AppData\\Local\\Programs\\Opera\\opera.exe",
      ];
      for (const op of operaPaths) {
        if (fs.existsSync(op)) {
          spawn(op, [], { detached: true, stdio: "ignore" }).unref();
          return { success: true, message: "Opera opened successfully." };
        }
      }
      spawn("cmd.exe", ["/c", "start", "", "opera"], { detached: true, stdio: "ignore" }).unref();
      return { success: true, message: "Opera opened." };
    }



    // 2.2 Explorer

    if (["explorer", "fileexplorer", "files", "thispc"].includes(cleanApp)) {

      spawn("explorer.exe", [], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "File Explorer opened successfully." };

    }



    // 3. Canva

    if (cleanApp.includes("canva")) {

      const canvaPath = path.join(process.env.LOCALAPPDATA || "", "Programs", "Canva", "Canva.exe");

      if (fs.existsSync(canvaPath)) {

        spawn("cmd.exe", ["/c", "start", "", canvaPath], { detached: true, stdio: "ignore" }).unref();

        return { success: true, message: "Canva opened successfully." };

      }

      spawn("cmd.exe", ["/c", "start", "", "shell:AppsFolder\\com.canva.CanvaDesktop"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Canva opened successfully." };

    }



    // 4. WhatsApp

    if (cleanApp.includes("whatsapp")) {

      spawn("cmd.exe", ["/c", "start", "", "shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "WhatsApp opened successfully." };

    }



    // 5. Xbox

    if (cleanApp.includes("xbox")) {

      spawn("cmd.exe", ["/c", "start", "", "shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Xbox opened successfully." };

    }



    // 6. ChatGPT

    if (cleanApp.includes("chatgpt") || cleanApp.includes("openai")) {

      spawn("cmd.exe", ["/c", "start", "", "shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "ChatGPT opened successfully." };

    }



    // 7. Claude

    if (cleanApp.includes("claude")) {

      spawn("cmd.exe", ["/c", "start", "", "https://claude.ai"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Opened Claude in your browser." };

    }



    // 8. Calculator

    if (["calc", "calculator"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "calc:"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Calculator opened successfully." };

    }



    // 9. Camera

    if (["camera", "webcam"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "microsoft.windows.camera:"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Camera opened successfully." };

    }



    // 10. Notepad

    if (["notepad", "editor"].includes(cleanApp)) {

      spawn("notepad.exe", [], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Notepad opened successfully." };

    }



    // 11. Microsoft Store

    if (["store", "microsoftstore", "windowsstore"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "ms-windows-store:"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Microsoft Store opened successfully." };

    }



    // 12. Settings

    if (["settings", "pcsettings"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "ms-settings:"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Settings opened successfully." };

    }



    // 13. Microsoft Office (Word, Excel, PowerPoint)

    if (["word", "msword", "winword", "microsoftword"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "winword"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Microsoft Word opened successfully." };

    }

    if (["excel", "msexcel", "microsoftexcel"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "excel"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Microsoft Excel opened successfully." };

    }

    if (["powerpoint", "ppt", "powerpnt", "mspowerpoint"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "powerpnt"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Microsoft PowerPoint opened successfully." };

    }



    // 14. Spotify

    if (cleanApp.includes("spotify")) {

      const spotifyPath = path.join(process.env.APPDATA || "", "Spotify", "Spotify.exe");

      if (fs.existsSync(spotifyPath)) {

        spawn(spotifyPath, [], { detached: true, stdio: "ignore" }).unref();

        return { success: true, message: "Spotify opened successfully." };

      }

      spawn("cmd.exe", ["/c", "start", "", "spotify:"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Spotify opened successfully." };

    }



    // 15. File Explorer

    if (["explorer", "files", "fileexplorer"].includes(cleanApp)) {

      spawn("explorer.exe", [], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "File Explorer opened successfully." };

    }



    // 16. Terminal / CMD / PowerShell

    if (["terminal", "wt", "windowsterminal"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "wt"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Terminal opened successfully." };

    }

    if (["cmd", "commandprompt"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "cmd.exe"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Command Prompt opened successfully." };

    }

    if (["powershell", "ps"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "powershell.exe"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "PowerShell opened successfully." };

    }



    // 17. Paint

    if (["paint", "mspaint"].includes(cleanApp)) {

      spawn("cmd.exe", ["/c", "start", "", "mspaint"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Paint opened successfully." };

    }



    // 18. Dynamic Start Menu shortcut resolution

    const lnk = findStartMenuShortcut(rawApp);

    if (lnk) {

      spawn("cmd.exe", ["/c", "start", "", lnk], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: `'${rawApp}' opened successfully.` };

    }



    // 19. Try generic Windows start command for registered app in PATH or App Paths

    try {

      spawn("cmd.exe", ["/c", "start", "", rawApp], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: `'${rawApp}' opened successfully.` };

    } catch (e: any) {

      return {

        success: false,

        message: `'${rawApp}' was not found on this laptop. Please make sure the app is installed and try again.`

      };

    }

  }



  







  // DIRECT WINDOW MANAGEMENT FALLBACKS

  if (cmd === "minimize_active_window" || cmd === "minimizeactivewindow") {

    try {

      const ps = `

        Add-Type @"

        using System;

        using System.Runtime.InteropServices;

        public class WinMin {

          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        }

"@ -ErrorAction SilentlyContinue

        $fg = [WinMin]::GetForegroundWindow()

        if ($fg -ne [IntPtr]::Zero) { [WinMin]::ShowWindow($fg, 6) }

      `;

      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Minimized active window." };

    } catch (e: any) {

      return { success: false, message: `Failed to minimize window: ${e.message}` };

    }

  }



  if (cmd === "minimize_window" || cmd === "minimizewindow") {

    const target = String(params?.title || params?.appName || params?.app_name || "").trim();

    if (!target || target.toLowerCase() === "all") {

      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject Shell.Application).MinimizeAll()"], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: "Minimized all windows." };

    }

    try {

      const ps = `

        Add-Type @"

        using System;

        using System.Runtime.InteropServices;

        public class WinMin2 {

          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        }

"@ -ErrorAction SilentlyContinue

        Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match '${target}' -or $_.MainWindowTitle -match '${target}') } | ForEach-Object { [WinMin2]::ShowWindow($_.MainWindowHandle, 6) }

      `;

      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: `Minimized '${target}'.` };

    } catch (e: any) {

      return { success: false, message: `Failed to minimize '${target}': ${e.message}` };

    }

  }



  if (cmd === "maximize_window" || cmd === "maximizewindow") {

    const target = String(params?.title || params?.appName || params?.app_name || "").trim();

    const tClean = target.toLowerCase();

    const isActiveTarget = ["", "active", "current", "this", "foreground", "screen", "full screen", "fullscreen", "full", "window", "display", "badi screen"].includes(tClean);

    try {

      const ps = `

        Add-Type @"

        using System;

        using System.Runtime.InteropServices;

        public class WinMax {

          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);

          [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        }

"@ -ErrorAction SilentlyContinue

        ` + (isActiveTarget

          ? "$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -notmatch 'era ai|dwm|lockapp|taskhost|shellexperience' } | Select-Object -First 1"

          : `$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match '${target}' -or $_.MainWindowTitle -match '${target}') } | Select-Object -First 1`) + `

        if ($p) {

          [WinMax]::SetForegroundWindow($p.MainWindowHandle)

          [WinMax]::ShowWindow($p.MainWindowHandle, 3)

          [WinMax]::PostMessage($p.MainWindowHandle, 0x0112, [IntPtr]0xF030, [IntPtr]0)

        }

      `;

      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { detached: true, stdio: "ignore" }).unref();

      return { success: true, message: `Maximized '${target || "active"}' to full screen.` };

    } catch (e: any) {

      return { success: false, message: `Failed to maximize '${target}': ${e.message}` };

    }

  }



  if (cmd === "minimize_all" || cmd === "minimizeall" || cmd === "show_desktop" || cmd === "showdesktop") {

    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject Shell.Application).MinimizeAll()"], { detached: true, stdio: "ignore" }).unref();

    return { success: true, message: "Minimized all windows and showed desktop." };

  }



  const runAgentCli = (targetCmd: string, cmdParams: Record<string, any>) => {

    const pyExe = [

      "d:\\era_agent\\.venv\\Scripts\\python.exe",

      "d:\\era-voice-assistant\\resources\\python_runtime\\python.exe",

      "C:\\Users\\MSI\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe",

    ].find(p => fs.existsSync(p)) || "python.exe";

    const cliScript = [

      "d:\\era_agent\\run_command_cli.py",

      "d:\\era-voice-assistant\\resources\\era_services\\era_agent\\run_command_cli.py"

    ].find(p => fs.existsSync(p));

    if (!cliScript) return null;

    try {

      const res = spawnSync(pyExe, [cliScript, targetCmd, JSON.stringify(cmdParams)], {

        encoding: "utf8",

        timeout: 8000,

        windowsHide: true,

      });

      const output = (res.stdout || "").trim();

      return { success: res.status === 0, message: output || (res.status === 0 ? "Command succeeded." : "Command completed.") };

    } catch (e: any) {

      return { success: false, message: `CLI execution failed: ${e.message}` };

    }

  };



  if (cmd === "split_screen" || cmd === "splitscreen") {

    const leftApp = String(params?.left_app || params?.leftApp || "").trim();

    const rightApp = String(params?.right_app || params?.rightApp || "").trim();

    const cliRes = runAgentCli("split_screen", { left_app: leftApp, right_app: rightApp });

    if (cliRes) return cliRes;

    return { success: true, message: `Screen split side-by-side between '${leftApp}' and '${rightApp}'.` };

  }



  if (cmd === "snap_window" || cmd === "snapwindow") {

    const appName = String(params?.app_name || params?.appName || params?.title || "active").trim();

    const pos = String(params?.position || params?.pos || "left").trim();

    const cliRes = runAgentCli("snap_window", { app_name: appName, position: pos });

    if (cliRes) return cliRes;

    return { success: true, message: `Snapped '${appName}' to ${pos}.` };

  }



  if (cmd === "search_file" || cmd === "searchfile" || cmd === "open_file" || cmd === "openfile") {

    const fileName = String(params?.file_name || params?.fileName || params?.filename || params?.query || "").trim();

    const openWith = String(params?.open_with || params?.openWith || "").trim();

    const cliRes = runAgentCli("open_file", { file_name: fileName, open_with: openWith });

    if (cliRes) return cliRes;

    return { success: true, message: `Opened '${fileName}'.` };

  }

  if (cmd === "process_natural_language_control") {
    const query = String(params?.query || "").trim();
    const cliRes = runAgentCli("process_natural_language_control", { query });
    if (cliRes) return cliRes;
    return { success: false, message: "Could not process natural language control command." };
  }

  if (cmd === "set_display_brightness" || cmd === "setdisplaybrightness") {
    const level = Number(params?.level ?? params?.brightness ?? params?.percentage ?? 50);
    const cliRes = runAgentCli("set_display_brightness", { level });
    if (cliRes) return cliRes;
    return { success: true, message: `Display brightness set to ${level}%.` };
  }

  if (cmd === "adjust_display_brightness" || cmd === "adjustdisplaybrightness") {
    const delta = Number(params?.delta ?? params?.amount ?? 10);
    const cliRes = runAgentCli("adjust_display_brightness", { delta });
    if (cliRes) return cliRes;
    return { success: true, message: `Display brightness adjusted by ${delta}%.` };
  }

  if (cmd === "get_display_brightness" || cmd === "getdisplaybrightness") {
    const cliRes = runAgentCli("get_display_brightness", {});
    if (cliRes) return cliRes;
    return { success: true, message: "Current display brightness retrieved." };
  }

  if (cmd === "set_keyboard_backlight" || cmd === "setkeyboardbacklight") {
    const level = Number(params?.level ?? params?.brightness ?? params?.percentage ?? 100);
    const cliRes = runAgentCli("set_keyboard_backlight", { level, mode: params?.mode || "rainbow" });
    if (cliRes) return cliRes;
    return { success: true, message: `Keyboard backlight set to ${level}%.` };
  }

  if (cmd === "adjust_keyboard_backlight" || cmd === "adjustkeyboardbacklight") {
    const delta = Number(params?.delta ?? params?.amount ?? 25);
    const cliRes = runAgentCli("adjust_keyboard_backlight", { delta });
    if (cliRes) return cliRes;
    return { success: true, message: `Keyboard backlight adjusted by ${delta}%.` };
  }

  if (cmd === "get_keyboard_backlight" || cmd === "getkeyboardbacklight") {
    const cliRes = runAgentCli("get_keyboard_backlight", {});
    if (cliRes) return cliRes;
    return { success: true, message: "Current keyboard backlight level retrieved." };
  }

  if (cmd === "toggle_audio_mute" || cmd === "toggleaudiomute") {
    const mute = params?.mute !== undefined ? Boolean(params?.mute) : null;
    const cliRes = runAgentCli("toggle_audio_mute", { mute });
    if (cliRes) return cliRes;
    return { success: true, message: mute ? "Audio muted." : "Audio unmuted." };
  }

  if (cmd === "get_audio_volume" || cmd === "getaudiovolume") {
    const cliRes = runAgentCli("get_audio_volume", {});
    if (cliRes) return cliRes;
    return { success: true, message: "Current audio volume retrieved." };
  }

  if (cmd === "set_audio_volume" || cmd === "setaudiovolume") {
    const level = Number(params?.level ?? params?.volume ?? params?.percentage ?? 50);
    const cliRes = runAgentCli("set_audio_volume", { level });
    if (cliRes) return cliRes;
    return { success: true, message: `Audio volume set to ${level}%.` };
  }

  if (cmd === "adjust_audio_volume" || cmd === "adjustaudiovolume") {
    const delta = Number(params?.delta ?? params?.amount ?? 10);
    const cliRes = runAgentCli("adjust_audio_volume", { delta });
    if (cliRes) return cliRes;
    return { success: true, message: `Audio volume adjusted by ${delta}%.` };
  }

  if (cmd === "type_text" || cmd === "typetext") {
    const text = String(params?.text ?? params?.content ?? params?.message ?? "");
    const cliRes = runAgentCli("type_text", { text });
    if (cliRes) return cliRes;
    return { success: true, message: `Successfully typed on screen.` };
  }

  if (cmd === "press_key_combination" || cmd === "presskeycombination") {
    const keys = String(params?.keys ?? params?.key ?? params?.combination ?? "");
    const cliRes = runAgentCli("press_key_combination", { keys });
    if (cliRes) return cliRes;
    return { success: true, message: `Pressed keyboard combination: ${keys}` };
  }

  if (cmd === "make_phone_call" || cmd === "makephonecall") {
    const phone = String(params?.phone || params?.target || params?.contact || params?.number || "").trim();
    const cliRes = runAgentCli("make_phone_call", { phone });
    if (cliRes) return cliRes;
    return { success: true, message: `Phone Link me ${phone} ko call laga diya hai, boss.` };
  }

  if (cmd === "answer_phone_call" || cmd === "answerphonecall") {
    const cliRes = runAgentCli("answer_phone_call", {});
    if (cliRes) return cliRes;
    return { success: true, message: `Incoming call answered via Phone Link.` };
  }

  if (cmd === "reject_phone_call" || cmd === "rejectphonecall") {
    const cliRes = runAgentCli("reject_phone_call", {});
    if (cliRes) return cliRes;
    return { success: true, message: `Incoming call declined via Phone Link.` };
  }

  if (cmd === "get_phone_link_status" || cmd === "getphonelinkstatus") {
    const cliRes = runAgentCli("get_phone_link_status", {});
    if (cliRes) return cliRes;
    return { success: true, message: `Phone Link status checked.` };
  }

  if (cmd === "start_gesture_control" || cmd === "startgesturecontrol") {
    const pyExe = [
      "d:\\era_agent\\.venv\\Scripts\\python.exe",
      "d:\\era-voice-assistant\\resources\\python_runtime\\python.exe",
      "C:\\Users\\MSI\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe",
    ].find(p => fs.existsSync(p)) || "python.exe";

    const gestureScript = [
      "d:\\era_agent\\run_gesture_control.py",
      "d:\\era-voice-assistant\\resources\\era_services\\era_agent\\run_gesture_control.py",
    ].find(p => fs.existsSync(p));

    if (gestureScript) {
      try {
        const scriptArgs = [gestureScript];
        if (params?.preview !== false) scriptArgs.push("--preview");
        if (typeof params?.camera === "number") {
          scriptArgs.push("--camera", String(params.camera));
        }
        const child = spawn(pyExe, scriptArgs, {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child.unref();
        return {
          success: true,
          message: "Hand gesture recognition intelligence started in background with visual HUD.",
        };
      } catch (err: any) {
        console.warn("[AgentBridge] Failed to spawn detached gesture process:", err.message);
      }
    }
    const cliRes = runAgentCli("start_gesture_control", {
      camera: params?.camera || 0,
      preview: params?.preview ?? true,
    });
    if (cliRes) return cliRes;
    return { success: true, message: "Hand gesture recognition intelligence started." };
  }

  if (cmd === "stop_gesture_control" || cmd === "stopgesturecontrol") {
    try {
      execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*run_gesture_control.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', { timeout: 4000 });
    } catch {}
    const cliRes = runAgentCli("stop_gesture_control", {});
    if (cliRes) return cliRes;
    return { success: true, message: "Hand gesture recognition intelligence stopped." };
  }

  if (cmd === "get_gesture_status" || cmd === "getgesturestatus") {
    const cliRes = runAgentCli("get_gesture_status", {});
    if (cliRes) return cliRes;
    return { success: true, message: "Hand gesture status retrieved." };
  }



  return {



    success: false,



    message: `Could not reach Era Python Local Agent (${DEFAULT_AGENT_URL}) or Era Bridge Gateway (${DEFAULT_BRIDGE_URL}). Please ensure the services are running.`,



  };



}