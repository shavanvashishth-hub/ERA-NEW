/**
 * Indian Standard Time (IST / Asia/Kolkata, UTC+05:30) utilities and schedule time parser.
 *
 * India does not observe Daylight Saving Time, so IST is strictly UTC + 5h30m year-round.
 * Using explicit UTC+05:30 epoch arithmetic guarantees ERA always operates on Indian time
 * regardless of host OS timezone, browser locale, or container settings.
 */

export const IST_TIMEZONE = "Asia/Kolkata";
export const IST_OFFSET_MINUTES = 330; // +05:30
export const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export interface IstDateParts {
  epochMs: number;
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour24: number; // 0-23
  hour12: number; // 1-12
  ampm: "AM" | "PM";
  minute: number; // 0-59
  second: number; // 0-59
  weekday: string;
  weekdayShort: string;
  monthName: string;
  monthShort: string;
  isoIst: string;
  displayTime12: string;
  displayTime12Short: string;
  displayTime24: string;
  displayDate: string;
  fullIstLabel: string;
  timezone: string;
}

const pad2 = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, "0");

export function getIstDateParts(epochMs: number = Date.now()): IstDateParts {
  const shifted = new Date(epochMs + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour24 = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();
  const dayIdx = shifted.getUTCDay();

  const ampm: "AM" | "PM" = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  const weekday = WEEKDAYS[dayIdx];
  const weekdayShort = WEEKDAYS_SHORT[dayIdx];
  const monthName = MONTHS[month - 1];
  const monthShort = MONTHS_SHORT[month - 1];

  const isoIst = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour24)}:${pad2(minute)}:${pad2(second)}+05:30`;
  const displayTime12 = `${pad2(hour12)}:${pad2(minute)}:${pad2(second)} ${ampm} IST`;
  const displayTime12Short = `${hour12}:${pad2(minute)} ${ampm} IST`;
  const displayTime24 = `${pad2(hour24)}:${pad2(minute)}:${pad2(second)} IST`;
  const displayDate = `${weekdayShort}, ${pad2(day)} ${monthShort} ${year}`;
  const fullIstLabel = `${displayDate}, ${displayTime12}`;

  return {
    epochMs,
    year,
    month,
    day,
    hour24,
    hour12,
    ampm,
    minute,
    second,
    weekday,
    weekdayShort,
    monthName,
    monthShort,
    isoIst,
    displayTime12,
    displayTime12Short,
    displayTime24,
    displayDate,
    fullIstLabel,
    timezone: "Asia/Kolkata (IST, UTC+05:30)",
  };
}

export function formatIstIso(epochMs: number = Date.now()): string {
  return getIstDateParts(epochMs).isoIst;
}

export function formatIstTime12(epochMs: number = Date.now(), includeSeconds = true): string {
  const parts = getIstDateParts(epochMs);
  return includeSeconds ? parts.displayTime12 : parts.displayTime12Short;
}

export function formatIstDateTime(epochMs: number = Date.now()): string {
  return getIstDateParts(epochMs).fullIstLabel;
}

export function istWallClockToEpochMs(
  year: number,
  month: number,
  day: number,
  hour24: number,
  minute: number,
  second = 0
): number {
  return Date.UTC(year, month - 1, day, hour24, minute, second, 0) - IST_OFFSET_MS;
}

export function getIstHour(epochMs: number = Date.now()): number {
  return getIstDateParts(epochMs).hour24;
}

export function getIstGreeting(epochMs: number = Date.now()): string {
  const hour = getIstHour(epochMs);
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good night";
}

export function getIstPromptBanner(epochMs: number = Date.now()): string {
  const p = getIstDateParts(epochMs);
  return [
    "INDIAN STANDARD TIME (IST) CLOCK CONTEXT (STRICT & MANDATORY):",
    `- Current Indian Standard Time (IST / Asia/Kolkata, UTC+05:30): ${p.fullIstLabel} (24h: ${p.displayTime24}, ISO: ${p.isoIst}).`,
    `- Today is ${p.weekday}, ${p.day} ${p.monthName} ${p.year}.`,
    "- ERA ALWAYS operates strictly on the Indian Time Clock (IST, Asia/Kolkata, UTC+05:30) — NEVER UTC, US, UK, or any other country's timezone.",
    "- Always interpret user clock references ('9 baje', '9:30 PM', 'subah 7 baje', 'exact 21:15') in IST and answer current time/date questions in IST.",
  ].join("\n");
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  ek: 1,
  aik: 1,
  one: 1,
  do: 2,
  two: 2,
  teen: 3,
  three: 3,
  char: 4,
  chaar: 4,
  four: 4,
  paanch: 5,
  panch: 5,
  five: 5,
  chhe: 6,
  che: 6,
  chhah: 6,
  six: 6,
  saat: 7,
  seven: 7,
  aath: 8,
  eight: 8,
  nau: 9,
  nine: 9,
  das: 10,
  ten: 10,
  gyarah: 11,
  eleven: 11,
  barah: 12,
  twelve: 12,
  terah: 13,
  thirteen: 13,
  chaudah: 14,
  fourteen: 14,
  pandrah: 15,
  fifteen: 15,
  bees: 20,
  twenty: 20,
  pachees: 25,
  "twenty-five": 25,
  tees: 30,
  thirty: 30,
  chalis: 40,
  forty: 40,
  pachas: 50,
  fifty: 50,
  saath: 60,
  sixty: 60,
  aadha: 0.5,
  aadhe: 0.5,
  adha: 0.5,
  adhe: 0.5,
  half: 0.5,
  dedh: 1.5,
  dhai: 2.5,
};

const NUM_WORD_ALT = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|");
const NUM_TOKEN_RE = `(?:\\d+(?:\\.\\d+)?|\\b(?:${NUM_WORD_ALT})\\b)`;
const UNIT_SEC_RE = `(?:seconds|second|sekands|sekends|sekand|sekend|sconds|scond|secon|secs|sec|s)\\b`;
const UNIT_MIN_RE = `(?:minutes|minute|minits|minit|minat|mints|mint|mins|min|m)\\b`;
const UNIT_HR_RE = `(?:ghantey|ghanto|ghante|ghanta|hours|hour|hrs|hr|h)\\b`;
const ANY_UNIT_RE = `(?:${UNIT_SEC_RE}|${UNIT_MIN_RE}|${UNIT_HR_RE})`;
const REL_BAAD_SUFFIX = `(?:k(?:e|a|i|ai)?\\s*)?(?:ba+d(?:\\s+me(?:in)?)?|later|from\\s+now|mein|me|mai|pachhi)`;
const REL_AFTER_RE = new RegExp(`\\b(?:after|in)\\s+${NUM_TOKEN_RE}\\s*${ANY_UNIT_RE}\\b`, "i");
const REL_BAAD_RE = new RegExp(`(?:^|\\s)${NUM_TOKEN_RE}\\s*${ANY_UNIT_RE}\\s*${REL_BAAD_SUFFIX}\\b`, "i");
const REL_COMPOUND_RE = new RegExp(
  `${NUM_TOKEN_RE}\\s*${ANY_UNIT_RE}(?:\\s+(?:aur|and)?\\s*${NUM_TOKEN_RE}\\s*${ANY_UNIT_RE})*\\s*${REL_BAAD_SUFFIX}\\b`,
  "i"
);

function parseNumToken(token: string): number | null {
  const clean = token.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(clean)) {
    const val = parseFloat(clean);
    return Number.isFinite(val) ? val : null;
  }
  return clean in NUMBER_WORDS ? NUMBER_WORDS[clean] : null;
}

function unitToSeconds(unit: string): number {
  const u = unit.trim().toLowerCase();
  if (/^(?:seconds|second|sekands|sekends|sekand|sekend|sconds|scond|secon|secs|sec|s)$/.test(u)) return 1;
  if (/^(?:minutes|minute|minits|minit|minat|mints|mint|mins|min|m)$/.test(u)) return 60;
  if (/^(?:ghantey|ghanto|ghante|ghanta|hours|hour|hrs|hr|h)$/.test(u)) return 3600;
  return 0;
}

export function formatHumanDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const remSec = s % 60;
  const parts: string[] = [];
  if (hrs > 0) parts.push(`${hrs} hour${hrs === 1 ? "" : "s"}`);
  if (mins > 0) parts.push(`${mins} minute${mins === 1 ? "" : "s"}`);
  if (remSec > 0) parts.push(`${remSec} second${remSec === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/**
 * Returns true if the message explicitly asks to schedule/delay an action for a future
 * duration or exact clock time (so instant fast-paths never fire it prematurely).
 */
export function hasExplicitSchedulePhrase(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase().trim();

  // 1. Relative delay patterns: "1 min ke baad", "ek min kai bad", "1 min bad me", "after 5 mins", "in 30 seconds"
  if (REL_AFTER_RE.test(lower) || REL_BAAD_RE.test(lower) || REL_COMPOUND_RE.test(lower)) {
    return true;
  }

  // 2. Explicit clock / AM-PM / "baje" / "baj kar"
  if (/\b\d{1,2}\s*(?:[:.]\s*\d{2}(?:\s*:\s*\d{2})?)?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(lower)) {
    return true;
  }
  if (/\b\d{1,2}(?:\s*[:.]\s*\d{2})?\s*(?:baj\s*kar|bajke|baje)\b/i.test(lower)) {
    return true;
  }
  if (/\b(?:exact|exect|fix|fixed|sharp|at|on)\s+\d{1,2}\s*[:.]\s*\d{2}\b/i.test(lower)) {
    return true;
  }
  if (/\b(?:subah|morning|dopahar|afternoon|sham|shaam|evening|raat|night)\s+(?:ko\s+)?(?:ke\s+)?\d{1,2}(?:[:.]\d{2})?(?:\s*(?:baje|pe|par|per|ko|am|pm))?\b/i.test(lower)) {
    return true;
  }
  if (/\b(?:kal|tomorrow|parso)\s+(?:subah|morning|dopahar|afternoon|sham|shaam|evening|raat|night|ko\s+\d{1,2}|\d{1,2}(?::\d{2})?\s*(?:baje|am|pm)|at\s+\d{1,2})\b/i.test(lower)) {
    return true;
  }

  // 3. Explicit scheduling/alarm keywords
  if (/\b(?:schedule\s+(?:kar|karo|kardo|karna|a\b|the\b|this|task)|timer\s+(?:set|laga|lagao|start)|alarm\s+(?:set|laga|lagao)|remind\s+me|yaad\s+dila(?:na|o|dena|do))\b/i.test(lower)) {
    return true;
  }

  return false;
}

export interface ParsedIstSchedule {
  ok: boolean;
  error?: string;
  triggerAtMs?: number;
  delayMs?: number;
  mode?: "relative" | "absolute";
  recurrence?: "once" | "daily";
  scheduledForIst?: string;
  scheduledForIsoIst?: string;
  humanDelayLabel?: string;
  remainderText?: string;
}

export interface IstScheduleSpec {
  delaySeconds?: number;
  delayMinutes?: number;
  delayHours?: number;
  targetTimeIst?: string;
  query?: string;
}

function parseIsoOrDateTimeIst(raw: string): number | null {
  const s = raw.trim();

  // ISO with explicit offset (+05:30, -05:00, Z)
  const isoWithTz = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.exec(s);
  if (isoWithTz) {
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // Naive YYYY-MM-DD[T ]HH:mm[:ss] -> ALWAYS interpret strictly as IST (+05:30)
  const isoNaive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (isoNaive) {
    const y = Number(isoNaive[1]);
    const m = Number(isoNaive[2]);
    const d = Number(isoNaive[3]);
    const h = Number(isoNaive[4]);
    const min = Number(isoNaive[5]);
    const sec = isoNaive[6] ? Number(isoNaive[6]) : 0;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && h >= 0 && h <= 23 && min >= 0 && min <= 59 && sec >= 0 && sec <= 59) {
      return istWallClockToEpochMs(y, m, d, h, min, sec);
    }
  }

  return null;
}

function addDaysToIstDate(year: number, month: number, day: number, addDays: number): { year: number; month: number; day: number } {
  const dt = new Date(Date.UTC(year, month - 1, day + addDays, 0, 0, 0));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

function stripMatchedPhrase(original: string, matched: string): string {
  const idx = original.toLowerCase().indexOf(matched.toLowerCase());
  if (idx === -1) return original;
  const before = original.slice(0, idx);
  const after = original.slice(idx + matched.length);
  return `${before} ${after}`
    .replace(/\b(?:exact|exect|fix|fixed|sharp|pe|par|per|ko|k(?:e|a|i|ai)?\s+ba+d(?:\s+me(?:in)?)?|ba+d(?:\s+me(?:in)?)?|later|at|on|in|after)\b\s*$/i, "")
    .replace(/^\s*(?:exact|exect|fix|fixed|sharp|pe|par|per|ko)\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseIstScheduleTime(spec: IstScheduleSpec, nowMs: number = Date.now()): ParsedIstSchedule {
  const recurrence: "once" | "daily" =
    spec.query && /\b(?:roz|har\s+roz|daily|every\s+day|everyday)\b/i.test(spec.query) ? "daily" : "once";

  // 1. Explicit numeric delay arguments
  const dSec = typeof spec.delaySeconds === "number" && Number.isFinite(spec.delaySeconds) ? spec.delaySeconds : 0;
  const dMin = typeof spec.delayMinutes === "number" && Number.isFinite(spec.delayMinutes) ? spec.delayMinutes : 0;
  const dHr = typeof spec.delayHours === "number" && Number.isFinite(spec.delayHours) ? spec.delayHours : 0;
  const totalDelaySec = dSec + dMin * 60 + dHr * 3600;

  if (totalDelaySec > 0) {
    const delayMs = Math.max(1000, Math.round(totalDelaySec * 1000));
    const triggerAtMs = nowMs + delayMs;
    return {
      ok: true,
      triggerAtMs,
      delayMs,
      mode: "relative",
      recurrence,
      scheduledForIst: formatIstDateTime(triggerAtMs),
      scheduledForIsoIst: formatIstIso(triggerAtMs),
      humanDelayLabel: formatHumanDuration(Math.round(delayMs / 1000)),
      remainderText: spec.query || "",
    };
  }

  // 2. Explicit targetTimeIst string (could be ISO, 24h/12h, Hinglish clock, or even relative string)
  const textToParse = (spec.targetTimeIst || spec.query || "").trim();
  if (!textToParse) {
    return { ok: false, error: "No delay or target IST time provided." };
  }

  if (spec.targetTimeIst) {
    const isoEpoch = parseIsoOrDateTimeIst(spec.targetTimeIst);
    if (isoEpoch !== null) {
      if (isoEpoch <= nowMs - 5000) {
        return {
          ok: false,
          error: `Requested IST time (${formatIstDateTime(isoEpoch)}) is already in the past. Current IST is ${formatIstDateTime(nowMs)}.`,
        };
      }
      const delayMs = Math.max(500, isoEpoch - nowMs);
      return {
        ok: true,
        triggerAtMs: isoEpoch,
        delayMs,
        mode: "absolute",
        recurrence,
        scheduledForIst: formatIstDateTime(isoEpoch),
        scheduledForIsoIst: formatIstIso(isoEpoch),
        humanDelayLabel: formatHumanDuration(Math.round(delayMs / 1000)),
        remainderText: spec.query || "",
      };
    }
  }

  // 3. Parse relative durations from natural language (supports compound e.g. "1 min 30 sec ke baad")
  const relChainPattern = new RegExp(
    `(?:(?:after|in)\\s+)?(${NUM_TOKEN_RE})\\s*(${ANY_UNIT_RE})(?:\\s*(?:aur|and|,)?\\s*(${NUM_TOKEN_RE})\\s*(${ANY_UNIT_RE}))?(?:\\s*${REL_BAAD_SUFFIX})?`,
    "i"
  );
  // Only treat as relative if either targetTimeIst explicitly passed it OR query has a delay indicator
  const hasRelativeCue =
    Boolean(spec.targetTimeIst && new RegExp(`^\\s*${NUM_TOKEN_RE}\\s*${ANY_UNIT_RE}`, "i").test(textToParse)) ||
    REL_AFTER_RE.test(textToParse) ||
    REL_BAAD_RE.test(textToParse);

  if (hasRelativeCue) {
    const m = relChainPattern.exec(textToParse);
    if (m) {
      const n1 = parseNumToken(m[1]);
      const u1 = unitToSeconds(m[2]);
      let sec = n1 !== null && u1 > 0 ? n1 * u1 : 0;
      if (m[3] && m[4]) {
        const n2 = parseNumToken(m[3]);
        const u2 = unitToSeconds(m[4]);
        if (n2 !== null && u2 > 0) sec += n2 * u2;
      }
      if (sec > 0) {
        const delayMs = Math.max(1000, Math.round(sec * 1000));
        const triggerAtMs = nowMs + delayMs;
        return {
          ok: true,
          triggerAtMs,
          delayMs,
          mode: "relative",
          recurrence,
          scheduledForIst: formatIstDateTime(triggerAtMs),
          scheduledForIsoIst: formatIstIso(triggerAtMs),
          humanDelayLabel: formatHumanDuration(Math.round(delayMs / 1000)),
          remainderText: stripMatchedPhrase(textToParse, m[0]),
        };
      }
    }
  }

  // 4. Parse absolute IST wall-clock time from natural language
  const nowIst = getIstDateParts(nowMs);
  let dayOffset = 0;
  let explicitDay = false;
  if (/\b(?:kal|tomorrow)\b/i.test(textToParse)) {
    dayOffset = 1;
    explicitDay = true;
  } else if (/\b(?:parso)\b/i.test(textToParse)) {
    dayOffset = 2;
    explicitDay = true;
  } else if (/\b(?:aaj|today)\b/i.test(textToParse)) {
    dayOffset = 0;
    explicitDay = true;
  }

  let periodHint: "am" | "pm" | "morning" | "afternoon" | "evening" | "night" | null = null;
  if (/\b(?:subah|subha|morning)\b/i.test(textToParse)) periodHint = "morning";
  else if (/\b(?:dopahar|afternoon)\b/i.test(textToParse)) periodHint = "afternoon";
  else if (/\b(?:sham|shaam|evening)\b/i.test(textToParse)) periodHint = "evening";
  else if (/\b(?:raat|night|midnight)\b/i.test(textToParse)) periodHint = "night";

  // Try Hinglish "X baj kar Y minute" / "X bajke Y min"
  let hourRaw: number | null = null;
  let minuteRaw = 0;
  let secondRaw = 0;
  let explicitAmPm: "am" | "pm" | null = null;
  let matchedClockSegment = "";

  const bajKarMatch =
    /(?:(?:subah|morning|dopahar|afternoon|sham|shaam|evening|raat|night|exact|exect|fix|fixed|sharp|at|kal|tomorrow|aaj|today)\s+)*(?:ko\s+)?(\d{1,2})\s*(?:baj\s*kar|bajke)\s*(\d{1,2})\s*(?:min|mins|minute|minutes)?\s*(?:(a\.?m\.?|p\.?m\.?))?\s*(?:baje|pe|par|per|ko)?/i.exec(
      textToParse
    );

  // Try standard HH:MM[:SS] [AM/PM] or H baje / H AM/PM
  const clockMatch =
    /(?:(?:subah|morning|dopahar|afternoon|sham|shaam|evening|raat|night|exact|exect|fix|fixed|sharp|at|kal|tomorrow|aaj|today)\s+)*(?:ko\s+)?(\d{1,2})(?:\s*[:.]\s*(\d{2})(?:\s*:\s*(\d{2}))?)?\s*(?:(a\.?m\.?|p\.?m\.?)\b|\b(baje)\b)(?:\s*(?:pe|par|per|ko))?/i.exec(
      textToParse
    );

  // Also try bare 24h/colon time after exact/fix/at or standalone in targetTimeIst
  const colonMatch =
    /(?:(?:exact|exect|fix|fixed|sharp|at|on|subah|morning|dopahar|afternoon|sham|shaam|evening|raat|night|kal|tomorrow|aaj|today)\s+)+(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*:\s*(\d{2}))?(?:\s*(?:pe|par|per|ko|ist))?/i.exec(
      textToParse
    );

  const bareTargetColon =
    spec.targetTimeIst && /^\s*(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*:\s*(\d{2}))?\s*(?:(a\.?m\.?|p\.?m\.?))?\s*(?:ist)?\s*$/i.exec(spec.targetTimeIst);

  if (bajKarMatch) {
    matchedClockSegment = bajKarMatch[0];
    hourRaw = Number(bajKarMatch[1]);
    minuteRaw = Number(bajKarMatch[2]);
    if (bajKarMatch[3]) explicitAmPm = bajKarMatch[3].toLowerCase().startsWith("a") ? "am" : "pm";
  } else if (bareTargetColon) {
    matchedClockSegment = bareTargetColon[0];
    hourRaw = Number(bareTargetColon[1]);
    minuteRaw = Number(bareTargetColon[2]);
    secondRaw = bareTargetColon[3] ? Number(bareTargetColon[3]) : 0;
    if (bareTargetColon[4]) explicitAmPm = bareTargetColon[4].toLowerCase().startsWith("a") ? "am" : "pm";
  } else if (clockMatch) {
    matchedClockSegment = clockMatch[0];
    hourRaw = Number(clockMatch[1]);
    minuteRaw = clockMatch[2] ? Number(clockMatch[2]) : 0;
    secondRaw = clockMatch[3] ? Number(clockMatch[3]) : 0;
    if (clockMatch[4]) explicitAmPm = clockMatch[4].toLowerCase().startsWith("a") ? "am" : "pm";
  } else if (colonMatch) {
    matchedClockSegment = colonMatch[0];
    hourRaw = Number(colonMatch[1]);
    minuteRaw = Number(colonMatch[2]);
    secondRaw = colonMatch[3] ? Number(colonMatch[3]) : 0;
  }

  if (hourRaw === null || hourRaw < 0 || hourRaw > 23 || minuteRaw < 0 || minuteRaw > 59 || secondRaw < 0 || secondRaw > 59) {
    return { ok: false, error: `Could not understand target IST time or delay from "${textToParse}".` };
  }

  // Resolve hour24 strictly in IST
  let candidateHours: number[] = [];
  if (hourRaw >= 13 || hourRaw === 0) {
    // Explicit 24-hour clock (e.g. 21:05 or 00:15)
    candidateHours = [hourRaw];
  } else if (explicitAmPm === "am" || periodHint === "morning") {
    candidateHours = [hourRaw === 12 ? 0 : hourRaw];
  } else if (explicitAmPm === "pm" || periodHint === "evening") {
    candidateHours = [hourRaw === 12 ? 12 : hourRaw + 12];
  } else if (periodHint === "afternoon") {
    candidateHours = [hourRaw >= 1 && hourRaw <= 6 ? hourRaw + 12 : hourRaw];
  } else if (periodHint === "night") {
    if (hourRaw === 12) candidateHours = [0];
    else if (hourRaw >= 4 && hourRaw <= 11) candidateHours = [hourRaw + 12];
    else candidateHours = [hourRaw]; // "raat 1 baje", "raat 2 baje" -> 01:00 / 02:00 AM
  } else {
    // Ambiguous 1..12 (e.g. "exact 9 baje", "9:30 pe") -> check both AM and PM, pick nearest future!
    const hAm = hourRaw === 12 ? 0 : hourRaw;
    const hPm = hourRaw === 12 ? 12 : hourRaw + 12;
    candidateHours = [hAm, hPm];
  }

  let chosenMs: number | null = null;
  const baseDate = addDaysToIstDate(nowIst.year, nowIst.month, nowIst.day, dayOffset);

  if (explicitDay) {
    // Pick the first candidate on that specific day (or next future if ambiguous)
    for (const h24 of candidateHours) {
      const candidate = istWallClockToEpochMs(baseDate.year, baseDate.month, baseDate.day, h24, minuteRaw, secondRaw);
      if (candidate > nowMs - 2000 && (chosenMs === null || candidate < chosenMs)) {
        chosenMs = candidate;
      }
    }
    if (chosenMs === null) {
      return {
        ok: false,
        error: `Requested IST time has already passed. Current IST is ${nowIst.fullIstLabel}.`,
      };
    }
  } else {
    // No explicit day: pick nearest future candidate today, otherwise tomorrow!
    for (const dAdd of [0, 1]) {
      const dt = addDaysToIstDate(nowIst.year, nowIst.month, nowIst.day, dAdd);
      for (const h24 of candidateHours) {
        const candidate = istWallClockToEpochMs(dt.year, dt.month, dt.day, h24, minuteRaw, secondRaw);
        if (candidate > nowMs + 1000 && (chosenMs === null || candidate < chosenMs)) {
          chosenMs = candidate;
        }
      }
      if (chosenMs !== null) break;
    }
  }

  if (chosenMs === null) {
    return { ok: false, error: `Could not resolve a future IST time from "${textToParse}".` };
  }

  const delayMs = Math.max(500, chosenMs - nowMs);
  return {
    ok: true,
    triggerAtMs: chosenMs,
    delayMs,
    mode: "absolute",
    recurrence,
    scheduledForIst: formatIstDateTime(chosenMs),
    scheduledForIsoIst: formatIstIso(chosenMs),
    humanDelayLabel: formatHumanDuration(Math.round(delayMs / 1000)),
    remainderText: stripMatchedPhrase(textToParse, matchedClockSegment),
  };
}
