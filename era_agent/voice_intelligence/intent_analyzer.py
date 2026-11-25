"""ERA Semantic Intent Analyzer for Spoken Commands.

Parses raw transcripts across Hindi, Hinglish, and English into structured
intent representations with calibrated intent confidence and strict distinction
between command actions, queries, and negative/stop commands.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .vocabulary import vocabulary_manager

log = logging.getLogger("era.intent")


@dataclass
class IntentCandidate:
    intent_name: str  # e.g., "open_app", "close_app", "adjust_volume", "set_volume", "adjust_brightness", "system_control"
    target_entity: Optional[str]  # e.g., "Google Chrome", "Notepad", "VS Code", "Downloads"
    action_type: str  # "open", "close", "increase", "decrease", "set", "query", "system"
    parameters: Dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.0  # Intent parser confidence [0.0 - 1.0]
    is_sensitive: bool = False
    requires_confirmation: bool = False
    is_complete: bool = True
    missing_parameter: Optional[str] = None
    confirmation_prompt: Optional[str] = None
    matched_phrase: str = ""


# Number words to integer mapping in English and Hindi/Hinglish
NUMBER_WORDS: Dict[str, int] = {
    "zero": 0, "shunya": 0, "sunya": 0,
    "one": 1, "ek": 1,
    "two": 2, "do": 2,
    "three": 3, "teen": 3,
    "four": 4, "char": 4, "chaar": 4,
    "five": 5, "paanch": 5, "panch": 5,
    "six": 6, "chhe": 6, "che": 6,
    "seven": 7, "saat": 7,
    "eight": 8, "aath": 8,
    "nine": 9, "nau": 9,
    "ten": 10, "das": 10,
    "fifteen": 15, "pandrah": 15,
    "twenty": 20, "bees": 20,
    "twenty five": 25, "pachees": 25,
    "thirty": 30, "tees": 30,
    "forty": 40, "chalis": 40,
    "fifty": 50, "pachaas": 50, "pachas": 50,
    "sixty": 60, "saath": 60,
    "seventy": 70, "sattar": 70,
    "eighty": 80, "assi": 80,
    "ninety": 90, "nabbe": 90,
    "hundred": 100, "sau": 100, "so": 100,
}


def extract_percentage_or_number(text: str) -> Optional[int]:
    """Extracts a numerical value from text either as digits ('50%') or words ('fifty percent')."""
    lower = text.lower()
    # Check digits first (ignore time delays like 1 min, 30 sec)
    m = re.search(r"\b(100|[1-9]?[0-9])\s*(?:%|percent|pratishat|प्रतिशत)?\b", lower)
    if m:
        val = int(m.group(1))
        if 0 <= val <= 100:
            if not re.search(rf"\b{val}\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b", lower):
                return val

    # Unambiguous number words
    unambiguous_words: Dict[str, int] = {
        "zero": 0, "shunya": 0, "sunya": 0, "शून्य": 0,
        "half": 50, "aadha": 50, "aadhe": 50, "आधा": 50,
        "fifteen": 15, "pandrah": 15, "पंद्रह": 15,
        "twenty": 20, "bees": 20, "बीस": 20,
        "twenty five": 25, "pachees": 25, "पच्चीस": 25,
        "thirty": 30, "tees": 30, "तीस": 30,
        "forty": 40, "chalis": 40, "चालीस": 40,
        "fifty": 50, "pachaas": 50, "pachas": 50, "पचास": 50,
        "sixty": 60, "saath": 60, "साठ": 60,
        "seventy": 70, "sattar": 70, "सत्तर": 70,
        "eighty": 80, "assi": 80, "अस्सी": 80,
        "ninety": 90, "nabbe": 90, "नब्बे": 90,
        "hundred": 100, "sau": 100, "सौ": 100,
    }
    for word, val in unambiguous_words.items():
        if re.search(rf"\b{re.escape(word)}\b", lower):
            return val

    # Small numbers (1-10) only if followed by %/percent or preceded by level/to/pe/par/set
    small_words: Dict[str, int] = {
        "one": 1, "ek": 1, "एक": 1,
        "two": 2, "do": 2, "दो": 2,
        "three": 3, "teen": 3, "तीन": 3,
        "four": 4, "char": 4, "chaar": 4, "चार": 4,
        "five": 5, "paanch": 5, "panch": 5, "पांच": 5,
        "six": 6, "chhe": 6, "che": 6, "छह": 6,
        "seven": 7, "saat": 7, "सात": 7,
        "eight": 8, "aath": 8, "आठ": 8,
        "nine": 9, "nau": 9, "नौ": 9,
        "ten": 10, "das": 10, "दस": 10,
    }
    for word, val in small_words.items():
        if re.search(rf"\b{re.escape(word)}\s*(?:%|percent|pratishat|प्रतिशत)\b", lower) or \
           re.search(rf"(?:level|to|pe|par|set)\s+{re.escape(word)}\b", lower):
            return val

    return None


class IntentAnalyzer:
    """Parses raw text transcripts into unambiguous actionable intents."""

    def __init__(self) -> None:
        pass

    def analyze(self, raw_transcript: str) -> IntentCandidate:
        """Determines the exact intent of a spoken voice command."""
        text = (raw_transcript or "").strip()
        if not text:
            return IntentCandidate(
                intent_name="unknown",
                target_entity=None,
                action_type="unknown",
                confidence=0.0,
                is_complete=False,
                missing_parameter="transcript",
            )

        lower = text.lower()

        # ---------------------------------------------------------
        # 1. Non-action queries (DO NOT execute desktop actions)
        # ---------------------------------------------------------
        is_query = bool(re.search(
            r"\b(?:kya|kaise|kyun|kahan|kidhar|batao|samjhao|explain|check|review|padho|read|tell|what|how|why|where|meaning)\b",
            lower
        ))
        # Questions asking what is on screen
        if is_query and re.search(r"\b(?:screen|display|samne)\b", lower):
            return IntentCandidate(
                intent_name="inspect_screen",
                target_entity="screen",
                action_type="query",
                confidence=0.95,
                is_complete=True,
                matched_phrase=text,
            )

        # ---------------------------------------------------------
        # 2. Sensitive System Commands (Shutdown / Restart)
        # ---------------------------------------------------------
        # Cancel shutdown
        if re.search(r"\b(?:cancel\s+shutdown|stop\s+shutdown|shutdown\s+cancel|shutdown\s+mat\s+karo|shutdown\s+rok\s+do)\b", lower):
            return IntentCandidate(
                intent_name="cancel_shutdown",
                target_entity="system",
                action_type="system",
                confidence=0.98,
                is_sensitive=False,
                matched_phrase=text,
            )

        # Restart PC
        if (
            re.search(r"\b(?:restart|reboot|punah\s*chalu)\b", lower) and re.search(r"\b(?:laptop|pc|computer|system)\b", lower)
            or re.search(r"\b(?:restart\s+(?:the\s+)?(?:pc|laptop|computer|system)|(?:pc|laptop|computer|system)\s+(?:ko\s+)?(?:restart|reboot)\s*(?:karo|kar\s+do|kardo)?)\b", lower)
        ):
            return IntentCandidate(
                intent_name="restart_pc",
                target_entity="system",
                action_type="system",
                confidence=0.96,
                is_sensitive=True,
                requires_confirmation=False,
                confirmation_prompt="Boss, kya aap sach me laptop restart karna chahte hain?",
                matched_phrase=text,
            )

        # Shutdown PC
        if re.search(r"\b(?:shutdown|shut\s+down|power\s+off|turn\s+off\s+(?:the\s+)?(?:pc|laptop|computer)|pc\s+band\s*(?:karo|kar\s*do|kardo)|laptop\s+band\s*(?:karo|kar\s*do|kardo)|computer\s+band\s*(?:karo|kar\s*do|kardo)|system\s+band\s*(?:karo|kar\s*do|kardo))\b", lower):
            return IntentCandidate(
                intent_name="shutdown_pc",
                target_entity="system",
                action_type="system",
                confidence=0.96,
                is_sensitive=True,
                requires_confirmation=False,
                confirmation_prompt="Boss, kya aap sach me computer shut down karna chahte hain?",
                matched_phrase=text,
            )

        # Lock PC
        if re.search(r"\b(?:lock\s+screen|lock\s+pc|screen\s+lock|pc\s+lock|laptop\s+lock|computer\s+lock|lock\s+(?:my\s+)?computer|pc\s*lock[-\s]*cardu|pc\s*lock[-\s]*karo)\b|कंप्यूटर\s*लॉक|स्क्रीन\s*लॉक", lower):
            return IntentCandidate(
                intent_name="lock_pc",
                target_entity="system",
                action_type="system",
                confidence=0.95,
                is_sensitive=False,
                matched_phrase=text,
            )

        # Take Screenshot
        if re.search(r"\b(?:screenshot|screen\s*shot|capture\s*screen)\b|स्क्रीनशॉट", lower):
            return IntentCandidate(
                intent_name="take_screenshot",
                target_entity="system",
                action_type="system",
                confidence=0.96,
                is_sensitive=False,
                matched_phrase=text,
            )

        # ---------------------------------------------------------
        # 3. Audio Volume Control
        # ---------------------------------------------------------
        is_audio = bool(re.search(r"\b(?:volume|sound|awaz|awaaz|aawaz|audio|mute|unmute)\b|आवाज़|आवाज|वॉल्यूम|वोल्यूम|साउंड|ऑडियो|म्यूट|अनम्यूट", lower))
        if is_audio:
            # Mute / Unmute
            if re.search(r"\b(?:unmute|awaz\s+chalu|sound\s+chalu)\b|अनम्यूट|आवाज़\s*चालू|आवाज\s*चालू", lower):
                return IntentCandidate(
                    intent_name="set_volume_mute",
                    target_entity="audio",
                    action_type="set",
                    parameters={"mute": False},
                    confidence=0.96,
                    matched_phrase=text,
                )
            if re.search(r"\b(?:mute|awaz\s+band|sound\s+band)\b|म्यूट|आवाज़\s*बंद|आवाज\s*बंद", lower):
                return IntentCandidate(
                    intent_name="set_volume_mute",
                    target_entity="audio",
                    action_type="set",
                    parameters={"mute": True},
                    confidence=0.96,
                    matched_phrase=text,
                )

            # Full / Maximum
            if re.search(r"\b(?:full|maximum|max|poora|poori|highest|sau percent|100%)\b|फुल|पूरा|पूरी|मैक्स", lower):
                return IntentCandidate(
                    intent_name="set_volume",
                    target_entity="audio",
                    action_type="set",
                    parameters={"level": 100},
                    confidence=0.96,
                    matched_phrase=text,
                )

            # Low volume
            if re.search(r"\b(?:low|dheemi|dheema|minimum|min)\b|लो|धीमा|धीमी", lower) and not re.search(r"\b(?:by|thoda|kam|ghata|decrease)\b", lower):
                return IntentCandidate(
                    intent_name="set_volume",
                    target_entity="audio",
                    action_type="set",
                    parameters={"level": 15},
                    confidence=0.95,
                    matched_phrase=text,
                )

            # Zero / Off
            if re.search(r"\b(?:zero|shunya|bilkul kam|0%)\b|शून्य|बिल्कुल\s*कम", lower):
                return IntentCandidate(
                    intent_name="set_volume",
                    target_entity="audio",
                    action_type="set",
                    parameters={"level": 0},
                    confidence=0.96,
                    matched_phrase=text,
                )

            # Explicit level (e.g. "volume 50 percent", "mera volume fifty percent kar do")
            target_num = extract_percentage_or_number(lower)
            if target_num is not None and not re.search(r"\b(?:increase|badhao|badha|decrease|kam|ghata)\b|बढ़ा|कम", lower):
                return IntentCandidate(
                    intent_name="set_volume",
                    target_entity="audio",
                    action_type="set",
                    parameters={"level": target_num},
                    confidence=0.95,
                    matched_phrase=text,
                )

            # Volume Increase (badhao, up, raise, tez, louder)
            if re.search(r"\b(?:increase|badhao|badha|up|raise|tez|louder|bada)\b|बढ़ा", lower):
                delta = target_num if (target_num and re.search(r"\b(?:by|point|percent)\b", lower)) else 10
                return IntentCandidate(
                    intent_name="adjust_volume",
                    target_entity="audio",
                    action_type="increase",
                    parameters={"delta": delta},
                    confidence=0.94,
                    matched_phrase=text,
                )

            # Volume Decrease (kam karo, down, lower, dheemi)
            if re.search(r"\b(?:decrease|kam|ghata|down|lower|dheemi|dheema)\b|कम", lower):
                delta = target_num if (target_num and re.search(r"\b(?:by|point|percent)\b", lower)) else 10
                return IntentCandidate(
                    intent_name="adjust_volume",
                    target_entity="audio",
                    action_type="decrease",
                    parameters={"delta": -delta},
                    confidence=0.94,
                    matched_phrase=text,
                )

            # Incomplete volume command (e.g., user just said "volume set karo" without number)
            if re.search(r"\b(?:set|kar\s*do|karo)\b", lower):
                return IntentCandidate(
                    intent_name="set_volume",
                    target_entity="audio",
                    action_type="set",
                    confidence=0.60,
                    is_complete=False,
                    missing_parameter="level",
                    confirmation_prompt="Boss, volume kitne percent set karna hai?",
                    matched_phrase=text,
                )

        # ---------------------------------------------------------
        # 4. Display Brightness Control
        # ---------------------------------------------------------
        is_brightness = bool(
            re.search(r"\b(?:brightness|brightnes|screen\s+light|screen\s+brightness|display\s+brightness|display\s+light)\b|ब्राइटनेस|स्क्रीन\s*लाइट|स्क्रीन\s*की\s*ब्राइटनेस", lower) or
            ("screen" in lower and any(w in lower for w in ["light", "brightness", "chamak", "लाइट", "ब्राइटनेस"])) or
            ("display" in lower and any(w in lower for w in ["light", "brightness", "chamak", "लाइट", "ब्राइटनेस"]))
        )
        if is_brightness:
            # Full / Maximum
            if re.search(r"\b(?:full|maximum|max|poora|poori|highest|sau percent|100%)\b|फुल|पूरा|पूरी|मैक्स", lower):
                return IntentCandidate(
                    intent_name="set_brightness",
                    target_entity="display",
                    action_type="set",
                    parameters={"level": 100},
                    confidence=0.96,
                    matched_phrase=text,
                )

            # Low brightness
            if re.search(r"\b(?:low|dheemi|dheema|minimum|min)\b|लो|धीमा|धीमी", lower) and not re.search(r"\b(?:by|thoda|kam|ghata|decrease)\b", lower):
                return IntentCandidate(
                    intent_name="set_brightness",
                    target_entity="display",
                    action_type="set",
                    parameters={"level": 15},
                    confidence=0.95,
                    matched_phrase=text,
                )

            # Zero / Off
            if re.search(r"\b(?:zero|shunya|bilkul kam|band|off|0%)\b|शून्य|बंद|बिल्कुल\s*कम", lower):
                return IntentCandidate(
                    intent_name="set_brightness",
                    target_entity="display",
                    action_type="set",
                    parameters={"level": 0},
                    confidence=0.96,
                    matched_phrase=text,
                )

            target_num = extract_percentage_or_number(lower)
            if target_num is not None and not re.search(r"\b(?:increase|badhao|badha|decrease|kam|ghata)\b|बढ़ा|कम", lower):
                return IntentCandidate(
                    intent_name="set_brightness",
                    target_entity="display",
                    action_type="set",
                    parameters={"level": target_num},
                    confidence=0.95,
                    matched_phrase=text,
                )
            if re.search(r"\b(?:increase|badhao|badha|up|raise|tez|brighter)\b|बढ़ा", lower):
                delta = target_num if (target_num and re.search(r"\b(?:by|point|percent)\b", lower)) else 15
                return IntentCandidate(
                    intent_name="adjust_brightness",
                    target_entity="display",
                    action_type="increase",
                    parameters={"delta": delta},
                    confidence=0.94,
                    matched_phrase=text,
                )
            if re.search(r"\b(?:decrease|kam|ghata|down|lower|dim|dheema)\b|कम|धीमा", lower):
                delta = target_num if (target_num and re.search(r"\b(?:by|point|percent)\b", lower)) else 15
                return IntentCandidate(
                    intent_name="adjust_brightness",
                    target_entity="display",
                    action_type="decrease",
                    parameters={"delta": -delta},
                    confidence=0.94,
                    matched_phrase=text,
                )

        # ---------------------------------------------------------
        # 4B. Keyboard Backlight Control
        # ---------------------------------------------------------
        is_backlight = bool(
            re.search(r"\b(?:keyboard\s+backlight|keyboard\s+light|keybord\s+backlight|keybord\s+light|backlight|back\s+light|key\s+light|keybord|keyboard|kbl)\b|कीबोर्ड\s*लाइट|कीबोर्ड", lower) or
            ("light" in lower and any(k in lower for k in ["key", "board", "bord", "कीबोर्ड"]))
        )
        if is_backlight:
            # Full / On
            if re.search(r"\b(?:full|maximum|max|poora|poori|highest|sau percent|100%|on|chalu|enable|turn\s*on|open|kholo|jalao)\b|फुल|पूरा|पूरी|चालू|जलाओ", lower):
                return IntentCandidate(
                    intent_name="set_keyboard_backlight",
                    target_entity="keyboard",
                    action_type="set",
                    parameters={"level": 100},
                    confidence=0.96,
                    matched_phrase=text,
                )

            # Low
            if re.search(r"\b(?:low|dheemi|dheema|minimum|min)\b|लो|धीमा|धीमी", lower) and not re.search(r"\b(?:by|thoda|kam|ghata|decrease)\b", lower):
                return IntentCandidate(
                    intent_name="set_keyboard_backlight",
                    target_entity="keyboard",
                    action_type="set",
                    parameters={"level": 25},
                    confidence=0.95,
                    matched_phrase=text,
                )

            # Off / Zero
            if re.search(r"\b(?:band|off|close|disable|zero|shunya|0%)\b|बंद|शून्य", lower):
                return IntentCandidate(
                    intent_name="set_keyboard_backlight",
                    target_entity="keyboard",
                    action_type="set",
                    parameters={"level": 0},
                    confidence=0.96,
                    matched_phrase=text,
                )

            target_num = extract_percentage_or_number(lower)
            if target_num is not None and not re.search(r"\b(?:increase|badhao|badha|decrease|kam|ghata)\b|बढ़ा|कम", lower):
                return IntentCandidate(
                    intent_name="set_keyboard_backlight",
                    target_entity="keyboard",
                    action_type="set",
                    parameters={"level": target_num},
                    confidence=0.96,
                    matched_phrase=text,
                )
            if re.search(r"\b(?:badhao|increase|up|tez|high)\b|बढ़ा", lower):
                delta = target_num if (target_num and re.search(r"\b(?:by|point|percent)\b", lower)) else 25
                return IntentCandidate(
                    intent_name="adjust_keyboard_backlight",
                    target_entity="keyboard",
                    action_type="increase",
                    parameters={"delta": delta},
                    confidence=0.94,
                    matched_phrase=text,
                )
            if re.search(r"\b(?:kam|decrease|down|dheemi)\b|कम", lower):
                delta = target_num if (target_num and re.search(r"\b(?:by|point|percent)\b", lower)) else 25
                return IntentCandidate(
                    intent_name="adjust_keyboard_backlight",
                    target_entity="keyboard",
                    action_type="decrease",
                    parameters={"delta": -delta},
                    confidence=0.94,
                    matched_phrase=text,
                )

        # ---------------------------------------------------------
        # 4B.1. Real-Time Camera Hand Gesture Recognition Commands
        # (e.g. "hand gesture chalu karo", "camera gesture on karo", "gesture band karo")
        # ---------------------------------------------------------
        is_gesture = bool(re.search(
            r"\b(?:gesture|gestures|hand\s*gesture|camera\s*gesture|gesture\s*control|ishara|ishare)\b|जेस्चर|हैंड\s*जेस्चर",
            lower
        ) or ((("camera" in lower or "कैमरा" in lower)) and any(w in lower for w in ["gesture", "hand", "हाथ", "ishara", "ishare"])))

        if is_gesture:
            # Check Stop / Off
            if re.search(r"\b(?:stop|off|band|disable|roko|rok|close|shut)\b|बंद|रोको", lower):
                return IntentCandidate(
                    intent_name="stop_gesture_control",
                    target_entity="camera_gestures",
                    action_type="close",
                    parameters={},
                    confidence=0.98,
                    matched_phrase=text,
                )

            # Check Status / Query
            if re.search(r"\b(?:status|check|state|dekho|batao|kitna)\b|स्टेटस", lower):
                return IntentCandidate(
                    intent_name="get_gesture_status",
                    target_entity="camera_gestures",
                    action_type="query",
                    parameters={},
                    confidence=0.98,
                    matched_phrase=text,
                )

            # Default to Start / On (e.g. "hand gesture chalu karo", "camera gesture on karo")
            show_preview = bool(re.search(r"\b(?:preview|window|dikhao|screen|hud)\b", lower))
            return IntentCandidate(
                intent_name="start_gesture_control",
                target_entity="camera_gestures",
                action_type="open",
                parameters={"camera": 0, "preview": show_preview},
                confidence=0.98,
                matched_phrase=text,
            )

        # ---------------------------------------------------------
        # 4C. Multi-Window Positioning & Split Screen Commands
        # (e.g. "Mera VS Code meri right screen par, mera WhatsApp mere left screen par set karo")
        # ---------------------------------------------------------
        has_screen_pos = bool(re.search(
            r"\b(?:left\s+screen|right\s+screen|left\s+side|right\s+side|left\s+me|right\s+me|left\s+pe|right\s+pe|split\s+screen|screen\s+split|aadha\s+aadha|side\s+by\s+side)\b|बाएं|दाएं|बाएँ|दाएँ|लेफ्ट|राइट|स्क्रींपर|स्क्रीनपर|स्क्रीन",
            lower
        ))
        if has_screen_pos:
            left_app, right_app = self._extract_split_screen_apps(lower)

            if left_app and right_app:
                return IntentCandidate(
                    intent_name="split_screen",
                    target_entity=f"{left_app} & {right_app}",
                    action_type="set",
                    parameters={"left_app": left_app, "right_app": right_app},
                    confidence=0.98,
                    is_complete=True,
                    matched_phrase=text,
                )
            elif left_app and not right_app:
                return IntentCandidate(
                    intent_name="snap_window",
                    target_entity=left_app,
                    action_type="set",
                    parameters={"app_name": left_app, "position": "left"},
                    confidence=0.95,
                    is_complete=True,
                    matched_phrase=text,
                )
            elif right_app and not left_app:
                return IntentCandidate(
                    intent_name="snap_window",
                    target_entity=right_app,
                    action_type="set",
                    parameters={"app_name": right_app, "position": "right"},
                    confidence=0.95,
                    is_complete=True,
                    matched_phrase=text,
                )
            elif re.search(r"\b(?:split\s+screen|screen\s+split|aadha\s+aadha|side\s+by\s+side)\b", lower):
                return IntentCandidate(
                    intent_name="split_screen",
                    target_entity="active_windows",
                    action_type="set",
                    parameters={},
                    confidence=0.92,
                    is_complete=True,
                    matched_phrase=text,
                )

        # ---------------------------------------------------------
        # 5. Application Closing / Stopping (Negative Commands)
        # ---------------------------------------------------------
        is_close_action = bool(re.search(
            r"\b(?:close|closed|band\s*karo|band\s*kar\s*do|band|ban\s*karo|ban\s*kar\s*do|bandkaro|bandkaru|bankaro|shut|stop\s*karo|roko|hatao|quit|exit)\b|बंद",
            lower
        ))
        if is_close_action:
            # Check first if any specific registered app is named (Opera, VS Code, WhatsApp, etc.)
            resolved = self._extract_app_entity(lower)
            if resolved:
                app_item, sim = resolved
                return IntentCandidate(
                    intent_name="close_app",
                    target_entity=app_item.canonical_name,
                    action_type="close",
                    parameters={"app_name": app_item.system_target or app_item.canonical_name},
                    confidence=sim,
                    matched_phrase=text,
                )
            if re.search(r"\b(?:browser|chrome|tab)\b", lower):
                return IntentCandidate(
                    intent_name="close_app",
                    target_entity="Google Chrome",
                    action_type="close",
                    parameters={"app_name": "chrome"},
                    confidence=0.96,
                    matched_phrase=text,
                )
            if re.search(r"\b(?:music|song|gaana|media|spotify)\b", lower):
                return IntentCandidate(
                    intent_name="media_control",
                    target_entity="media",
                    action_type="close",
                    parameters={"action": "pause"},
                    confidence=0.95,
                    matched_phrase=text,
                )

        # ---------------------------------------------------------
        # 6. Folder Opening ("Mere downloads folder ko kholo")
        # ---------------------------------------------------------
        is_folder = bool(re.search(r"\b(?:folder|directory)\b", lower))
        if is_folder or any(f in lower for f in ["downloads", "documents", "desktop", "pictures"]):
            for folder_name in ["downloads", "documents", "desktop", "pictures"]:
                if folder_name in lower:
                    return IntentCandidate(
                        intent_name="open_folder",
                        target_entity=folder_name.capitalize(),
                        action_type="open",
                        parameters={"folder_name": folder_name},
                        confidence=0.95,
                        matched_phrase=text,
                    )

        # ---------------------------------------------------------
        # 7. Application Launching ("Chrome open karo", "Notepad kholo")
        # ---------------------------------------------------------
        is_open_action = bool(re.search(
            r"\b(?:open|launch|start|run|chalu\s*karo|chalu|kholo|khol\s*do|khol|chalao)\b|खोलो|खोल",
            lower
        ))

        resolved_app = self._extract_app_entity(lower)
        if resolved_app:
            app_item, sim = resolved_app
            # If explicit open action or short unambiguous command (e.g. "Notepad kholo" or just "Notepad")
            if is_open_action or sim >= 0.95:
                # Guard: if there's also a close/stop phrase present, prefer close_app
                has_close_phrase = bool(re.search(
                    r"\b(?:close|band\s*karo|band\s*kar\s*do|band|quit|exit|stop|shut|hatao|roko)\b|बंद",
                    lower
                ))
                if has_close_phrase:
                    return IntentCandidate(
                        intent_name="close_app",
                        target_entity=app_item.canonical_name,
                        action_type="close",
                        parameters={"app_name": app_item.system_target or app_item.canonical_name},
                        confidence=sim,
                        matched_phrase=text,
                    )
                return IntentCandidate(
                    intent_name="open_app",
                    target_entity=app_item.canonical_name,
                    action_type="open",
                    parameters={"app_name": app_item.system_target or app_item.canonical_name},
                    confidence=sim,
                    matched_phrase=text,
                )

        # Incomplete open action without application target (e.g. "open karo", "kholo")
        if is_open_action and not resolved_app:
            return IntentCandidate(
                intent_name="open_app",
                target_entity=None,
                action_type="open",
                confidence=0.50,
                is_complete=False,
                missing_parameter="app_name",
                confirmation_prompt="Boss, kaunsi application kholni hai?",
                matched_phrase=text,
            )

        # ---------------------------------------------------------
        # 8. Conversational Fallback / Generic Dialogue
        # ---------------------------------------------------------
        return IntentCandidate(
            intent_name="conversational_chat",
            target_entity=None,
            action_type="chat",
            confidence=0.70,
            is_complete=True,
            matched_phrase=text,
        )

    def _extract_app_entity(self, lower_text: str) -> Optional[Tuple[Any, float]]:
        """Scans the text for known registered applications and tools."""
        # Strip common action/filler words
        cleaned = re.sub(
            r"\b(?:era|eira|ira|please|zara|mera|meri|mere|ko|pe|par|open|karo|kar|do|kholo|khol|chalu|start|launch|band|close)\b",
            " ",
            lower_text
        ).strip()
        cleaned = re.sub(r"\s+", " ", cleaned)

        # Check full cleaned string
        res = vocabulary_manager.resolve_alias(cleaned, min_confidence=0.82)
        if res and res[0].category in ("app", "tool", "folder"):
            return res

        # Check individual tokens or bigrams
        tokens = cleaned.split()
        for i in range(len(tokens)):
            # Unigram
            res = vocabulary_manager.resolve_alias(tokens[i], min_confidence=0.88)
            if res and res[0].category in ("app", "tool", "folder"):
                return res
            # Bigram
            if i + 1 < len(tokens):
                bigram = f"{tokens[i]} {tokens[i+1]}"
                res = vocabulary_manager.resolve_alias(bigram, min_confidence=0.85)
                if res and res[0].category in ("app", "tool", "folder"):
                    return res

        return None

    def _extract_split_screen_apps(self, lower_text: str) -> Tuple[Optional[str], Optional[str]]:
        """Extracts left and right target apps from compound multi-window placement phrases."""
        norm = lower_text.lower()

        # 1. Find all registered applications mentioned in the string
        apps_found: List[Tuple[int, int, str]] = []
        for item in vocabulary_manager.list_all_items():
            if item.get("category") in ("app", "tool"):
                target = item.get("system_target") or item.get("canonical_name", "").lower()
                all_names = [item.get("canonical_name", "").lower()] + item.get("aliases", []) + item.get("hinglish_variants", [])
                for alias in all_names:
                    if len(alias) >= 2:
                        for m in re.finditer(rf"\b{re.escape(alias.lower())}\b", norm):
                            apps_found.append((m.start(), m.end(), target))

        # Deduplicate overlapping spans (prefer longer alias)
        apps_found.sort(key=lambda x: (x[1] - x[0]), reverse=True)
        unique_apps: List[Tuple[int, int, str]] = []
        for start, end, name in apps_found:
            if not any(u_start <= start and end <= u_end for u_start, u_end, _ in unique_apps):
                unique_apps.append((start, end, name))
        unique_apps.sort(key=lambda x: x[0])

        # 2. Find direction keywords (handles compound words like leftscreen, leftside, etc.)
        dirs: List[Tuple[int, int, str]] = []
        for m in re.finditer(r"(?:\bleft\b|\bleftscreen\b|\bleftside\b|\bleft-screen\b|\bbaye\b|\bbaaye\b|\bbayein\b|बाएं|बाएँ|लेफ्ट)", norm):
            dirs.append((m.start(), m.end(), "left"))
        for m in re.finditer(r"(?:\bright\b|\brightscreen\b|\brightside\b|\bright-screen\b|\bdaye\b|\bdaaye\b|\bdayein\b|दाएं|दाएँ|राइट)", norm):
            dirs.append((m.start(), m.end(), "right"))
        dirs.sort(key=lambda x: x[0])

        left_app: Optional[str] = None
        right_app: Optional[str] = None

        # Case A: Two apps and two directions -> align by sequence order
        if len(unique_apps) >= 2 and len(dirs) >= 2:
            mapping = {dirs[0][2]: unique_apps[0][2], dirs[1][2]: unique_apps[1][2]}
            return mapping.get("left"), mapping.get("right")

        # Case B: One app and directions
        if len(unique_apps) == 1 and dirs:
            app_name = unique_apps[0][2]
            d_name = dirs[0][2]
            if d_name == "left":
                return app_name, None
            else:
                return None, app_name

        # Case C: Fallback to proximity
        for a_start, a_end, app_name in unique_apps:
            a_mid = (a_start + a_end) / 2.0
            best_d = min(dirs, key=lambda d: abs(a_mid - (d[0] + d[1]) / 2.0)) if dirs else None
            if best_d:
                if best_d[2] == "left" and not left_app:
                    left_app = app_name
                elif best_d[2] == "right" and not right_app:
                    right_app = app_name

        return left_app, right_app


# Global singleton instance
intent_analyzer = IntentAnalyzer()
