import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "../types";
import { isPhantomNoiseTranscript, transliterateDevanagariToHinglish } from "../lib/hinglishTransliterate";

/**
 * LiveTranscript
 * ------------------------------------------------------------------
 * The side panel that mirrors the voice & text conversation as chat
 * messages, exactly in the language spoken. Message text is rendered
 * verbatim without forced translation.
 */

export type TranscriptItem = {
  id: string;
  sender: string;
  text: string;
  timestamp: Date;
};

type Props = {
  messages: TranscriptItem[];
  /** ids that came from the live voice stream, used for the VOICE tag */
  voiceIds?: string[];
  state: SessionState;
  /** same text formatter the app already used for ERA replies */
  formatModelText?: (text: string) => string;
  isLoading?: boolean;
  className?: string;
};

type SpeakerFilter = "all" | "user" | "model";

const SPEAKERS: { key: SpeakerFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "user", label: "You" },
  { key: "model", label: "ERA" },
];

/** Which script or language is the conversation actually in? Used only for the chip label. */
export function detectLanguage(text: string): string {
  if (!text || !text.trim()) return "Hindi";
  if (/[\u0900-\u097F]/.test(text)) return "Hindi";
  if (/[\u0600-\u06FF]/.test(text)) return "Urdu";
  if (/[\u0980-\u09FF]/.test(text)) return "Bengali";
  if (/[\u0A00-\u0A7F]/.test(text)) return "Punjabi";
  if (/[\u0A80-\u0AFF]/.test(text)) return "Gujarati";
  if (/[\u0B80-\u0BFF]/.test(text)) return "Tamil";
  if (/[\u0C00-\u0C7F]/.test(text)) return "Telugu";
  if (/[\u0C80-\u0CFF]/.test(text)) return "Kannada";
  if (/[\u0D00-\u0D7F]/.test(text)) return "Malayalam";

  // Romanized Hindi / Hinglish conversational vocabulary
  if (/\b(kya|kaise|kaisa|kaisi|haan|nahi|nahin|karo|karna|karu|batao|theek|mera|meri|mere|aap|aapka|aapki|tum|tumhara|hum|yeh|ye|woh|wo|hai|hain|hoon|ho|kar|rahe|raha|rahi|shukriya|namaste|kuch|bolo|bolna|sun|suno|samajh|madad|chalo|gaana|aawaz|baat|baatein|dost|bhai|sahab|ji|bhaiyya|kripya|accha|achha|achhi|kaha|kidhar|kab|kyun|kyu|kaun)\b/i.test(text)) {
    return "Hindi";
  }

  return "English";
}

function formatTime(ts: Date): string {
  const d = ts instanceof Date ? ts : new Date(ts as unknown as string);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function LiveTranscript({
  messages,
  voiceIds,
  state,
  formatModelText,
  isLoading = false,
  className = "",
}: Props) {
  const [speaker, setSpeaker] = useState<SpeakerFilter>("all");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const voiceSet = useMemo(() => new Set(voiceIds || []), [voiceIds]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (messages || []).filter((m) => {
      // Discard phantom noise hallucinations like "Tchá.", "Tsk.", isolated punctuation
      if (isPhantomNoiseTranscript(m.text)) return false;
      const isUser = m.sender === "user" || m.sender === "User";
      if (speaker === "user" && !isUser) return false;
      if (speaker === "model" && isUser) return false;
      const clean = transliterateDevanagariToHinglish(m.text || "").toLowerCase();
      if (q && !clean.includes(q) && !(m.text || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [messages, speaker, query]);

  const language = useMemo(() => {
    const tail = (messages || []).slice(-6).map((m) => m.text || "").join(" ");
    return detectLanguage(tail);
  }, [messages]);

  const lastMessageText = messages && messages.length > 0 ? messages[messages.length - 1]?.text : "";
  const lastMessageId = messages && messages.length > 0 ? messages[messages.length - 1]?.id : "";

  // Follow the conversation on any new message or streaming chunk
  useEffect(() => {
    const scrollToBottom = () => {
      if (endRef.current) {
        endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
      }
      if (listRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      }
    };
    scrollToBottom();
    setShowJump(false);
    setAutoScroll(true);
    const timeout = setTimeout(scrollToBottom, 60);
    return () => clearTimeout(timeout);
  }, [messages?.length, lastMessageId, lastMessageText, visible.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceToBottom < 60;
    setShowJump(!atBottom);
    if (atBottom) {
      if (!autoScroll) setAutoScroll(true);
    } else {
      if (autoScroll) setAutoScroll(false);
    }
  };

  const jumpToLatest = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    setAutoScroll(true);
    setShowJump(false);
  };

  const copy = async (m: TranscriptItem) => {
    try {
      const textToCopy = transliterateDevanagariToHinglish(m.text || "");
      await navigator.clipboard.writeText(textToCopy);
      setCopiedId(m.id);
      window.setTimeout(() => setCopiedId((id) => (id === m.id ? null : id)), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <section className={`flex min-h-0 flex-col ${className}`}>
      {/* Panel header */}
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-neutral-100 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          Live Conversation
        </h3>
        <span
          className="inline-flex items-center gap-1 rounded-[5px] border border-[#e6a94a]/30 bg-[#e6a94a]/10 px-1.5 py-[1px] font-mono text-[9.5px] text-[#e6a94a]"
          title="Conversation language detected in real-time"
        >
          <span className="h-1 w-1 rounded-full bg-[#e6a94a]" />
          {language}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setSearchOpen((v) => !v);
              if (searchOpen) setQuery("");
            }}
            title="Search transcript"
            className="btn btn-ghost btn-sm !px-2"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => {
              setAutoScroll((v) => {
                const next = !v;
                if (next && listRef.current) {
                  listRef.current.scrollTop = listRef.current.scrollHeight;
                  endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
                }
                return next;
              });
            }}
            title={autoScroll ? "Pause auto-scroll" : "Resume auto-scroll"}
            className={`btn btn-ghost btn-sm !px-2 ${autoScroll ? "!text-[#e6a94a]" : ""}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14" />
              <path d="m5 12 7 7 7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#101215] p-[3px]">
          {SPEAKERS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSpeaker(s.key)}
              className={`rounded-md px-2 py-[3px] font-mono text-[9.5px] transition-colors ${
                speaker === s.key
                  ? "bg-white/10 font-semibold text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-200"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[9.5px] text-neutral-600">
          {visible.length} {visible.length === 1 ? "turn" : "turns"}
        </span>
      </div>

      {searchOpen && (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversation…"
          className="field mb-2 !py-1.5 !text-[11.5px]"
        />
      )}

      {/* The conversation messages container */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={onScroll}
          className="h-[380px] max-h-[460px] space-y-3 overflow-y-auto pr-1"
        >
          {visible.length === 0 ? (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-lg border border-white/5 bg-[#0a0b0d]/60 px-6 text-center">
              <p className="text-[12px] font-medium text-neutral-300">
                {query ? "No messages match that search" : "No conversation yet / अभी कोई बात नहीं हुई"}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                {query
                  ? "Try a different word, or clear the search."
                  : "Voice Mode on karke boliye ya niche type kijiye — aapki baatein yahan turant dikhengi."}
              </p>
            </div>
          ) : (
            visible.map((m, idx) => {
              const isUser = m.sender === "user" || m.sender === "User";
              const isVoice = voiceSet.has(m.id);
              const formattedRaw = isUser ? m.text : (formatModelText ? formatModelText(m.text) : m.text);
              const displayText = transliterateDevanagariToHinglish(formattedRaw);

              return (
                <div key={`${m.id}_${idx}`} className="group animate-fade-up">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span
                      className={`grid h-[18px] w-[18px] place-items-center rounded-[5px] border font-mono text-[9px] ${
                        isUser
                          ? "border-white/10 bg-[#1b1f24] text-neutral-400"
                          : "border-[#e6a94a]/30 bg-[#e6a94a]/10 text-[#e6a94a]"
                      }`}
                    >
                      {isUser ? "Y" : "E"}
                    </span>
                    <span className="text-[11px] font-semibold text-neutral-300">
                      {isUser ? "You" : "ERA"}
                    </span>
                    <span className="font-mono text-[9px] text-neutral-600">
                      {formatTime(m.timestamp)}
                    </span>
                    {isVoice && (
                      <span className="rounded-[3px] border border-white/10 px-[3px] font-mono text-[8.5px] tracking-wide text-neutral-500">
                        VOICE
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => copy(m)}
                      className="ml-auto font-mono text-[9px] text-neutral-600 opacity-0 transition-opacity hover:text-[#e6a94a] group-hover:opacity-100"
                      title="Copy message"
                    >
                      {copiedId === m.id ? "copied" : "copy"}
                    </button>
                  </div>
                  <p
                    className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed rounded-lg p-2 ${
                      isUser 
                        ? "bg-[#14171b] border border-white/5 text-neutral-100" 
                        : "bg-[#181510] border border-amber-500/10 text-neutral-200"
                    }`}
                  >
                    {displayText}
                  </p>
                </div>
              );
            })
          )}

          {/* Live Listening Indicator */}
          {state === "listening" && (
            <div className="flex items-center gap-2 pt-1 animate-fade-in">
              <span className="grid h-[18px] w-[18px] place-items-center rounded-[5px] border border-rose-500/35 bg-rose-500/10 font-mono text-[9px] text-rose-300">
                Y
              </span>
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-rose-300">
                Listening / सुन रहा हूँ
                <span className="flex gap-[3px]">
                  <span className="h-[3px] w-[3px] animate-bounce rounded-full bg-rose-400" />
                  <span className="h-[3px] w-[3px] animate-bounce rounded-full bg-rose-400 [animation-delay:120ms]" />
                  <span className="h-[3px] w-[3px] animate-bounce rounded-full bg-rose-400 [animation-delay:240ms]" />
                </span>
              </span>
            </div>
          )}

          {/* Live Speaking Indicator */}
          {state === "speaking" && (
            <div className="flex items-center gap-2 pt-1 animate-fade-in">
              <span className="grid h-[18px] w-[18px] place-items-center rounded-[5px] border border-amber-500/35 bg-amber-500/10 font-mono text-[9px] text-amber-300">
                E
              </span>
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300">
                ERA Speaking...
                <span className="flex gap-[3px]">
                  <span className="h-[3px] w-[3px] animate-bounce rounded-full bg-amber-400" />
                  <span className="h-[3px] w-[3px] animate-bounce rounded-full bg-amber-400 [animation-delay:120ms]" />
                  <span className="h-[3px] w-[3px] animate-bounce rounded-full bg-amber-400 [animation-delay:240ms]" />
                </span>
              </span>
            </div>
          )}

          {/* ERA Thinking Indicator */}
          {isLoading && state !== "speaking" && (
            <div className="flex items-center gap-2 pt-1 animate-fade-in">
              <span className="grid h-[18px] w-[18px] place-items-center rounded-[5px] border border-[#e6a94a]/30 bg-[#e6a94a]/10 font-mono text-[9px] text-[#e6a94a]">
                E
              </span>
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#e6a94a]">
                ERA is thinking
                <span className="flex gap-[3px]">
                  <span className="h-[3px] w-[3px] animate-bounce rounded-full bg-[#e6a94a]" />
                  <span className="h-[3px] w-[3px] animate-bounce rounded-full bg-[#e6a94a] [animation-delay:120ms]" />
                  <span className="h-[3px] w-[3px] animate-bounce rounded-full bg-[#e6a94a] [animation-delay:240ms]" />
                </span>
              </span>
            </div>
          )}

          <div ref={endRef} />
        </div>

        {showJump && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="btn btn-sm absolute bottom-2 left-1/2 -translate-x-1/2 !bg-[#1b1f24] !text-[11px] shadow-lg"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14" />
              <path d="m5 12 7 7 7-7" />
            </svg>
            Latest
          </button>
        )}
      </div>
    </section>
  );
}

export default LiveTranscript;
