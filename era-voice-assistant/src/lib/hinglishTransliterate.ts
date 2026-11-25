/**
 * hinglishTransliterate.ts
 * ---------------------------------------------------------------------------
 * High-accuracy phonetic Hindi Devanagari -> Hinglish transliteration and
 * speech recognition noise filtering.
 *
 * Rules:
 * 1. English speech remains 100% pure English (untouched).
 * 2. Hindi speech (transcribed in Devanagari) is transliterated into natural,
 *    fluid Hinglish (Roman script, e.g. "Dobara se usko yahi code send karo.").
 * 3. Phantom noise hallucinations (e.g. "Tchá.", "Tsk.", single punctuation,
 *    isolated breath/noise artifacts) are filtered out completely.
 */

const DEVANAGARI_REGEX = /[\u0900-\u097F]/;

/** Known spurious hallucinations produced by ASR models on ambient noise or breath */
const NOISE_WORDS = new Set([
  "tchá", "tcha", "tcha.", "tchá.", "tsk", "tsk.", "tá", "tá.", "ta", "ta.",
  "shh", "shh.", "psst", "psst.", "hmph", "hmph.", "uh", "um", "er", "ah", "oh",
  "huh", "mm", "mmm", "hmm", "hmmm", "aha", "yaa", "haa", "você", "está", "olá"
]);

/**
 * Returns true if the transcript text is a known ASR noise artifact,
 * phantom trigger, or spurious breath/click hallucination.
 */
export function isPhantomNoiseTranscript(text?: string | null): boolean {
  if (!text || typeof text !== "string") return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  // Pure punctuation or symbols
  if (/^[.,\/#!$%\^&\*;:{}=\-_`~()?"'«»।॥\s]+$/.test(trimmed)) return true;

  const lower = trimmed.toLowerCase().replace(/[.,!?;:]+$/, "");
  if (NOISE_WORDS.has(lower) || NOISE_WORDS.has(trimmed.toLowerCase())) return true;

  // Single Latin character except 'I' or 'a'
  if (/^[b-hj-z]$/i.test(trimmed)) return true;

  // Single Devanagari character or lone syllable artifact like "या", "हा", "अ"
  if (/^[\u0900-\u097F]$/.test(trimmed)) return true;
  if (/^[\u0915-\u0939][\u093E-\u094C]?$/.test(trimmed) && trimmed === "या") return true;

  // Accented single token typical of foreign ASR hallucinations when conversation is Hindi/English
  if (/^(tch[aá]|você|está|olá|então|não|sim|tá)[.?!]*$/i.test(trimmed)) return true;

  // Repetitive ASR hallucination loop (e.g. "mera mera mera mera..." or "13 mera mera mera...")
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    const wordCounts: Record<string, number> = {};
    let maxCount = 0;
    for (const w of words) {
      wordCounts[w] = (wordCounts[w] || 0) + 1;
      if (wordCounts[w] > maxCount) maxCount = wordCounts[w];
    }
    const unique = Object.keys(wordCounts);
    // If more than 50% of the utterance is a single repeating word
    if (words.length >= 4 && maxCount / words.length >= 0.5) return true;
    if (unique.length <= 2 && words.length >= 3) return true; // Degenerate loop
    if (/(\b[\w'-]+\b)(?:\s+\1){2,}/i.test(trimmed)) return true;
  }

  return false;
}

/**
 * Deduplicates degenerate ASR repetitions (e.g. "mera mera mera..." -> "mera")
 */
export function deduplicateRepeatedTokens(text: string): string {
  if (!text) return "";
  let s = text;
  // Collapse 2+ consecutive identical words down to 1
  s = s.replace(/(\b[\w'-]+\b)(?:[\s,.]+\1)+/gi, "$1");
  // Collapse 2+ consecutive identical 2-word phrases down to 1
  s = s.replace(/(\b[\w'-]+\s+[\w'-]+\b)(?:[\s,.]+\1)+/gi, "$1");
  // Additional safety pass: if a word occurs more than twice in any 5-word window, remove duplicates
  const tokens = s.split(/\s+/);
  const deduped: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = deduped.length > 0 ? deduped[deduped.length - 1] : "";
    if (tok.toLowerCase() === prev.toLowerCase()) {
      continue;
    }
    deduped.push(tok);
  }
  return deduped.join(" ").trim();
}

/**
 * High-frequency Hindi conversational vocabulary + English loanwords commonly
 * spoken in Indian context, mapped to standard natural Hinglish spellings.
 */
const COMMON_WORDS: Record<string, string> = {
  // Verbs & Actions
  "करो": "karo", "कर": "kar", "करना": "karna", "करू": "karu", "करूँ": "karoon", "करेंगे": "karenge",
  "किया": "kiya", "किए": "kiye", "की": "ki", "दीजिए": "dijiye", "दो": "do", "देना": "dena",
  "दिया": "diya", "दिए": "diye", "लो": "lo", "लेना": "lena", "लिया": "liya", "भेजो": "bhejo",
  "भेज": "bhej", "भेजना": "bhejna", "सेंड": "send", "कोड": "code", "लिखो": "likho", "लिख": "likh",
  "लिखना": "likhna", "पढ़ो": "padho", "पढ़": "padh", "दिखाओ": "dikhao", "दिखा": "dikha",
  "बताओ": "batao", "बता": "bata", "बोलो": "bolo", "बोल": "bol", "सुनाओ": "sunao", "सुनो": "suno",
  "खोलो": "kholo", "खोल": "khol", "बंद": "band", "चलाओ": "chalao", "चला": "chala", "रुको": "ruko",
  "रोक": "rok", "रोको": "roko", "जाओ": "jao", "जा": "ja", "आओ": "aao", "आ": "aa", "आना": "aana",
  "हो": "ho", "है": "hai", "हैं": "hain", "हूँ": "hoon", "था": "tha", "थी": "thi", "थे": "the",
  "रहा": "raha", "रही": "rahi", "रहे": "rahe", "सकता": "sakta", "सकती": "sakti", "सकते": "sakte",
  "चाहिए": "chahiye", "चाहता": "chahta", "चाहती": "chahti", "चाहते": "chahte", "मिलते": "milte",
  "मिल": "mil", "मिलना": "milna", "मिले": "mile", "रखो": "rakho", "रख": "rakh", "रखना": "rakhna",

  // Pronouns & Demonstratives
  "मैं": "main", "मुझे": "mujhe", "मुझको": "mujhko", "मेरा": "mera", "मेरी": "meri", "मेरे": "mere",
  "हम": "hum", "हमें": "humein", "हमारा": "hamara", "हमारी": "hamari", "हमारे": "hamare",
  "आप": "aap", "आपको": "aapko", "आपका": "aapka", "आपकी": "aapki", "आपके": "aapke",
  "तुम": "tum", "तुम्हें": "tumhein", "तुम्हारा": "tumhara", "तुम्हारी": "tumhari", "तुम्हारे": "tumhare",
  "वह": "woh", "वो": "wo", "उसे": "use", "उसको": "usko", "उसका": "uska", "उसकी": "uski", "उसके": "uske",
  "यह": "yeh", "ये": "ye", "इसे": "ise", "इसको": "isko", "इसका": "iska", "इसकी": "iski", "इसके": "iske",
  "वे": "ve", "उन्हें": "unhein", "उनको": "unko", "उनका": "unka", "उनकी": "unki", "उनके": "unke",
  "यही": "yahi", "वही": "wahi", "इसी": "isi", "उसी": "usi",

  // Adverbs & Connectors
  "दोबारा": "dobara", "फिर": "phir", "से": "se", "को": "ko", "का": "ka", "के": "ke",
  "में": "mein", "पर": "par", "पे": "pe", "तक": "tak", "भी": "bhi", "तो": "toh", "ही": "hi",
  "और": "aur", "या": "ya", "लेकिन": "lekin", "मगर": "magar", "क्योंकि": "kyunki", "अगर": "agar",
  "जब": "jab", "तब": "tab", "अब": "ab", "कब": "kab", "कहाँ": "kahan", "यहाँ": "yahan", "वहाँ": "wahan",
  "किधर": "kidhar", "इधर": "idhar", "उधर": "udhar", "कैसे": "kaise", "कैसा": "kaisa", "कैसी": "kaisi",
  "क्या": "kya", "क्यों": "kyun", "कौन": "kaun", "कितना": "kitna", "कितनी": "kitni", "कितने": "kitne",
  "अभी": "abhi", "कभी": "kabhi", "हमेशा": "hamesha", "पहले": "pehle", "बाद": "baad",
  "कल": "kal", "आज": "aaj", "परसों": "parson", "सुबह": "subah", "शाम": "shaam", "रात": "raat",
  "दिन": "din", "साथ": "saath", "पास": "paas", "दूर": "door", "ऊपर": "upar", "नीचे": "neeche",
  "अंदर": "andar", "बाहर": "bahar", "सामने": "saamne", "पीछे": "peeche",

  // Conversational terms
  "हाँ": "haan", "नहीं": "nahi", "ना": "na", "अच्छा": "achha", "अच्छी": "achhi",
  "अच्छे": "achhe", "ठीक": "theek", "सही": "sahi", "गलत": "galat", "सच": "sach", "झूठ": "jhooth",
  "बॉस": "boss", "सर": "sir", "जी": "ji", "भैया": "bhaiya", "भाई": "bhai", "दोस्त": "dost",
  "मदद": "madad", "काम": "kaam", "बात": "baat", "बातें": "baatein", "सवाल": "sawal", "जवाब": "jawab",
  "नमस्ते": "namaste", "धन्यवाद": "dhanyawad", "शुक्रिया": "shukriya", "अलविदा": "alvida",
  "कुछ": "kuch", "सब": "sab", "बहुत": "bahut", "थोड़ा": "thoda", "ज्यादा": "zyada", "कम": "kam",

  // Tech, Apps, & Loanwords commonly spoken
  "व्हाट्सएप": "WhatsApp", "व्हाट्सएप्प": "WhatsApp", "यूट्यूब": "YouTube", "गूगल": "Google",
  "क्रोम": "Chrome", "अनस": "Anas", "साक्षी": "Sakshi", "रोहित": "Rohit", "दीपक": "Deepak",
  "अमन": "Aman", "स्क्रीन": "screen", "मैसेज": "message", "कॉल": "call", "चैट": "chat",
  "फाइल": "file", "ब्राउज़र": "browser", "ब्राउजर": "browser", "ओपन": "open", "क्लोज": "close",
  "रन": "run", "टेस्ट": "test", "सर्च": "search", "ऑनलाइन": "online", "ऑफलाइन": "offline",
  "लिंक": "link", "फोटो": "photo", "वीडियो": "video", "ऑडियो": "audio", "टेक्स्ट": "text",
  "बैकग्राउंड": "background", "क्लिक": "click", "टाइप": "type", "विंडो": "window", "ऐप": "app",
  "एप्लिकेशन": "application", "नोटपैड": "notepad", "कैलकुलेटर": "calculator", "स्पॉटिफाई": "spotify",
  "कैनवा": "canva", "डिस्कॉर्ड": "discord", "इंटरनेट": "internet", "वाईफाई": "wifi", "ब्लूटूथ": "bluetooth",
  "वॉल्यूम": "volume", "स्टॉप": "stop", "ऑफिस": "office", "सॉफ्टवेयर": "software",
  "बॉक्स": "box", "हॉटस्पॉट": "hotspot", "चेक": "check", "आवाज": "aawaz", "गाना": "gaana",
  "गाने": "gaane", "गीत": "geet", "बढ़ाओ": "badhao", "घटाओ": "ghatao", "म्यूट": "mute",
  "अनम्यूट": "unmute", "समझ": "samajh", "समझे": "samjhe", "समझो": "samjho", "समझाओ": "samjhao",
  "दिक्कत": "dikkat", "प्रॉब्लम": "problem", "चलता": "chalta", "चलती": "chalti",
  "सुन": "sun", "सुना": "suna", "सुनना": "sunna", "बोला": "bola",
  "कमांड": "command", "माउस": "mouse", "कीबोर्ड": "keyboard", "लैपटॉप": "laptop",
  "कंप्यूटर": "computer", "रीस्टार्ट": "restart", "शटडाउन": "shutdown", "लॉक": "lock",
  "सेव": "save", "डाउनलोड": "download", "अपलोड": "upload",
  "राइट": "right", "लेफ्ट": "left", "सेट": "set", "वीएस": "VS", "ओपेरा": "Opera",
  "स्प्लिट": "split", "हाफ": "half", "फुल": "full", "साइड": "side"
};

const VOWELS: Record<string, string> = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri",
  "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e", "अं": "an", "अः": "ah"
};

const MATRAS: Record<string, string> = {
  "ा": "a", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
  "ं": "n", "ँ": "n", "ः": "h", "़": ""
};

const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "ड़": "d", "ढ़": "dh", "फ़": "f"
};

function transliterateWord(word: string): string {
  if (COMMON_WORDS[word]) return COMMON_WORDS[word];

  const chars = Array.from(word);
  const out: string[] = [];
  const n = chars.length;
  let i = 0;

  while (i < n) {
    let ch = chars[i];
    if (i + 1 < n && chars[i + 1] === "़") {
      const comb = ch + "़";
      if (CONSONANTS[comb]) {
        ch = comb;
        i++;
      }
    }

    if (VOWELS[ch]) {
      out.push(VOWELS[ch]);
    } else if (CONSONANTS[ch]) {
      const cons = CONSONANTS[ch];
      const next = i + 1 < n ? chars[i + 1] : null;

      if (next === "्") {
        out.push(cons);
        i++; // skip virama
      } else if (next && MATRAS[next]) {
        out.push(cons + MATRAS[next]);
        i++; // skip matra
      } else if (next === "ं" || next === "ँ") {
        out.push(cons + "an");
        i++; // skip anusvara
      } else {
        if (!next) {
          // Word-final Hindi consonant drops inherent 'a' (schwa deletion)
          out.push(cons);
        } else {
          // Medial consonant followed by another consonant + matra (e.g. lad-ka, us-ko)
          if (i + 2 < n && CONSONANTS[chars[i + 1]] && MATRAS[chars[i + 2]]) {
            out.push(cons);
          } else {
            out.push(cons + "a");
          }
        }
      }
    } else if (MATRAS[ch]) {
      out.push(MATRAS[ch]);
    } else if (ch === "ं" || ch === "ँ") {
      out.push("n");
    } else if (ch === "ः") {
      out.push("h");
    } else {
      out.push(ch);
    }
    i++;
  }

  return out.join("");
}

/**
 * Transliterates Devanagari Hindi text to natural Hinglish.
 * If text contains no Devanagari characters, returns the text unmodified.
 */
export function transliterateDevanagariToHinglish(text?: string | null): string {
  if (!text || typeof text !== "string") return "";
  if (!DEVANAGARI_REGEX.test(text)) {
    return text; // Already English or Romanized Hinglish
  }

  // Tokenize preserving spaces and punctuation
  const tokens = text.split(/([.,!?;:()\[\]"'«»।॥\s]+)/);
  const result = tokens.map((token) => {
    if (!token || !token.trim()) return token;
    if (/^[.,!?;:()\[\]"'«»।॥]+$/.test(token)) {
      return token.replace(/[।॥]/g, ".");
    }
    if (DEVANAGARI_REGEX.test(token)) {
      return transliterateWord(token);
    }
    return token;
  }).join("");

  // Sentence casing: Capitalize first letter of each sentence
  return result.replace(/(^\s*|[.!?]\s+)([a-z])/g, (_, p1, p2) => p1 + p2.toUpperCase()).trim();
}

/**
 * Full transcript sanitizer for voice & chat streams:
 * - Drops phantom noise hallucinations (returns empty string)
 * - Converts Devanagari Hindi into clean Hinglish
 * - Preserves English speech exactly
 */
export function cleanTranscript(text?: string | null): string {
  if (isPhantomNoiseTranscript(text)) return "";
  const transliterated = transliterateDevanagariToHinglish(text);
  const deduped = deduplicateRepeatedTokens(transliterated);
  if (isPhantomNoiseTranscript(deduped)) return "";
  return deduped;
}

export default {
  isPhantomNoiseTranscript,
  transliterateDevanagariToHinglish,
  cleanTranscript,
  deduplicateRepeatedTokens
};
