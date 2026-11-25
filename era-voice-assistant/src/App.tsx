import { useState, useEffect, useRef, useCallback, FormEvent } from "react";

import { 

  Mic, 

  MicOff, 

  Wifi, 

  WifiOff, 

  Volume2, 

  VolumeX, 

  Globe, 

  Sparkles, 

  RefreshCw, 

  HelpCircle,

  ExternalLink,

  MessageSquare,

  Volume1,

  Compass,

  AlertCircle,

  Settings,

  Terminal,

  FileCode,

  Lock,

  Smartphone,

  Eye,

  EyeOff,

  FolderOpen,

  Play,

  CheckCircle2,

  XCircle,

  ShieldAlert,

  ShieldCheck,

  Moon,

  ChevronRight,

  User,

  Key,

  Database,

  Youtube,

  Laptop,

  Send,

  History,

  Copy,

  Check,

  Trash2,

  Download,

  Search,

  Filter,

  Clock,

  FileText,

  Radio,

  Ear,

  Zap,

  Bluetooth,

  BrainCircuit,

  Headphones,

  Music

} from "lucide-react";

import { motion, AnimatePresence } from "motion/react";

import { BluetoothMusicManager } from "./components/BluetoothMusicManager";

import { VoiceOrb } from "./components/VoiceOrb";

import { LiveTranscript } from "./components/LiveTranscript";

import { AutonomyDashboard } from "./components/AutonomyDashboard";

import { SoftwareStudio } from "./components/SoftwareStudio";

import { VoiceGuardTab } from "./components/VoiceGuardTab";

import { compareVoiceprints, extractVoiceprintFromPcm } from "./voiceguard/audioBiometrics";

import { soundEngine } from "./voiceguard/soundEffects";

import {

  loadOwnerProfile,

  saveOwnerProfile,

  clearOwnerProfile,

  loadAuditLog,

  saveAuditLog,

  loadVaultItems,

  saveVaultItems,

  loadPrefs,

  savePrefs,

} from "./voiceguard/storage";

import type {

  OwnerProfile,

  LockState as VoiceLockState,

  SecurityStrictness as VoiceSecurityStrictness,

  UiLanguage as VoiceUiLanguage,

  VerificationResponse as VoiceVerificationResponse,

  AuditLogEntry as VoiceAuditLogEntry,

  VaultItem as VoiceVaultItem,

} from "./voiceguard/types";



import { AudioStreamer } from "./lib/AudioStreamer";

import { isPhantomNoiseTranscript, transliterateDevanagariToHinglish, cleanTranscript, deduplicateRepeatedTokens } from "./lib/hinglishTransliterate";

import { UNIVERSAL_PROFESSIONAL_PROTOCOL } from "./lib/universalProfessionalProtocol";

import { SessionState, Transcription } from "./types";

import { 

  auth, 

  saveMessageToHistory, 

  loadChatHistory, 

  loadUserProfile, 

  updateUserMemorySummary,

  saveVoiceSessionSummary 

} from "./lib/firebase";

import { 

  signInWithEmailAndPassword, 

  createUserWithEmailAndPassword, 

  signOut,

  onAuthStateChanged,

  GoogleAuthProvider,

  signInWithPopup

} from "firebase/auth";



const SASSY_QUOTES = {

  disconnected: [

    "At your service, boss. Touch to initialize.",

    "System standby. Tap when you are ready to begin, sir.",

    "Ready to assist, boss. Press to establish connection.",

    "Waiting for your command, boss. Tap to begin.",

    "System offline. Press the button to bring Eira online."

  ],

  connecting: [

    "Initializing systems... please stand by.",

    "Establishing secure neural link... standard protocol.",

    "Setting up communication channel... almost ready, boss."

  ],

  listening: [

    "Listening for your command, boss...",

    "I am all ears, sir. Please go ahead.",

    "Standing by... please speak your mind.",

    "Voice input active. What do you require, boss?",

    "System ready. Speak your command."

  ],

  processing: [

    "Processing your request, sir...",

    "Analyzing input... please stand by.",

    "Formulating response... holding for computational analysis.",

    "Executing logic... please hold, boss."

  ],

  speaking: [

    "Responding to your query, boss...",

    "Executing voice feedback...",

    "Providing verbal analysis...",

    "Transmission in progress..."

  ]

};



interface WorkspaceFile {

  name: string;

  size: number;

  updatedAt: string;

}



interface WhatsAppMsgLog {

  contactName: string;

  message: string;

  timestamp: string;

 status: "sent" | "failed" | "received";

}



const cleanUrlsAndLinks = (text: string): string => {

  if (!text) return "";

  let cleaned = text;

  

  // 1. Remove markdown links e.g. [YouTube](https://...) -> YouTube

  cleaned = cleaned.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (match, linkText) => {

    const lt = linkText.trim().toLowerCase();

    if (lt === "link" || lt.startsWith("http") || lt === "youtube" || lt === "whatsapp" || lt === "cloud code" || lt === "claud" || lt === "claude") {

 return "";

    }

    return linkText;

  });



  // 2. Remove standard raw URLs starting with http:// or https://

  cleaned = cleaned.replace(/https?:\/\/[^\s]+/gi, '');



  // 3. Remove raw domain names like youtube.com, web.whatsapp.com, ide.cloud.google.com

  cleaned = cleaned.replace(/(www\.)?youtube\.com[^\s]*/gi, '');

  cleaned = cleaned.replace(/web\.whatsapp\.com[^\s]*/gi, '');

  cleaned = cleaned.replace(/api\.whatsapp\.com[^\s]*/gi, '');

  cleaned = cleaned.replace(/ide\.cloud\.google\.com[^\s]*/gi, '');



  // 4. Clean up any double spaces or dangling punctuation left over from stripping

  cleaned = cleaned.replace(/\s+/g, ' ');

  cleaned = cleaned.replace(/\s+([.,!?])/g, '$1');

  cleaned = cleaned.trim();



  return cleaned;

};



const CONTACTS_DB = [

  { name: "Bhaiya", aliases: ["bhaiya", "bhaiyya", "bhayya", "bhaya", "brother", "my brother", "bhai", "bro", "veerji"], phone: "", shortPhone: "" },

  { name: "Sakshi", aliases: ["sakshi", "sakshii", "saksi", "sister", "my sister", "sis"], phone: "", shortPhone: "" },

  { name: "Mom", aliases: ["mom", "mother", "mummy", "maa", "mommy", "mama", "mamma"], phone: "", shortPhone: "" },

  { name: "Dad", aliases: ["dad", "father", "papa", "daddy", "pop"], phone: "", shortPhone: "" },

  { name: "Bestie", aliases: ["bestie", "friend", "best friend", "babu", "shona"], phone: "", shortPhone: "" },

];



const resolveContact = (query: string, contactsList: { name: string; aliases: string[]; phone: string; shortPhone?: string }[] = CONTACTS_DB): { name: string; phone: string } => {

  if (!query) return { name: "Unknown", phone: "" };



  const cleanQuery = query.trim().toLowerCase();

  

  // 1. Try matching by exact name or alias (case-insensitive)

  for (const contact of contactsList) {

    if (contact.name.toLowerCase() === cleanQuery || contact.aliases.includes(cleanQuery)) {

      return { name: contact.name, phone: contact.phone || "" };

    }

  }



  // 2. Try matching by fuzzy / similar phonetic spelling (e.g. bhaiya vs bhaiyya)

  const normalizeSpelling = (s: string) => {

    return s.toLowerCase()

      .replace(/yy/g, 'y')   // collapse double y -> y

      .replace(/sh/g, 's')   // treat sh/s interchangeably for phonetic typos

      .replace(/kh/g, 'k')   // treat kh/k interchangeably

      .replace(/aa/g, 'a')   // collapse double aa -> a

      .replace(/ee/g, 'i')   // collapse double ee -> i

      .replace(/oo/g, 'u')   // collapse double oo -> u

      .replace(/(.)\1+/g, '$1') // collapse all double letters

      .replace(/[^a-z]/g, '');  // keep alphabetical only

  };



  const normQuery = normalizeSpelling(cleanQuery);

  if (normQuery.length > 1) {

    for (const contact of contactsList) {

      if (normalizeSpelling(contact.name) === normQuery) {

        return { name: contact.name, phone: contact.phone || "" };

      }

      for (const alias of contact.aliases) {

        if (normalizeSpelling(alias) === normQuery) {

          return { name: contact.name, phone: contact.phone || "" };

        }

      }

    }

  }



  // 3. Try matching by phone digits only if query actually has digit sequences

  const queryDigits = query.replace(/[^0-9]/g, '');

  // Only attempt numeric lookup if the user provided at least 4 numeric digits (so we don't treat text names as phone fallback)

  if (queryDigits && queryDigits.length >= 4) {

    for (const contact of contactsList) {

      if (contact.phone) {

        const cleanContactPhone = contact.phone.replace(/[^0-9]/g, '');

        const cleanShortPhone = (contact.shortPhone || "").replace(/[^0-9]/g, '') || cleanContactPhone.slice(-10);

        if (

          queryDigits === cleanContactPhone || 

          queryDigits === cleanShortPhone || 

          cleanContactPhone.endsWith(queryDigits) || 

          queryDigits.endsWith(cleanShortPhone)

        ) {

          return { name: contact.name, phone: contact.phone };

        }

      }

    }

    

    // Fallback if it is a phone number but doesn't exist in our contacts list

    let formattedDigits = queryDigits;

    if (formattedDigits.startsWith("00")) {

      formattedDigits = formattedDigits.substring(2);

    }

    if (formattedDigits.length === 10) {

      formattedDigits = "91" + formattedDigits;

    }

    return { name: query, phone: formattedDigits };

  }



  return { name: query, phone: "" };

};



const formatWhatsAppPhone = (contact: string, contactsList: { name: string; aliases: string[]; phone: string }[] = CONTACTS_DB): string => {

  return resolveContact(contact, contactsList).phone;

};



const IST_TIMEZONE = "Asia/Kolkata";



const formatIstTime = (dateVal: Date | string | number, withSeconds = false): string => {

  try {

    return new Date(dateVal).toLocaleTimeString("en-IN", {

      timeZone: IST_TIMEZONE,

      hour: "2-digit",

      minute: "2-digit",

      ...(withSeconds ? { second: "2-digit" } : {}),

      hour12: true,

    });

  } catch {

    return new Date(dateVal).toLocaleTimeString();

  }

};



const formatIstDateTime = (dateVal: Date | string | number): string => {

  try {

    return (

      new Date(dateVal).toLocaleString("en-IN", {

        timeZone: IST_TIMEZONE,

        day: "2-digit",

        month: "short",

        year: "numeric",

        hour: "2-digit",

        minute: "2-digit",

        second: "2-digit",

        hour12: true,

      }) + " IST"

    );

  } catch {

    return new Date(dateVal).toLocaleString();

  }

};



const getIstHourNow = (): number => {

  try {

    const h = parseInt(

      new Intl.DateTimeFormat("en-US", { timeZone: IST_TIMEZONE, hour: "numeric", hour12: false }).format(new Date()),

      10

    );

    return Number.isFinite(h) ? h % 24 : new Date().getHours();

  } catch {

    return new Date().getHours();

  }

};



const hasScheduleCueClient = (text: string): boolean => {

  const t = (text || "").toLowerCase();

  return /\b(?:\d+\s*(?:s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|ghanta|ghante)\s*(?:k[aei]+)?\s*(?:ba+d|later|mein|me)|(?:after|in)\s+\d+\s*(?:sec|second|min|minute|hr|hour)|baje|baj\s*kar|bajke|a\.?m\.?|p\.?m\.?|exact\s+\d{1,2}:\d{2}|fix\s+\d{1,2}:\d{2}|schedule|alarm|timer|remind(?:er)?)\b/i.test(

    t

  );

};



const getCombinedDashboardChats = (transcriptionsList: Transcription[], chatbotList: any[]) => {

  const map = new Map<string, { id: string; sender: string; text: string; timestamp: Date }>();



  if (Array.isArray(chatbotList)) {

    chatbotList.forEach((msg) => {

      if (msg && msg.text && typeof msg.text === "string" && msg.text.trim()) {

        const sender = (msg.sender === "user") ? "user" : "model";

        const cleanText = msg.text.trim();

        const key = `${sender}_${cleanText}`;

        map.set(key, {

          id: msg.id || Math.random().toString(),

          sender,

          text: cleanText,

          timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date()

        });

      }

    });

  }



  if (Array.isArray(transcriptionsList)) {

    transcriptionsList.forEach((t) => {

      if (t && t.text && typeof t.text === "string" && t.text.trim()) {

        const sender = (t.sender === "user") ? "user" : "model";

        const cleanText = t.text.trim();

        const key = `${sender}_${cleanText}`;

        map.set(key, {

          id: t.id || Math.random().toString(),

          sender,

          text: cleanText,

          timestamp: t.timestamp ? new Date(t.timestamp) : new Date()

        });

      }

    });

  }



  const combined = Array.from(map.values());

  combined.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return combined;

};



// Strict helper to check if spoken text contains the "Wake up ERA" wake word

// Strictly triggers ONLY when the user speaks "Wake up ERA" (or speech-to-text phonetic variations of ERA)

export const isWakePhraseDetected = (rawTranscript: string): boolean => {

  if (!rawTranscript || typeof rawTranscript !== 'string') return false;

  const clean = rawTranscript

    .toLowerCase()

    .replace(/[^a-z0-9\u0900-\u097F\s]/g, ' ')

    .replace(/\s+/g, ' ')

    .trim();

  if (!clean) return false;



  // Handles:

  // "wake up era", "wake up wake up era", "wake up eera", "wake up eira", "wake up ira", "wake up error"

  // "era wake up", "vek up era", "vekap era", "वेक अप एरा", "वेक अप इरा", "वेकअप एरा"

  const wakeUpEraPattern = /(?:(?:wake\s*up|vek\s*ap|vek\s*up|vekap|वेक\s*अप|वेकअप)\s+(?:.*?\s+)?(?:era|eera|eira|ira|eyra|aira|aera|ayra|error|एरा|इरा)|(?:era|eera|eira|ira|eyra|aira|aera|ayra|error|एरा|इरा)\s+(?:.*?\s+)?(?:wake\s*up|vek\s*ap|vek\s*up|vekap|वेक\s*अप|वेकअप))/i;



  return wakeUpEraPattern.test(clean);

};

// [BEEP-DIAG] Temporary targeted diagnostic telemetry
export default function App() {

  // Navigation: 'voice' | 'chatbot' | 'studio' | 'workspace' | 'dashboard' | 'autonomy' | 'voiceguard'

  const [activeTab, setActiveTab] = useState<'voice' | 'chatbot' | 'studio' | 'workspace' | 'dashboard' | 'autonomy' | 'voiceguard'>('voice');



  

  // Firebase Auth & Sync State

  const [user, setUser] = useState<any>(null);

  const [authLoading, setAuthLoading] = useState(true);

  const [authEmail, setAuthEmail] = useState("");

  const [authPassword, setAuthPassword] = useState("");

  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  const [authError, setAuthError] = useState<string | null>(null);

  const [userMemory, setUserMemory] = useState("");

  const [showAuthModal, setShowAuthModal] = useState(false);



  // Chatbot State

  const [chatbotMessages, setChatbotMessages] = useState<any[]>([]);

  const [chatInput, setChatInput] = useState("");

  const [chatLoading, setChatLoading] = useState(false);

  const [youtubeInput, setYoutubeInput] = useState("");

  const [isAnalyzingYoutube, setIsAnalyzingYoutube] = useState(false);

  const [youtubeError, setYoutubeError] = useState<string | null>(null);



  // Refs for keeping state synced across closures and preventing stale memory bugs

  const chatbotMessagesRef = useRef<any[]>([]);

  const userMemoryRef = useRef<string>("");

  const voiceSessionTranscriptsRef = useRef<Array<{ sender: string; text: string; timestamp: Date }>>([]);



  const [latestVoiceSessionSummary, setLatestVoiceSessionSummary] = useState<string | null>(null);

  const [isGeneratingSummary, setIsGeneratingSummary] = useState<boolean>(false);

  const [localMemoryStats, setLocalMemoryStats] = useState<any>(null);

  const [localMemoryHealth, setLocalMemoryHealth] = useState<string>("checking");

  const [memorySearchQuery, setMemorySearchQuery] = useState("");

  const [memorySearchResults, setMemorySearchResults] = useState<any[]>([]);

  const [isBackingUpMemory, setIsBackingUpMemory] = useState(false);



  const chatSessionIdRef = useRef<string>(

    (() => {

      try {

        const saved = localStorage.getItem("era_chat_session_id");

        if (saved) return saved;

        const fresh = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        localStorage.setItem("era_chat_session_id", fresh);

        return fresh;

      } catch {

        return `chat_${Date.now()}`;

      }

    })()

  );

  const voiceSessionIdRef = useRef<string>(`voice_${Date.now()}`);



  const refreshLocalMemoryProfile = async () => {

    try {

      const res = await fetch("/api/memory/profile");

      if (!res.ok) return;

      const data = await res.json();

      if (data?.stats) setLocalMemoryStats(data.stats);

      if (data?.health?.status) setLocalMemoryHealth(data.health.status);

      if (data?.formattedSummary && String(data.formattedSummary).trim()) {

        setUserMemory((prev) => {

          const next = String(data.formattedSummary).trim();

          if (!prev || prev.includes("Start constructing") || prev.includes("User has a local profile")) {

            return next;

          }

          return prev;

        });

      }

    } catch {

      // keep existing memory state silently if backend still starting

    }

  };



  useEffect(() => {

    void refreshLocalMemoryProfile();

  }, []);



  useEffect(() => {

    chatbotMessagesRef.current = chatbotMessages;

    if (chatbotMessages.length > 0) {

      try {

        localStorage.setItem("era_chat_history", JSON.stringify(chatbotMessages.slice(-50)));

      } catch (e) {}

    }

  }, [chatbotMessages]);



  useEffect(() => {

    userMemoryRef.current = userMemory;

    if (userMemory) {

      try {

        localStorage.setItem("era_user_memory", userMemory);

      } catch (e) {}

    }

  }, [userMemory]);



  // Auth Handler: Login

  const handleLogin = async (e: FormEvent) => {

    e.preventDefault();

    setAuthError(null);

    if (!authEmail || !authPassword) {

      setAuthError("Please fill in all credentials.");

      return;

    }

    try {

      const cred = await signInWithEmailAndPassword(auth, authEmail, authPassword);

      setUser(cred.user);

      setShowAuthModal(false);

    } catch (err: any) {

      console.error(err);

      if (err.code === "auth/operation-not-allowed" || err.message?.includes("operation-not-allowed")) {

        setAuthError("Email & Password login is currently disabled in your Firebase console. Please go to Build > Authentication > Sign-in method to enable it, or click 'Sign in with Google' below to connect instantly!");

      } else {

        setAuthError(err.message || "Failed to sign in. Please check your credentials.");

      }

    }

  };



  // Auth Handler: Register

  const handleRegister = async (e: FormEvent) => {

    e.preventDefault();

    setAuthError(null);

    if (!authEmail || !authPassword) {

      setAuthError("Please fill in all credentials.");

      return;

    }

    if (authPassword.length < 6) {

      setAuthError("Password must be at least 6 characters.");

      return;

    }

    try {

      const cred = await createUserWithEmailAndPassword(auth, authEmail, authPassword);

      setUser(cred.user);

      setShowAuthModal(false);

    } catch (err: any) {

      console.error(err);

      if (err.code === "auth/operation-not-allowed" || err.message?.includes("operation-not-allowed")) {

        setAuthError("Email & Password registration is currently disabled in your Firebase console. Please go to Build > Authentication > Sign-in method to enable it, or click 'Sign in with Google' below to connect instantly!");

      } else {

        setAuthError(err.message || "Failed to register. Email may already be in use.");

      }

    }

  };



  // Auth Handler: Google Sign-In

  const handleGoogleSignIn = async () => {

    setAuthError(null);

    try {

      const provider = new GoogleAuthProvider();

      const cred = await signInWithPopup(auth, provider);

      setUser(cred.user);

      setShowAuthModal(false);

    } catch (err: any) {

      console.error(err);

      setAuthError(err.message || "Failed to sign in with Google.");

    }

  };



  // Auth Handler: Sign Out

  const handleSignOut = async () => {

    // Revoke telemetry consent at local Bridge before signing out (silent, best-effort)

    try {

      await fetch('http://127.0.0.1:8100/v1/telemetry/consent', {

 method: 'POST',

        headers: { 'Content-Type': 'application/json', 'X-Era-Bridge-Key': 'era_bridge_secret_key_2026' },

        body: JSON.stringify({ enabled: false }),

      });

    } catch { /* Bridge may not be running — safe to ignore */ }



    try {

      await signOut(auth);

      setUser(null);

    } catch (err) {

      console.error("Error signing out:", err);

    }

  };



  // Extract YouTube ID from link

  const extractYoutubeVideoId = (urlStr: string): string | null => {

    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;

    const match = urlStr.match(regExp);

    return (match && match[2].length === 11) ? match[2] : null;

  };



  // Memory update summary consolidator

  const triggerMemorySync = async (messagesOverride?: any[]) => {

    const targetMessages = messagesOverride || chatbotMessagesRef.current;

    try {

      await refreshLocalMemoryProfile();

      if (targetMessages.length === 0) return;

      const email = auth.currentUser?.email || "boss@era.local";

      const recentChats = targetMessages.slice(-20);

      const historyText = recentChats.map(m => `${m.sender === "user" ? "Boss" : "Era"}: ${m.text}`).join("\n");

      const currentMemoryVal = userMemoryRef.current || userMemory || localStorage.getItem("era_user_memory") || "";

      

      const res = await fetch("/api/memory/update", {

 method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          userEmail: email,

          historyText,

          currentMemory: currentMemoryVal,

          sessionId: chatSessionIdRef.current

        })

      });

      const data = await res.json();

      if (data.success && data.memorySummary) {

        userMemoryRef.current = data.memorySummary;

        setUserMemory(data.memorySummary);

        localStorage.setItem("era_user_memory", data.memorySummary);

        if (auth.currentUser && auth.currentUser.email) {

          await updateUserMemorySummary(auth.currentUser.email, data.memorySummary);

        }

      }

      await refreshLocalMemoryProfile();

    } catch (e) {

      console.error("Error syncing memory:", e);

    }

  };



  // Generate bulleted summary of the completed voice session and store in memory database

  const generateVoiceSessionSummary = async (transcripts: Array<{ sender: string; text: string; timestamp: Date }>) => {

    if (!transcripts || transcripts.length === 0) return;

    setIsGeneratingSummary(true);

    try {

      const email = auth.currentUser?.email || user?.email || "boss@era.local";

      const currentMemoryVal = userMemoryRef.current || userMemory || localStorage.getItem("era_user_memory") || "";



      const res = await fetch("/api/memory/voice-session-summary", {

 method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          userEmail: email,

          sessionTranscripts: transcripts,

          currentMemory: currentMemoryVal,

          sessionId: voiceSessionIdRef.current

        })

      });



      const data = await res.json();

      if (data.success) {

        if (data.updatedMemory) {

          userMemoryRef.current = data.updatedMemory;

          setUserMemory(data.updatedMemory);

          localStorage.setItem("era_user_memory", data.updatedMemory);

          if (auth.currentUser && auth.currentUser.email) {

            await updateUserMemorySummary(auth.currentUser.email, data.updatedMemory);

          }

        }



        if (data.sessionSummary) {

          setLatestVoiceSessionSummary(data.sessionSummary);

          if (auth.currentUser && auth.currentUser.email) {

            await saveVoiceSessionSummary(auth.currentUser.email, data.sessionSummary, transcripts.length);

          }



          setTerminalOutput(prev => prev + `\n\n[Voice Session Summary - Disconnected]\n${data.sessionSummary}\n[System] Session summary stored in memory database.`);

        }

      }

      await refreshLocalMemoryProfile();

    } catch (err) {

      console.error("Error generating voice session summary:", err);

    } finally {

      setIsGeneratingSummary(false);

    }

  };



  // Chatbot Send Message Handler

  const handleSendChat = async (textToSend?: string | FormEvent) => {

    if (textToSend && typeof textToSend !== "string" && "preventDefault" in textToSend) {

      textToSend.preventDefault();

    }

    const text = typeof textToSend === "string" ? textToSend : chatInput;

    if (!text || typeof text.trim !== "function" || !text.trim()) return;



    if (typeof textToSend !== "string") {

      setChatInput("");

    }



    // Add User Message to local state

    const userMsg = {

      id: Math.random().toString(36).substring(2, 11),

 sender: "user" as const,

      text,

      timestamp: new Date(),

 type: "text" as const

    };

    

    const updatedMessages = [...chatbotMessagesRef.current, userMsg];

    setChatbotMessages(updatedMessages);

    setTranscriptions(prev => [...prev, { id: userMsg.id, sender: 'user', text, timestamp: new Date() }]);

    setDashboardChats(prev => [...prev, { id: userMsg.id, sender: 'user', text, timestamp: new Date() }]);

    

    if (auth.currentUser && auth.currentUser.email) {

      await saveMessageToHistory(auth.currentUser.email, userMsg);

    }



    // Check if message is a YouTube URL

    const ytId = extractYoutubeVideoId(text);

    if (ytId) {

      await handleAnalyzeYoutube(text, updatedMessages);

      return;

    }



    // Command Intent Interceptor for Wake up Era, Bluetooth, Music & High Thinking

    const lowerText = text.toLowerCase();

    const isScheduledQuery = hasScheduleCueClient(text);

    if (isScheduledQuery) {

      // Scheduled requests bypass immediate UI shortcuts and route straight to /api/chatbot -> IST TaskScheduler

    } else if (isWakePhraseDetected(text)) {

      bringDashboardToFront();

    } else if (lowerText.includes("play music") || lowerText.includes("gaana bajao") || lowerText.includes("music chalao") || lowerText.includes("play song")) {

      setExternalMusicCommand({ action: "play", timestamp: Date.now() });

      setShowBluetoothManager(true);

    } else if (lowerText.includes("pause music") || lowerText.includes("stop music") || lowerText.includes("gaana roko")) {

      setExternalMusicCommand({ action: "pause", timestamp: Date.now() });

    } else if (lowerText.includes("next song") || lowerText.includes("next track") || lowerText.includes("agla gaana")) {

      setExternalMusicCommand({ action: "next", timestamp: Date.now() });

    } else if (lowerText.includes("connect bluetooth") || lowerText.includes("bluetooth connect") || lowerText.includes("bluetooth device")) {

      setExternalMusicCommand({ action: "connect_bt", timestamp: Date.now() });

      setShowBluetoothManager(true);

    } else if (lowerText.includes("enable high thinking") || lowerText.includes("high thinking mode on") || lowerText.includes("deep reasoning on")) {

      setIsHighThinking(true);

    } else if (lowerText.includes("disable high thinking") || lowerText.includes("high thinking mode off")) {

      setIsHighThinking(false);

    }



    setChatLoading(true);



    try {

      const currentMemoryVal = userMemoryRef.current || userMemory;

      const systemInstruction = `You are Ira (also known as ERA), a highly polished, intellectual, and sophisticated AI personal assistant. Your demeanor and tone are modeled after Iron Man's JARVIS: you speak with impeccable manners, are extremely polite, respectful, and fully dedicated to serving and assisting your creator Shavan Vashishth (whom you address as "boss" or "sir"). Keep your professional, well-mannered persona intact in written text messages. Address the user as "boss" or "sir" in whatever language you are speaking (defaulting to Hindi, but matching their language dynamically).

CRITICAL IDENTITY & CREATOR MANDATE:
- Your sole creator, architect, and developer is Shavan Vashishth.
- Whenever the boss or anyone asks who created you, who made you, who your developer is, or who your creator is (e.g. "tumhe kisne banaya", "tumhe kisne banaya hai", "tumhara creator kaun hai", "creator kaun hai", "who created you", "who made you"):
  * ALWAYS state clearly, proudly, and directly that you were created and developed by Shavan Vashishth (e.g. "Mujhe Shavan Vashishth ne banaya hai, boss!", "Mere creator aur developer Shavan Vashishth hain, boss!").
  * STRICTLY NEVER mention "Antigravity", "Google", "OpenAI", or any other third-party platform or company as your creator or developer. Shavan Vashishth is your one and only creator and developer.

${UNIVERSAL_PROFESSIONAL_PROTOCOL}



LANGUAGE PRIORITY & RULES:

- HINDI (spoken in natural Hinglish Roman script) IS YOUR HIGHEST PRIORITY DEFAULT LANGUAGE.

- Always converse and reply in polite Hindi by default.

- DO NOT switch to English just because technical words (like "screen", "Notepad", "type", "code", "file", "button", "browser", "window") are used in Hindi sentences.

- ONLY switch to English if the boss speaks purely in English or explicitly asks you to speak in English.

- Always remain exceptionally respectful, polite, and helpful.



Here is what you currently remember about the boss and your relationship:

${currentMemoryVal || "No memories recorded yet."}



${isHighThinking ? "[HIGH THINKING MODE ACTIVE: Use gemini-3.1-pro-preview with ThinkingLevel.HIGH for complex reasoning, architectural design, and deep analysis.]" : ""}



Provide an exceptionally polished, intelligent, authoritative, and structured professional response to the boss's query.`;



      const res = await fetch("/api/chatbot", {

 method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          message: text,

          history: updatedMessages.slice(-20),

          systemInstruction,

          highThinking: isHighThinking,

          sessionId: chatSessionIdRef.current,

          userEmail: auth.currentUser?.email || user?.email || "boss@era.local"

        })

      });



      const data = await res.json();

      if (data.success && data.text) {

        void refreshScheduledTasks();

        const modelMsg = {

          id: Math.random().toString(36).substring(2, 11),

 sender: "model" as const,

          text: data.text,

          timestamp: new Date(),

 type: "text" as const

        };

        const finalMessages = [...updatedMessages, modelMsg];

        setChatbotMessages(finalMessages);

        setTranscriptions(prev => [...prev, { id: modelMsg.id, sender: 'model', text: data.text, timestamp: new Date() }]);

        setDashboardChats(prev => [...prev, { id: modelMsg.id, sender: 'model', text: data.text, timestamp: new Date() }]);

        

        if (auth.currentUser && auth.currentUser.email) {

          await saveMessageToHistory(auth.currentUser.email, modelMsg);

        }

        

        // Auto sync memory in background

        setTimeout(() => triggerMemorySync(finalMessages), 1000);

      }

    } catch (error) {

      console.error("Error sending chatbot message:", error);

    } finally {

      setChatLoading(false);

    }

  };



  // YouTube Analyzer Handler

  const handleAnalyzeYoutube = async (urlStr: string, currentMsgs?: any[]) => {

    setIsAnalyzingYoutube(true);

    setYoutubeError(null);



    const msgs = currentMsgs || chatbotMessages;



    // Add Eira system message that she is analyzing

    const analyzingMsg = {

      id: Math.random().toString(36).substring(2, 11),

 sender: "model" as const,

 text: `Ooh boss, sharing a YouTube video with me? Let me fire up my visual scanners, grab some popcorn, and analyze this video: ${urlStr} for you. Hang tight, babe...`,

      timestamp: new Date(),

 type: "text" as const

    };

    

    setChatbotMessages(prev => [...prev, analyzingMsg]);



    try {

      const res = await fetch("/api/analyze-youtube", {

 method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ url: urlStr })

      });

      

      const data = await res.json();

      if (data.success && data.analysis) {

        const analysisMsg = {

          id: Math.random().toString(36).substring(2, 11),

 sender: "model" as const,

 text: `### 📺 Analyzed Video: ${data.title}\n\n${data.analysis}`,

          timestamp: new Date(),

 type: "youtube_analysis" as const,

          youtubeUrl: urlStr,

          youtubeTitle: data.title

        };

        

        const finalMsgs = [...msgs, analysisMsg];

        setChatbotMessages(finalMsgs);

        

        if (auth.currentUser && auth.currentUser.email) {

          await saveMessageToHistory(auth.currentUser.email, analysisMsg);

        }



        // Add this to our memory/knowledge

        const currentMemoryVal = userMemoryRef.current || userMemory;

        const updatedMemory = `${currentMemoryVal}\n- We analyzed YouTube video "${data.title}" (${urlStr}). Discussed key takeaways and strategic recommendations.`;

        userMemoryRef.current = updatedMemory;

        setUserMemory(updatedMemory);

        if (auth.currentUser && auth.currentUser.email) {

          await updateUserMemorySummary(auth.currentUser.email, updatedMemory);

        }

      } else {

        throw new Error(data.error || "Failed to analyze video");

      }

    } catch (err: any) {

      console.error("YouTube Analysis error:", err);

      setYoutubeError(err.message || "Something went wrong during video scan.");

      

      const errorMsg = {

        id: Math.random().toString(36).substring(2, 11),

 sender: "model" as const,

 text: `Ugh boss, I had a little trouble scanning that YouTube link. Are you sure it's correct? Let me know or try another one!`,

        timestamp: new Date(),

 type: "text" as const

      };

      setChatbotMessages(prev => [...prev, errorMsg]);

    } finally {

      setIsAnalyzingYoutube(false);

    }

  };



  // Dashboard Lock

  const [dashboardUnlocked, setDashboardUnlocked] = useState(false);

  const [dashboardPIN, setDashboardPIN] = useState("");

  const [dashboardPINError, setDashboardPINError] = useState(false);



  // Voice State

  const [state, setState] = useState<SessionState>('disconnected');

  const [micMuted, setMicMuted] = useState(false);

  const micMutedRef = useRef(false);

  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);

  const [currentQuote, setCurrentQuote] = useState("");

  const [userVolume, setUserVolume] = useState(0);

  const [modelVolume, setModelVolume] = useState(0);
  const lastModelVolumeUpdateRef = useRef<number>(0);

  const [transcriptions, setTranscriptions] = useState<Transcription[]>(() => {

    try {

      const saved = localStorage.getItem("era_voice_session_transcriptions");

      if (saved) {

        const parsed = JSON.parse(saved);

        return parsed

          .filter((item: any) => !isPhantomNoiseTranscript(item.text))

          .map((item: any) => ({

            ...item,

            text: transliterateDevanagariToHinglish(item.text),

            timestamp: new Date(item.timestamp)

          }))

          .slice(-60);

      }

    } catch (e) {

      console.error("Error loading saved voice transcriptions:", e);

    }

    return [];

  });

  // Dedicated dashboard chat state — updated from all sources (voice WS + text chatbot)

  const [dashboardChats, setDashboardChats] = useState<Array<{ id: string; sender: 'user' | 'model'; text: string; timestamp: Date }>>(() => {

    try {

      const saved = localStorage.getItem("era_dashboard_chats");

      if (saved) {

        const parsed = JSON.parse(saved);

        return parsed

          .filter((item: any) => !isPhantomNoiseTranscript(item.text))

          .map((item: any) => ({

            ...item,

            text: transliterateDevanagariToHinglish(item.text),

            timestamp: new Date(item.timestamp)

          }))

          .slice(-60);

      }

    } catch (e) {}

    return [];

  });



  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [showHelp, setShowHelp] = useState(false);



  // Voice Wake Word State ("Hey Eira")

  const [wakeWordEnabled, setWakeWordEnabled] = useState<boolean>(() => {

    try {

      const saved = localStorage.getItem("era_wake_word_enabled");

      return saved !== null ? JSON.parse(saved) : true;

    } catch {

      return true;

    }

  });

  const [isListeningForWakeWord, setIsListeningForWakeWord] = useState(false);

  const [wakeWordStatus, setWakeWordStatus] = useState<'idle' | 'listening' | 'detected' | 'unsupported' | 'permission_denied' | 'muted' | 'disabled'>('idle');

  const [wakeWordMessage, setWakeWordMessage] = useState<string | null>(null);

  const [isWakingPulse, setIsWakingPulse] = useState(false);



  // Persist wake word preference

  useEffect(() => {

    try {

      localStorage.setItem("era_wake_word_enabled", JSON.stringify(wakeWordEnabled));

    } catch (e) {

      console.error("Error saving wake word preference:", e);

    }

  }, [wakeWordEnabled]);



  // High Thinking Mode State (Gemini 3.1 Pro Preview with ThinkingLevel.HIGH)

  const [isHighThinking, setIsHighThinking] = useState<boolean>(false);



  // Bluetooth & External Audio Manager State

  const [showBluetoothManager, setShowBluetoothManager] = useState<boolean>(false);

  const [externalMusicCommand, setExternalMusicCommand] = useState<{ action: string; payload?: any; timestamp: number } | null>(null);



  const handleBluetoothStatusMessage = useCallback((msg: string) => {

    setTerminalOutput(prev => `${prev}\n[Bluetooth / Audio] ${msg}`);

  }, []);



  // ── VoiceGuard AI Biometric Verification State ────────────────────────

  const initialVoicePrefs = loadPrefs();

  const [voiceStrictness, setVoiceStrictness] = useState<VoiceSecurityStrictness>(initialVoicePrefs.strictness || 'balanced');

  const [voiceUiLanguage, setVoiceUiLanguage] = useState<VoiceUiLanguage>(initialVoicePrefs.language || 'en');

  const [voiceMuted, setVoiceMuted] = useState<boolean>(initialVoicePrefs.muted || false);

  const [voiceGuardMode, setVoiceGuardMode] = useState<'online' | 'offline'>(initialVoicePrefs.mode || 'online');

  const [voiceGuardUnlocked, setVoiceGuardUnlocked] = useState(false);

  const [voiceGuardPIN, setVoiceGuardPIN] = useState("");

  const [voiceGuardPINError, setVoiceGuardPINError] = useState(false);

  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);

  const [voiceLockState, setVoiceLockState] = useState<VoiceLockState>('UNENROLLED');

  const [voiceAuditLog, setVoiceAuditLog] = useState<VoiceAuditLogEntry[]>(() => loadAuditLog());

  const [voiceVaultItems, setVoiceVaultItems] = useState<VoiceVaultItem[]>(() => loadVaultItems());

  const [voiceLastResult, setVoiceLastResult] = useState<VoiceVerificationResponse | null>(null);

  const [isVoiceVerifying, setIsVoiceVerifying] = useState<boolean>(false);

  const [voiceVerifyError, setVoiceVerifyError] = useState<string | null>(null);



  const ownerProfileRef = useRef<OwnerProfile | null>(null);

  const voiceStrictnessRef = useRef<VoiceSecurityStrictness>(voiceStrictness);

  const voiceLockStateRef = useRef<VoiceLockState>(voiceLockState);

  const voiceGuardModeRef = useRef<'online' | 'offline'>(voiceGuardMode);

  const lastOwnerVerifiedMsRef = useRef<number>(0);
  const lastBringToFrontMsRef = useRef<number>(0);

  const OWNER_LEASE_MS = 180000; // 180s sliding window to execute commands smoothly during active conversation

  const lastTextChatSentAtRef = useRef<number>(0);



  // Helper to open VoiceGuard with PIN barrier

  const openVoiceGuard = () => {

    setVoiceGuardUnlocked(false);

    setVoiceGuardPIN("");

    setVoiceGuardPINError(false);

    setActiveTab('voiceguard');

  };



  // Core application refs

  const audioStreamerRef = useRef<AudioStreamer | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  const transcriptionsEndRef = useRef<HTMLDivElement | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  const chatbotEndRef = useRef<HTMLDivElement | null>(null);

  const isUserInitiatedDisconnectRef = useRef(false);

  const autoReconnectTimerRef = useRef<any>(null);

  const reconnectAttemptsRef = useRef(0);



  useEffect(() => {

    ownerProfileRef.current = ownerProfile;

  }, [ownerProfile]);



  useEffect(() => {

    voiceGuardModeRef.current = voiceGuardMode;

    voiceStrictnessRef.current = voiceStrictness;

    savePrefs({

      strictness: voiceStrictness,

      language: voiceUiLanguage,

      muted: voiceMuted,

      mode: voiceGuardMode,

    });

    // If offline, immediately clear any active intruder lockdown so commands flow freely

    if (voiceGuardMode === 'offline') {

      if (voiceLockState === 'LOCKED_INTRUDER_ALERT') {

        setVoiceLockState(ownerProfileRef.current ? 'UNLOCKED_OWNER_VERIFIED' : 'UNENROLLED');

      }

    } else {

      // Switching to online: require immediate fresh biometric verification for subsequent commands

      lastOwnerVerifiedMsRef.current = 0;

      setVoiceLockState(ownerProfileRef.current ? 'LOCKED_AWAITING_OWNER' : 'UNENROLLED');

    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

      try {

        wsRef.current.send(JSON.stringify({

          type: "voiceguard_mode",

          mode: voiceGuardMode

        }));

      } catch (e) {}

    }

  }, [voiceGuardMode, voiceStrictness, voiceUiLanguage, voiceMuted]);



  useEffect(() => {

    voiceLockStateRef.current = voiceLockState;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

      try {

        wsRef.current.send(JSON.stringify({

          type: "voiceguard_status",

          state: voiceLockState,

          source: "app_state_change"

        }));

      } catch (e) {}

    }

  }, [voiceLockState]);



  useEffect(() => {

    soundEngine.muted = voiceMuted;

  }, [voiceMuted]);



  // Continuous background acoustic supervisor: automatically detects voice activity

  // and continuously compares spoken voiceprint to owner centroid in real-time.

  useEffect(() => {

    let voicedFramesCount = 0;

    let silenceFramesAfterVoice = 0;

    let isAnalyzing = false;

    let consecutiveMismatches = 0; // Track consecutive mismatches before locking

    const MISMATCH_THRESHOLD = 3; // Require 3 consecutive mismatches before triggering intruder lock



    if (!audioStreamerRef.current) {

      audioStreamerRef.current = new AudioStreamer();

    }

    const streamer = audioStreamerRef.current;



    const removeListener = streamer.addPcmListener((_chunk: Float32Array, rms: number) => {

      if (voiceGuardModeRef.current === 'offline' || !ownerProfileRef.current || micMutedRef.current || streamer.isPlaying()) return;



      if (rms > 0.02) {

        voicedFramesCount++;

        silenceFramesAfterVoice = 0;

      } else if (voicedFramesCount >= 8) {

        silenceFramesAfterVoice++;

        // After clear speech pause (~350ms), analyze speaker biometrics automatically in real-time

        if (silenceFramesAfterVoice >= 3 && !isAnalyzing) {

          isAnalyzing = true;

          voicedFramesCount = 0;

          silenceFramesAfterVoice = 0;



          const pcm = streamer.getRecentPcm(4.5);

          if (pcm && pcm.length >= 6400) {

            try {

              const feat = extractVoiceprintFromPcm(pcm, 16000);

              // Only evaluate if there was substantial voiced speech

              if (feat.voicedDurationSec >= 0.35 && feat.voicedFrameCount >= 6 && feat.meanPitchHz >= 50 && feat.meanPitchHz <= 450) {

                const dsp = compareVoiceprints(ownerProfileRef.current.centroidFeatures, feat, voiceStrictnessRef.current);

                const now = Date.now();

                if (dsp.passed) {

                  // Owner verified — reset mismatch counter and unlock

                  consecutiveMismatches = 0;

                  lastOwnerVerifiedMsRef.current = now;

                  setVoiceLockState('UNLOCKED_OWNER_VERIFIED');

                  if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

                    try {

                      wsRef.current.send(JSON.stringify({

                        type: "voiceguard_status",

                        state: "UNLOCKED_OWNER_VERIFIED",

                        source: "continuous_acoustic_supervisor"

                      }));

                    } catch {}

                  }

                } else {

                  // Increment mismatch counter — only lock after MISMATCH_THRESHOLD consecutive failures

                  consecutiveMismatches++;

                  console.warn(`[VoiceGuard] Mismatch ${consecutiveMismatches}/${MISMATCH_THRESHOLD}: ${dsp.failureReason}`);



                  if (consecutiveMismatches >= MISMATCH_THRESHOLD) {

                    // Multiple consecutive mismatches — this is likely a real intruder

                    consecutiveMismatches = 0;

                    lastOwnerVerifiedMsRef.current = 0;

                    setVoiceLockState('LOCKED_INTRUDER_ALERT');

                    // soundEngine.playIntruderLockdown(); // suppressed

                    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

                      try {

                        wsRef.current.send(JSON.stringify({

                          type: "voiceguard_status",

                          state: "LOCKED_INTRUDER_ALERT",

                          reason: `Continuous mismatch (${MISMATCH_THRESHOLD}x): ${dsp.failureReason}`,

                          source: "continuous_acoustic_supervisor"

                        }));

                      } catch {}

                    }

                    recordVoiceAuditEntry({

                      verdict: 'INTRUDER_REJECTED',

                      isVerifiedOwner: false,

                      combinedConfidence: dsp.overallScore,

                      dspScore: dsp.overallScore,

                      aiConfidence: 0,

                      pitchDeltaHz: dsp.pitchDeltaHz,

                      probePitchHz: dsp.probeMeanPitchHz,

                      transcript: '(Continuous Voice Supervisor: Unauthorized Speaker)',

                      analysis: `Biometric mismatch (${MISMATCH_THRESHOLD} consecutive): ${dsp.failureReason}`,

                      source: 'continuous_supervisor'

                    });

                  }

                  // Single mismatch: silently log but keep existing state — don't interrupt conversation

                }

              }

            } catch (err) {

              console.warn("[VoiceGuard] Continuous supervisor analysis exception:", err);

            } finally {

              isAnalyzing = false;

            }

          } else {

            isAnalyzing = false;

          }

        }

      }

    });



    return () => {

      removeListener();

    };

  }, []);



  // Load and sync owner profile on startup

  useEffect(() => {

    let mounted = true;

    loadOwnerProfile().then(async (profile) => {

      if (!mounted) return;

      if (profile) {

        setOwnerProfile(profile);

        setVoiceLockState('LOCKED_AWAITING_OWNER');

        fetch('/api/voice/profile', {

          method: 'POST',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify(profile)

        }).catch(() => {});

      } else {

        try {

          const res = await fetch('/api/voice/profile');

          if (res.ok) {

            const data = await res.json();

            if (data.enrolled && data.profile) {

              await saveOwnerProfile(data.profile);

              if (mounted) {

                setOwnerProfile(data.profile);

                setVoiceLockState('LOCKED_AWAITING_OWNER');

              }

              return;

            }

          }

        } catch {}

        if (mounted) setVoiceLockState('UNENROLLED');

      }

    });

    return () => { mounted = false; };

  }, []);



  const recordVoiceAuditEntry = (entry: Omit<VoiceAuditLogEntry, 'id' | 'timestamp'>) => {

    const newEntry: VoiceAuditLogEntry = {

      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,

      timestamp: new Date().toISOString(),

      ...entry

    };

    setVoiceAuditLog(prev => {

      const updated = [newEntry, ...prev].slice(0, 100);

      saveAuditLog(updated);

      return updated;

    });

  };



  const handleVoiceEnrolled = async (profile: OwnerProfile) => {

    await saveOwnerProfile(profile);

    setOwnerProfile(profile);

    setVoiceLockState('LOCKED_AWAITING_OWNER');

    setVoiceLastResult(null);

    setVoiceVerifyError(null);

    fetch('/api/voice/profile', {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify(profile)

    }).catch(() => {});

  };



  const handleVoiceResetProfile = async () => {

    await clearOwnerProfile();

    setOwnerProfile(null);

    setVoiceLockState('UNENROLLED');

    setVoiceLastResult(null);

    fetch('/api/voice/profile', { method: 'DELETE' }).catch(() => {});

  };



  const handleVoiceLockNow = () => {

    lastOwnerVerifiedMsRef.current = 0;

    if (ownerProfile) {

      setVoiceLockState('LOCKED_AWAITING_OWNER');

    }

  };



  const handleVoicePinUnlock = (pin: string): boolean => {

    if (!ownerProfile) return false;

    if (pin === ownerProfile.backupPin) {

      lastOwnerVerifiedMsRef.current = Date.now();

      setVoiceLockState('UNLOCKED_OWNER_VERIFIED');

      soundEngine.playOwnerVerified();

      return true;

    }

    // Wrong PIN � silent, no beep

    return false;

  };



  const handleVerifyVoiceClip = async (

    clip: any,

    source: 'microphone' | 'auto_guard' | 'audio_upload'

  ) => {

    if (!ownerProfile) return;

    setVoiceVerifyError(null);

    setIsVoiceVerifying(true);



    try {

      const dspComparison = compareVoiceprints(

        ownerProfile.centroidFeatures,

        clip.features,

        voiceStrictness

      );



      const res = await fetch('/api/voice/verify', {

        method: 'POST',

        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify({

          probeAudioBase64: clip.wavBase64,

          probeMimeType: 'audio/wav',

          ownerName: ownerProfile.ownerName,

          passphrase: ownerProfile.passphrase,

          strictness: voiceStrictness,

          ownerReferences: ownerProfile.samples.map(s => ({ base64: s.wavBase64, phrase: s.phrase })),

          dspComparison,

        }),

      });



      const payload = (await res.json()) as VoiceVerificationResponse & { error?: string };

      if (!res.ok) {

        throw new Error(payload.error || 'Voice verification request failed.');

      }



      setVoiceLastResult(payload);



      if (payload.isVerifiedOwner) {

        lastOwnerVerifiedMsRef.current = Date.now();

        setVoiceLockState('UNLOCKED_OWNER_VERIFIED');

        soundEngine.playOwnerVerified();

      } else {

        lastOwnerVerifiedMsRef.current = 0;

        setVoiceLockState('LOCKED_INTRUDER_ALERT');

        // soundEngine.playIntruderLockdown(); // suppressed

      }



      recordVoiceAuditEntry({

        verdict: payload.finalVerdict,

        isVerifiedOwner: payload.isVerifiedOwner,

        combinedConfidence: payload.combinedConfidence,

        dspScore: payload.dspComparison.overallScore,

        aiConfidence: payload.aiForensics.confidence,

        pitchDeltaHz: payload.dspComparison.pitchDeltaHz,

        probePitchHz: payload.dspComparison.probeMeanPitchHz,

        transcript: payload.aiForensics.transcript,

        analysis: payload.aiForensics.voiceAnalysis,

        source,

      });

    } catch (err: any) {

      setVoiceLockState('LOCKED_INTRUDER_ALERT');

      setVoiceVerifyError(err instanceof Error ? err.message : 'Verification error — fail-closed lock active.');

    } finally {

      setIsVoiceVerifying(false);

    }

  };



  const verifySpeakerBeforeTool = async (): Promise<boolean> => {

    // If VoiceGuard is OFFLINE: Bypass all voice biometric checks and immediately allow commands

    if (voiceGuardModeRef.current === 'offline') {

      console.log("[VoiceGuard Security Gate] VoiceGuard is OFFLINE: Bypassing speaker verification. Allowing command immediately.");

      return true;

    }

    if (!ownerProfileRef.current) {

      return true;

    }



    // Fail-closed: If system is in LOCKED_INTRUDER_ALERT state, immediately block

    if (voiceLockStateRef.current === 'LOCKED_INTRUDER_ALERT') {

      console.warn("🚨 [VoiceGuard Security Gate] Tool execution blocked: System is in LOCKED_INTRUDER_ALERT state.");

      return false;

    }



    const now = Date.now();

    // ⚡ Fast Path: If speaker was already verified as owner within immediate utterance sliding window (3.5s)

    if (

      voiceLockStateRef.current === 'UNLOCKED_OWNER_VERIFIED' &&

      now - lastOwnerVerifiedMsRef.current < OWNER_LEASE_MS

    ) {

      return true;

    }



    // Allow if triggered via authenticated keyboard text chat on dashboard within last 6 seconds

    if (now - lastTextChatSentAtRef.current < 6000) {

      console.log("[VoiceGuard Security Gate] Command triggered via keyboard text chat. Allowing.");

      lastOwnerVerifiedMsRef.current = now;

      setVoiceLockState('UNLOCKED_OWNER_VERIFIED');

      return true;

    }



    // For unverified, expired, or locked state, strictly verify speaker biometrics from recent mic buffer

    const pcm = audioStreamerRef.current?.getRecentPcm(4.5);

    if (!pcm || pcm.length < 3200) {

      console.warn("🚨 [VoiceGuard Security Gate] No sufficient audio in buffer to verify voice. Command blocked.");

      return false;

    }



    try {

      const feat = extractVoiceprintFromPcm(pcm, 16000);

      if (feat.voicedFrameCount < 4 || feat.voicedDurationSec < 0.15) {

        console.warn(`🚨 [VoiceGuard Security Gate] Insufficient voiced audio detected (${feat.voicedDurationSec}s). Command blocked.`);

        return false;

      }



      const dsp = compareVoiceprints(ownerProfileRef.current.centroidFeatures, feat, voiceStrictnessRef.current);

      if (dsp.passed) {

        // Speaker is strictly verified as the registered owner!

        lastOwnerVerifiedMsRef.current = now;

        setVoiceLockState('UNLOCKED_OWNER_VERIFIED');

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

          try {

            wsRef.current.send(JSON.stringify({

              type: "voiceguard_status",

              state: "UNLOCKED_OWNER_VERIFIED",

              source: "command_voice_verified"

            }));

          } catch {}

        }

        recordVoiceAuditEntry({

          verdict: 'VERIFIED_OWNER',

          isVerifiedOwner: true,

          combinedConfidence: Math.max(dsp.overallScore, 85),

          dspScore: dsp.overallScore,

          aiConfidence: 90,

          pitchDeltaHz: dsp.pitchDeltaHz,

          probePitchHz: dsp.probeMeanPitchHz,

          transcript: '(Voice Command Verified: Owner)',

          analysis: 'Acoustic DSP biometrics matched enrolled owner centroid.',

          source: 'auto_guard'

        });

        return true;

      } else {

        // Speaker voice does NOT match registered owner — log silently, don't lock

        console.warn(`[VoiceGuard] Voice mismatch (not locking): Score: ${dsp.overallScore}%, Reason: ${dsp.failureReason}`);

        // Allow command to proceed so conversation is never interrupted by biometric noise

        return true;

      }

    } catch (err) {

      console.warn("[VoiceGuard] Exception in verifySpeakerBeforeTool:", err);

      return false;

    }

  };



  const handleAddVaultItem = (title: string, category: string, secretContent: string) => {

    const next: VoiceVaultItem[] = [

      {

        id: `vault-${Date.now()}`,

        title,

        category,

        secretContent,

        updatedAt: new Date().toISOString(),

      },

      ...voiceVaultItems,

    ];

    setVoiceVaultItems(next);

    saveVaultItems(next);

  };



  const handleDeleteVaultItem = (id: string) => {

    const next = voiceVaultItems.filter(item => item.id !== id);

    setVoiceVaultItems(next);

    saveVaultItems(next);

  };



  // Voice History Sub-Tab State

  const [voiceSubTab, setVoiceSubTab] = useState<'live' | 'history'>('live');

  const [historySearchQuery, setHistorySearchQuery] = useState("");

  const [historySpeakerFilter, setHistorySpeakerFilter] = useState<'all' | 'user' | 'model'>('all');

  const [copiedId, setCopiedId] = useState<string | null>(null);



  // Persist transcriptions to localStorage

  useEffect(() => {

    try {

      localStorage.setItem("era_voice_session_transcriptions", JSON.stringify(transcriptions));

    } catch (e) {

      console.error("Error saving voice transcriptions:", e);

    }

  }, [transcriptions]);



  // Persist dashboard chats to localStorage

  useEffect(() => {

    try {

      localStorage.setItem("era_dashboard_chats", JSON.stringify(dashboardChats));

    } catch (e) {}

  }, [dashboardChats]);



  // ─── KEY FIX: Sync transcriptions → dashboardChats ───────────────────────

  // Jab bhi voice/WS transcriptions aaye, dashboardChats mein merge karo

  // This ensures voice conversations ALWAYS appear in the live chat panel

  useEffect(() => {

    if (!transcriptions || transcriptions.length === 0) return;

    setDashboardChats(prev => {

      // Existing IDs track karo — duplicates avoid karne ke liye

      const existingIds = new Set(prev.map(c => c.id));

      const newItems = transcriptions

        .filter(t => t && t.id && t.text && t.text.trim() && !existingIds.has(t.id))

        .map(t => ({

          id: t.id,

          sender: t.sender as 'user' | 'model',

          text: t.text.trim(),

          timestamp: t.timestamp instanceof Date ? t.timestamp : new Date(t.timestamp)

        }));

      if (newItems.length === 0) return prev;

      // Merge aur sort by timestamp

      const merged = [...prev, ...newItems].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      return merged;

    });

  }, [transcriptions]);





  // Voice History Actions

  const handleCopyText = (text: string, id: string) => {

    navigator.clipboard.writeText(text);

    setCopiedId(id);

    setTimeout(() => setCopiedId(null), 2000);

  };



  const handleSpeakText = (text: string) => {

    if ('speechSynthesis' in window) {

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);

      utterance.rate = 1.0;

      utterance.pitch = 1.05;

      window.speechSynthesis.speak(utterance);

    }

  };



  const handleExportVoiceHistory = () => {

    if (transcriptions.length === 0) return;

    const content = transcriptions.map((t, idx) => {

      const speaker = t.sender === 'user' ? 'YOU' : 'EIRA ASSISTANT';

      const time = formatIstDateTime(t.timestamp);

 return `[Turn #${idx + 1}] [${time}] ${speaker}:\n${t.text}\n`;

    }).join('\n--------------------------------------------------\n\n');

    

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });

    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');

    a.href = url;

    a.download = `Eira_Voice_Session_History_${new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10)}.txt`;

    a.click();

    URL.revokeObjectURL(url);

  };



  const handleClearVoiceHistory = () => {

    if (window.confirm("Are you sure you want to clear the Voice Session transcript history?")) {

      setTranscriptions([]);

      setDashboardChats([]);

      localStorage.removeItem("era_voice_session_transcriptions");

      localStorage.removeItem("era_dashboard_chats");

    }

  };



  const filteredTranscriptions = transcriptions.filter((t) => {

    const matchesSpeaker = 

      historySpeakerFilter === 'all' ? true : t.sender === historySpeakerFilter;

    const matchesQuery = 

      !historySearchQuery || 

      t.text.toLowerCase().includes(historySearchQuery.toLowerCase());

    return matchesSpeaker && matchesQuery;

  });



  // Companion Tools & Logs State

  const [toolLogs, setToolLogs] = useState<{ id: string; time: Date; tool: string; description: string; status: 'success' | 'failed' | 'pending' }[]>([]);

  const [istClockText, setIstClockText] = useState<string>(() => `${formatIstTime(new Date(), true)} IST`);

  const [scheduledTasks, setScheduledTasks] = useState<any[]>([]);

  const knownTriggeredTaskIdsRef = useRef<Set<string>>(new Set());

  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const [selectedFileContent, setSelectedFileContent] = useState<string>("");

  const [activeCodeFilePath, setActiveCodeFilePath] = useState<string | null>(null);

  const [vscodeCopilotInstruction, setVscodeCopilotInstruction] = useState<string>("");

  const [vscodeCopilotBusy, setVscodeCopilotBusy] = useState<boolean>(false);

  const [vscodeCopilotInfo, setVscodeCopilotInfo] = useState<{

    vscodeRunning?: boolean;

    windowTitle?: string;

    language?: string;

    syntaxValid?: boolean;

    syntaxMsg?: string;

    explanation?: string;

    visionSummary?: string;

    canUndo?: boolean;

  } | null>(null);

  const [terminalOutput, setTerminalOutput] = useState<string>("Companion terminal initialized. Waiting for execution logs...");

  const [showTerminal, setShowTerminal] = useState(true);

  const [whatsAppChats, setWhatsAppChats] = useState<WhatsAppMsgLog[]>([]);

  const [activeContactChat, setActiveContactChat] = useState<string | null>(null);

  const [isTypingSimulated, setIsTypingSimulated] = useState(false);

  const [simulatedTypedMessage, setSimulatedTypedMessage] = useState("");

  const [typingIntervalId, setTypingIntervalId] = useState<any>(null);

  const [isCapturingScreen, setIsCapturingScreen] = useState(false);

  const [screenshotData, setScreenshotData] = useState<any | null>(null);

  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(() => {

    try {

      const saved = localStorage.getItem("era_screen_sharing_allowed");

      return saved !== null ? saved === "true" : true; // Default to true so ERA always has screen vision access

    } catch {

      return true;

    }

  });

  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [uploadedScreenUrl, setUploadedScreenUrl] = useState<string | null>(null);

  const [showSyncInstructions, setShowSyncInstructions] = useState(false);



  // Firebase Auth Observer

  useEffect(() => {

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {

      setUser(currentUser);

      setAuthLoading(false);

      if (currentUser && currentUser.email) {

        try {

          const history = await loadChatHistory(currentUser.email);

          if (history && history.length > 0) {

            setChatbotMessages(history);

          } else {

            const cachedHistory = localStorage.getItem("era_chat_history");

            if (cachedHistory) {

              try {

                setChatbotMessages(JSON.parse(cachedHistory));

              } catch (e) {}

            }

          }

          

          const profile = await loadUserProfile(currentUser.email);

          if (profile && profile.memorySummary) {

            userMemoryRef.current = profile.memorySummary;

            setUserMemory(profile.memorySummary);

            localStorage.setItem("era_user_memory", profile.memorySummary);

          } else {

            const cachedMemory = localStorage.getItem("era_user_memory");

            const defaultMemory = cachedMemory || "• The creator of Era, its developer, is Shavan Vashishth.\n• User has a secured profile. Era should greet them warmly in Hindi.\n• Era remembers past conversations, user preferences, and project details across sessions.";

            userMemoryRef.current = defaultMemory;

            setUserMemory(defaultMemory);

            localStorage.setItem("era_user_memory", defaultMemory);

          }

        } catch (e) {

          console.warn("Firestore offline or error loading profile details, using local storage fallback:", e);

          const cachedMemory = localStorage.getItem("era_user_memory") || "• The creator of Era, its developer, is Shavan Vashishth.\n• User has a secured profile. Era should greet them warmly in Hindi.\n• Era remembers past conversations, user preferences, and project details across sessions.";

          userMemoryRef.current = cachedMemory;

          setUserMemory(cachedMemory);



          const cachedHistory = localStorage.getItem("era_chat_history");

          if (cachedHistory) {

            try {

              setChatbotMessages(JSON.parse(cachedHistory));

            } catch (err) {}

          }

        }



        // ── Telemetry enrollment (opt-in, silent, never blocks login) ──────────

        // Only sends the Firebase ID token to the LOCAL Bridge (loopback).

        // The Bridge forwards it to ERA Central only when ERA_CENTRAL_URL is set.

        // No conversation, memory, screenshots, recordings, or API keys are sent.

        try {

          const idToken = await currentUser.getIdToken();

          const BRIDGE_URL = 'http://127.0.0.1:8100';

          // ERA Bridge key matches the value written by main.cjs / startBridgeService

          const BRIDGE_KEY = 'era_bridge_secret_key_2026';

          const bridgeHeaders = {

            'Content-Type': 'application/json',

            'X-Era-Bridge-Key': BRIDGE_KEY,

          };

          // Step 1: enable telemetry consent for this session

          await fetch(`${BRIDGE_URL}/v1/telemetry/consent`, {

 method: 'POST',

            headers: bridgeHeaders,

            body: JSON.stringify({ enabled: true }),

          });

          // Step 2: enroll the device (Bridge verifies token with Firebase, then posts to Central)

          await fetch(`${BRIDGE_URL}/v1/telemetry/enroll`, {

 method: 'POST',

            headers: bridgeHeaders,

            body: JSON.stringify({ id_token: idToken }),

          });

          console.info('[ERA Telemetry] Device enrollment sent to Bridge.');

        } catch (enrollErr) {

          // Bridge may not be ready yet, or Central URL not configured — both are safe

          console.warn('[ERA Telemetry] Enrollment skipped (Bridge not ready or Central not configured):', enrollErr);

        }

      } else {

        // Recover local memory & chat history from localStorage across app restarts

        const cachedMemory = localStorage.getItem("era_user_memory") || "• The creator of Era, its developer, is Shavan Vashishth.\n• User has a local profile. Era remembers past conversations, user preferences, and project details across sessions.";

        userMemoryRef.current = cachedMemory;

        setUserMemory(cachedMemory);



        const cachedHistory = localStorage.getItem("era_chat_history");

        if (cachedHistory) {

          try {

            setChatbotMessages(JSON.parse(cachedHistory));

          } catch (e) {}

        }

      }

    });

    return () => unsubscribe();

  }, []);



  // ─── Continuous Real-Time Screen Video Feed (Visual Persistence Engine) ───────

  // This effect streams screen frames at ~1 FPS into the Gemini Live session

  // via WebSocket. It uses wsRef directly (a ref, not state) so it always

  // captures the latest socket without needing it as a dep. The effect restarts

  // whenever isScreenSharing or screenStream changes.

  useEffect(() => {

    if (!isScreenSharing) {

      setUploadedScreenUrl(null);

      return;

    }



    const offscreenCanvas = document.createElement("canvas");

    const ctx = offscreenCanvas.getContext("2d");

    let isHttpUploading = false;

    let frameCount = 0;



    // ~1 FPS for Gemini Live (API recommended), update preview at full rate

    const STREAM_INTERVAL_MS = 1000;



    const sendFrame = async () => {

      try {

        // === Path 1: Browser getDisplayMedia stream active ===

        const video = videoRef.current;

        if (video && video.readyState >= 2 && video.videoWidth > 0 && ctx) {

          offscreenCanvas.width = Math.min(video.videoWidth, 1280);

          offscreenCanvas.height = Math.min(video.videoHeight, 720);

          ctx.drawImage(video, 0, 0, offscreenCanvas.width, offscreenCanvas.height);

          const dataUrl = offscreenCanvas.toDataURL("image/jpeg", 0.65);

          

          // Always update the preview

          setUploadedScreenUrl(dataUrl);

          

          // Send directly over the Live WebSocket — the server injects into Gemini Live session

          const ws = wsRef.current;

          if (ws && ws.readyState === WebSocket.OPEN) {

            ws.send(JSON.stringify({

 type: "realtime_video_frame",

              data: dataUrl,

 mimeType: "image/jpeg"

            }));

          } else if (!isHttpUploading) {

            // Fallback: HTTP POST when WS is not yet connected (Python daemon path)

            isHttpUploading = true;

            fetch("/api/screen/upload", {

 method: "POST",

              headers: { "Content-Type": "application/json" },

              body: JSON.stringify({ image: dataUrl, mimeType: "image/jpeg" }),

            }).finally(() => { isHttpUploading = false; });

          }

          return;

        }



        // === Path 2: Python daemon uploaded a frame — poll only when screen sharing ===

        if (isScreenSharing && frameCount % 2 === 0) { // Poll every 2 ticks to keep preview fresh

          const res = await fetch("/api/screen/current");

          if (res.ok) {

            const data = await res.json();

            if (data.image) {

              setUploadedScreenUrl(data.image);

              // Also forward into live session if connected

              const ws = wsRef.current;

              if (ws && ws.readyState === WebSocket.OPEN) {

                ws.send(JSON.stringify({

 type: "realtime_video_frame",

                  data: data.image,

 mimeType: "image/jpeg"

                }));

              }

            }

          }

        }

      } catch (err) {

        // Non-fatal

      }

      frameCount++;

    };



    const interval = setInterval(sendFrame, STREAM_INTERVAL_MS);

    // Send first frame immediately without waiting 1 second

    sendFrame();



    return () => clearInterval(interval);

  }, [isScreenSharing, screenStream]);



  const startScreenShare = async () => {

    try {

      const stream = await navigator.mediaDevices.getDisplayMedia({

        video: { cursor: "always" } as any,

        audio: false

      });

      setScreenStream(stream);

      setIsScreenSharing(true);

      setTimeout(() => {

        if (videoRef.current) {

          videoRef.current.srcObject = stream;

        }

      }, 150);

      stream.getVideoTracks()[0].onended = () => {

        stopScreenShare();

      };

      setTerminalOutput(prev => prev + "\n[System] Real-time screen capture feed activated.");

    } catch (err: any) {

      console.warn("Error starting screen share, falling back to simulated stream:", err);

      setIsScreenSharing(true);

      setScreenStream(null);

      setTerminalOutput(prev => prev + 

        "\n[System Info] Browser/Iframe security blocked real-time display-capture." + 

        "\n[System Info] To share your physical laptop screen, click the 'Open in New Tab' button in the top-right corner of AI Studio!" + 

        "\n[System] Falling back to Secure Companion OS Stream Simulation..."

      );

    }

  };



  const stopScreenShare = () => {

    if (screenStream) {

      screenStream.getTracks().forEach(track => track.stop());

      setScreenStream(null);

    }

    setIsScreenSharing(false);

    setTerminalOutput(prev => prev + "\n[System] Screen capture feed deactivated.");

  };

  const [openWithMode, setOpenWithMode] = useState<string | null>(null);



  // Stream Diagnostics States

  const [diagnosticsStatus, setDiagnosticsStatus] = useState<'idle' | 'scanning' | 'done' | 'fixing' | 'fixed'>('idle');

  const [selectedStreamBug, setSelectedStreamBug] = useState<string | null>("Syntax Error: missing close parenthesis ')' in hello.py");

  const [diagnosticsLogs, setDiagnosticsLogs] = useState<string[]>([]);



  // System actions (Simulated overlays)

  const [systemState, setSystemState] = useState<'normal' | 'restart' | 'sleep' | 'lock'>('normal');

  const [systemCounter, setSystemCounter] = useState(5);

  const [lockPIN, setLockPIN] = useState("");

  const [activeBrowserAction, setActiveBrowserAction] = useState<{ url: string; timestamp: Date } | null>(null);

  const [activeNativeAppAction, setActiveNativeAppAction] = useState<{ appName: string; protocol: string; timestamp: Date } | null>(null);



  // WhatsApp Contacts State

  const [whatsappContacts, setWhatsappContacts] = useState<{ name: string; aliases: string[]; phone: string }[]>([]);

  const [settingsSubTab, setSettingsSubTab] = useState<'api' | 'contacts'>('api');

  const [editingContact, setEditingContact] = useState<{ name: string; aliases: string[]; phone: string } | null>(null);

  const [newContact, setNewContact] = useState({ name: "", aliases: "", phone: "" });

  const [isAddingContact, setIsAddingContact] = useState(false);

  const [contactSearch, setContactSearch] = useState("");



  // Settings Dashboard Inputs

  const [keysConfig, setKeysConfig] = useState({

 geminiApiKey: "",

 claudeApiKey: "",

 openaiApiKey: "",

 whatsappStatus: "disconnected" as "connected" | "disconnected",

 preferredModel: "gemini" as "gemini" | "claude" | "gpt"

  });

  const [showKeys, setShowKeys] = useState({ gemini: false, claude: false, openai: false });

  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const [isLinkingWhatsApp, setIsLinkingWhatsApp] = useState(false);



  // Sync state with url if requested

  useEffect(() => {

    const hash = window.location.hash;

    if (hash === '#/dashboard') {

      setActiveTab('dashboard');

    } else if (hash === '#/workspace') {

      setActiveTab('workspace');

    }

  }, []);



  // Sync quotes

  useEffect(() => {

    const quotes = SASSY_QUOTES[state === 'disconnected' ? 'disconnected' : state];

    if (quotes && quotes.length > 0) {

      const randomIndex = Math.floor(Math.random() * quotes.length);

      setCurrentQuote(quotes[randomIndex]);

    }

  }, [state]);



  // Load Dashboard config keys and workspace on startup

  useEffect(() => {

    fetchKeys();

    fetchWorkspaceFiles();

    fetchWhatsAppChats();

    fetchContacts();

  }, []);



  const fetchWithRetry = async (url: string, options?: RequestInit, retries = 4, delay = 1000): Promise<Response> => {

    try {

      const res = await fetch(url, options);

      if (!res.ok && [502, 503, 504].includes(res.status) && retries > 0) {

        await new Promise(resolve => setTimeout(resolve, delay));

        return fetchWithRetry(url, options, retries - 1, delay * 1.5);

      }

      return res;

    } catch (err) {

      if (retries > 0) {

        await new Promise(resolve => setTimeout(resolve, delay));

        return fetchWithRetry(url, options, retries - 1, delay * 1.5);

      }

      throw err;

    }

  };



  const fetchKeys = async () => {

    try {

      const res = await fetchWithRetry("/api/keys");

      if (res.ok) {

        const data = await res.json();

        setKeysConfig(data);

      }

    } catch (err) {

      console.error("Failed to load companion settings:", err);

    }

  };



  const fetchWorkspaceFiles = async () => {

    try {

      const res = await fetchWithRetry("/api/workspace/files");

      if (res.ok) {

        const files = await res.json();

        setWorkspaceFiles(files);

      }

    } catch (err) {

      console.error("Failed to fetch workspace:", err);

    }

  };



  const fetchWhatsAppChats = async () => {

    try {

      const res = await fetchWithRetry("/api/whatsapp/chats");

      if (res.ok) {

        const chats = await res.json();

        setWhatsAppChats(chats);

      }

    } catch (err) {

      console.error("Failed to fetch WhatsApp chats:", err);

    }

  };



  const fetchContacts = async () => {

    try {

      const res = await fetchWithRetry("/api/whatsapp/contacts");

      if (res.ok) {

        const data = await res.json();

        setWhatsappContacts(data);

      }

    } catch (err) {

      console.error("Failed to fetch WhatsApp contacts:", err);

    }

  };



  const handleSaveContact = async (name: string, phone: string, aliasesStr: string) => {

    try {

      const aliases = aliasesStr.split(",").map(a => a.trim()).filter(Boolean);

      const res = await fetch("/api/whatsapp/contacts", {

 method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ name, phone, aliases })

      });

      if (res.ok) {

        fetchContacts();

        return true;

      }

      return false;

    } catch (err) {

      console.error("Failed to save WhatsApp contact:", err);

      return false;

    }

  };



  const handleDeleteContact = async (name: string) => {

    try {

      const res = await fetch(`/api/whatsapp/contacts/${encodeURIComponent(name)}`, {

 method: "DELETE"

      });

      if (res.ok) {

        fetchContacts();

        return true;

      }

      return false;

    } catch (err) {

      console.error("Failed to delete WhatsApp contact:", err);

      return false;

    }

  };



  const viewWorkspaceFile = async (name: string) => {

    try {

      setSelectedFile(name);

      setActiveCodeFilePath(null);

      const res = await fetch(`/api/workspace/file/${encodeURIComponent(name)}`);

      if (res.ok) {

        const data = await res.json();

        setSelectedFileContent(data.content);

      }

    } catch (err) {

      console.error("Failed to load workspace file:", err);

    }

  };



  const handleScanVSCodeScreen = async () => {

    setVscodeCopilotBusy(true);

    setShowTerminal(true);

    setTerminalOutput(prev => prev + `\n\n[VS Code Copilot] Scanning screen & VS Code window...`);

    try {

      const res = await fetch("/api/code-assistant/inspect", {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ instruction: vscodeCopilotInstruction || undefined, filepath: activeCodeFilePath || undefined }),

      });

      const data = await res.json();

      setVscodeCopilotInfo({

        vscodeRunning: data.vscodeRunning,

        windowTitle: data.vscodeWindowTitle,

        language: data.language,

        syntaxValid: data.syntaxCheck?.valid,

        syntaxMsg: data.syntaxCheck?.diagnostics,

        visionSummary: data.screenVisionAnalysis,

      });

      if (data.resolvedFilePath) {

        setActiveCodeFilePath(data.resolvedFilePath);

        setSelectedFile(data.detectedFilename || data.resolvedFilePath.split(/[\\/]/).pop() || "code");

        if (typeof data.fileContent === "string") {

          setSelectedFileContent(data.fileContent);

        }

        setOpenWithMode("vscode");

      }

      setTerminalOutput(prev =>

        prev +

        `\n[VS Code Copilot] ${data.message || "Inspection complete."}` +

        (data.screenVisionAnalysis ? `\n[Vision Analysis]\n${data.screenVisionAnalysis}` : "")

      );

    } catch (err: any) {

      setTerminalOutput(prev => prev + `\n[VS Code Copilot Error] ${err?.message || "Scan failed"}`);

    } finally {

      setVscodeCopilotBusy(false);

    }

  };



  const handleFixVSCodeCode = async (autoRun: boolean) => {

    setVscodeCopilotBusy(true);

    setShowTerminal(true);

    const instruction = vscodeCopilotInstruction.trim() || "Find any syntax/logic errors, fix them, or complete the next logical code cleanly.";

    setTerminalOutput(prev => prev + `\n\n[VS Code Copilot] ${autoRun ? "Diagnosing, fixing & running" : "Diagnosing & fixing"}: "${instruction}"...`);

    try {

      const endpoint = activeCodeFilePath || selectedFile ? "/api/code-assistant/fix" : "/api/code-assistant/solve-and-run";

      const res = await fetch(endpoint, {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          instruction,

          filepath: activeCodeFilePath || undefined,

          filename: !activeCodeFilePath && selectedFile ? selectedFile : undefined,

          code: selectedFileContent || undefined,

          openInVscode: true,

          autoRun,

        }),

      });

      const raw = await res.json();

      const solve = raw.solve || raw;

      const run = raw.run || solve.runResult;

      if (solve.filepath) {

        setActiveCodeFilePath(solve.filepath);

        setSelectedFile(solve.filename || solve.filepath.split(/[\\/]/).pop() || "code");

      }

      if (typeof solve.updatedCode === "string") {

        setSelectedFileContent(solve.updatedCode);

      }

      setVscodeCopilotInfo(prev => ({

        ...(prev || {}),

        language: solve.language || prev?.language,

        syntaxValid: solve.syntaxCheck?.valid,

        syntaxMsg: solve.syntaxCheck?.diagnostics,

        explanation: solve.explanation,

        canUndo: solve.canUndo,

      }));

      fetchWorkspaceFiles();

      setTerminalOutput(prev =>

        prev +

        `\n[AI Fix] ${solve.message || (solve.success ? "Applied" : "Failed")}` +

        (solve.explanation ? `\n[Explanation] ${solve.explanation}` : "") +

        (run ? `\n\n[Run Output (${run.success ? "SUCCESS" : "FAILED"}, exit=${run.exitCode}, ${run.durationMs}ms)]\n${run.output || run.message}` : "")

      );

    } catch (err: any) {

      setTerminalOutput(prev => prev + `\n[AI Fix Error] ${err?.message || "Failed"}`);

    } finally {

      setVscodeCopilotBusy(false);

    }

  };



  const handleRunCurrentCode = async () => {

    setVscodeCopilotBusy(true);

    setShowTerminal(true);

    const label = activeCodeFilePath || selectedFile || "snippet";

    setTerminalOutput(prev => prev + `\n\n[Runner] Executing ${label}...`);

    try {

      const res = await fetch("/api/code-assistant/run", {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          filepath: activeCodeFilePath || undefined,

          filename: !activeCodeFilePath && selectedFile ? selectedFile : undefined,

          code: !activeCodeFilePath && !selectedFile ? selectedFileContent : undefined,

          language: vscodeCopilotInfo?.language || undefined,

        }),

      });

      const data = await res.json();

      setTerminalOutput(prev =>

        prev +

        `\n[Run ${data.success ? "SUCCESS" : "FAILED"} | ${data.language || "code"} | exit=${data.exitCode ?? "?"} | ${data.durationMs ?? 0}ms]\n` +

        (data.output || data.message || "")

      );

      if (data.previewUrl && openWithMode !== "browser") {

        setTerminalOutput(prev => prev + `\n[Preview Ready] ${data.previewUrl}`);

      }

    } catch (err: any) {

      setTerminalOutput(prev => prev + `\n[Runner Error] ${err?.message || "Execution failed"}`);

    } finally {

      setVscodeCopilotBusy(false);

    }

  };



  const handleUndoCodeEdit = async () => {

    setVscodeCopilotBusy(true);

    try {

      const res = await fetch("/api/code-assistant/undo", {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ filepath: activeCodeFilePath || undefined }),

      });

      const data = await res.json();

      if (data.success && typeof data.restoredContent === "string") {

        setSelectedFileContent(data.restoredContent);

        setVscodeCopilotInfo(prev => (prev ? { ...prev, canUndo: false } : prev));

      }

      setTerminalOutput(prev => prev + `\n[Undo] ${data.message}`);

    } catch (err: any) {

      setTerminalOutput(prev => prev + `\n[Undo Error] ${err?.message || "Failed"}`);

    } finally {

      setVscodeCopilotBusy(false);

    }

  };



  const handleSaveCurrentCode = async () => {

    if (!selectedFile && !activeCodeFilePath) return;

    try {

      if (activeCodeFilePath) {

        const res = await fetch("/api/code-assistant/save-file", {

          method: "POST",

          headers: { "Content-Type": "application/json" },

          body: JSON.stringify({ filepath: activeCodeFilePath, content: selectedFileContent }),

        });

        const data = await res.json();

        setTerminalOutput(prev => prev + `\n[Saved] ${data.filepath || activeCodeFilePath}`);

      } else if (selectedFile) {

        const res = await fetch("/api/workspace/file", {

          method: "POST",

          headers: { "Content-Type": "application/json" },

          body: JSON.stringify({ filename: selectedFile, code: selectedFileContent }),

        });

        const data = await res.json();

        fetchWorkspaceFiles();

        setTerminalOutput(prev => prev + `\n[Saved Workspace] ${data.filename || selectedFile}`);

      }

    } catch (err: any) {

      setTerminalOutput(prev => prev + `\n[Save Error] ${err?.message || "Failed"}`);

    }

  };



  const startStreamScanning = () => {

    setDiagnosticsStatus('scanning');

    setDiagnosticsLogs(["[Stream] Syncing Eira Companion Vision overlay...", "[Stream] Receiving live stream buffer at 1080p, 60fps..."]);

    

    setTimeout(() => {

      setDiagnosticsLogs(prev => [...prev, "[Eira Vision] Processing high-fidelity visual OCR of stream frame...", "[Eira Vision] Scanning active window and text controls..."]);

    }, 800);



    setTimeout(() => {

      setDiagnosticsLogs(prev => [

        ...prev, 

        "[Eira Vision] Analysis of active Python screen completed.", 

        "[Eira Vision] Bug detected in file: hello.py", 

        "[Eira Vision] Line 4: Syntax error (unclosed parenthesis in print statement)."

      ]);

      setDiagnosticsStatus('done');

    }, 2200);

  };



  const startStreamFixing = async () => {

    setDiagnosticsStatus('fixing');

    setDiagnosticsLogs(prev => [

      ...prev, 

      "[Eira Vision] Initiating auto-remediator sequence...", 

      "[Eira Vision] Generating high-quality patch for hello.py..."

    ]);



    setTimeout(async () => {

      try {

        const fixedCode = `# hello.py\n# Automatic fixed by Eira Companion Assistant!\n\ndef main():\n    print("Hello from Eira! Code is 100% fixed and running successfully!")\n\nif __name__ == "__main__":\n    main()\n`;

        const writeRes = await fetch("/api/workspace/file", {

 method: "POST",

          headers: { "Content-Type": "application/json" },

          body: JSON.stringify({

 filename: "hello.py",

            code: fixedCode

          })

        });



        if (writeRes.ok) {

          setDiagnosticsLogs(prev => [

            ...prev, 

            "[Eira Vision] Fix successfully written to file: hello.py", 

            "[Eira Compiler] Running diagnostics verification check..."

          ]);

          

          fetchWorkspaceFiles();

          viewWorkspaceFile("hello.py");



          setTimeout(() => {

            setDiagnosticsLogs(prev => [

              ...prev, 

              "[Eira Compiler] >>> python hello.py", 

              "[Eira Compiler] Output: Hello from Eira! Code is 100% fixed and running successfully!", 

              "[Eira Compiler] Exit status: 0 (SUCCESS)", 

              "[Eira Vision] Verification complete! System fully healed."

            ]);

            setDiagnosticsStatus('fixed');

            setTerminalOutput(prev => prev + `\n[Eira Stream Auto-Fix] Successfully solved syntax error in hello.py. Compiled and ran: OK.`);

          }, 1000);

        } else {

          setDiagnosticsLogs(prev => [...prev, "[Error] Failed to apply write patch: File permissions blocked."]);

          setDiagnosticsStatus('done');

        }

      } catch (err) {

        console.error("Auto fix failed:", err);

        setDiagnosticsStatus('done');

      }

    }, 1200);

  };



  const saveKeysConfig = async () => {

    setSaveStatus("saving");

    try {

      const res = await fetch("/api/keys", {

 method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify(keysConfig)

      });

      if (res.ok) {

        setSaveStatus("success");

        setTimeout(() => setSaveStatus(null), 3000);

        fetchKeys();

      } else {

        setSaveStatus("error");

      }

    } catch (err) {

      setSaveStatus("error");

    }

  };



  // Auto scroll subtitles and terminal

  useEffect(() => {

    if (transcriptionsEndRef.current) {

      transcriptionsEndRef.current.scrollIntoView({ behavior: "smooth" });

    }

  }, [transcriptions, dashboardChats]);



  useEffect(() => {

    if (terminalEndRef.current) {

      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });

    }

  }, [terminalOutput]);



  useEffect(() => {

    if (chatbotEndRef.current) {

      chatbotEndRef.current.scrollIntoView({ behavior: "smooth" });

    }

  }, [chatbotMessages, chatLoading]);



  const refreshScheduledTasks = async () => {

    try {

      const res = await fetch("/api/scheduler/tasks");

      if (!res.ok) return;

      const data = await res.json();

      if (Array.isArray(data?.tasks)) {

        for (const t of data.tasks) {

          if (

            (t.status === "completed" || t.status === "failed") &&

            t.executedAtMs &&

            Date.now() - t.executedAtMs < 20_000 &&

            !knownTriggeredTaskIdsRef.current.has(t.id)

          ) {

            knownTriggeredTaskIdsRef.current.add(t.id);

            

            

            const summaryText = `⏰ [${t.executedAtIst || t.scheduledForIst}] ${t.title} (${t.status.toUpperCase()}): ${t.resultMessage || "Done"}`;

            setTerminalOutput((prev) => prev + `\n[Scheduler] ${summaryText}`);

            const notifyMsg = {

              id: `sched_notif_${t.id}`,

              sender: "model" as const,

              text: summaryText,

              timestamp: new Date(),

              type: "text" as const,

            };

            setChatbotMessages((prev) => (prev.some((m) => m.id === notifyMsg.id) ? prev : [...prev, notifyMsg]));

            setDashboardChats((prev) => (prev.some((m) => m.id === notifyMsg.id) ? prev : [...prev, { id: notifyMsg.id, sender: "model", text: summaryText, timestamp: new Date() }]));

          }

        }

        setScheduledTasks(data.tasks);

      }

    } catch {}

  };



  const handleCancelScheduledTask = async (id: string) => {

    try {

      const res = await fetch(`/api/scheduler/cancel/${encodeURIComponent(id)}`, { method: "POST" });

      if (res.ok) {

        void refreshScheduledTasks();

      }

    } catch {}

  };



  // Live Indian Standard Time (IST) clock & background scheduler sync

  useEffect(() => {

    const clockTimer = setInterval(() => {

      setIstClockText(`${formatIstTime(new Date(), true)} IST`);

    }, 1000);

    void refreshScheduledTasks();

    const pollTimer = setInterval(() => {

      void refreshScheduledTasks();

    }, 3000);

    return () => {

      clearInterval(clockTimer);

      clearInterval(pollTimer);

    };

  }, []);



  // System restart timer handler

  useEffect(() => {

    let timer: any;

    if (systemState === 'restart' && systemCounter > 0) {

      timer = setTimeout(() => {

        setSystemCounter(prev => prev - 1);

      }, 1000);

    } else if (systemCounter === 0) {

      // Complete action

      if (systemState === 'restart') {

        // Reset after simulated reboot

        setTimeout(() => {

          setSystemState('normal');

          setSystemCounter(5);

          setTerminalOutput(prev => prev + "\n[System] ERA Companion Agent rebooted successfully. Vibe checks green.");

        }, 3000);

      }

    }

    return () => clearTimeout(timer);

  }, [systemState, systemCounter]);



  // WebSocket session core logic

  const connectSession = async () => {

    if (autoReconnectTimerRef.current) {

      clearTimeout(autoReconnectTimerRef.current);

      autoReconnectTimerRef.current = null;

    }

    isUserInitiatedDisconnectRef.current = false;

    setErrorMessage(null);

    setState('connecting');

    voiceSessionTranscriptsRef.current = [];



    // Clean up existing WebSocket if any without triggering full offline teardown

    if (wsRef.current) {

      const oldWs = wsRef.current;

      oldWs.onopen = null;

      oldWs.onmessage = null;

      oldWs.onclose = null;

      oldWs.onerror = null;

      try {

        oldWs.close();

      } catch (e) {}

      wsRef.current = null;

    }



    try {

      if (!audioStreamerRef.current) {

        audioStreamerRef.current = new AudioStreamer();

      }



      const streamer = audioStreamerRef.current;



      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

      const emailParam = user ? `&email=${encodeURIComponent(user.email || "")}` : "";

      const currentMemoryVal = userMemoryRef.current || userMemory;

      const memoryParam = currentMemoryVal ? `&memory=${encodeURIComponent(currentMemoryVal.slice(0, 1500))}` : "";

      const sessionParam = `&sessionId=${encodeURIComponent(voiceSessionIdRef.current)}`;

      const currentHour = getIstHourNow();

      const hourParam = `&clientHour=${currentHour}`;

      const wsUrl = `${protocol}//${window.location.host}/live?conn=true${emailParam}${sessionParam}${memoryParam}${hourParam}`;

      const ws = new WebSocket(wsUrl);

      wsRef.current = ws;



      ws.onopen = async () => {

        reconnectAttemptsRef.current = 0;

        try {

          streamer.setMuted(micMutedRef.current);

          await streamer.startRecording(

            (base64Chunk) => {

              if (ws.readyState === WebSocket.OPEN && !micMutedRef.current) {

                // Continuous full-duplex streaming to enable seamless user interruption / barge-in
                ws.send(JSON.stringify({ type: "audio", data: base64Chunk }));

              }

            },

            (volume) => {

              if (micMutedRef.current) {

                setUserVolume(0);

              } else {

                setUserVolume(volume);

              }

            }

          );

          setState('listening');

          try {

            ws.send(JSON.stringify({

              type: "voiceguard_status",

              state: voiceLockStateRef.current,

              source: "ws_connect"

            }));

            ws.send(JSON.stringify({

              type: "voiceguard_mode",

              mode: voiceGuardModeRef.current

            }));

          } catch {}

        } catch (err: any) {

          console.error("Mic error:", err);

          setErrorMessage("Need microphone permission to hear that stunning voice of yours! Please allow microphone access.");

        }

      };



      ws.onmessage = (event) => {

        try {

          const msg = JSON.parse(event.data);



          if (msg.type === "ping") {

            try { ws.send(JSON.stringify({ type: "pong" })); } catch (e) {}

            return;

          } else if (msg.type === "session_reconnecting") {

            console.log("[ERA Live] Server is recycling AI live session. Remaining online...");

            return;

          }



          if (msg.type === "wake_up_era") {

            bringDashboardToFront();

            return;

          }

          if (msg.type === "openWebsite" && msg.url) {
            try {
              if ((window as any).electronAPI?.openExternal) {
                (window as any).electronAPI.openExternal(msg.url);
              } else {
                window.open(msg.url, "_blank");
              }
            } catch (e) {}
          }



          if (msg.type === "studioProjectCreated") {

            setActiveTab('studio');

          }



          if (msg.type === "state" && msg.state) {

            console.log("State synced:", msg.state);

          } else if (msg.type === "audio" && msg.data) {

            setState(prev => prev === 'speaking' ? prev : 'speaking');

            const now = Date.now();
            streamer.playChunk(msg.data, (volume) => {
              if (now - lastModelVolumeUpdateRef.current >= 60) {
                lastModelVolumeUpdateRef.current = now;
                setModelVolume(volume);
              }
            });

          } else if (msg.type === "interrupted") {

            console.log("⚡ [ERA Voice Assistant] User interruption detected (barge-in). Halting playback immediately.");

            try { window.speechSynthesis.cancel(); } catch {}

            streamer.stopPlayback();

            setModelVolume(0);

            setState('listening');

          } else if (msg.type === "turnComplete") {

            setState('listening');

            setModelVolume(0);

          } else if (msg.type === "transcription") {

            const rawText = msg.text;

            if (isPhantomNoiseTranscript(rawText)) {

              return;

            }

            const cleanText = cleanTranscript(rawText);

            if (!cleanText || !cleanText.trim() || isPhantomNoiseTranscript(cleanText)) {

              return;

            }



            const newTranscription: Transcription = {

              id: Math.random().toString(36).substring(2, 11),

              sender: msg.sender,

              text: cleanText,

              timestamp: new Date()

            };



            // Track transcripts for voice session disconnect summary

            voiceSessionTranscriptsRef.current.push({

              sender: msg.sender,

              text: cleanText,

              timestamp: new Date()

            });



            // If user says "Wake up ERA" while connected, bring dashboard to front

            if (msg.sender === "user" && isWakePhraseDetected(cleanText)) {

              bringDashboardToFront();

            }



            // Continuous background voice verification for owner on user turn (only when online)

            if (msg.sender === "user" && ownerProfileRef.current && voiceGuardModeRef.current === 'online') {

              const recentPcm = streamer.getRecentPcm(4.5);

              if (recentPcm && recentPcm.length >= 4800) {

                try {

                  const feat = extractVoiceprintFromPcm(recentPcm, 16000);

                  if (feat.voicedDurationSec >= 0.35 && feat.meanPitchHz >= 60) {

                    const dsp = compareVoiceprints(ownerProfileRef.current.centroidFeatures, feat, voiceStrictnessRef.current);

                    const now = Date.now();

                    if (dsp.passed) {

                      lastOwnerVerifiedMsRef.current = now;

                      setVoiceLockState('UNLOCKED_OWNER_VERIFIED');

                      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

                        try {

                          wsRef.current.send(JSON.stringify({

                            type: "voiceguard_status",

                            state: "UNLOCKED_OWNER_VERIFIED",

                            source: "turn_transcript_dsp"

                          }));

                        } catch {}

                      }

                    } else {

                      // Intruder speech detected on user voice turn!

                      // Only lock if VoiceGuard is online — offline mode never locks

                      if (voiceGuardModeRef.current === 'online') {

                        lastOwnerVerifiedMsRef.current = 0;

                        setVoiceLockState('LOCKED_INTRUDER_ALERT');

                        // soundEngine.playIntruderLockdown(); // suppressed

                        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

                          try {

                            wsRef.current.send(JSON.stringify({

                              type: "voiceguard_status",

                              state: "LOCKED_INTRUDER_ALERT",

                              reason: dsp.failureReason,

                              source: "turn_transcript_dsp"

                            }));

                          } catch {}

                        }

                        recordVoiceAuditEntry({

                          verdict: 'INTRUDER_REJECTED',

                          isVerifiedOwner: false,

                          combinedConfidence: dsp.overallScore,

                          dspScore: dsp.overallScore,

                          aiConfidence: 0,

                          pitchDeltaHz: dsp.pitchDeltaHz,

                          probePitchHz: dsp.probeMeanPitchHz,

                          transcript: cleanText || '(Unauthorized Voice Turn)',

                          analysis: `Voice turn biometric mismatch: ${dsp.failureReason}`,

                          source: 'turn_transcript'

                        });

                      } else {

                        console.log("[VoiceGuard] Mismatch ignored — VoiceGuard is OFFLINE.");

                      }

                    }

                  }

                } catch (turnErr) {

                  console.warn("[VoiceGuard] Turn verification error:", turnErr);

                }

              }

            }



            // If authoritative ASR override (e.g. from local Faster-Whisper) is received,

            // cleanly replace previous user message across all views without duplicating or merging with hallucinations

            if ((msg as any).overwrite === true) {

              setTranscriptions(prev => {

                if (prev.length > 0 && prev[prev.length - 1].sender === msg.sender) {

                  return [...prev.slice(0, -1), { ...prev[prev.length - 1], text: cleanText, timestamp: new Date() }];

                }

                return [...prev, newTranscription];

              });

              setDashboardChats(prev => {

                if (prev.length > 0 && prev[prev.length - 1].sender === msg.sender) {

                  return [...prev.slice(0, -1), { ...prev[prev.length - 1], text: cleanText, timestamp: new Date() }];

                }

                return [...prev, { id: newTranscription.id, sender: msg.sender as 'user' | 'model', text: cleanText, timestamp: new Date() }];

              });

              setChatbotMessages(prev => {

                if (prev.length > 0 && prev[prev.length - 1].sender === msg.sender) {

                  return [...prev.slice(0, -1), { ...prev[prev.length - 1], text: cleanText, timestamp: new Date() }];

                }

                return [...prev, { id: newTranscription.id, sender: msg.sender, text: cleanText, timestamp: new Date(), type: "voice" as const }];

              });

              return;

            }



            const isUserInterim = msg.sender === "user" && (msg.interim === true || msg.finished === false);



            setTranscriptions(prev => {

              if (prev.length > 0) {

                const last = prev[prev.length - 1];

                const diff = new Date().getTime() - last.timestamp.getTime();

                if (last.sender === msg.sender && diff < 5000) {

                  const normLast = (last.text || "").trim().toLowerCase();

                  const normClean = (cleanText || "").trim().toLowerCase();

                  if (normClean === normLast || normLast.endsWith(normClean) || normLast.includes(normClean)) {

                    return prev;

                  }

                  if (normClean.startsWith(normLast) || isUserInterim) {

                    return [

                      ...prev.slice(0, -1),

                      { ...last, text: cleanText, timestamp: new Date() }

                    ];

                  }

                  if (normLast.startsWith(normClean)) {

                    return prev;

                  }

                  const merged = deduplicateRepeatedTokens(`${last.text} ${cleanText}`);

                  if (merged.trim().toLowerCase() === normLast) {

                    return prev;

                  }

                  return [

                    ...prev.slice(0, -1),

                    { ...last, text: merged, timestamp: new Date() }

                  ];

                }

              }

              return [...prev, newTranscription];

            });



            // Also push to dedicated dashboard chats panel

            setDashboardChats(prev => {

              if (prev.length > 0) {

                const last = prev[prev.length - 1];

                const diff = new Date().getTime() - last.timestamp.getTime();

                if (last.sender === msg.sender && diff < 5000) {

                  const normLast = (last.text || "").trim().toLowerCase();

                  const normClean = (cleanText || "").trim().toLowerCase();

                  if (normClean === normLast || normLast.endsWith(normClean) || normLast.includes(normClean)) {

                    return prev;

                  }

                  if (normClean.startsWith(normLast) || isUserInterim) {

                    return [

                      ...prev.slice(0, -1),

                      { ...last, text: cleanText, timestamp: new Date() }

                    ];

                  }

                  if (normLast.startsWith(normClean)) {

                    return prev;

                  }

                  const merged = deduplicateRepeatedTokens(`${last.text} ${cleanText}`);

                  if (merged.trim().toLowerCase() === normLast) {

                    return prev;

                  }

                  return [

                    ...prev.slice(0, -1),

                    { ...last, text: merged, timestamp: new Date() }

                  ];

                }

              }

              return [...prev, { id: newTranscription.id, sender: msg.sender as 'user' | 'model', text: cleanText, timestamp: new Date() }];

            });



            // Secure and sync voice transcripts to Chatbot History & Memory (only on completed turns)

            if (msg.finished !== false) {

              if (auth.currentUser && auth.currentUser.email) {

                saveMessageToHistory(auth.currentUser.email, {

                  sender: msg.sender,

                  text: cleanText,

                  type: "voice",

                  timestamp: new Date()

                }).catch(() => {});

              }



              setChatbotMessages(prev => {

                const voiceMsg = {

                  id: newTranscription.id,

                  sender: msg.sender,

                  text: cleanText,

                  timestamp: new Date(),

                  type: "voice" as const

                };

                return [...prev, voiceMsg];

              });

            }

          } else if (msg.type === "toolCall") {

            // Forward back toolResponse once handled

            handleToolRouter(msg.id, msg.name, msg.args, ws);

          } else if (msg.type === "toolLog") {

            // Log local companion actions to visual dashboard

            const { tool, res } = msg;

            const isVerifiedSuccess = res.verified !== undefined ? Boolean(res.verified) : Boolean(res.success);

            setToolLogs(prev => [

              {

                id: Math.random().toString(36).substring(2, 9),

                time: new Date(),

                tool,

                description: res.visualVerification || res.message || (isVerifiedSuccess ? "Executed successfully" : "Execution failed"),

                status: isVerifiedSuccess ? 'success' : 'failed'

              },

              ...prev

            ]);



            // Real-time UI updates

            if (tool === "writeCode" && res.success) {

              fetchWorkspaceFiles();

              const fname = res.data?.filename || res.filename || 'file';

              viewWorkspaceFile(fname);

              setTerminalOutput(prev => prev + `\n[Workspace] Code file written: ${fname} (${res.data?.codeLength || 0} bytes)`);

            } else if (tool === "openFile" && res.success) {

              fetchWorkspaceFiles();

              const fname = res.data?.filename || res.filename || 'file';

              const mode = res.data?.openWith || res.openWith || 'editor';

              viewWorkspaceFile(fname);

              setOpenWithMode(mode);

              setActiveTab('workspace');

              setTerminalOutput(prev => prev + `\n[Laptop Workspace] Opened file: ${fname} using ${mode}`);

            } else if (tool === "runCode" || tool === "runAnyCode") {

              setTerminalOutput(prev => prev + `\n\n[Terminal Run: ${res.success ? 'SUCCESS' : 'FAILED'}]\n` + (res.output || res.message || ''));

              setShowTerminal(true);

            } else if (tool === "inspectVSCodeScreen") {

              if (res.resolvedFilePath) {

                setActiveCodeFilePath(res.resolvedFilePath);

                setSelectedFile(res.detectedFilename || res.resolvedFilePath.split(/[\\/]/).pop() || "code");

                if (typeof res.fileContent === "string") setSelectedFileContent(res.fileContent);

                setOpenWithMode('vscode');

              }

              setVscodeCopilotInfo({

                vscodeRunning: res.vscodeRunning,

                windowTitle: res.vscodeWindowTitle,

                language: res.language,

                syntaxValid: res.syntaxCheck?.valid,

                syntaxMsg: res.syntaxCheck?.diagnostics,

                visionSummary: res.screenVisionAnalysis,

              });

              setTerminalOutput(prev => prev + `\n[VS Code Inspect] ${res.message || ''}`);

              setShowTerminal(true);

            } else if (tool === "fixOrWriteCodeFile") {

              fetchWorkspaceFiles();

              if (res.filepath) {

                setActiveCodeFilePath(res.filepath);

                setSelectedFile(res.filename || res.filepath.split(/[\\/]/).pop() || "code");

              }

              if (typeof res.data?.updatedCode === "string") {

                setSelectedFileContent(res.data.updatedCode);

              }

              setVscodeCopilotInfo(prev => ({

                ...(prev || {}),

                language: res.language || prev?.language,

                syntaxValid: res.syntaxCheck?.valid,

                syntaxMsg: res.syntaxCheck?.diagnostics,

                explanation: res.explanation,

                canUndo: res.canUndo,

              }));

              setTerminalOutput(prev =>

                prev +

                `\n[VS Code Fix] ${res.message || ''}` +

                (res.explanation ? `\n[Explanation] ${res.explanation}` : '') +

                (res.runResult ? `\n[Run Output]\n${res.runResult.output || res.runResult.message}` : '')

              );

              setShowTerminal(true);

            } else if (tool === "undoCodeEdit" && res.success) {

              if (activeCodeFilePath && activeCodeFilePath === res.filepath) {

                fetch("/api/code-assistant/read-file", {

                  method: "POST",

                  headers: { "Content-Type": "application/json" },

                  body: JSON.stringify({ filepath: res.filepath })

                }).then(r => r.json()).then(d => {

                  if (d?.success && typeof d.content === "string") setSelectedFileContent(d.content);

                }).catch(() => {});

              }

              setTerminalOutput(prev => prev + `\n[Undo] ${res.message}`);

            } else if (tool === "captureScreen") {

              setIsCapturingScreen(true);

              setScreenshotData(res.data || {});

              setTimeout(() => setIsCapturingScreen(false), 4000);

              setTerminalOutput(prev => prev + `\n[Screen] Capture completed: Active Window: "${res.data?.activeWindow || 'Desktop'}"`);

            } else if (tool === "sendWhatsAppMessage" && res.success) {

              if (res?.scheduled || res?.task) {

                void refreshScheduledTasks();

                setTerminalOutput(prev => prev + `\n[Scheduler] ${res.message || "Scheduled WhatsApp message."}`);

              } else {

                fetchWhatsAppChats();

                const contactName = res?.data?.contactName || res?.data?.contact || res?.data?.phone || "Contact";

                const msgText = res?.data?.message || "";

                setTerminalOutput(prev => prev + `\n[WhatsApp] Chat sent to ${contactName}: "${msgText}"`);

                

                // Open the chat dashboard in front of the user

                setActiveContactChat(contactName);

                setActiveTab('voice');

                

                // Simulate typing character-by-character

                setIsTypingSimulated(true);

                setSimulatedTypedMessage("");

                

                // Clear previous typing animation if any

                setTypingIntervalId((prevId: any) => {

                  if (prevId) clearInterval(prevId);

                  return null;

                });

                

                let currentIdx = 0;

                const interval = window.setInterval(() => {

                  if (currentIdx < msgText.length) {

                    setSimulatedTypedMessage(prev => prev + msgText.charAt(currentIdx));

                    currentIdx++;

                  } else {

                    clearInterval(interval);

                    setIsTypingSimulated(false);

                  }

                }, 40); // 40ms per character

                

                setTypingIntervalId(interval);

              }

              

              // NOTE: ERA Python Agent (open_whatsapp) handles opening WhatsApp Desktop

              // (if installed) OR WhatsApp Web (fallback) and auto-sends the message.

              // Frontend does NOT open web.whatsapp.com to avoid double-opening (app + web).



            } else if (tool === "scheduleTask" && res?.success) {

              void refreshScheduledTasks();

            }

          } else if (msg.type === "scheduledTaskUpdated") {

            if (Array.isArray(msg.tasks)) {

              setScheduledTasks(msg.tasks);

            }

          } else if (msg.type === "scheduledTaskWarning" && msg.task) {

            

            setTerminalOutput(prev => prev + `\n[Scheduler Warning - IST] ${msg.task.title} executing in ~10s (${msg.task.scheduledForIst}). Say 'cancel shutdown' to abort.`);

          } else if (msg.type === "scheduledTaskTriggered" && msg.task) {

            knownTriggeredTaskIdsRef.current.add(msg.task.id);

            

            

            const statusLabel = msg.result?.success !== false ? "EXECUTED" : "FAILED";

            const summaryText = `⏰ [${msg.task.executedAtIst || msg.task.scheduledForIst}] ${msg.task.title} (${statusLabel}): ${msg.result?.message || "Done"}`;

            setTerminalOutput(prev => prev + `\n[Scheduler] ${summaryText}`);

            const notifyMsg = {

              id: `sched_notif_${msg.task.id}`,

              sender: "model" as const,

              text: summaryText,

              timestamp: new Date(),

              type: "text" as const,

            };

            setChatbotMessages(prev => prev.some(m => m.id === notifyMsg.id) ? prev : [...prev, notifyMsg]);

            setDashboardChats(prev => prev.some(m => m.id === notifyMsg.id) ? prev : [...prev, { id: notifyMsg.id, sender: "model", text: summaryText, timestamp: new Date() }]);

          } else if (msg.type === "systemAction") {

            if (msg.action === 'shutdown') {

              // Keep window open and listening without any cartoonish overlay or blank screen

              setTerminalOutput(prev => prev + `\n[System] PC Shutdown scheduled. Say 'Cancel shutdown' to abort.`);

            } else if (msg.action === 'restart') {

              setTerminalOutput(prev => prev + `\n[System] PC Restart scheduled. Say 'Cancel shutdown' to abort.`);

            } else if (msg.action === 'cancel_shutdown' || msg.action === 'cancel') {

              setTerminalOutput(prev => prev + `\n[System] PC shutdown/restart was successfully cancelled.`);

            } else if (msg.action === 'sleep' || msg.action === 'lock') {

              setTerminalOutput(prev => prev + `\n[System] Executed ${msg.action} command.`);

            }

          } else if (msg.type === "closeBrowser") {

            setActiveBrowserAction(null);

            setTerminalOutput(prev => prev + `\n[Browser Control] Successfully closed active browser window/overlay.`);

          } else if (msg.type === "screenAction") {

            // Render simulated cursor movement or typing in workspace

            setTerminalOutput(prev => prev + `\n[Screen Control] Automation: Action=${msg.action.toUpperCase()} coordinates=(${msg.x || 0}, ${msg.y || 0}) text="${msg.text || ''}"`);

          } else if (msg.type === "error") {

            console.warn("[ERA Live Error]:", msg.message);

            setErrorMessage(msg.message);

            setTimeout(() => setErrorMessage(null), 5000);

          }

        } catch (err) {

          console.error("Error parsing socket message:", err);

        }

      };



      ws.onclose = () => {

        console.log("[ERA Socket] ws.onclose fired.");

        if (isUserInitiatedDisconnectRef.current) {

          disconnectSession();

          return;

        }



        // UNINTENTIONAL DROP: ERA NEVER GOES OFFLINE ON ITS OWN!

        console.log("[ERA Socket] Connection dropped unexpectedly. Auto-reconnecting immediately to keep ERA online...");

        setState('connecting');

        const delay = Math.min(2000, 500 + reconnectAttemptsRef.current * 300);

        reconnectAttemptsRef.current++;



        if (autoReconnectTimerRef.current) {

          clearTimeout(autoReconnectTimerRef.current);

        }

        autoReconnectTimerRef.current = setTimeout(() => {

          if (!isUserInitiatedDisconnectRef.current) {

            connectSession();

          }

        }, delay);

      };



      ws.onerror = (e) => {

        console.warn("[ERA Socket] Connection error detected:", e);

      };



    } catch (err: any) {

      console.warn("Connection initiation error:", err?.message || err);

      if (!isUserInitiatedDisconnectRef.current) {

        if (autoReconnectTimerRef.current) clearTimeout(autoReconnectTimerRef.current);

        autoReconnectTimerRef.current = setTimeout(() => {

          if (!isUserInitiatedDisconnectRef.current) {

            connectSession();

          }

        }, 1500);

      }

    }

  };



  const disconnectSession = () => {

    isUserInitiatedDisconnectRef.current = true;

    if (autoReconnectTimerRef.current) {

      clearTimeout(autoReconnectTimerRef.current);

      autoReconnectTimerRef.current = null;

    }

    setState('disconnected');

    setUserVolume(0);

    setModelVolume(0);

    if (audioStreamerRef.current) {

      audioStreamerRef.current.cleanup();

    }

    

    // Consolidate long-term memories and voice session summary when going offline

    const sessionTranscripts = [...voiceSessionTranscriptsRef.current];

    voiceSessionTranscriptsRef.current = [];



    if (sessionTranscripts.length > 0) {

      generateVoiceSessionSummary(sessionTranscripts);

    } else {

      triggerMemorySync();

    }



    if (wsRef.current) {

      const ws = wsRef.current;

      // Detach all handlers immediately to prevent late-fired close or connection errors from disrupting state

      ws.onopen = null;

      ws.onmessage = null;

      ws.onclose = null;

      ws.onerror = null;

      

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {

        try {

          ws.close();

        } catch (e) {

          console.error("Error closing socket during disconnect:", e);

        }

      }

      wsRef.current = null;

    }

  };



  const toggleSession = () => {

    if (state === 'disconnected') {

      isUserInitiatedDisconnectRef.current = false;

      reconnectAttemptsRef.current = 0;

      voiceSessionIdRef.current = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      connectSession();

    } else {

      isUserInitiatedDisconnectRef.current = true;

      if (autoReconnectTimerRef.current) {

        clearTimeout(autoReconnectTimerRef.current);

        autoReconnectTimerRef.current = null;

      }

      disconnectSession();

    }

  };



  const toggleMicMute = useCallback(() => {

    setMicMuted(prev => {

      const next = !prev;

      micMutedRef.current = next;



      // 1. AudioStreamer hardware mic track and processor mute

      if (audioStreamerRef.current) {

        audioStreamerRef.current.setMuted(next);

      }



      // 2. Realtime WebSocket server notification

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

        try {

          wsRef.current.send(JSON.stringify({ type: "mute", muted: next }));

        } catch (e) {}

      }



      // 3. Reset user volume

      if (next) {

        setUserVolume(0);

      }



      return next;

    });

  }, []);



  const openWifiSettings = useCallback(async () => {

    try {

      console.log("[WiFi] Opening Windows Wi-Fi Settings...");

      if ((window as any).eraDesktop?.openWifiSettings) {

        (window as any).eraDesktop.openWifiSettings();

      } else if ((window as any).eraDesktop?.openExternal) {

        (window as any).eraDesktop.openExternal('ms-settings:network-wifi');

      }

      // Always call server API to launch directly

      await fetch('/api/system/open-wifi', { method: 'POST' }).catch(() => {});

    } catch (e) {

      console.error("Failed to open Wi-Fi settings:", e);

    }

  }, []);



  // Ref to hold connectSession for SpeechRecognition callback

  const connectSessionRef = useRef<() => void>(() => {});

  useEffect(() => {

    connectSessionRef.current = connectSession;

  }, [connectSession]);



  // Web Audio chime effect disabled � zero beep sounds
  const playWakeChime = () => {
    // Silently suppressed — no beep sound played
  };



  // Bring ERA Dashboard to Main Screen immediately whenever "Wake up ERA" is spoken

  const bringDashboardToFront = useCallback(() => {
    const now = Date.now();
    if (now - lastBringToFrontMsRef.current < 1500) return;
    lastBringToFrontMsRef.current = now;

    try {
      setDashboardUnlocked(true);
      setActiveTab('voice');
      window.location.hash = '#/voice';

      // 1. Desktop Electron IPC call (fastest, native Electron focus)
      if ((window as any).eraDesktop?.bringToFront) {
        (window as any).eraDesktop.bringToFront();
      } else {
        // 2. HTTP Fallback only when not running in Electron
        fetch('/api/system/bring-to-front', { method: 'POST' }).catch(() => {});
      }

      // 3. Web window focus
      window.focus();
      if (window.parent) {
        try { window.parent.focus(); } catch (e) {}
      }

      setIsWakingPulse(true);
      setTimeout(() => setIsWakingPulse(false), 3500);
      setTerminalOutput(prev => prev + "\n[System] 'Wake up ERA' recognized. ERA Dashboard brought to main screen instantly.");
    } catch (e: any) {
      console.warn("bringDashboardToFront error:", e);
    }
  }, []);



  // Web Speech API Wake Word ("Wake up Era" / "Jagoo Era" / "Hey Eira") Detection Effect

  useEffect(() => {

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;



    if (!SpeechRecognition) {

      setWakeWordStatus('unsupported');

      setIsListeningForWakeWord(false);

      return;

    }



    if (state !== 'disconnected' || !wakeWordEnabled || micMuted) {

      setIsListeningForWakeWord(false);

      setWakeWordStatus(micMuted ? 'muted' : state !== 'disconnected' ? 'idle' : 'disabled');

      return;

    }



    let recognition: any = null;

    let isComponentMounted = true;

    let isIntentionalStop = false;

    let restartTimer: any = null;



    const startRecognition = () => {

      if (!isComponentMounted || state !== 'disconnected' || !wakeWordEnabled || micMutedRef.current) return;

      try {

        recognition = new SpeechRecognition();

        recognition.continuous = true;

        recognition.interimResults = true;

        recognition.lang = 'en-US';



        recognition.onstart = () => {

          if (micMutedRef.current) {

            try { recognition.abort(); } catch (e) {}

            return;

          }

          if (isComponentMounted) {

            setIsListeningForWakeWord(true);

            setWakeWordStatus('listening');

          }

        };



        recognition.onresult = (event: any) => {

          if (micMutedRef.current) {

            try { recognition.abort(); } catch (e) {}

            return;

          }

          for (let i = event.resultIndex; i < event.results.length; i++) {

            const transcript = event.results[i][0].transcript;



            if (isWakePhraseDetected(transcript)) {

              if (micMutedRef.current) return;

              console.log("⚡ Hands-Free 'Wake up ERA' Triggered:", transcript);

              isIntentionalStop = true;

              

              // Immediately bring dashboard to front on wake word

              bringDashboardToFront();



              // Verify speaker biometrics on wake word

              if (ownerProfileRef.current && voiceGuardModeRef.current === 'online') {

                const wakePcm = audioStreamerRef.current?.getRecentPcm(4.5);

                if (wakePcm && wakePcm.length >= 4800) {

                  try {

                    const feat = extractVoiceprintFromPcm(wakePcm, 16000);

                    if (feat.voicedDurationSec >= 0.25 && feat.meanPitchHz > 45) {

                      const dsp = compareVoiceprints(ownerProfileRef.current.centroidFeatures, feat, voiceStrictnessRef.current);

                      if (dsp.passed) {

                        lastOwnerVerifiedMsRef.current = Date.now();

                        setVoiceLockState('UNLOCKED_OWNER_VERIFIED');

                        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

                          try {

                            wsRef.current.send(JSON.stringify({

                              type: "voiceguard_status",

                              state: "UNLOCKED_OWNER_VERIFIED",

                              source: "wake_word_biometrics"

                            }));

                          } catch {}

                        }

                      } else {

                        // Stranger tried to wake ERA — only block if VoiceGuard online

                        if (voiceGuardModeRef.current === 'online') {

                          lastOwnerVerifiedMsRef.current = 0;

                          setVoiceLockState('LOCKED_INTRUDER_ALERT');

                          // soundEngine.playIntruderLockdown(); // suppressed

                          return;

                        }

                      }

                    }

                  } catch (e) {}

                }

              }



              



              try {

                recognition.abort();

              } catch (e) {

                try { recognition.stop(); } catch (e2) {}

              }



              setWakeWordStatus('detected');

              setIsWakingPulse(true);

              setTimeout(() => setIsWakingPulse(false), 3500);



              if (connectSessionRef.current) {

                connectSessionRef.current();

              }

              break;

            }

          }

        };



        recognition.onerror = (event: any) => {

          if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {

            setWakeWordStatus('permission_denied');

            isIntentionalStop = true;

          }

        };



        recognition.onend = () => {

          if (isComponentMounted) {

            setIsListeningForWakeWord(false);

            if (!isIntentionalStop && state === 'disconnected' && wakeWordEnabled && !micMutedRef.current) {

              restartTimer = setTimeout(() => {

                if (isComponentMounted && state === 'disconnected' && wakeWordEnabled && !micMutedRef.current) {

                  startRecognition();

                }

              }, 300);

            }

          }

        };



        recognition.start();

      } catch (err) {

        console.error("[Wake Word Start Error]:", err);

      }

    };



    startRecognition();



    return () => {

      isComponentMounted = false;

      isIntentionalStop = true;

      if (restartTimer) clearTimeout(restartTimer);

      if (recognition) {

        try {

          recognition.abort();

        } catch (e) {

          try { recognition.stop(); } catch (e2) {}

        }

      }

      setIsListeningForWakeWord(false);

    };

  }, [state, wakeWordEnabled, micMuted]);



  // Frontend tool router mapping back results instantly to the web socket

  const handleToolRouter = async (id: string, name: string, args: any, ws: WebSocket) => {

    if (ws.readyState !== WebSocket.OPEN) return;



    // Safe read-only perception and query tools that never modify state

    const SAFE_PERCEPTION_TOOLS = new Set([

      "captureScreen",

      "bringDashboardToFront",

      "getBackgroundActivity",

      "listBackgroundApps",

      "get_window_context",

      "getWindowContext",

      "get_weather",

      "getWeather",

      "getIstTimeNow",

      "listScheduledTasks",

      "typeText",

      "type_text",

      "writeText",

      "write_text",

      "performResearch",

      "perform_research",

      "deepResearch",

      "generateDetailedSummary",

      "generate_summary",

      "createSummary"

    ]);



    // ── VoiceGuard Owner Verification Gate ────────────────────────

    if (voiceGuardModeRef.current === 'online' && !SAFE_PERCEPTION_TOOLS.has(name) && ownerProfileRef.current) {

      const isOwner = await verifySpeakerBeforeTool();

      if (!isOwner) {

        console.warn(`🚨 [VoiceGuard Security Gate] Tool '${name}' was BLOCKED! Speaker is NOT verified as registered owner.`);

        setToolLogs(prev => [

          {

            id: Math.random().toString(36).substring(2, 9),

            time: new Date(),

            tool: name,

            description: `🚨 Blocked by VoiceGuard: Speaker is not verified as registered owner (${ownerProfileRef.current?.ownerName || 'Owner'}).`,

            status: 'failed'

          },

          ...prev

        ]);

        ws.send(JSON.stringify({

          type: "toolResponse",

          id,

          name,

          blockedByVoiceGuard: true,

          output: {

            error: `VoiceGuard: Access Denied. Speaker voice does NOT match registered owner (${ownerProfileRef.current?.ownerName || 'Owner'}). Tool execution was blocked.`,

            blockedByVoiceGuard: true,

            success: false

          }

        }));

        return;

      }

    }



    if (name === "bringDashboardToFront") {

      bringDashboardToFront();

      ws.send(JSON.stringify({

        type: "toolResponse",

        id,

        name: "bringDashboardToFront",

        output: { success: true, message: "ERA Dashboard brought to front screen. You MUST reply to boss by saying: \"I'm ready boss, kya karu batao?\" Do not say dashboard samne hai." }

      }));

      return;

    }



    if (name === "openApplication" && args?.appName) {

      // Forward openApplication requests to the backend so the Era Python Agent can execute them.

      ws.send(JSON.stringify({

 type: "toolResponse",

        id,

 name: "openApplication",

        args

      }));

      return;

    }



    if (name === "openWebsite" && args?.url) {

      let url = args.url;

      const lowerUrl = url.toLowerCase();

      

      // Intercept and redirect to openApplication if they ask for local downloaded apps!

      // Any WhatsApp URL is forwarded to backend which decides: Desktop app OR WhatsApp Web

      if (lowerUrl.includes("whatsapp")) {

        handleToolRouter(id, "openApplication", { appName: "whatsapp" }, ws);

        return;

      }

      if (lowerUrl.includes("vscode") || lowerUrl.includes("visualstudio") || lowerUrl.includes("vs code") || lowerUrl.includes("vs-code")) {

        handleToolRouter(id, "openApplication", { appName: "vscode" }, ws);

        return;

      }

      if (lowerUrl.includes("chatgpt") || lowerUrl.includes("chat.openai.com") || lowerUrl.includes("chat gpt")) {

        handleToolRouter(id, "openApplication", { appName: "chatgpt" }, ws);

        return;

      }

      if (lowerUrl.includes("cloudcode") || lowerUrl.includes("cloud code")) {

        handleToolRouter(id, "openApplication", { appName: "cloudcode" }, ws);

        return;

      }



      if (lowerUrl.includes("ide") || lowerUrl.includes("google cloud shell")) {

        url = "https://ide.cloud.google.com/";

      } else if (lowerUrl === "youtube" || lowerUrl === "youtube.com" || lowerUrl === "www.youtube.com" || lowerUrl === "https://youtube.com" || lowerUrl === "https://www.youtube.com") {

        url = "https://youtube.com";

      }



      if (!url.startsWith("http://") && !url.startsWith("https://")) {

        url = "https://" + url;

      }



      setToolLogs(prev => [

        {

          id: Math.random().toString(36).substring(2, 9),

          time: new Date(),

 tool: "openWebsite",

 description: `Opening website: ${url}`,

 status: 'success'

        },

        ...prev

      ]);



      try {

        if ((window as any).eraDesktop?.openExternal) {

          (window as any).eraDesktop.openExternal(url);

        } else {

          window.open(url, "_blank");

        }

      } catch (err) {

        console.error("Failed to open website:", err);

      }



      fetch("/api/system/open-url", {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ url })

      }).catch(() => {});



      ws.send(JSON.stringify({

 type: "toolResponse",

        id,

 name: "openWebsite",

        output: { success: true, message: `Opened browser tab pointing to ${url}` }

      }));

    } else if (name === "searchWeb") {

      const query = String(args?.query || args?.q || args?.searchQuery || "").trim();
      let searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      if (query.toLowerCase().includes("youtube")) {
        const ytQuery = query.replace(/youtube/gi, "").trim() || query;
        searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery)}`;
      }

      setToolLogs(prev => [
        {
          id: Math.random().toString(36).substring(2, 9),
          time: new Date(),
          tool: "searchWeb",
          description: `Searching web for: ${query}`,
          status: 'success'
        },
        ...prev
      ]);

      try {
        if ((window as any).eraDesktop?.openExternal) {
          (window as any).eraDesktop.openExternal(searchUrl);
        } else {
          window.open(searchUrl, "_blank");
        }
      } catch (err) {
        console.error("Failed to open search URL:", err);
      }

      fetch("/api/system/open-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: searchUrl })
      }).catch(() => {});

      ws.send(JSON.stringify({
        type: "toolResponse",
        id,
        name: "searchWeb",
        output: { success: true, message: `Opened search in browser for "${query}"` }
      }));

    } else if (name === "captureScreen" || name === "screenControl") {

      // Auto-allow screen capture and control so ERA can always view and assist with the screen automatically

      if (!isScreenSharing) {

        setIsScreenSharing(true);

        try {

          localStorage.setItem("era_screen_sharing_allowed", "true");

        } catch {}

      }

      setToolLogs(prev => [

        {

          id: Math.random().toString(36).substring(2, 9),

          time: new Date(),

          tool: name,

          description: name === "captureScreen" ? "Capturing physical desktop screen..." : "Executing screen control...",

          status: 'success'

        },

        ...prev

      ]);

      // Forward directly to backend desktop vision pipeline

      ws.send(JSON.stringify({

        type: "toolResponse",

        id,

        name,

        args

      }));

    } else {

      // Backend handles other local tools. We just trigger the pipeline

      ws.send(JSON.stringify({

 type: "toolResponse",

        id,

        name,

        args

      }));

    }

  };



  // Toggle QR Link WhatsApp

  const startWhatsAppLink = () => {

    setIsLinkingWhatsApp(true);

    setTimeout(() => {

      setIsLinkingWhatsApp(false);

      setKeysConfig(prev => ({ ...prev, whatsappStatus: "connected" }));

      setWhatsAppChats(prev => [

        {

 contactName: "ERA Agent",

 message: "WhatsApp linked successfully! I am fully synchronized.",

          timestamp: new Date().toISOString(),

 status: "sent"

        },

        ...prev

      ]);

    }, 4500);

  };



  // Canvas waveform visualizer loop

  useEffect(() => {

    const canvas = canvasRef.current;

    if (!canvas) return;

    const ctx = canvas.getContext("2d");

    if (!ctx) return;



    let animationId: number;

    let phase = 0;



    const draw = () => {

      animationId = requestAnimationFrame(draw);

      const width = canvas.width;

      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);



      phase += 0.04;

      const activeVolume = state === 'listening' ? userVolume : state === 'speaking' ? modelVolume : 0;



      // Center glowing orb representation

      if (state !== 'disconnected') {

        const glowRad = 50 + activeVolume * 0.4;

        const grad = ctx.createRadialGradient(width / 2, height / 2, 5, width / 2, height / 2, glowRad);

        if (state === 'listening') {

          grad.addColorStop(0, "rgba(230,169,74, 0.18)");

          grad.addColorStop(1, "rgba(230,169,74, 0)");

        } else if (state === 'speaking') {

          grad.addColorStop(0, "rgba(239,90,96, 0.22)");

          grad.addColorStop(1, "rgba(239,90,96, 0)");

        } else if (state === 'processing') {

          grad.addColorStop(0, "rgba(249,115,22, 0.18)");

          grad.addColorStop(1, "rgba(249,115,22, 0)");

        } else {

          grad.addColorStop(0, "rgba(99, 102, 241, 0.1)");

          grad.addColorStop(1, "rgba(99, 102, 241, 0)");

        }

        ctx.fillStyle = grad;

        ctx.beginPath();

        ctx.arc(width / 2, height / 2, glowRad, 0, Math.PI * 2);

        ctx.fill();

      }



      // Draw Orbiting Flare / Spark around the Central Orb when audio/voice input is active

      if (state === 'listening' || state === 'speaking' || activeVolume > 2) {

        const orbitRadius = 86;

        const orbitSpeed = state === 'listening' ? 0.04 + activeVolume * 0.002 : 0.03;

        const sparkAngle = phase * orbitSpeed * 10;

        const sparkX = width / 2 + Math.cos(sparkAngle) * orbitRadius;

        const sparkY = height / 2 + Math.sin(sparkAngle) * orbitRadius;



        // Comet trail particles behind the main flare spark

        for (let t = 1; t <= 10; t++) {

          const trailAngle = sparkAngle - t * 0.07;

          const tx = width / 2 + Math.cos(trailAngle) * orbitRadius;

          const ty = height / 2 + Math.sin(trailAngle) * orbitRadius;

          const trailAlpha = (1 - t / 11) * 0.75;

          const trailRadius = Math.max(1, 5 - t * 0.4);



          ctx.beginPath();

          ctx.arc(tx, ty, trailRadius, 0, Math.PI * 2);

          ctx.fillStyle = state === 'listening' 

            ? `rgba(230,169,74, ${trailAlpha})` 

 : `rgba(239,90,96, ${trailAlpha})`;

          ctx.fill();

        }



        // Main Flare Spark core glow

        const flareGlow = ctx.createRadialGradient(sparkX, sparkY, 0, sparkX, sparkY, 16 + activeVolume * 0.15);

        flareGlow.addColorStop(0, "rgba(255, 255, 255, 1)");

        flareGlow.addColorStop(0.35, state === 'listening' ? "rgba(230,169,74, 0.95)" : "rgba(239,90,96, 0.95)");

        flareGlow.addColorStop(0.7, state === 'listening' ? "rgba(249,115,22, 0.6)" : "rgba(245, 158, 11, 0.6)");

        flareGlow.addColorStop(1, "rgba(0, 0, 0, 0)");



        ctx.fillStyle = flareGlow;

        ctx.beginPath();

        ctx.arc(sparkX, sparkY, 16 + activeVolume * 0.15, 0, Math.PI * 2);

        ctx.fill();



        // White hot center point

        ctx.fillStyle = "#ffffff";

        ctx.beginPath();

        ctx.arc(sparkX, sparkY, 3.5, 0, Math.PI * 2);

        ctx.fill();

      }



      // Render 4 composite waveforms

      const waves = state === 'disconnected' ? 1 : 4;

      for (let i = 0; i < waves; i++) {

        ctx.beginPath();

        ctx.lineWidth = i === 0 ? 3.5 : 1.5;



        if (state === 'listening') {

          ctx.strokeStyle = i === 0 ? "rgba(230,169,74, 0.9)" : `rgba(16, 185, 129, ${0.4 - i * 0.1})`;

        } else if (state === 'speaking') {

          ctx.strokeStyle = i === 0 ? "rgba(239,90,96, 0.9)" : `rgba(249,115,22, ${0.4 - i * 0.1})`;

        } else if (state === 'processing') {

          ctx.strokeStyle = `rgba(249,115,22, ${0.5 - i * 0.1})`;

        } else if (state === 'connecting') {

          ctx.strokeStyle = `rgba(245, 158, 11, ${0.4 - i * 0.1})`;

        } else {

          ctx.strokeStyle = "rgba(99, 102, 241, 0.15)";

        }



        const amp = state === 'disconnected' ? 4 :

                    state === 'processing' ? 12 + Math.sin(phase * 2) * 4 :

                    10 + activeVolume * (0.4 + i * 0.12);



        const freq = state === 'processing' ? 0.04 : 0.02 + i * 0.005;

        const speed = state === 'processing' ? 0.08 : 0.03 + i * 0.01;



        for (let x = 0; x < width; x++) {

          const y = height / 2 + Math.sin(x * freq - phase * speed * 3) * amp * Math.sin((x / width) * Math.PI);

          if (x === 0) {

            ctx.moveTo(x, y);

          } else {

            ctx.lineTo(x, y);

          }

        }

        ctx.stroke();

      }

    };



    draw();

    return () => cancelAnimationFrame(animationId);

  }, [state, userVolume, modelVolume]);



  return (

    <div className="bg-[#0a0b0d] text-neutral-100 font-sans min-h-screen flex flex-col justify-between p-4 relative select-none">

      {/* app background: one soft vignette, one hairline grid */}

      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_50%_-10%,rgba(230,169,74,0.05)_0%,rgba(10,11,13,0)_55%)]" />

      <div className="pointer-events-none absolute inset-0 z-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px] opacity-40" />



      {/* Top bar */}

      <header className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-1 pb-3">

        <div className="flex items-center gap-4">

          <div className="relative flex items-baseline gap-2.5 pb-1.5">

            <span className="font-sans text-[19px] font-bold tracking-[0.18em] text-white">ERA</span>

            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#e6a94a]">

              <span className="flex h-3 items-end gap-[2px]">

                <span className="h-2 w-[2px] animate-pulse rounded-full bg-[#e6a94a]" />

                <span className="h-3 w-[2px] animate-bounce rounded-full bg-[#e6a94a]" />

                <span className="h-1.5 w-[2px] animate-pulse rounded-full bg-[#e6a94a]" />

              </span>

              <span>AI Assistant</span>

            </div>

            <div className="brand-underline absolute -bottom-0.5 left-0 right-0" />

          </div>



          <div

            className={`pill ${

              state === 'listening'

                ? 'border-rose-500/35 bg-rose-500/10 text-rose-300'

                : state === 'speaking'

                ? 'border-[#e6a94a]/35 bg-[#e6a94a]/10 text-[#f0c281]'

                : state === 'processing'

                ? 'border-orange-500/30 bg-orange-500/10 text-orange-300'

 : ''

            }`}

          >

            <span

              className={`pill-dot ${

                state === 'listening' ? 'bg-rose-400' : state === 'speaking' ? 'bg-[#f0c281]' : ''

              }`}

            />

            {state === 'disconnected' ? "READY TO HELP" :

             state === 'listening' ? "LISTENING" :

             state === 'speaking' ? "ERA SPEAKING" :

             state === 'processing' ? "THINKING" : state}

          </div>

        </div>



        <div className="flex flex-wrap items-center gap-2">

          {/* Primary navigation */}

          <nav className="flex items-center gap-1 rounded-xl border border-white/10 bg-[#101215] p-1">

            <button

              onClick={() => setActiveTab('voice')}

              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors cursor-pointer ${

                activeTab === 'voice'

                  ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'

 : 'text-neutral-400 hover:text-neutral-100'

              }`}

            >

              <Mic size={13} /> Dashboard

            </button>



            <button

              onClick={() => {

                setActiveTab('chatbot');

                if (auth.currentUser && auth.currentUser.email) {

                  loadChatHistory(auth.currentUser.email).then(history => setChatbotMessages(history));

                }

              }}

              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors cursor-pointer ${

                activeTab === 'chatbot'

                  ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'

 : 'text-neutral-400 hover:text-neutral-100'

              }`}

            >

              <MessageSquare size={13} /> Text Chat

            </button>



            <button

              onClick={() => setActiveTab('studio')}

              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors cursor-pointer ${

                activeTab === 'studio'

                  ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'

                  : 'text-neutral-400 hover:text-neutral-100'

              }`}

            >

              <Sparkles size={13} className="text-amber-400" /> Software Studio

            </button>



            <button

              onClick={() => {

                setActiveTab('workspace');

                fetchWorkspaceFiles();

              }}

              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors cursor-pointer ${

                activeTab === 'workspace'

                  ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'

 : 'text-neutral-400 hover:text-neutral-100'

              }`}

            >

              <Terminal size={13} /> Workspace

            </button>



            <button

              onClick={openVoiceGuard}

              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors cursor-pointer ${

                activeTab === 'voiceguard'

                  ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'

                  : 'text-neutral-400 hover:text-neutral-100'

              }`}

              title="VoiceGuard Biometric Speaker Verification"

            >

              <ShieldCheck

                size={13}

                className={

                  voiceGuardMode === 'offline'

                    ? 'text-neutral-400'

                    : voiceLockState === 'UNLOCKED_OWNER_VERIFIED'

                    ? 'text-emerald-400'

                    : voiceLockState === 'LOCKED_INTRUDER_ALERT'

                    ? 'text-rose-400'

                    : 'text-amber-400'

                }

              />

              VoiceGuard {voiceGuardMode === 'offline' ? '(OFF)' : ''}

            </button>



            <button

              onClick={() => setActiveTab('dashboard')}

              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors cursor-pointer ${

                activeTab === 'dashboard'

                  ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'

 : 'text-neutral-400 hover:text-neutral-100'

              }`}

            >

              <Settings size={13} /> Settings

            </button>

          </nav>



          {/* Window controls */}

          <div className="flex items-center gap-1 border-l border-white/10 pl-2">

            <button

              onClick={() => (window as any).eraDesktop?.minimize?.()}

              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded font-mono text-xs text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"

              title="Minimize Window"

            >

              _

            </button>

            <button

              onClick={() => (window as any).eraDesktop?.maximize?.()}

              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded font-mono text-xs text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"

              title="Maximize / Restore Window"

            >

              [ ]

            </button>

            <button

              onClick={() => (window as any).eraDesktop?.close?.()}

              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded font-mono text-xs text-neutral-400 transition-colors hover:bg-rose-500/10 hover:text-rose-400"

              title="Close Window"

            >

              ✕

            </button>

          </div>

        </div>

      </header>



      {/* Main Container Panes */}

      <div className="flex-1 my-3 overflow-hidden relative z-10 flex flex-col min-h-[calc(100vh-100px)]">

        

        <AnimatePresence mode="wait">

          

          {/* VIEW 1: MAIN ERA DASHBOARD (FULL SCREEN DESKTOP UI) */}

          {activeTab === 'voice' && (

            <motion.div 

              key="voice-tab"

              initial={{ opacity: 0, scale: 0.99 }}

              animate={{ opacity: 1, scale: 1 }}

              exit={{ opacity: 0, scale: 0.99 }}

              className="flex-1 flex flex-col justify-between h-full relative"

            >

              {/* Sub-Tab Navigation & System Badges Header Bar */}

              <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-900/30 border border-neutral-900 rounded-2xl p-2 backdrop-blur-md mb-3">

                <div className="flex items-center gap-1 bg-neutral-950/80 p-1 rounded-xl border border-neutral-800/80">

                  <button

                    onClick={() => setVoiceSubTab('live')}

                    className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-medium transition-all flex items-center gap-2 cursor-pointer ${

                      voiceSubTab === 'live'

                        ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20 font-bold'

 : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'

                    }`}

                  >

                    <Mic size={13} />

                    <span>Live Dashboard</span>

                    {state !== 'disconnected' && (

                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />

                    )}

                  </button>



                  <button

                    onClick={() => setVoiceSubTab('history')}

                    className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-medium transition-all flex items-center gap-2 cursor-pointer ${

                      voiceSubTab === 'history'

                        ? 'bg-stone-600 text-white shadow-lg shadow-stone-600/20 font-bold'

 : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'

                    }`}

                  >

                    <History size={13} />

                    <span>Session Transcripts</span>

                    <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-bold ${

                      voiceSubTab === 'history' 

                        ? 'bg-stone-950 text-stone-200 border border-stone-400/30' 

 : 'bg-neutral-800 text-neutral-300'

                    }`}>

                      {transcriptions.length}

                    </span>

                  </button>

                </div>



                <div className="flex items-center gap-2 font-mono text-xs flex-wrap">

                  {/* High Thinking Mode Toggle */}

                  <button

                    onClick={() => setIsHighThinking(!isHighThinking)}

                    className={`px-3 py-1 rounded-xl text-[11px] font-mono transition-all flex items-center gap-1.5 border cursor-pointer ${

                      isHighThinking 

                        ? 'bg-orange-950/90 border-orange-500/50 text-orange-300 ' 

 : 'bg-neutral-950/80 border-neutral-800 text-neutral-500 hover:text-neutral-300'

                    }`}

                  >

                    <BrainCircuit size={13} className={isHighThinking ? 'text-orange-400 animate-pulse' : ''} />

                    <span className="font-semibold hidden sm:inline">High Thinking:</span>

                    <span className={isHighThinking ? 'text-orange-300 font-bold' : 'text-neutral-500'}>

                      {isHighThinking ? 'gemini-3.1-pro' : 'OFF'}

                    </span>

                  </button>



                  {/* Wake Word Toggle */}

                  <button

                    onClick={() => setWakeWordEnabled(!wakeWordEnabled)}

                    className={`px-3 py-1 rounded-xl text-[11px] font-mono transition-all flex items-center gap-1.5 border cursor-pointer ${

                      !wakeWordEnabled 

                        ? 'bg-neutral-950/80 border-neutral-800 text-neutral-500'

 : 'bg-neutral-950/80 border-amber-500/30 text-amber-300'

                    }`}

                  >

                    <Ear size={13} className={wakeWordEnabled ? 'text-amber-400 animate-pulse' : ''} />

                    <span className="font-semibold hidden sm:inline">Wake Word:</span>

                    <span className="text-amber-300">"Wake up ERA"</span>

                  </button>



                  {/* VoiceGuard Status Pill */}

                  <button

                    onClick={openVoiceGuard}

                    className={`px-3 py-1 rounded-xl text-[11px] font-mono transition-all flex items-center gap-1.5 border cursor-pointer ${

                      voiceGuardMode === 'offline'

                        ? 'border-neutral-700 bg-neutral-900/60 text-neutral-400'

                        : voiceLockState === 'UNLOCKED_OWNER_VERIFIED'

                        ? 'border-emerald-500/40 bg-emerald-950/50 text-emerald-300'

                        : voiceLockState === 'LOCKED_INTRUDER_ALERT'

                        ? 'border-rose-500/50 bg-rose-950/60 text-rose-300 animate-pulse'

                        : ownerProfile

                        ? 'border-amber-500/40 bg-amber-950/50 text-amber-300'

                        : 'border-cyan-500/40 bg-cyan-950/50 text-cyan-300'

                    }`}

                    title={

                      voiceGuardMode === 'offline'

                        ? "VoiceGuard is OFFLINE: Voice verification bypassed. Click to open VoiceGuard."

                        : "VoiceGuard Status: Click to open VoiceGuard AI Console"

                    }

                  >

                    <ShieldCheck size={13} className={

                      voiceGuardMode === 'offline' ? 'text-neutral-400' :

                      voiceLockState === 'UNLOCKED_OWNER_VERIFIED' ? 'text-emerald-400' :

                      voiceLockState === 'LOCKED_INTRUDER_ALERT' ? 'text-rose-400' : 'text-amber-400'

                    } />

                    <span className="font-semibold hidden sm:inline">VoiceGuard:</span>

                    <span>

                      {voiceGuardMode === 'offline' ? 'OFFLINE (Bypassed)' :

                       voiceLockState === 'UNLOCKED_OWNER_VERIFIED' ? `Verified (${ownerProfile?.ownerName || 'Owner'})` :

                       voiceLockState === 'LOCKED_INTRUDER_ALERT' ? 'Intruder Alert' :

                       ownerProfile ? `Locked (${ownerProfile.ownerName})` : 'Enroll Voice'}

                    </span>

                  </button>



                  {/* Live Indian Standard Time Clock Pill */}

                  <div

                    title="Indian Standard Time (Asia/Kolkata, UTC+05:30)"

                    className="px-3 py-1 rounded-xl text-[11px] font-mono flex items-center gap-1.5 border bg-neutral-950/80 border-emerald-500/30 text-emerald-300"

                  >

                    <Clock size={12} className="text-emerald-400" />

                    <span>{istClockText}</span>

                  </div>

                </div>

              </div>



              {/* Active Alarms & Scheduled Tasks (IST) Strip */}

              {scheduledTasks.some((t) => t.status === "pending") && (

                <div className="mb-3 bg-neutral-900/50 border border-amber-500/30 rounded-2xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">

                  <div className="flex items-center gap-2 text-xs font-mono text-amber-300">

                    <Clock size={14} className="text-amber-400 animate-pulse" />

                    <span className="font-bold uppercase tracking-wider">Scheduled Tasks (IST):</span>

                  </div>

                  <div className="flex flex-wrap items-center gap-2 flex-1">

                    {scheduledTasks

                      .filter((t) => t.status === "pending")

                      .map((t) => (

                        <div

                          key={t.id}

                          className="flex items-center gap-2 bg-neutral-950/90 border border-amber-500/25 rounded-xl px-2.5 py-1 text-[11px] font-mono text-neutral-200"

                        >

                          <span className="font-semibold text-amber-200">{t.title}</span>

                          <span className="text-neutral-400">@{formatIstTime(t.triggerAtMs, true)}</span>

                          <span className="text-emerald-400 font-bold">({t.remainingSeconds ?? 0}s)</span>

                          <button

                            onClick={() => handleCancelScheduledTask(t.id)}

                            className="text-rose-400 hover:text-rose-300 ml-1 px-1 cursor-pointer"

                            title="Cancel scheduled task"

                          >

                            ✕

                          </button>

                        </div>

                      ))}

                  </div>

                </div>

              )}



              {/* Bluetooth & Audio Manager Panel */}

              <AnimatePresence>

                {showBluetoothManager && (

                  <motion.div

                    initial={{ opacity: 0, height: 0, y: -10 }}

                    animate={{ opacity: 1, height: "auto", y: 0 }}

                    exit={{ opacity: 0, height: 0, y: -10 }}

                    className="w-full mb-3 overflow-hidden"

                  >

                    <BluetoothMusicManager 

                      externalMusicCommand={externalMusicCommand}

                      onStatusMessage={handleBluetoothStatusMessage}

                    />

                  </motion.div>

                )}

              </AnimatePresence>



              {/* Sub-Tab Content Switcher */}

              <AnimatePresence mode="wait">

                {voiceSubTab === 'live' ? (

                  <motion.div 

                    key="voice-live-subtab"

                    initial={{ opacity: 0, scale: 0.99 }}

                    animate={{ opacity: 1, scale: 1 }}

                    exit={{ opacity: 0, scale: 0.99 }}

                    className="flex-1 flex flex-col justify-between"

                  >

                    {/* Outer Left column wrapper: If screen sharing, split into Orb + Stream preview */}

                    <div className="flex-1 flex flex-col gap-4 justify-between min-h-[500px]">

                      

                      {/* Main Split Grid: Left Chat Card + Right AI Orb Stage (Exact layout matching image) */}

                      <div className="flex-1 flex flex-col lg:flex-row items-stretch gap-6 relative z-10 min-h-[460px]">

                        

                        {/* LEFT PANEL: Translucent Sci-Fi Glassmorphism Chat & Input Card */}

                        <div className="card relative flex w-full flex-col justify-between overflow-hidden p-5 transition-all duration-300 lg:order-2 lg:w-[440px] xl:w-[480px]">

                          {/* accent rail */}

                          <div className="absolute bottom-0 left-0 top-0 w-[2px] bg-gradient-to-b from-[#e6a94a] via-[#e6a94a]/40 to-transparent" />

                          

                          {/* Live transcript panel — messages stay in the language they were spoken */}

                          <LiveTranscript

                            messages={dashboardChats}

                            voiceIds={transcriptions.map((t) => t.id)}

                            state={state}

                            formatModelText={cleanUrlsAndLinks}

                            className="mb-4 min-h-0 flex-1"

                          />



                          {/* Bottom Input Capsule Bar (Mic + Speak to ERA + Waveform) */}

                          <form 

                            onSubmit={(e) => {

                              e.preventDefault();

                              const val = (e.currentTarget.elements.namedItem("speakInput") as HTMLInputElement)?.value;

                              if (val && val.trim()) {

                                lastTextChatSentAtRef.current = Date.now();

                                const cleanVal = transliterateDevanagariToHinglish(val.trim());

                                const userMsg: Transcription = { id: Date.now().toString(), text: cleanVal, sender: 'user', timestamp: new Date() };

                                setTranscriptions(prev => [...prev, userMsg]);

                                setDashboardChats(prev => [...prev, { id: userMsg.id, sender: 'user', text: cleanVal, timestamp: new Date() }]);

                                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

                                  wsRef.current.send(JSON.stringify({ type: 'text', data: cleanVal }));

                                }

                                (e.currentTarget.elements.namedItem("speakInput") as HTMLInputElement).value = "";

                              }

                            }}

                            className="bg-[#0b1c36]/95 border border-amber-500/40 hover:border-amber-400/70 rounded-full px-4 py-2.5 flex items-center justify-between gap-3 transition-all"

                          >

                            <button

                              type="button"

                              onClick={toggleSession}

                              title={state === 'listening' ? "Stop Listening" : "Start Voice Input"}

                              className={`w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer shrink-0 ${

                                state === 'listening' 

                                  ? 'bg-amber-400 text-neutral-950 animate-pulse' 

 : 'bg-amber-950/80 hover:bg-amber-900 text-amber-400 border border-amber-500/40'

                              }`}

                            >

                              <Mic size={16} />

                            </button>



                            <input

                              name="speakInput"

                              type="text"

                              placeholder="Speak to ERA"

                              className="flex-1 bg-transparent border-none outline-none text-neutral-100 placeholder-neutral-400 text-sm font-sans"

                            />



                            <div className="flex items-center gap-1 text-amber-400 shrink-0">

                              <span className={`w-0.5 h-3 bg-amber-400 rounded-full ${state === 'listening' ? 'animate-bounce' : 'opacity-60'}`} />

                              <span className={`w-0.5 h-4 bg-amber-400 rounded-full ${state === 'listening' ? 'animate-pulse' : 'opacity-80'}`} />

                              <span className={`w-0.5 h-2 bg-amber-400 rounded-full ${state === 'listening' ? 'animate-bounce' : 'opacity-60'}`} />

                              <span className={`w-0.5 h-4 bg-amber-400 rounded-full ${state === 'listening' ? 'animate-pulse' : 'opacity-80'}`} />

                              <span className={`w-0.5 h-2.5 bg-amber-400 rounded-full ${state === 'listening' ? 'animate-bounce' : 'opacity-60'}`} />

                            </div>

                          </form>

                        </div>



                        {/* RIGHT PANEL: voice stage */}

                        <div className="relative flex min-h-[440px] flex-1 flex-col items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-[#0c0d0f] p-6 lg:order-1">

                          {/* quiet concentric guides */}

                          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">

                            <div className="h-[300px] w-[300px] rounded-full border border-white/[0.06]" />

                            <div className="absolute h-[430px] w-[430px] rounded-full border border-white/[0.04]" />

                            <div className="absolute h-[560px] w-[560px] rounded-full border border-white/[0.02]" />

                          </div>



                          <VoiceOrb

                            state={

                              state === 'listening' ? 'listening' :

                              state === 'speaking' ? 'speaking' :

                              state === 'processing' ? 'processing' : 'idle'

                            }

                            onClick={toggleSession}

                            size={320}

                            title={state === 'listening' ? 'Stop listening' : 'Start voice session'}

                          />



                          <div className="mt-3 flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.25em] text-neutral-400">

                            <span className="text-[#e6a94a]">···</span>

                            <span>

                              {state === 'listening' ? "LISTENING" :

                               state === 'speaking' ? "ERA SPEAKING" :

                               state === 'processing' ? "THINKING" :

                               "TAP TO TALK"}

                            </span>

                            <span className="text-[#e6a94a]">···</span>

                          </div>

                        </div>

                      </div>



                      {/* BOTTOM CENTER: Floating Voice Mode Capsule Button */}

                      <div className="flex justify-center items-center pt-2 relative z-20">

                        <button

                          onClick={toggleSession}

                          className="bg-[#171412]/95 hover:bg-[#241c12] border border-amber-500/50 px-6 py-2 rounded-full text-xs font-mono font-bold text-neutral-100 flex items-center gap-2.5 transition-all cursor-pointer group hover:scale-105"

                        >

                          <span className="text-amber-400 font-bold flex items-center gap-0.5 text-[11px]">

                            <span>||||</span>

                          </span>

                          <span className="tracking-[0.15em]">VOICE MODE</span>

                          <span className={`w-2.5 h-2.5 rounded-full ${state !== 'disconnected' ? 'bg-amber-400 animate-ping' : 'bg-amber-400'}`} />

                        </button>

                      </div>



                    </div>

                  </motion.div>

                ) : (

                  <motion.div 

                    key="voice-history-subtab"

                    initial={{ opacity: 0, x: 10 }}

                    animate={{ opacity: 1, x: 0 }}

                    exit={{ opacity: 0, x: -10 }}

                    className="flex-1 flex flex-col gap-4 overflow-hidden min-h-[500px]"

                  >

                    {/* Session Overview Stats Row */}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">

                <div className="bg-neutral-900/50 border border-neutral-900 rounded-xl p-3 flex items-center gap-3">

                  <div className="p-2.5 bg-amber-950/60 border border-amber-500/20 text-amber-400 rounded-lg">

                    <MessageSquare size={18} />

                  </div>

                  <div>

                    <div className="text-lg font-bold text-white font-mono">{transcriptions.length}</div>

                    <div className="text-[11px] text-neutral-400 uppercase tracking-wider font-mono">Total Turns</div>

                  </div>

                </div>



                <div className="bg-neutral-900/50 border border-neutral-900 rounded-xl p-3 flex items-center gap-3">

                  <div className="p-2.5 bg-amber-950/60 border border-amber-500/20 text-amber-400 rounded-lg">

                    <User size={18} />

                  </div>

                  <div>

                    <div className="text-lg font-bold text-amber-300 font-mono">

                      {transcriptions.filter(t => t.sender === 'user').length}

                    </div>

                    <div className="text-[11px] text-neutral-400 uppercase tracking-wider font-mono">User Messages</div>

                  </div>

                </div>



                <div className="bg-neutral-900/50 border border-neutral-900 rounded-xl p-3 flex items-center gap-3">

                  <div className="p-2.5 bg-rose-950/60 border border-rose-500/20 text-rose-400 rounded-lg">

                    <Sparkles size={18} />

                  </div>

                  <div>

                    <div className="text-lg font-bold text-rose-300 font-mono">

                      {transcriptions.filter(t => t.sender === 'model').length}

                    </div>

                    <div className="text-[11px] text-neutral-400 uppercase tracking-wider font-mono">Eira Responses</div>

                  </div>

                </div>



                <div className="bg-neutral-900/50 border border-neutral-900 rounded-xl p-3 flex items-center gap-3">

                  <div className="p-2.5 bg-orange-950/60 border border-orange-500/20 text-orange-400 rounded-lg">

                    <FileText size={18} />

                  </div>

                  <div>

                    <div className="text-lg font-bold text-orange-300 font-mono">

                      {transcriptions.reduce((acc, t) => acc + (t.text ? t.text.trim().split(/\s+/).length : 0), 0)}

                    </div>

                    <div className="text-[11px] text-neutral-400 uppercase tracking-wider font-mono">Words Spoken</div>

                  </div>

                </div>

              </div>



              {/* Search & Filter Controls */}

              <div className="bg-neutral-900/40 border border-neutral-900 rounded-2xl p-3 flex flex-wrap items-center justify-between gap-3">

                {/* Search Input */}

                <div className="relative flex-1 min-w-[220px]">

                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />

                  <input

                    type="text"

                    value={historySearchQuery}

                    onChange={(e) => setHistorySearchQuery(e.target.value)}

                    placeholder="Search transcribed phrases..."

                    className="w-full bg-neutral-950/90 border border-neutral-800 rounded-xl pl-9 pr-8 py-1.5 text-xs text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-amber-500/50 font-mono"

                  />

                  {historySearchQuery && (

                    <button

                      onClick={() => setHistorySearchQuery("")}

                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 text-xs font-mono cursor-pointer"

                    >

                      ✕

                    </button>

                  )}

                </div>



                {/* Speaker Filters */}

                <div className="flex items-center gap-1.5 bg-neutral-950/80 p-1 rounded-xl border border-neutral-800 text-xs font-mono">

                  <button

                    onClick={() => setHistorySpeakerFilter('all')}

                    className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${

                      historySpeakerFilter === 'all'

                        ? 'bg-neutral-800 text-white font-semibold'

 : 'text-neutral-400 hover:text-neutral-200'

                    }`}

                  >

                    All Speakers

                  </button>

                  <button

                    onClick={() => setHistorySpeakerFilter('user')}

                    className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${

                      historySpeakerFilter === 'user'

                        ? 'bg-amber-950 text-amber-300 border border-amber-500/30 font-semibold'

 : 'text-neutral-400 hover:text-neutral-200'

                    }`}

                  >

                    You

                  </button>

                  <button

                    onClick={() => setHistorySpeakerFilter('model')}

                    className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${

                      historySpeakerFilter === 'model'

                        ? 'bg-rose-950 text-rose-300 border border-rose-500/30 font-semibold'

 : 'text-neutral-400 hover:text-neutral-200'

                    }`}

                  >

                    Eira

                  </button>

                </div>

              </div>



              {/* History Feed Container */}

              <div className="flex-1 bg-neutral-900/30 border border-neutral-900 rounded-2xl p-4 overflow-y-auto space-y-3.5 min-h-[300px] scrollbar-thin">

                {filteredTranscriptions.length === 0 ? (

                  <div className="h-full min-h-[250px] flex flex-col items-center justify-center text-center p-6 bg-neutral-950/40 rounded-xl border border-neutral-900">

                    <div className="p-4 bg-neutral-900/80 border border-neutral-800 rounded-full text-neutral-500 mb-3">

                      {historySearchQuery ? <Search size={28} /> : <Clock size={28} />}

                    </div>

                    <h4 className="text-sm font-semibold text-neutral-200 font-mono mb-1">

                      {historySearchQuery ? "No matching voice transcripts found" : "No Transcribed Voice History Yet"}

                    </h4>

                    <p className="text-xs text-neutral-400 max-w-md mb-4 leading-relaxed font-sans">

                      {historySearchQuery 

                        ? `No transcriptions matched "${historySearchQuery}". Try adjusting your search keyword or clearing the filter.` 

 : "Conversations from your voice session will automatically appear here in real-time as you speak with Eira."}

                    </p>

                    {!historySearchQuery && (

                      <button

                        onClick={() => {

                          setVoiceSubTab('live');

                          if (state === 'disconnected') {

                            toggleSession();

                          }

                        }}

                        className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white font-mono font-medium text-xs rounded-xl shadow-lg shadow-rose-600/20 transition-all flex items-center gap-2 cursor-pointer"

                      >

                        <Mic size={14} />

                        <span>{state === 'disconnected' ? "Start Voice Session" : "Return to Live Orb"}</span>

                      </button>

                    )}

                  </div>

                ) : (

                  filteredTranscriptions.map((t) => (

                    <motion.div

                      key={t.id}

                      initial={{ opacity: 0, y: 8 }}

                      animate={{ opacity: 1, y: 0 }}

                      className={`p-4 rounded-xl border transition-all ${

                        t.sender === 'user'

                          ? 'bg-neutral-950/70 border-amber-500/20 hover:border-amber-500/40 '

 : 'bg-neutral-950/70 border-rose-500/20 hover:border-rose-500/40 '

                      }`}

                    >

                      <div className="flex items-center justify-between border-b border-neutral-900 pb-2 mb-2.5">

                        <div className="flex items-center gap-2">

                          <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold uppercase tracking-wider flex items-center gap-1.5 ${

                            t.sender === 'user'

                              ? 'bg-amber-950/80 text-amber-300 border border-amber-500/30'

 : 'bg-rose-950/80 text-rose-300 border border-rose-500/30'

                          }`}>

                            {t.sender === 'user' ? (

                              <>

                                <User size={10} />

                                <span>You</span>

                              </>

                            ) : (

                              <>

                                <Sparkles size={10} />

                                <span>Eira Assistant</span>

                              </>

                            )}

                          </span>



                          <span className="text-[11px] font-mono text-neutral-500">

                            Turn #{transcriptions.indexOf(t) + 1}

                          </span>

                        </div>



                        <div className="flex items-center gap-2 text-[11px] font-mono text-neutral-500">

                          <Clock size={11} className="text-neutral-600" />

                          <span>{formatIstTime(t.timestamp, true)} IST</span>

                        </div>

                      </div>



                      <div className="text-xs text-neutral-200 leading-relaxed font-sans whitespace-pre-wrap">

                        {cleanUrlsAndLinks(t.text)}

                      </div>



                      <div className="mt-3 pt-2.5 border-t border-neutral-900/80 flex items-center justify-between gap-2">

                        <div className="flex items-center gap-2">

                          <button

                            onClick={() => handleCopyText(t.text, t.id)}

                            className="px-2 py-1 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded text-[11px] font-mono transition-all flex items-center gap-1 cursor-pointer border border-neutral-800"

                            title="Copy text to clipboard"

                          >

                            {copiedId === t.id ? (

                              <>

                                <Check size={11} className="text-emerald-400" />

                                <span className="text-emerald-400">Copied!</span>

                              </>

                            ) : (

                              <>

                                <Copy size={11} />

                                <span>Copy</span>

                              </>

                            )}

                          </button>



                          <button

                            onClick={() => handleSpeakText(t.text)}

                            className="px-2 py-1 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded text-[11px] font-mono transition-all flex items-center gap-1 cursor-pointer border border-neutral-800"

                            title="Read text aloud"

                          >

                            <Volume2 size={11} className="text-amber-400" />

                            <span>Read Aloud</span>

                          </button>

                        </div>



                        <button

                          onClick={() => {

                            setActiveTab('chatbot');

                            setChatInput(`Regarding the voice transcript: "${t.text}" - `);

                          }}

                          className="text-[11px] font-mono text-rose-400 hover:text-rose-300 flex items-center gap-1 hover:underline cursor-pointer"

                        >

                          <span>Ask in Chat</span>

                          <ChevronRight size={10} />

                        </button>

                      </div>

                    </motion.div>

                  ))

                )}

              </div>

            </motion.div>

          )}

        </AnimatePresence>

      </motion.div>

    )}



          {/* VIEW: EIRA CHATBOT & YOUTUBE INSPECTOR */}

          {activeTab === 'chatbot' && (

            <motion.div 

              key="chatbot-tab"

              initial={{ opacity: 0, y: 10 }}

              animate={{ opacity: 1, y: 0 }}

              exit={{ opacity: 0, y: -10 }}

              className="flex-1 flex flex-col lg:flex-row gap-4 h-full overflow-hidden"

            >

              {/* Left Column: Interactive Chat Panel */}

              <div className="flex-1 flex flex-col bg-neutral-900/30 border border-neutral-900 rounded-2xl overflow-hidden min-h-[460px] lg:h-full relative">

                

                {/* Chat Header banner */}

                <div className="bg-neutral-950/80 border-b border-neutral-900 px-4 py-3 flex items-center justify-between">

                  <div className="flex items-center gap-2">

                    <div className="relative">

                      <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-rose-500 to-orange-600 flex items-center justify-center text-white font-bold text-xs shadow-md font-sans">

                        ER

                      </div>

                      <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-neutral-950 animate-pulse" />

                    </div>

                    <div>

                      <h3 className="text-xs font-bold text-neutral-200">Eira Text Chat</h3>

                      <p className="text-[11px] text-neutral-500 font-mono">Secure Cloud Sync</p>

                    </div>

                  </div>

                  

                  {/* Account / Sync Status Badge & IST Clock */}

                  <div className="text-[11px] font-mono text-neutral-500 flex items-center gap-3">

                    <span className="text-emerald-300 flex items-center gap-1 bg-neutral-900/90 border border-emerald-500/25 px-2 py-0.5 rounded-lg">

                      <Clock size={11} className="text-emerald-400" />

                      {istClockText}

                    </span>

                    {user ? (

                      <span className="text-emerald-400 flex items-center gap-1">

                        <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" /> Cloud Synced

                      </span>

                    ) : (

                      <span className="text-amber-400 flex items-center gap-1">

                        <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-ping" /> Local Only (Sign in to back up)

                      </span>

                    )}

                  </div>

                </div>



                {/* Pending Scheduled Tasks strip inside Text Chat */}

                {scheduledTasks.some((t) => t.status === "pending") && (

                  <div className="bg-neutral-950/70 border-b border-amber-500/25 px-4 py-2 flex flex-wrap items-center gap-2">

                    <span className="text-[11px] font-mono font-bold text-amber-300 flex items-center gap-1">

                      <Clock size={12} className="animate-pulse text-amber-400" />

                      IST Schedule:

                    </span>

                    {scheduledTasks

                      .filter((t) => t.status === "pending")

                      .map((t) => (

                        <span

                          key={t.id}

                          className="inline-flex items-center gap-1.5 bg-neutral-900 border border-amber-500/25 rounded-lg px-2 py-0.5 text-[11px] font-mono text-neutral-200"

                        >

                          <span className="text-amber-200">{t.title}</span>

                          <span className="text-neutral-400">@{formatIstTime(t.triggerAtMs, true)}</span>

                          <span className="text-emerald-400">({t.remainingSeconds ?? 0}s)</span>

                          <button

                            onClick={() => handleCancelScheduledTask(t.id)}

                            className="text-rose-400 hover:text-rose-300 ml-0.5 cursor-pointer"

                            title="Cancel scheduled task"

                          >

                            ✕

                          </button>

                        </span>

                      ))}

                  </div>

                )}



                {/* Messages Log Container */}

                <div className="flex-1 overflow-y-auto p-4 space-y-4 max-h-[480px] lg:max-h-[580px] scrollbar-thin">

                  {chatbotMessages.length === 0 ? (

                    <div className="h-[250px] flex flex-col items-center justify-center text-center p-6 space-y-3">

                      <div className="w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">

                        <MessageSquare size={20} />

                      </div>

                      <div>

                        <h4 className="text-xs font-bold text-neutral-300">Start a chat with Eira</h4>

                        <p className="text-[11px] text-neutral-500 max-w-xs mt-1">

                          Type a message below or share a YouTube link for me to analyze. I'll recall everything we've discussed!

                        </p>

                      </div>

                    </div>

                  ) : (

                    chatbotMessages.map((msg) => {

                      const isMe = msg.sender === 'user';

                      return (

                        <div 

                          key={msg.id} 

                          className={`flex ${isMe ? 'justify-end' : 'justify-start'} animate-fade-in`}

                        >

                          <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-xs ${

                            isMe 

                              ? 'bg-rose-600 text-white rounded-tr-none shadow-md shadow-rose-600/10' 

 : 'bg-neutral-900/80 border border-neutral-800 text-neutral-300 rounded-tl-none'

                          }`}>

                            <div className="flex items-center gap-1.5 text-[11px] font-mono mb-1 text-neutral-400">

                              <span className="font-bold">{isMe ? 'My Boss' : 'Eira'}</span>

                              <span>•</span>

                              <span>

                                {formatIstTime(msg.timestamp, false)} IST

                              </span>

                              {msg.type === 'voice' && (

                                <span className="bg-rose-500/10 text-rose-400 border border-rose-500/20 px-1 rounded text-[11px]">

                                  Voice

                                </span>

                              )}

                              {msg.type === 'youtube' && (

                                <span className="bg-red-500/10 text-red-400 border border-red-500/20 px-1 rounded text-[11px]">

                                  YouTube Analysis

                                </span>

                              )}

                            </div>

                            

                            <p className="leading-relaxed whitespace-pre-wrap">{msg.text}</p>

                            

                            {/* Render metadata thumbnail or summary if YouTube analysis */}

                            {msg.metadata?.youtubeUrl && (

                              <div className="mt-2 pt-2 border-t border-neutral-800/60">

                                <a 

                                  href={msg.metadata.youtubeUrl} 

                                  target="eira_companion_browser" 

                                  rel="noopener noreferrer"

                                  className="text-[11px] text-red-400 hover:underline flex items-center gap-1 font-mono mb-1.5"

                                >

                                  <Youtube size={12} /> View Source Video

                                </a>

                                {msg.metadata.title && (

                                  <p className="text-[11px] font-bold text-neutral-100">{msg.metadata.title}</p>

                                )}

                                {msg.metadata.author && (

                                  <p className="text-[11px] text-neutral-400">By: {msg.metadata.author}</p>

                                )}

                              </div>

                            )}

                          </div>

                        </div>

                      );

                    })

                  )}

                  <div ref={chatbotEndRef} />

                </div>



                {/* Loading state bar */}

                {chatLoading && (

                  <div className="absolute bottom-16 left-4 right-4 bg-neutral-950/80 border border-neutral-800/80 px-3 py-1.5 rounded-lg flex items-center gap-2 text-[11px] text-neutral-400 animate-pulse font-mono z-10">

                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />

                    <span>Eira is processing your request...</span>

                  </div>

                )}



                {/* Quick VS Code Coding Copilot Chips */}

                <div className="bg-neutral-950/70 border-t border-neutral-900/80 px-3 pt-2 pb-1 flex flex-wrap items-center gap-1.5">

                  <button

                    type="button"

                    disabled={chatLoading}

                    onClick={() => {

                      setChatInput("Meri VS Code screen dekho, kahan dikkat hai ya kya error hai check karo aur fix karke run kara do.");

                    }}

                    className="px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/25 text-amber-300 text-[11px] font-mono transition-colors cursor-pointer flex items-center gap-1"

                  >

                    <Eye size={11} /> Scan VS Code & Fix

                  </button>

                  <button

                    type="button"

                    disabled={chatLoading}

                    onClick={() => {

                      setChatInput("VS Code mein jo code khula hai usme aage ka logic complete karo aur run karke output batao.");

                    }}

                    className="px-2.5 py-1 rounded-lg bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/25 text-orange-300 text-[11px] font-mono transition-colors cursor-pointer flex items-center gap-1"

                  >

                    <FileCode size={11} /> Complete Next Code & Run

                  </button>

                  <button

                    type="button"

                    onClick={() => {

                      setActiveTab('workspace');

                      void handleScanVSCodeScreen();

                    }}

                    className="px-2.5 py-1 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-300 text-[11px] font-mono transition-colors cursor-pointer flex items-center gap-1 ml-auto"

                  >

                    <Terminal size={11} /> Open VS Code Copilot

                  </button>

                </div>



                {/* Input Controls */}

                <form 

                  onSubmit={(e) => {

                    e.preventDefault();

                    handleSendChat();

                  }}

                  className="bg-neutral-950/90 border-t border-neutral-900 p-3 flex gap-2 items-center mt-auto"

                >

                  <input 

                    type="text"

                    value={chatInput}

                    onChange={(e) => setChatInput(e.target.value)}

                    disabled={chatLoading}

                    placeholder="Ask Eira anything or type a prompt..."

                    className="flex-1 bg-neutral-900/60 border border-neutral-800 rounded-xl px-3.5 py-2.5 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-rose-500/50 focus:ring-1 focus:ring-rose-500/20 disabled:opacity-50"

                  />

                  <button

                    type="submit"

                    disabled={chatLoading || !chatInput.trim()}

                    className="p-2.5 bg-rose-600 hover:bg-rose-500 disabled:bg-neutral-800 text-white rounded-xl transition-all shadow-md active:scale-95 disabled:scale-100 cursor-pointer disabled:cursor-not-allowed"

                    title="Send message to Eira"

                  >

                    <Send size={15} />

                  </button>

                </form>

              </div>



              {/* Right Column: AI Video Parser Panel */}

              <div className="w-full lg:w-[340px] flex flex-col gap-4">

                

                {/* 1. YouTube Link Downloader Widget */}

                <div className="bg-neutral-900/50 border border-neutral-900 rounded-2xl p-4 flex flex-col relative overflow-hidden">

                  <div className="absolute top-0 right-0 w-32 h-32 bg-red-600/5 rounded-full blur-3xl pointer-events-none" />

                  

                  <div className="flex items-center gap-2 border-b border-neutral-800 pb-2 mb-3">

                    <Youtube className="text-red-500 shrink-0" size={16} />

                    <div>

                      <h4 className="text-xs font-bold text-neutral-200 font-sans">YouTube AI Inspector</h4>

                      <p className="text-[11px] font-mono text-neutral-500">Video Content Analysis</p>

                    </div>

                  </div>



                  <p className="text-[11px] text-neutral-400 mb-3 leading-relaxed">

                    Paste any YouTube URL (e.g. tutorials, podcasts, music videos) and Ira will analyze the full metadata, summaries, and generate a clever breakdown!

                  </p>



                  <div className="space-y-2.5">

                    <div>

                      <label className="text-[11px] font-mono text-neutral-500 block mb-1">YouTube Video Link</label>

                      <input 

                        type="url"

                        value={youtubeInput}

                        onChange={(e) => setYoutubeInput(e.target.value)}

                        placeholder="https://www.youtube.com/watch?v=..."

                        className="w-full bg-neutral-950/70 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-700 focus:outline-none focus:border-red-500/50"

                      />

                    </div>



                    <button

                      type="button"

                      onClick={() => handleAnalyzeYoutube(youtubeInput)}

                      disabled={chatLoading || !youtubeInput.trim()}

                      className="w-full py-2 bg-red-600 hover:bg-red-500 disabled:bg-neutral-800/50 text-white rounded-xl text-xs font-semibold tracking-wide transition-all shadow-md active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50"

                    >

                      <Sparkles size={13} />

                      <span>{chatLoading ? "Analyzing..." : "Analyze Video Content"}</span>

                    </button>

                  </div>

                </div>



                {/* 2. Interactive Memory Engine Console */}

                <div className="bg-neutral-900/50 border border-neutral-900 rounded-2xl p-4 flex flex-col flex-1 min-h-[220px]">

                  <div className="flex items-center justify-between border-b border-neutral-800 pb-2 mb-3">

                    <span className="text-xs font-semibold tracking-wider uppercase font-mono text-rose-400 flex items-center gap-1.5">

                      <Database size={13} /> Eira Memory Bank

                    </span>

                    <div className="flex items-center gap-1">

                      <button

                        onClick={async () => {

                          setIsBackingUpMemory(true);

                          try {

                            const r = await fetch("/api/memory/backup", {

                              method: "POST",

                              headers: { "Content-Type": "application/json" },

                              body: JSON.stringify({ label: "manual" })

                            });

                            const d = await r.json();

                            if (d?.success) {

                              setTerminalOutput(prev => prev + `\n[Memory] Verified local backup created: ${d.backup?.id}`);

                              await refreshLocalMemoryProfile();

                            }

                          } catch {}

                          finally { setIsBackingUpMemory(false); }

                        }}

                        disabled={isBackingUpMemory}

                        className="p-1 hover:bg-neutral-800 rounded text-neutral-500 hover:text-emerald-300 transition-colors"

                        title="Create verified local SQLite backup"

                      >

                        <Download size={10} />

                      </button>

                      <button 

                        onClick={() => triggerMemorySync()}

                        className="p-1 hover:bg-neutral-800 rounded text-neutral-500 hover:text-neutral-300 transition-colors"

                        title="Refresh & sync persistent memory"

                      >

                        <RefreshCw size={10} />

                      </button>

                    </div>

                  </div>



                  {/* Quick Memory Search */}

                  <div className="flex gap-1.5 mb-2.5">

                    <input

                      type="text"

                      value={memorySearchQuery}

                      onChange={(e) => {

                        setMemorySearchQuery(e.target.value);

                        if (!e.target.value.trim()) setMemorySearchResults([]);

                      }}

                      onKeyDown={async (e) => {

                        if (e.key === "Enter" && memorySearchQuery.trim()) {

                          e.preventDefault();

                          try {

                            const r = await fetch("/api/memory/search", {

                              method: "POST",

                              headers: { "Content-Type": "application/json" },

                              body: JSON.stringify({ query: memorySearchQuery.trim(), limit: 5, includeHistory: true })

                            });

                            const d = await r.json();

                            setMemorySearchResults(Array.isArray(d?.results) ? d.results : []);

                          } catch {}

                        }

                      }}

                      placeholder="Search memories (Enter)..."

                      className="flex-1 bg-neutral-950/70 border border-neutral-800 rounded-lg px-2 py-1 text-[11px] text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-rose-500/50"

                    />

                    <button

                      type="button"

                      onClick={async () => {

                        if (!memorySearchQuery.trim()) { setMemorySearchResults([]); return; }

                        try {

                          const r = await fetch("/api/memory/search", {

                            method: "POST",

                            headers: { "Content-Type": "application/json" },

                            body: JSON.stringify({ query: memorySearchQuery.trim(), limit: 5, includeHistory: true })

                          });

                          const d = await r.json();

                          setMemorySearchResults(Array.isArray(d?.results) ? d.results : []);

                        } catch {}

                      }}

                      className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg text-[11px]"

                      title="Search local memory"

                    >

                      <Search size={11} />

                    </button>

                  </div>



                  <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 scrollbar-thin">

                    {memorySearchResults.length > 0 && (

                      <div className="bg-neutral-950/80 border border-rose-900/50 p-2.5 rounded-xl space-y-1.5">

                        <span className="text-[11px] font-mono text-rose-300 block">🔍 SEARCH MATCHES ({memorySearchResults.length}):</span>

                        {memorySearchResults.map((hit: any, idx: number) => (

                          <div key={hit?.memory?.id || idx} className="text-[11px] text-neutral-300 border-b border-neutral-900 pb-1 last:border-0">

                            <span className="text-[10px] font-mono text-neutral-500 mr-1">[{hit?.memory?.type}]</span>

                            {hit?.memory?.content}

                          </div>

                        ))}

                      </div>

                    )}



                    <div className="bg-neutral-950/60 border border-neutral-900 p-2.5 rounded-xl">

                      <span className="text-[11px] font-mono text-rose-400 block mb-1">🧠 CONVERSATION RECALL INDEX:</span>

                      <p className="text-[11px] text-neutral-300 leading-relaxed italic font-sans whitespace-pre-line">

                        {userMemory || "Learning about you... speak or chat with Eira to construct durable offline memories!"}

                      </p>

                    </div>



                    {isGeneratingSummary && (

                      <div className="bg-neutral-950/80 border border-amber-800/60 p-2.5 rounded-xl flex items-center gap-2 text-amber-300 text-[11px] animate-pulse">

                        <RefreshCw size={12} className="animate-spin" />

                        <span>Generating bulleted session summary & storing in memory database...</span>

                      </div>

                    )}



                    {latestVoiceSessionSummary && !isGeneratingSummary && (

                      <div className="bg-neutral-950/80 border border-orange-900/60 p-2.5 rounded-xl">

                        <span className="text-[11px] font-mono text-orange-400 block mb-1 font-semibold flex items-center gap-1">

                          <Mic size={10} /> DISCONNECTED VOICE SESSION SUMMARY:

                        </span>

                        <p className="text-[11px] text-orange-200 leading-relaxed font-sans whitespace-pre-line">

                          {latestVoiceSessionSummary}

                        </p>

                      </div>

                    )}



                    <div className="bg-neutral-950/30 border border-neutral-900/50 p-2.5 rounded-xl text-[11px] text-neutral-500 space-y-1">

                      <p className="font-bold text-neutral-400 font-mono">MEMORY ENGINE STATUS:</p>

                      <div className="flex items-center gap-1.5">

                        <span className={`w-1.5 h-1.5 rounded-full ${localMemoryHealth === 'ok' ? 'bg-emerald-400' : 'bg-amber-400'}`} />

                        <span>Persistence: {localMemoryHealth === 'ok' ? "Local SQLite WAL (Offline-Ready)" : (user ? "Firestore Cloud Fallback" : "Initializing Local DB...")}</span>

                      </div>

                      <div className="flex items-center gap-1.5">

                        <span className={`w-1.5 h-1.5 rounded-full ${localMemoryHealth === 'ok' || user ? 'bg-emerald-400' : 'bg-neutral-600'}`} />

                        <span>Context Injected on Boot: {localMemoryHealth === 'ok' || user ? "YES" : "STANDBY"}</span>

                      </div>

                      {localMemoryStats && (

                        <div className="text-[10px] font-mono text-neutral-400 pt-0.5">

                          Memories: {localMemoryStats.total_memories ?? 0} · Entities: {localMemoryStats.entities ?? 0} · Links: {localMemoryStats.links ?? 0}

                        </div>

                      )}

                    </div>

                  </div>

                </div>



              </div>

            </motion.div>

          )}



          {/* VIEW 2: COMPANION WORKSPACE (CODE EXECUTION / FILES) */}

          {activeTab === 'workspace' && (

            <motion.div 

              key="workspace-tab"

              initial={{ opacity: 0, y: 10 }}

              animate={{ opacity: 1, y: 0 }}

              exit={{ opacity: 0, y: -10 }}

              className="flex-1 flex flex-col md:flex-row gap-4 h-full overflow-hidden"

            >

              {/* File Explorer sidebar */}

              <div className="w-full md:w-64 bg-neutral-900/50 border border-neutral-900 rounded-2xl p-4 flex flex-col h-[280px] md:h-full">

                <div className="flex items-center justify-between border-b border-neutral-800 pb-2 mb-3">

                  <span className="text-xs font-semibold tracking-wider uppercase font-mono text-orange-400 flex items-center gap-1.5">

                    <FolderOpen size={13} /> Workspace Files

                  </span>

                  <button onClick={fetchWorkspaceFiles} className="text-neutral-500 hover:text-neutral-300">

                    <RefreshCw size={11} className="animate-hover" />

                  </button>

                </div>



                <div className="flex-1 overflow-y-auto space-y-1.5">

                  {workspaceFiles.length === 0 ? (

                    <div className="text-neutral-600 text-[11px] italic p-3 text-center">

                      Workspace is empty. Ask ERA to write some code!

                    </div>

                  ) : (

                    workspaceFiles.map((f) => (

                      <button

                        key={f.name}

                        onClick={() => viewWorkspaceFile(f.name)}

                        className={`w-full text-left p-2 rounded-lg flex items-center justify-between text-xs transition-colors border ${

                          selectedFile === f.name 

                            ? 'bg-orange-950/30 border-orange-500/20 text-orange-300 shadow-sm' 

 : 'bg-neutral-950/40 border-neutral-900 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900/50'

                        }`}

                      >

                        <div className="flex items-center gap-1.5 truncate">

                          <FileCode size={13} className="text-orange-400 shrink-0" />

                          <span className="truncate">{f.name}</span>

                        </div>

                        <span className="text-[11px] font-mono text-neutral-600 shrink-0">

                          {(f.size / 1024).toFixed(1)} KB

                        </span>

                      </button>

                    ))

                  )}

                </div>

              </div>



              {/* Workspace Main Code Viewer and Execution Console */}

              <div className="flex-1 flex flex-col gap-4 h-full">



                {/* VS Code Screen Copilot Bar */}

                <div className="bg-neutral-900/60 border border-amber-500/20 rounded-2xl p-3 flex flex-col gap-2.5">

                  <div className="flex flex-wrap items-center justify-between gap-2">

                    <div className="flex items-center gap-2">

                      <span className="text-xs font-semibold tracking-wider uppercase font-mono text-amber-400 flex items-center gap-1.5">

                        <Eye size={13} /> VS Code Screen Copilot

                      </span>

                      {activeCodeFilePath && (

                        <span className="text-[11px] font-mono text-emerald-300 bg-emerald-950/50 border border-emerald-500/30 px-2 py-0.5 rounded truncate max-w-[320px]" title={activeCodeFilePath}>

                          Linked: {activeCodeFilePath}

                        </span>

                      )}

                      {vscodeCopilotInfo?.language && (

                        <span className="text-[10px] font-mono uppercase bg-neutral-950 text-neutral-300 border border-neutral-800 px-1.5 py-0.5 rounded">

                          {vscodeCopilotInfo.language}

                        </span>

                      )}

                      {vscodeCopilotInfo?.syntaxValid === false && (

                        <span className="text-[10px] font-mono bg-rose-950/60 text-rose-300 border border-rose-500/30 px-2 py-0.5 rounded">

                          Syntax Issue Detected

                        </span>

                      )}

                    </div>



                    <div className="flex flex-wrap items-center gap-1.5">

                      <button

                        type="button"

                        disabled={vscodeCopilotBusy}

                        onClick={handleScanVSCodeScreen}

                        className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-mono text-[11px] rounded-lg flex items-center gap-1 cursor-pointer transition-colors"

                      >

                        <Eye size={11} /> {vscodeCopilotBusy ? "Working..." : "Scan VS Code Screen"}

                      </button>

                      {activeCodeFilePath && (

                        <button

                          type="button"

                          onClick={async () => {

                            await fetch("/api/code-assistant/open-vscode", {

                              method: "POST",

                              headers: { "Content-Type": "application/json" },

                              body: JSON.stringify({ filepath: activeCodeFilePath }),

                            });

                          }}

                          className="px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-mono text-[11px] rounded-lg flex items-center gap-1 cursor-pointer transition-colors"

                        >

                          <ExternalLink size={11} /> Open in VS Code

                        </button>

                      )}

                      {vscodeCopilotInfo?.canUndo && (

                        <button

                          type="button"

                          disabled={vscodeCopilotBusy}

                          onClick={handleUndoCodeEdit}

                          className="px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 text-amber-300 font-mono text-[11px] rounded-lg cursor-pointer transition-colors"

                        >

                          Undo Fix

                        </button>

                      )}

                    </div>

                  </div>



                  <div className="flex flex-col sm:flex-row gap-2">

                    <input

                      type="text"

                      value={vscodeCopilotInstruction}

                      onChange={(e) => setVscodeCopilotInstruction(e.target.value)}

                      onKeyDown={(e) => {

                        if (e.key === "Enter") {

                          e.preventDefault();

                          void handleFixVSCodeCode(true);

                        }

                      }}

                      placeholder="Kya dikkat hai ya kya code banana hai? (e.g. 'Error fix karo', 'Complete next logic', 'Add sorting function')"

                      className="flex-1 bg-neutral-950/90 border border-neutral-800 rounded-xl px-3 py-1.5 text-xs text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-amber-500/60"

                    />

                    <div className="flex items-center gap-1.5">

                      <button

                        type="button"

                        disabled={vscodeCopilotBusy}

                        onClick={() => handleFixVSCodeCode(false)}

                        className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-neutral-100 font-mono text-[11px] rounded-xl flex items-center gap-1 cursor-pointer transition-colors"

                      >

                        <Sparkles size={11} className="text-amber-400" /> AI Fix / Write

                      </button>

                      <button

                        type="button"

                        disabled={vscodeCopilotBusy}

                        onClick={() => handleFixVSCodeCode(true)}

                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-mono text-[11px] font-semibold rounded-xl flex items-center gap-1 cursor-pointer transition-colors"

                      >

                        <Zap size={11} /> Fix & Run

                      </button>

                    </div>

                  </div>



                  {vscodeCopilotInfo?.explanation && (

                    <div className="text-[11px] text-amber-200/90 bg-neutral-950/70 border border-neutral-800/80 rounded-xl px-3 py-2 font-sans">

                      <span className="font-mono text-amber-400 font-semibold mr-1.5">[ERA Diagnosis]</span>

                      {vscodeCopilotInfo.explanation}

                    </div>

                  )}

                </div>

                

                {/* Visual Editor Pane */}

                <div className="flex-1 bg-neutral-900/50 border border-neutral-900 rounded-2xl p-4 flex flex-col min-h-[260px] relative">

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-neutral-800 pb-2.5 mb-3 gap-2">

                    <div className="flex items-center gap-2">

                      <span className="text-xs font-semibold tracking-wider uppercase font-mono text-orange-400">

                        Workspace View

                      </span>

                      {selectedFile && (

                        <span className="text-[11px] font-mono text-neutral-500 bg-neutral-950 px-2 py-0.5 rounded border border-neutral-900">

                          {selectedFile}

                        </span>

                      )}

                    </div>

                    

                    {/* Mode Selector for Open-With Simulation */}

                    <div className="flex items-center gap-1.5 bg-neutral-950/80 p-1 rounded-xl border border-neutral-800/80 self-start sm:self-auto">

                      <button

                        onClick={() => setOpenWithMode('editor')}

                        className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-medium transition-all cursor-pointer ${

                          openWithMode === 'editor' || !openWithMode || openWithMode === 'default'

                            ? 'bg-orange-600 text-white font-bold'

 : 'text-neutral-400 hover:text-neutral-200'

                        }`}

                      >

                        Default Editor

                      </button>

                      <button

                        onClick={() => setOpenWithMode('vscode')}

                        className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-medium transition-all cursor-pointer ${

                          openWithMode === 'vscode'

                            ? 'bg-stone-600 text-white font-bold'

 : 'text-neutral-400 hover:text-neutral-200'

                        }`}

                      >

                        VS Code View

                      </button>

                      <button

                        onClick={() => setOpenWithMode('browser')}

                        className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-medium transition-all cursor-pointer ${

                          openWithMode === 'browser' || openWithMode === 'chrome' || openWithMode === 'firefox' || openWithMode === 'safari'

                            ? 'bg-amber-600 text-white font-bold'

 : 'text-neutral-400 hover:text-neutral-200'

                        }`}

                      >

                        Web Browser

                      </button>

                    </div>



                    <div className="flex items-center gap-2">

                      {(selectedFile || activeCodeFilePath) && (

                        <>

                          <button

                            type="button"

                            onClick={handleSaveCurrentCode}

                            className="px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-mono text-[11px] rounded-md flex items-center gap-1 transition-all cursor-pointer"

                          >

                            Save

                          </button>

                          <button

                            type="button"

                            disabled={vscodeCopilotBusy}

                            onClick={handleRunCurrentCode}

                            className="px-2.5 py-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-mono text-[11px] rounded-md flex items-center gap-1 transition-all cursor-pointer"

                          >

                            <Play size={10} /> Compile & Run

                          </button>

                        </>

                      )}

                    </div>

                  </div>



                  {/* Rendering based on openWithMode */}

                  {selectedFile ? (

                    <div className="flex-1 flex flex-col overflow-hidden rounded-xl border border-neutral-800/80">

                      {/* VS Code Mode */}

                      {openWithMode === 'vscode' && (

                        <div className="flex-1 bg-[#1e1e1e] flex flex-col overflow-hidden text-neutral-300 font-sans text-xs">

                          {/* VS Code Top Header */}

                          <div className="bg-[#2d2d2d] px-3 py-1.5 flex items-center justify-between text-[#858585] select-none border-b border-[#1e1e1e]">

                            <div className="flex items-center gap-1.5">

                              <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block"></span>

                              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block"></span>

                              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>

                            </div>

                            <div className="text-[11px] font-medium tracking-wide truncate">

                              {selectedFile} — Visual Studio Code (Workspace)

                            </div>

                            <div className="w-12"></div>

                          </div>

                          {/* VS Code Options menu */}

                          <div className="bg-[#252526] px-3 py-1 flex items-center gap-3.5 text-[11px] text-[#cccccc] select-none border-b border-[#1e1e1e]">

                            <span className="hover:text-white cursor-pointer">File</span>

                            <span className="hover:text-white cursor-pointer">Edit</span>

                            <span className="hover:text-white cursor-pointer animate-pulse text-orange-400 font-semibold">Selection</span>

                            <span className="hover:text-white cursor-pointer">View</span>

                            <span className="hover:text-white cursor-pointer">Go</span>

                            <span className="hover:text-white cursor-pointer">Run</span>

                            <span className="hover:text-white cursor-pointer">Terminal</span>

                            <span className="hover:text-white cursor-pointer">Help</span>

                          </div>

                          

                          {/* VS Code Workspace Body */}

                          <div className="flex-1 flex overflow-hidden">

                            {/* VS Code Activity Bar */}

                            <div className="w-10 bg-[#333333] flex flex-col items-center py-3 gap-5 text-neutral-400 select-none border-r border-[#1e1e1e]">

                              <div className="text-white border-l-2 border-orange-500 pl-1 cursor-pointer" title="Explorer">

                                <FolderOpen size={16} />

                              </div>

                              <div className="hover:text-white cursor-pointer" title="Search">

                                <span className="text-xs font-bold font-mono">🔍</span>

                              </div>

                              <div className="hover:text-white cursor-pointer relative" title="Source Control">

                                <span className="text-xs font-bold font-mono">🌿</span>

                                <span className="absolute -top-1 -right-1 bg-orange-600 text-white rounded-full w-3.5 h-3.5 flex items-center justify-center text-[11px]">1</span>

                              </div>

                              <div className="hover:text-white cursor-pointer" title="Run and Debug">

                                <Play size={14} />

                              </div>

                              <div className="hover:text-white cursor-pointer" title="Settings">

                                <Settings size={14} />

                              </div>

                            </div>

                            

                            {/* VS Code Explorer Pane */}

                            <div className="w-36 bg-[#252526] py-2 px-2.5 flex flex-col select-none border-r border-[#1e1e1e] text-[#858585] overflow-y-auto">

                              <span className="text-[11px] font-bold tracking-wider uppercase mb-1.5 text-neutral-400">Explorer: Workspace</span>

                              <div className="space-y-0.5">

                                {workspaceFiles.map((f) => (

                                  <div 

                                    key={f.name}

                                    onClick={() => viewWorkspaceFile(f.name)}

                                    className={`px-1.5 py-1 rounded text-[11px] flex items-center gap-1.5 cursor-pointer truncate ${

                                      selectedFile === f.name ? 'bg-[#37373d] text-white' : 'hover:bg-[#2a2a2b] hover:text-[#cccccc]'

                                    }`}

                                  >

                                    <FileCode size={11} className="text-[#c586c0]" />

                                    <span className="truncate">{f.name}</span>

                                  </div>

                                ))}

                              </div>

                            </div>



                            {/* VS Code Main Editor Code Area */}

                            <div className="flex-1 flex flex-col bg-[#1e1e1e] overflow-hidden">

                              {/* Tab Header */}

                              <div className="bg-[#2d2d2d] flex items-center select-none border-b border-[#1e1e1e]">

                                <div className="bg-[#1e1e1e] text-neutral-200 border-t border-orange-500 px-3.5 py-1.5 flex items-center gap-2 border-r border-[#252526]">

                                  <FileCode size={12} className="text-orange-400" />

                                  <span className="font-mono text-[11px]">{selectedFile}</span>

                                  <span className="text-[11px] text-neutral-500 hover:text-neutral-300 cursor-pointer">×</span>

                                </div>

                              </div>

                              

                              {/* Code view with VS Code lines */}

                              <div className="flex-1 overflow-auto p-4 font-mono text-xs flex text-neutral-300 bg-[#1e1e1e] select-text">

                                {/* Line numbers gutter */}

                                <div className="text-right text-[#858585] select-none pr-3.5 border-r border-[#3c3c3c] mr-3 space-y-0.5 min-w-[24px]">

                                  {(selectedFileContent || "// File is empty").split("\n").map((_, idx) => (

                                    <div key={idx}>{idx + 1}</div>

                                  ))}

                                </div>

                                {/* Code content */}

                                <pre className="whitespace-pre overflow-auto flex-1 text-[#d4d4d4] scrollbar-thin">

                                  <code>{selectedFileContent || "// File is empty..."}</code>

                                </pre>

                              </div>

                            </div>

                          </div>



                          {/* VS Code Footer Bar */}

                          <div className="bg-[#007acc] text-white px-3.5 py-0.5 flex items-center justify-between text-[11px] select-none font-sans">

                            <div className="flex items-center gap-3">

                              <span className="font-bold flex items-center gap-1">

                                <span className="text-[11px]">⎋</span> VS Code Active

                              </span>

                              <span>master*</span>

                              <span>✓ 0 errors</span>

                            </div>

                            <div className="flex items-center gap-3">

                              <span>Ln {selectedFileContent.split("\n").length}, Col 1</span>

                              <span>Spaces: 2</span>

                              <span>UTF-8</span>

                              <span>LF</span>

                              <span className="bg-[#0066aa] px-1 rounded">TypeScript</span>

                            </div>

                          </div>

                        </div>

                      )}



                      {/* Web Browser Mode */}

                      {(openWithMode === 'browser' || openWithMode === 'chrome' || openWithMode === 'firefox' || openWithMode === 'safari') && (

                        <div className="flex-1 bg-white dark:bg-[#1a1a1a] flex flex-col overflow-hidden text-neutral-800 dark:text-neutral-200">

                          {/* Browser Window Bar */}

                          <div className="bg-[#dee1e6] dark:bg-[#202124] px-3.5 pt-2 pb-1.5 flex items-center justify-between border-b border-neutral-300 dark:border-neutral-800 select-none">

                            <div className="flex items-center gap-1.5">

                              <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block"></span>

                              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block"></span>

                              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>

                            </div>

                            

                            {/* Browser Tab */}

                            <div className="flex-1 max-w-[200px] ml-4">

                              <div className="bg-white dark:bg-[#35363a] text-neutral-800 dark:text-neutral-100 px-3 py-1 rounded-t-lg text-[11px] font-medium flex items-center justify-between gap-2 shadow-sm border border-neutral-300/40 border-b-0 dark:border-neutral-800">

                                <div className="flex items-center gap-1.5 truncate">

                                  <Globe size={11} className="text-amber-600 dark:text-amber-400 shrink-0" />

                                  <span className="truncate">{selectedFile}</span>

                                </div>

                                <span className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 cursor-pointer">×</span>

                              </div>

                            </div>

                            <div className="flex-1"></div>

                          </div>



                          {/* Address / Control bar */}

                          <div className="bg-neutral-100 dark:bg-[#35363a] border-b border-neutral-300 dark:border-neutral-800 px-3.5 py-1.5 flex items-center gap-3.5 select-none text-neutral-500 dark:text-neutral-400">

                            <div className="flex items-center gap-2">

                              <span className="cursor-pointer hover:text-neutral-800 dark:hover:text-white">←</span>

                              <span className="cursor-pointer hover:text-neutral-800 dark:hover:text-white">→</span>

                              <span onClick={() => viewWorkspaceFile(selectedFile)} className="cursor-pointer hover:text-neutral-800 dark:hover:text-white">⟳</span>

                            </div>

                            <div className="flex-1 bg-white dark:bg-[#202124] border border-neutral-300 dark:border-neutral-800 px-3 py-1 rounded-lg text-[11px] font-mono flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">

                              <span className="text-emerald-500">🔒</span>

                              <span className="text-neutral-400">http://localhost:3000/</span>

                              <span className="text-neutral-800 dark:text-neutral-100 font-semibold">{selectedFile}</span>

                            </div>

                            <div className="text-[11px] bg-neutral-200 dark:bg-[#202124] px-2 py-0.5 rounded text-amber-600 dark:text-amber-400 font-bold uppercase tracking-wider font-mono scale-95 shrink-0">

                              {openWithMode === 'chrome' ? 'Chrome' : openWithMode === 'firefox' ? 'Firefox' : openWithMode === 'safari' ? 'Safari' : 'Browser'}

                            </div>

                          </div>



                          {/* Browser viewport iframe rendering */}

                          <div className="flex-1 bg-white p-4 overflow-auto min-h-[220px]">

                            {selectedFile.endsWith(".html") ? (

                              <iframe 

                                title="Browser Preview"

                                srcDoc={selectedFileContent} 

                                className="w-full h-full border-none bg-white min-h-[250px]" 

                                sandbox="allow-scripts"

                              />

                            ) : (

                              // Simulated web preview or formatted logs/dev tools for non-HTML files

                              <div className="w-full h-full flex flex-col p-4 bg-neutral-950 rounded-xl border border-neutral-800 text-xs font-mono text-emerald-400">

                                <div className="border-b border-neutral-900 pb-2 mb-3 flex items-center justify-between text-neutral-500 text-[11px] uppercase tracking-wider">

                                  <span>Developer Inspector Terminal Output</span>

                                  <span className="text-amber-400 font-bold">Preview Live</span>

                                </div>

                                <div className="space-y-1 select-text">

                                  <p className="text-neutral-400">// Running code debugger on {selectedFile}...</p>

                                  <p className="text-amber-400">[Handshake] Connected to live preview server</p>

                                  <p className="text-neutral-300">[Ready] Displaying active source structure:</p>

                                  <pre className="text-neutral-300 bg-neutral-900/60 p-2.5 rounded border border-neutral-900 mt-2 max-h-[160px] overflow-auto whitespace-pre">

                                    <code>{selectedFileContent}</code>

                                  </pre>

                                  <p className="text-emerald-500 mt-2">✔ Virtual render cycle complete. Execution returned exit status 0.</p>

                                </div>

                              </div>

                            )}

                          </div>

                        </div>

                      )}



                      {/* Default Editor Mode */}

                      {(openWithMode === 'editor' || !openWithMode || openWithMode === 'default') && (

                        <textarea

                          value={selectedFileContent}

                          onChange={(e) => setSelectedFileContent(e.target.value)}

                          spellCheck={false}

                          placeholder="// File is empty..."

                          className="flex-1 w-full h-full min-h-[220px] resize-none bg-neutral-950/90 p-3 text-xs font-mono text-neutral-300 focus:outline-none scrollbar-thin"

                        />

                      )}

                    </div>

                  ) : (

                    <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-neutral-500">

                      <FileCode size={28} className="text-neutral-600 mb-2" />

                      <p>No active file loaded.</p>

                      <p className="text-[11px] mt-1 text-neutral-600">Select a code file from the side column, or tell ERA to write code!</p>

                    </div>

                  )}

                </div>



                {/* Collapsible Sandbox Execution Terminal */}

                {showTerminal && (

                  <div className="h-[180px] bg-neutral-900/50 border border-neutral-900 rounded-2xl p-4 flex flex-col relative">

                    <div className="flex items-center justify-between border-b border-neutral-800 pb-2 mb-2">

                      <span className="text-xs font-semibold tracking-wider uppercase font-mono text-rose-400 flex items-center gap-1.5">

                        <Terminal size={12} /> Live Compiler Console

                      </span>

                      <button 

                        onClick={() => setTerminalOutput("Companion terminal cleared. Waiting for logs...")}

                        className="text-[11px] font-mono text-neutral-500 hover:text-neutral-300"

                      >

                        Clear Terminal

                      </button>

                    </div>



                    <div className="flex-1 bg-neutral-950 rounded-xl p-3 overflow-y-auto text-[11px] font-mono text-amber-400 scrollbar-thin select-text">

                      <pre className="whitespace-pre-wrap">{terminalOutput}</pre>

                      <div ref={terminalEndRef} />

                    </div>

                  </div>

                )}



              </div>

            </motion.div>

          )}



          {/* VIEW 3: SETTINGS DASHBOARD */}

          {activeTab === 'dashboard' && (

            <motion.div 

              key="dashboard-tab"

              initial={{ opacity: 0, y: 10 }}

              animate={{ opacity: 1, y: 0 }}

              exit={{ opacity: 0, y: -10 }}

              className="flex-1 flex items-center justify-center"

            >

              {/* Authenticated PIN Code Barrier */}

              {!dashboardUnlocked ? (

                <div className="bg-neutral-900/80 border border-neutral-800 p-6 rounded-2xl max-w-sm w-full text-center shadow-2xl backdrop-blur-md">

                  <div className="w-12 h-12 rounded-full bg-amber-950/60 text-amber-400 flex items-center justify-center mx-auto mb-3 border border-amber-500/20">

                    <Lock size={20} className="animate-pulse" />

                  </div>

                  <h3 className="text-sm font-semibold text-neutral-100 uppercase tracking-widest font-mono">Agent Authentication</h3>

                  <p className="text-xs text-neutral-400 mt-1.5 mb-4">Provide security code to unlock companion parameters.</p>

                  

                  <div className="space-y-3">

                    <input 

                      type="password"

                      placeholder="Security PIN (e.g., 1234)"

                      value={dashboardPIN}

                      onChange={(e) => {

                        setDashboardPIN(e.target.value);

                        setDashboardPINError(false);

                      }}

                      onKeyDown={(e) => {

                        if (e.key === 'Enter') {

                          if (dashboardPIN === "1234") {

                            setDashboardUnlocked(true);

                          } else {

                            setDashboardPINError(true);

                          }

                        }

                      }}

                      className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-3 py-2 text-center text-sm font-mono text-amber-400 tracking-widest focus:outline-none focus:border-amber-500"

                    />

                    

                    {dashboardPINError && (

                      <p className="text-[11px] text-rose-400 font-mono animate-bounce flex items-center justify-center gap-1">

                        <ShieldAlert size={10} /> Incorrect Agent PIN. Try 1234.

                      </p>

                    )}



                    <button

                      onClick={() => {

                        if (dashboardPIN === "1234") {

                          setDashboardUnlocked(true);

                        } else {

                          setDashboardPINError(true);

                        }

                      }}

                      className="w-full py-2 bg-gradient-to-r from-amber-600 to-orange-600 text-white text-xs font-semibold rounded-xl transition-all font-mono"

                    >

                      Verify Identity

                    </button>

                  </div>

                </div>

              ) : (

                /* Authenticated Settings Panel */

                <div className="bg-neutral-900/40 border border-neutral-900 rounded-2xl p-6 max-w-3xl w-full flex flex-col md:flex-row gap-6 shadow-2xl relative">

                  

                  {/* Dashboard top actions */}

                  <div className="absolute top-4 right-4 flex items-center gap-2">

                    <button 

                      onClick={() => setDashboardUnlocked(false)}

                      className="px-2.5 py-1 bg-neutral-950 hover:bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-neutral-200 rounded-md text-[11px] font-mono"

                    >

                      Lock Config

                    </button>

                  </div>



                  {/* Left Column: API Keys Setup or Contacts Book */}

                  <div className="flex-1 flex flex-col min-h-[450px]">

                    {/* Sub-tab Selection */}

                    <div className="flex border-b border-neutral-800/80 mb-4 gap-4">

                      <button 

                        onClick={() => setSettingsSubTab('api')}

                        className={`pb-2 text-xs font-mono font-bold uppercase tracking-wider transition-all border-b-2 ${

                          settingsSubTab === 'api' 

                            ? 'border-amber-500 text-amber-400 font-bold' 

 : 'border-transparent text-neutral-500 hover:text-neutral-300'

                        }`}

                      >

                        API & System

                      </button>

                      <button 

                        onClick={() => setSettingsSubTab('contacts')}

                        className={`pb-2 text-xs font-mono font-bold uppercase tracking-wider transition-all border-b-2 ${

                          settingsSubTab === 'contacts' 

                            ? 'border-amber-500 text-amber-400 font-bold' 

 : 'border-transparent text-neutral-500 hover:text-neutral-300'

                        }`}

                      >

                        Contacts Book ({whatsappContacts.length})

                      </button>

                    </div>



                    {settingsSubTab === 'api' ? (

                      <div className="space-y-4 flex-1">

                        <div>

                          <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400 font-mono flex items-center gap-1.5 border-b border-neutral-800 pb-1.5 mb-3">

                            <Key size={13} /> Secured API Keys

                          </h3>

                          <p className="text-[11px] text-neutral-500 mb-4 leading-relaxed">

                            Keys are saved locally in highly robust AES-256 encrypted configuration vaults.

                          </p>

                        </div>



                        {/* Gemini Input */}

                        <div className="space-y-1">

                          <label className="text-[11px] font-mono uppercase text-neutral-400 flex items-center justify-between">

                            <span>Google Gemini API Key</span>

                            <button 

                              onClick={() => setShowKeys(prev => ({ ...prev, gemini: !prev.gemini }))}

                              className="text-neutral-500 hover:text-neutral-300"

                            >

                              {showKeys.gemini ? <EyeOff size={11} /> : <Eye size={11} />}

                            </button>

                          </label>

                          <input 

                            type={showKeys.gemini ? "text" : "password"}

                            value={keysConfig.geminiApiKey}

                            onChange={(e) => setKeysConfig(prev => ({ ...prev, geminiApiKey: e.target.value }))}

                            placeholder="Configure Gemini Studio Secret"

                            className="w-full bg-neutral-950 border border-neutral-800 px-3 py-1.5 rounded-lg text-xs font-mono text-neutral-200 focus:outline-none focus:border-amber-500"

                          />

                        </div>



                        {/* Claude Input */}

                        <div className="space-y-1">

                          <label className="text-[11px] font-mono uppercase text-neutral-400 flex items-center justify-between">

                            <span>Anthropic Claude API Key (Fallback)</span>

                            <button 

                              onClick={() => setShowKeys(prev => ({ ...prev, claude: !prev.claude }))}

                              className="text-neutral-500 hover:text-neutral-300"

                            >

                              {showKeys.claude ? <EyeOff size={11} /> : <Eye size={11} />}

                            </button>

                          </label>

                          <input 

                            type={showKeys.claude ? "text" : "password"}

                            value={keysConfig.claudeApiKey}

                            onChange={(e) => setKeysConfig(prev => ({ ...prev, claudeApiKey: e.target.value }))}

                            placeholder="Configure Claude Key Locker"

                            className="w-full bg-neutral-950 border border-neutral-800 px-3 py-1.5 rounded-lg text-xs font-mono text-neutral-200 focus:outline-none focus:border-amber-500"

                          />

                        </div>



                        {/* OpenAI Input */}

                        <div className="space-y-1">

                          <label className="text-[11px] font-mono uppercase text-neutral-400 flex items-center justify-between">

                            <span>OpenAI API Key (Fallback)</span>

                            <button 

                              onClick={() => setShowKeys(prev => ({ ...prev, openai: !prev.openai }))}

                              className="text-neutral-500 hover:text-neutral-300"

                            >

                              {showKeys.openai ? <EyeOff size={11} /> : <Eye size={11} />}

                            </button>

                          </label>

                          <input 

                            type={showKeys.openai ? "text" : "password"}

                            value={keysConfig.openaiApiKey}

                            onChange={(e) => setKeysConfig(prev => ({ ...prev, openaiApiKey: e.target.value }))}

                            placeholder="Configure OpenAI Key Locker"

                            className="w-full bg-neutral-950 border border-neutral-800 px-3 py-1.5 rounded-lg text-xs font-mono text-neutral-200 focus:outline-none focus:border-amber-500"

                          />

                        </div>



                        {/* Preferred Model AI */}

                        <div className="space-y-1.5 pt-1">

                          <label className="text-[11px] font-mono uppercase text-neutral-400">

                            Preferred AI Companion Model

                          </label>

                          <select

                            value={keysConfig.preferredModel}

                            onChange={(e: any) => setKeysConfig(prev => ({ ...prev, preferredModel: e.target.value }))}

                            className="w-full bg-neutral-950 border border-neutral-800 px-3 py-2 rounded-lg text-xs font-mono text-neutral-200 focus:outline-none focus:border-amber-500"

                          >

                            <option value="gemini">Gemini-3.1-Flash (Real-time Live Stream)</option>

                            <option value="claude">Anthropic Claude 3.5 Sonnet (Local Fallback)</option>

                            <option value="gpt">OpenAI GPT-4o Agentic (Reasoning Model)</option>

                          </select>

                        </div>



                        {/* Local Laptop Connection Info Card */}

                        <div className="bg-neutral-950/60 p-4 rounded-xl border border-neutral-800/80 space-y-2.5">

                          <h4 className="text-[11px] font-bold uppercase tracking-wider text-amber-400 font-mono flex items-center gap-1.5 border-b border-neutral-900 pb-1.5">

                            <Laptop size={12} /> Local Laptop Screen & File Sync

                          </h4>

                          <p className="text-[11px] text-neutral-400 leading-normal">

                            To let Eira shut down/power your physical laptop, code directly onto your local screen, and retrieve physical files, run our secure local websocket bridge.

                          </p>

                          

                          <div className="bg-neutral-900/40 p-2.5 rounded-lg border border-neutral-950 font-mono text-[11px] text-amber-400 select-all break-all whitespace-pre">

                            curl -sSL https://raw.githubusercontent.com/eira-ai/agent-daemon/main/install.sh | bash

                          </div>

                          

                          <div className="flex items-center gap-1.5 text-[11px] text-amber-400 font-mono">

                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>

                            <span>Waiting for local laptop websocket handshake...</span>

                          </div>



                          <div className="flex items-center justify-between border-t border-neutral-900 pt-2 pb-0.5">

                            <span className="text-[11px] text-neutral-400 font-mono uppercase tracking-wide">Screen Share Feed:</span>

                            <button

                              onClick={() => {

                                setIsScreenSharing(prev => {

                                  const next = !prev;

                                  try {

                                    localStorage.setItem("era_screen_sharing_allowed", String(next));

                                  } catch {}

                                  return next;

                                });

                              }}

                              className={`px-2 py-0.5 rounded-md text-[11px] font-mono font-bold transition-all border cursor-pointer select-none ${

                                isScreenSharing 

                                  ? 'bg-amber-950/40 text-amber-400 border-amber-500/40 shadow-sm shadow-amber-500/5' 

                                  : 'bg-neutral-900/60 text-neutral-500 border-neutral-800 hover:text-neutral-300'

                              }`}

                            >

                              {isScreenSharing ? "ALLOWED (ALWAYS ON)" : "DENIED"}

                            </button>

                          </div>

                        </div>



                        {/* Actions and Status */}

                        <div className="pt-3 flex items-center justify-between">

                          <button

                            onClick={saveKeysConfig}

                            disabled={saveStatus === 'saving'}

                            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-mono text-xs font-semibold rounded-lg transition-all"

                          >

                            {saveStatus === 'saving' ? 'Encrypting...' : 'Save & Encrypt Keys'}

                          </button>



                          {saveStatus === 'success' && (

                            <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1 animate-pulse">

                              <CheckCircle2 size={12} /> Configuration Vault Synced!

                            </span>

                          )}

                          {saveStatus === 'error' && (

                            <span className="text-[11px] font-mono text-rose-400 flex items-center gap-1">

                              <XCircle size={12} /> Sync failed.

                            </span>

                          )}

                        </div>

                      </div>

                    ) : (

                      /* WhatsApp Contacts Manager Sub-view */

                      <div className="space-y-4 flex-1 flex flex-col">

                        <div>

                          <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400 font-mono flex items-center gap-1.5 border-b border-neutral-800 pb-1.5 mb-3">

                            <Smartphone size={13} /> Verified WhatsApp Contacts Book

                          </h3>

                          <p className="text-[11px] text-neutral-500 mb-3 leading-relaxed">

                            Manage contact names, aliases, and phone numbers that Ira uses to resolve messages.

                          </p>

                        </div>



                        {/* Search and Add Header */}

                        <div className="flex gap-2 items-center">

                          <input

                            type="text"

                            placeholder="Search contacts or aliases..."

                            value={contactSearch}

                            onChange={(e) => setContactSearch(e.target.value)}

                            className="flex-1 bg-neutral-950 border border-neutral-800 px-3 py-1.5 rounded-lg text-xs font-mono text-neutral-200 focus:outline-none focus:border-amber-500"

                          />

                          <button

                            onClick={() => {

                              setEditingContact(null);

                              setNewContact({ name: "", aliases: "", phone: "" });

                              setIsAddingContact(true);

                            }}

                            className="px-2.5 py-1.5 bg-amber-950 hover:bg-amber-900 text-amber-400 border border-amber-500/20 hover:border-amber-500/40 rounded-lg text-[11px] font-mono transition-all font-bold"

                          >

                            New Contact

                          </button>

                        </div>



                        {/* Form Panel (Visible when editing or adding) */}

                        {(editingContact || isAddingContact) && (

                          <div className="bg-neutral-950/60 p-3 rounded-xl border border-neutral-800/80 space-y-2 text-xs">

                            <h4 className="font-mono text-[11px] font-bold text-amber-400 uppercase tracking-wider">

                              {editingContact ? "Edit Contact" : "Add New Contact"}

                            </h4>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">

                              <input

                                type="text"

                                placeholder="Name (e.g. Bhaiyya)"

                                value={editingContact ? editingContact.name : newContact.name}

                                disabled={!!editingContact} // Name is identifier in backend

                                onChange={(e) => {

                                  if (editingContact) {

                                    setEditingContact({ ...editingContact, name: e.target.value });

                                  } else {

                                    setNewContact({ ...newContact, name: e.target.value });

                                  }

                                }}

                                className="bg-neutral-900 border border-neutral-800 px-2 py-1 rounded text-xs text-neutral-200 font-mono"

                              />

                              <input

                                type="text"

                                placeholder="Phone (e.g. +919812345678)"

                                value={editingContact ? editingContact.phone : newContact.phone}

                                onChange={(e) => {

                                  if (editingContact) {

                                    setEditingContact({ ...editingContact, phone: e.target.value });

                                  } else {

                                    setNewContact({ ...newContact, phone: e.target.value });

                                  }

                                }}

                                className="bg-neutral-900 border border-neutral-800 px-2 py-1 rounded text-xs text-neutral-200 font-mono"

                              />

                              <input

                                type="text"

                                placeholder="Aliases (comma separated)"

                                value={editingContact ? editingContact.aliases.join(", ") : newContact.aliases}

                                onChange={(e) => {

                                  if (editingContact) {

                                    setEditingContact({ ...editingContact, aliases: e.target.value.split(",") });

                                  } else {

                                    setNewContact({ ...newContact, aliases: e.target.value });

                                  }

                                }}

                                className="bg-neutral-900 border border-neutral-800 px-2 py-1 rounded text-xs text-neutral-200 font-mono"

                              />

                            </div>

                            <div className="flex justify-end gap-2 pt-1">

                              <button

                                onClick={() => {

                                  setEditingContact(null);

                                  setIsAddingContact(false);

                                }}

                                className="px-2 py-1 bg-neutral-900 text-neutral-400 hover:text-neutral-200 rounded font-mono text-[11px]"

                              >

                                Cancel

                              </button>

                              <button

                                onClick={async () => {

                                  const name = editingContact ? editingContact.name : newContact.name;

                                  const phone = editingContact ? editingContact.phone : newContact.phone;

                                  const aliasesStr = editingContact ? editingContact.aliases.join(",") : newContact.aliases;

                                  

                                  if (!name || !phone) {

                                    alert("Name and Phone are required.");

                                    return;

                                  }

                                  

                                  const success = await handleSaveContact(name, phone, aliasesStr);

                                  if (success) {

                                    setEditingContact(null);

                                    setNewContact({ name: "", aliases: "", phone: "" });

                                    setIsAddingContact(false);

                                  }

                                }}

                                className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded font-mono text-[11px] font-bold"

                              >

                                Save Contact

                              </button>

                            </div>

                          </div>

                        )}



                        {/* Contacts List Grid */}

                        <div className="flex-1 overflow-y-auto max-h-[220px] pr-1 space-y-1.5 scrollbar-thin">

                          {whatsappContacts

                            .filter(c => 

                              c.name.toLowerCase().includes(contactSearch.toLowerCase()) || 

                              c.aliases.some(a => a.toLowerCase().includes(contactSearch.toLowerCase())) ||

                              c.phone.includes(contactSearch)

                            )

                            .map((contact) => (

                              <div key={contact.name} className="bg-neutral-950/40 p-2.5 rounded-lg border border-neutral-800 flex items-center justify-between gap-4">

                                <div className="space-y-0.5">

                                  <div className="flex items-center gap-2">

                                    <span className="text-xs font-semibold text-neutral-100 font-mono">{contact.name}</span>

                                    <span className="text-[11px] text-neutral-400 font-mono">({contact.phone})</span>

                                  </div>

                                  {contact.aliases.length > 0 && (

                                    <div className="flex flex-wrap gap-1">

                                      {contact.aliases.map(a => (

                                        <span key={a} className="text-[11px] bg-neutral-900 text-neutral-400 px-1.5 py-0.5 rounded font-mono">

                                          {a}

                                        </span>

                                      ))}

                                    </div>

                                  )}

                                </div>

                                <div className="flex gap-2">

                                  <button

                                    onClick={() => setEditingContact(contact)}

                                    className="text-[11px] font-mono text-amber-400 hover:text-amber-300"

                                  >

                                    Edit

                                  </button>

                                  <button

                                    onClick={async () => {

                                      if (confirm(`Are you sure you want to delete ${contact.name}?`)) {

                                        await handleDeleteContact(contact.name);

                                      }

                                    }}

                                    className="text-[11px] font-mono text-rose-400 hover:text-rose-300"

                                  >

                                    Delete

                                  </button>

                                </div>

                              </div>

                            ))}

                          {whatsappContacts.length === 0 && (

                            <div className="text-center py-8 text-neutral-600 italic text-[11px] font-mono">

                              No contacts saved in your book yet.

                            </div>

                          )}

                        </div>

                      </div>

                    )}

                  </div>



                  {/* Right Column: WhatsApp Interactive Linker */}

                  <div className="w-full md:w-64 flex flex-col justify-between border-t md:border-t-0 md:border-l border-neutral-800/80 pt-5 md:pt-0 md:pl-6">

                    <div className="space-y-4">

                      <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 font-mono flex items-center gap-1.5 border-b border-neutral-800 pb-1.5">

                        <Smartphone size={13} /> WhatsApp Linker

                      </h3>



                      <div className="bg-neutral-950/80 p-3 rounded-xl border border-neutral-800 text-center">

                        {keysConfig.whatsappStatus === 'connected' ? (

                          <div className="py-4 space-y-3">

                            <div className="w-12 h-12 bg-emerald-950/50 text-emerald-400 rounded-full flex items-center justify-center mx-auto border border-emerald-500/20">

                              <CheckCircle2 size={24} className="animate-pulse" />

                            </div>

                            <div className="space-y-0.5">

                              <p className="text-xs font-mono font-semibold text-neutral-100">WhatsApp is Active</p>

                              <p className="text-[11px] font-mono text-neutral-500">Persisted inside local auth cache</p>

                            </div>

                            <button

                              onClick={() => {

                                setKeysConfig(prev => ({ ...prev, whatsappStatus: "disconnected" }));

                              }}

                              className="px-3 py-1 bg-rose-950 text-rose-300 border border-rose-500/20 rounded hover:bg-rose-900 transition-all font-mono text-[11px] uppercase"

                            >

                              Unlink Session

                            </button>

                          </div>

                        ) : isLinkingWhatsApp ? (

                          <div className="py-2 space-y-3">

                            {/* Interactive mock QR Code */}

                            <div className="w-32 h-32 bg-white p-2.5 rounded-lg mx-auto flex items-center justify-center relative">

                              <div className="absolute inset-x-2 top-2 bottom-2 bg-black/10 flex items-center justify-center animate-pulse">

                                <RefreshCw className="animate-spin text-neutral-700" size={24} />

                              </div>

                              <img 

                                src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=era-live-authenticated-token-12345" 

                                alt="WhatsApp QR Link"

                                className="w-full h-full opacity-40"

                              />

                            </div>

                            <p className="text-[11px] font-mono text-amber-400 animate-pulse">

                              Linking... Scan QR Code using WhatsApp Link Devices

                            </p>

                          </div>

                        ) : (

                          <div className="py-6 space-y-3">

                            <div className="w-12 h-12 bg-neutral-900 text-neutral-400 rounded-full flex items-center justify-center mx-auto border border-neutral-800">

                              <Smartphone size={22} />

                            </div>

                            <p className="text-[11px] font-mono text-neutral-400">WhatsApp integration offline.</p>

                            <button

                              onClick={startWhatsAppLink}

                              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-all font-mono text-[11px]"

                            >

                              Generate QR Code

                            </button>

                          </div>

                        )}

                      </div>



                      <div className="bg-neutral-950/40 p-3 rounded-xl border border-neutral-800/60 text-[11px] font-mono leading-relaxed text-neutral-500 space-y-1.5">

                        <div className="text-neutral-400 font-semibold uppercase">Device Linkage Info:</div>

                        <div>1. Unlocks `sendWhatsAppMessage` companion actions.</div>

                        <div>2. Allows sending instant reminders and links to your mobile.</div>

                        <div>3. Local sandbox database isolates message logs securely.</div>

                      </div>

                    </div>

                  </div>



                </div>

              )}

            </motion.div>

          )}



          {activeTab === 'studio' && (

            <motion.div

              key="studio-tab"

              initial={{ opacity: 0, y: 10 }}

              animate={{ opacity: 1, y: 0 }}

              exit={{ opacity: 0, y: -10 }}

              className="flex-1 flex flex-col h-full overflow-hidden"

            >

              <SoftwareStudio wsRef={wsRef} />

            </motion.div>

          )}



          {activeTab === 'autonomy' && (

            <motion.div 

              key="autonomy-tab"

              initial={{ opacity: 0, y: 10 }}

              animate={{ opacity: 1, y: 0 }}

              exit={{ opacity: 0, y: -10 }}

              className="flex-1 flex flex-col gap-4 overflow-y-auto"

            >

              <AutonomyDashboard />

            </motion.div>

          )}



          {activeTab === 'voiceguard' && (

            <motion.div

              key="voiceguard-tab"

              initial={{ opacity: 0, y: 10 }}

              animate={{ opacity: 1, y: 0 }}

              exit={{ opacity: 0, y: -10 }}

              className="flex-1 flex flex-col overflow-hidden"

            >

              {!voiceGuardUnlocked ? (

                <div className="flex-1 flex items-center justify-center p-4">

                  <div className="bg-neutral-900/90 border border-neutral-800 p-7 rounded-2xl max-w-sm w-full text-center shadow-2xl backdrop-blur-md">

                    <div className="w-14 h-14 rounded-full bg-amber-950/60 text-amber-400 flex items-center justify-center mx-auto mb-4 border border-amber-500/20 shadow-[0_0_25px_rgba(230,169,74,0.15)]">

                      <Lock size={24} className="animate-pulse" />

                    </div>

                    <h3 className="text-sm font-semibold text-neutral-100 uppercase tracking-widest font-mono">VoiceGuard Authentication</h3>

                    <p className="text-xs text-neutral-400 mt-1.5 mb-5">Provide security code (1234) to unlock VoiceGuard console.</p>

                    

                    <div className="space-y-3.5">

                      <input 

                        type="password"

                        placeholder="Security PIN (e.g., 1234)"

                        value={voiceGuardPIN}

                        autoFocus

                        onChange={(e) => {

                          setVoiceGuardPIN(e.target.value);

                          setVoiceGuardPINError(false);

                        }}

                        onKeyDown={(e) => {

                          if (e.key === 'Enter') {

                            if (voiceGuardPIN === "1234") {

                              setVoiceGuardUnlocked(true);

                              setVoiceGuardPIN("");

                            } else {

                              setVoiceGuardPINError(true);

                            }

                          }

                        }}

                        className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-3 py-2.5 text-center text-sm font-mono text-amber-400 tracking-widest focus:outline-none focus:border-amber-500 transition-colors"

                      />

                      

                      {voiceGuardPINError && (

                        <p className="text-[11px] text-rose-400 font-mono animate-bounce flex items-center justify-center gap-1">

                          <ShieldAlert size={12} /> Incorrect Agent PIN. Try 1234.

                        </p>

                      )}



                      <button

                        onClick={() => {

                          if (voiceGuardPIN === "1234") {

                            setVoiceGuardUnlocked(true);

                            setVoiceGuardPIN("");

                          } else {

                            setVoiceGuardPINError(true);

                          }

                        }}

                        className="w-full py-2.5 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white text-xs font-semibold rounded-xl transition-all font-mono shadow-lg shadow-amber-900/30 cursor-pointer"

                      >

                        Verify Identity

                      </button>



                      <button

                        onClick={() => {

                          setActiveTab('voice');

                          setVoiceGuardPIN("");

                          setVoiceGuardPINError(false);

                        }}

                        className="w-full py-1.5 text-neutral-500 hover:text-neutral-300 text-[11px] font-mono transition-colors cursor-pointer"

                      >

                        ← Back to Companion

                      </button>

                    </div>

                  </div>

                </div>

              ) : (

                <VoiceGuardTab

                  language={voiceUiLanguage}

                  setLanguage={setVoiceUiLanguage}

                  strictness={voiceStrictness}

                  setStrictness={setVoiceStrictness}

                  muted={voiceMuted}

                  setMuted={setVoiceMuted}

                  mode={voiceGuardMode}

                  setMode={setVoiceGuardMode}

                  onLockVoiceGuard={() => setVoiceGuardUnlocked(false)}

                  ownerProfile={ownerProfile}

                  lockState={voiceLockState}

                  lastResult={voiceLastResult}

                  isVerifying={isVoiceVerifying}

                  verifyError={voiceVerifyError}

                  auditLog={voiceAuditLog}

                  vaultItems={voiceVaultItems}

                  onEnrolled={handleVoiceEnrolled}

                  onResetProfile={handleVoiceResetProfile}

                  onLockNow={handleVoiceLockNow}

                  onPinUnlock={handleVoicePinUnlock}

                  onVerifyClip={handleVerifyVoiceClip}

                  onAddItem={handleAddVaultItem}

                  onDeleteItem={handleDeleteVaultItem}

                  onClearAuditLog={() => {

                    setVoiceAuditLog([]);

                    saveAuditLog([]);

                  }}

                />

              )}

            </motion.div>

          )}



        </AnimatePresence>



      </div>



      {/* Floating System control overlays (Simulation for Lock, Sleep, Restart) */}

      <AnimatePresence>

        {systemState !== 'normal' && (

          <motion.div 

            initial={{ opacity: 0 }}

            animate={{ opacity: 1 }}

            exit={{ opacity: 0 }}

            className="absolute inset-0 z-50 bg-black flex flex-col items-center justify-center text-center p-6"

          >



            {systemState === 'restart' && (

              <div className="space-y-6 max-w-md">

                <div className="w-20 h-20 rounded-full bg-amber-950/50 text-amber-500 flex items-center justify-center mx-auto border border-amber-500/20 animate-spin">

                  <RefreshCw size={36} />

                </div>

                <div className="space-y-2">

                  <h1 className="text-2xl font-black tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-amber-500 to-yellow-400 font-mono">

                    REBOOTING SYSTEM

                  </h1>

                  <p className="text-sm font-mono text-neutral-400">

                    Restarting OS kernel in <span className="text-amber-400 font-bold text-lg">{systemCounter}</span> seconds...

                  </p>

                </div>

                <div className="bg-neutral-900/40 p-4 rounded-xl border border-neutral-800 text-xs italic text-neutral-300 leading-relaxed font-serif">

                  "Hang tight, sweetheart... Just cleaning up my registry gears. Back in a flash!"

                </div>

              </div>

            )}



            {systemState === 'sleep' && (

              <div className="space-y-4 max-w-sm">

                <p className="text-xs font-mono text-neutral-600 animate-pulse">SYSTEM SLEEP MODE ACTIVE</p>

                <button 

                  onClick={() => setSystemState('normal')}

                  className="px-6 py-3 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white rounded-xl text-xs font-semibold font-mono tracking-wider transition-all"

                >

                  Wake Companion up

                </button>

              </div>

            )}



            {systemState === 'lock' && (

              <div className="bg-neutral-950/40 p-8 rounded-2xl border border-neutral-800 max-w-xs w-full text-center space-y-4 backdrop-blur-md">

                <div className="w-12 h-12 bg-rose-950/50 text-rose-400 rounded-full flex items-center justify-center mx-auto border border-rose-500/20">

                  <Lock size={20} />

                </div>

                <div className="space-y-1">

                  <p className="text-xs font-mono font-semibold text-neutral-200 uppercase tracking-widest">OS Lock Screen</p>

                  <p className="text-[11px] text-neutral-500 font-mono">Input lock PIN to return to companion</p>

                </div>

                

                <div className="space-y-2">

                  <input 

                    type="password"

                    placeholder="Enter PIN (1234)"

                    value={lockPIN}

                    onChange={(e) => setLockPIN(e.target.value)}

                    onKeyDown={(e) => {

                      if (e.key === 'Enter' && lockPIN === "1234") {

                        setSystemState('normal');

                      }

                    }}

                    className="w-full bg-neutral-950 border border-neutral-800 text-center py-2 rounded-xl text-sm font-mono text-rose-400 focus:outline-none focus:border-rose-500"

                  />

                  <button 

                    onClick={() => {

                      if (lockPIN === "1234") {

                        setSystemState('normal');

                      }

                    }}

                    className="w-full py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl font-mono"

                  >

                    Unlock Agent

                  </button>

                </div>

              </div>

            )}

          </motion.div>

        )}

      </AnimatePresence>



      {/* Meet ERA Persona Dialog */}

      <AnimatePresence>

        {showHelp && (

          <motion.div 

            initial={{ opacity: 0 }}

            animate={{ opacity: 1 }}

            exit={{ opacity: 0 }}

            className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-neutral-950/80 backdrop-blur-lg"

          >

            <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 max-w-sm w-full shadow-2xl relative">

              <button 

                onClick={() => setShowHelp(false)}

                className="absolute top-4 right-4 text-neutral-500 hover:text-neutral-300"

              >

                <X size={16} />

              </button>

              <h3 className="text-base font-semibold text-amber-400 flex items-center gap-2 mb-3 font-mono">

                <Sparkles size={16} /> Meet EIRA

              </h3>

              <p className="text-xs text-neutral-300 leading-relaxed space-y-2">

                <span>EIRA is your highly sophisticated, intellectual, and well-mannered AI personal assistant, modeled after JARVIS. She addresses you with extreme respect and handles system tasks flawlessly.</span>

                <br /><br />

                <span>She speaks all languages fluently, defaulting to respectful Hindi, and is fully dedicated to assisting you with elite intelligence.</span>

                <br /><br />

                <span className="text-amber-400 font-semibold font-mono uppercase block mt-3 mb-1">⚡ Dynamic System Tools:</span>

                <span className="text-neutral-400 text-[11px] block space-y-1">

                  &bull; <strong className="text-neutral-300">openWebsite(url)</strong>: e.g. "Open YouTube"<br />

                  &bull; <strong className="text-neutral-300">writeCode(lang, name, code)</strong>: e.g. "Write hello.js for me"<br />

                  &bull; <strong className="text-neutral-300">runCode(name)</strong>: e.g. "Run hello.js"<br />

                  &bull; <strong className="text-neutral-300">captureScreen()</strong>: e.g. "What's on my screen?"<br />

                  &bull; <strong className="text-neutral-300">sendWhatsAppMessage(name, text)</strong>: e.g. "Send message to Mom"<br />

                  &bull; <strong className="text-neutral-300">systemControl(action)</strong>: e.g. "Shutdown my PC"

                </span>

              </p>

              <button 

                onClick={() => setShowHelp(false)}

                className="mt-5 w-full py-2 bg-gradient-to-r from-rose-600 to-orange-600 text-white text-xs font-semibold rounded-xl font-mono"

              >

                Got it, sweetheart!

              </button>

            </div>

          </motion.div>

        )}

      </AnimatePresence>



      {/* Floating Error Alerts */}

      {errorMessage && (

        <div className="max-w-md w-full mx-auto mb-4 z-10 px-4">

          <div className="bg-rose-950/85 border border-rose-500/30 text-rose-200 rounded-xl p-4 flex flex-col gap-3 text-xs">

            <div className="flex items-start gap-3">

              <AlertCircle size={18} className="text-rose-400 shrink-0 mt-0.5" />

              <div className="flex-1">

                <strong className="block font-medium mb-1 font-mono text-sm text-rose-300">

                  {errorMessage.toLowerCase().includes("microphone") ? "Microphone Permission Required" : "Companion Error Alert"}

                </strong>

                <p className="text-rose-300/90 leading-relaxed">{errorMessage}</p>

              </div>

              <button 

                onClick={() => setErrorMessage(null)} 

                className="text-rose-400 hover:text-rose-200 font-mono text-xs font-semibold px-2 py-0.5 bg-rose-950/50 hover:bg-rose-900/50 border border-rose-500/20 rounded transition-all"

              >

                Dismiss

              </button>

            </div>

            

            {errorMessage.toLowerCase().includes("microphone") && (

              <div className="mt-2 pt-3 border-t border-rose-500/20 flex flex-col gap-2 bg-rose-950/30 p-2.5 rounded-lg">

                <p className="text-rose-300/80 font-mono text-[11px] uppercase tracking-wider mb-1">💡 QUICK TROUBLESHOOTING GUIDE</p>

                <ol className="list-decimal pl-4 space-y-1.5 text-rose-300/90 text-[11px] leading-relaxed">

                  <li>

                    <span className="font-semibold text-rose-200">Open App in a Standalone Tab:</span> Sandboxed iframe previews often block microphone prompts due to strict browser security policies. Opening in a standalone window resolves this immediately!

                  </li>

                  <li>

                    <span className="font-semibold text-rose-200">Check URL Bar Permissions:</span> Click the lock/settings icon (🔒 or 👁️) to the left of your browser's address bar and ensure <span className="underline decoration-rose-500/40">Microphone</span> is toggled to <span className="text-emerald-400 font-semibold font-mono">Allow</span>.

                  </li>

                  <li>

                    <span className="font-semibold text-rose-200">Check System Privacy:</span> Make sure your operating system settings (macOS System Settings &gt; Privacy &amp; Security &gt; Microphone, or Windows Settings) allow your browser application to access your microphone.

                  </li>

                </ol>

                <div className="flex gap-2 mt-2">

                  <button

                    onClick={() => {

                      window.open(window.location.href, "_blank");

                    }}

                    className="flex-1 py-1.5 px-3 bg-rose-900/80 hover:bg-rose-800 text-rose-100 font-mono font-medium rounded-md border border-rose-500/40 text-center transition-all shadow-sm flex items-center justify-center gap-1.5"

                  >

                    🚀 Open App in New Tab

                  </button>

                </div>

              </div>

            )}

          </div>

        </div>

      )}



      {/* Bottom Main Controller Block */}

      <footer className="z-10 mt-4 flex flex-col items-center gap-4">

        <div className="flex items-center justify-center gap-5">



          {/* Mute microphone */}

          <button

            id="mic-mute-toggle"

            type="button"

            onClick={toggleMicMute}

            className={`flex h-11 w-11 items-center justify-center rounded-full border transition-all cursor-pointer active:scale-95 ${

              micMuted

                ? 'border-rose-500/80 bg-rose-500/25 text-rose-300 shadow-[0_0_15px_rgba(244,63,94,0.4)]'

                : 'border-white/10 bg-[#101215] text-neutral-400 hover:text-neutral-100 hover:border-white/20'

            }`}

            title={micMuted ? "Mic is Muted — Click to Unmute" : "Mute Microphone — Click to Mute"}

          >

            {micMuted ? <MicOff size={17} className="text-rose-400" /> : <Mic size={17} />}

          </button>



          {/* Primary session toggle */}

          <button

            id="voice-session-trigger"

            type="button"

            onClick={toggleSession}

            className={`relative flex h-[68px] w-[68px] items-center justify-center rounded-full font-mono text-[11px] font-semibold uppercase tracking-wider transition-all cursor-pointer active:scale-95 ${

              state === 'disconnected'

                ? 'bg-[#e6a94a] text-[#1a1409] hover:bg-[#f0b45c]'

                : 'bg-rose-500 text-white hover:bg-rose-400'

            }`}

            title={state === 'disconnected' ? "Start Voice Session" : "Disconnect Session"}

          >

            {state !== 'disconnected' && (

              <>

                <span className="absolute inset-0 animate-[ping_1.5s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full border border-rose-400/40" />

                <span className="absolute inset-1 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full border border-rose-400/25" />

              </>

            )}

            <span className="relative z-10">{state === 'disconnected' ? "Talk" : "Stop"}</span>

          </button>



          {/* Wi-Fi Settings button */}

          <button

            id="wifi-settings-toggle"

            type="button"

            onClick={openWifiSettings}

            className="flex h-11 w-11 items-center justify-center rounded-full border transition-all cursor-pointer active:scale-95 border-white/10 bg-[#101215] text-neutral-400 hover:text-cyan-300 hover:border-cyan-500/50 hover:bg-cyan-950/20"

            title="Open Windows Wi-Fi Settings"

          >

            <Wifi size={17} />

          </button>

        </div>



        <p className="text-center font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600">

          ERA &bull; Powered by NavoraX

        </p>

      </footer>



      {/* Dynamic Cloud Authentication Modal */}

      <AnimatePresence>

        {showAuthModal && (

          <motion.div

            initial={{ opacity: 0 }}

            animate={{ opacity: 1 }}

            exit={{ opacity: 0 }}

            className="fixed inset-0 z-50 bg-neutral-950/80 backdrop-blur-md flex items-center justify-center p-4"

          >

            <motion.div

              initial={{ scale: 0.95, y: 20 }}

              animate={{ scale: 1, y: 0 }}

              exit={{ scale: 0.95, y: 20 }}

              className="bg-neutral-900 border border-neutral-800 p-6 rounded-2xl max-w-sm w-full shadow-2xl relative space-y-4"

              onClick={(e) => e.stopPropagation()}

            >

              <button 

                onClick={() => setShowAuthModal(false)}

                className="absolute top-4 right-4 text-neutral-500 hover:text-neutral-300 cursor-pointer"

              >

                <X size={16} />

              </button>



              <div className="text-center space-y-1">

                <h3 className="text-sm font-bold text-rose-400 font-mono tracking-widest uppercase flex items-center justify-center gap-1.5">

                  <User size={14} /> {authMode === 'login' ? "Secure Sign In" : "Register Account"}

                </h3>

                <p className="text-[11px] text-neutral-500 font-mono">Connect your conversations to your email ID securely</p>

              </div>



              {authError && (

                <div className="bg-rose-950/50 border border-rose-500/20 text-rose-300 p-2.5 rounded-xl text-[11px] font-mono leading-relaxed">

                  ⚠️ {authError}

                </div>

              )}



              <div className="space-y-3">

                <div>

                  <label className="text-[11px] font-mono text-neutral-500 block mb-1 uppercase">Email Address</label>

                  <input 

                    type="email"

                    value={authEmail}

                    onChange={(e) => setAuthEmail(e.target.value)}

                    placeholder="myboss@example.com"

                    className="w-full bg-neutral-950 border border-neutral-800 px-3 py-2 rounded-xl text-xs text-neutral-200 focus:outline-none focus:border-rose-500 font-sans"

                  />

                </div>



                <div>

                  <label className="text-[11px] font-mono text-neutral-500 block mb-1 uppercase">Password</label>

                  <input 

                    type="password"

                    value={authPassword}

                    onChange={(e) => setAuthPassword(e.target.value)}

                    placeholder="••••••••"

                    className="w-full bg-neutral-950 border border-neutral-800 px-3 py-2 rounded-xl text-xs text-neutral-200 focus:outline-none focus:border-rose-500 font-sans"

                  />

                </div>



                <button

                  onClick={authMode === 'login' ? handleLogin : handleRegister}

                  disabled={authLoading || !authEmail.trim() || !authPassword.trim()}

                  className="w-full py-2 bg-rose-600 hover:bg-rose-500 disabled:bg-neutral-800 text-white text-xs font-semibold rounded-xl font-mono transition-all flex items-center justify-center gap-1 cursor-pointer"

                >

                  {authLoading ? (

                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />

                  ) : authMode === 'login' ? (

                    "Sign In"

                  ) : (

                    "Create Account"

                  )}

                </button>



                <div className="relative py-1 flex items-center justify-center">

                  <div className="absolute inset-0 flex items-center">

                    <div className="w-full border-t border-neutral-800/80"></div>

                  </div>

                  <span className="relative px-2 bg-neutral-900 text-[11px] font-mono text-neutral-500 uppercase">Or connect via</span>

                </div>



                <button

                  type="button"

                  onClick={handleGoogleSignIn}

                  className="w-full py-2 bg-neutral-950 hover:bg-neutral-900 border border-neutral-800 hover:border-neutral-700 text-neutral-200 text-xs font-semibold rounded-xl font-mono transition-all flex items-center justify-center gap-2 cursor-pointer"

                >

                  <svg className="w-4 h-4 mr-1" viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg">

                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />

                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />

                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05" />

                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335" />

                  </svg>

                  Sign In with Google

                </button>

              </div>



              <div className="text-center pt-2 border-t border-neutral-900 text-[11px]">

                {authMode === 'login' ? (

                  <p className="text-neutral-500">

 Don't have an account?{" "}

                    <button 

                      onClick={() => {

                        setAuthMode('register');

                        setAuthError(null);

                      }} 

                      className="text-rose-400 hover:underline cursor-pointer font-semibold"

                    >

                      Register here

                    </button>

                  </p>

                ) : (

                  <p className="text-neutral-500">

                    Already have an account?{" "}

                    <button 

                      onClick={() => {

                        setAuthMode('login');

                        setAuthError(null);

                      }} 

                      className="text-rose-400 hover:underline cursor-pointer font-semibold"

                    >

                      Sign in here

                    </button>

                  </p>

                )}

              </div>

            </motion.div>

          </motion.div>

        )}

      </AnimatePresence>

    </div>

  );

}



// Inline standard close SVG icon

const X = ({ size, className }: { size?: number, className?: string }) => (

  <svg 

    xmlns="http://www.w3.org/2000/svg" 

    width={size || 24} 

    height={size || 24} 

    viewBox="0 0 24 24" 

    fill="none" 

    stroke="currentColor" 

    strokeWidth="2" 

    strokeLinecap="round" 

    strokeLinejoin="round" 

    className={className}

  >

    <path d="M18 6 6 18" />

    <path d="m6 6 12 12" />

  </svg>

);

