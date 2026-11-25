"""Natural Language Intent Engine for Era System Controls.

Interprets natural language phrases in English and Hinglish (e.g. 'increase brightness',
'key light chalu kar', 'volume set to 50', 'turn off bluetooth', 'mute audio')
into structured intent actions and numerical parameters.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass
class SystemIntent:
    """Represents an extracted system control intent from natural language input."""

    action: str
    params: Dict[str, Any] = field(default_factory=dict)
    matched: bool = True
    raw_query: str = ""


def extract_level(text: str) -> Optional[int]:
    """Extracts a target percentage or numerical level (0-100) from natural language text.
    Handles digits (e.g. '50%', '80 percent', '50 par'), Hindi words ('pachas', 'aadha'),
    and English words ('fifty', 'half', 'hundred').
    """
    # 1. Direct digits (e.g. 50, 50%, 80 %, 100)
    m = re.search(r"\b(100|[1-9]?[0-9])\s*%?", text)
    if m:
        val = int(m.group(1))
        # Ensure it's not part of a delay (e.g. 1 min, 30 sec)
        if not re.search(rf"\b{val}\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b", text):
            return val

    # 2. Unambiguous number words in Hindi, Hinglish, and English
    unambiguous = {
        "zero": 0, "shunya": 0, "sunya": 0, "शून्य": 0,
        "half": 50, "aadha": 50, "aadhe": 50, "आधा": 50,
        "pandrah": 15, "fifteen": 15, "पंद्रह": 15,
        "bees": 20, "twenty": 20, "बीस": 20,
        "pachees": 25, "pachis": 25, "twenty five": 25, "पच्चीस": 25,
        "tees": 30, "thirty": 30, "तीस": 30,
        "chalis": 40, "forty": 40, "चालीस": 40,
        "pachaas": 50, "pachas": 50, "fifty": 50, "पचास": 50,
        "saath": 60, "sixty": 60, "साठ": 60,
        "sattar": 70, "seventy": 70, "सत्तर": 70,
        "assi": 80, "eighty": 80, "अस्सी": 80,
        "nabbe": 90, "ninety": 90, "नब्बे": 90,
        "hundred": 100, "sau": 100, "सौ": 100,
    }
    for word, val in unambiguous.items():
        if re.search(rf"\b{re.escape(word)}\b", text):
            return val

    # 3. Small numbers (1-10) only if followed by %/percent or preceded by level/to/pe/par/set
    small_numbers = {
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
    for word, val in small_numbers.items():
        if re.search(rf"\b{re.escape(word)}\s*(?:%|percent|pratishat|प्रतिशत)\b", text) or \
           re.search(rf"(?:level|to|pe|par|set)\s+{re.escape(word)}\b", text):
            return val

    return None


class IntentParser:
    """Parses natural language requests into structured system control actions."""

    @classmethod
    def parse(cls, query: str) -> SystemIntent:
        text = query.strip().lower()
        if not text:
            return SystemIntent(action="unknown", matched=False, raw_query=query)

        # ------------------------------------------------------------------
        # 7. Shutdown Cancellation Intents (English + Hinglish)
        # ------------------------------------------------------------------
        if any(kw in text for kw in [
            "cancel shutdown", "cancel the shutdown", "abort shutdown", "stop shutdown",
            "shutdown cancel", "shutdown mat karo", "pc shutdown cancel", "pc band mat karo",
            "computer band mat karo", "shutdown rok do", "shutdown roko", "cancel karo shutdown",
            "cancel pc shutdown", "stop the shutdown"
        ]) or (("shutdown" in text or "band" in text) and any(w in text for w in ["cancel", "abort", "roko", "rok", "mat"])):
            return SystemIntent(action="cancel_shutdown", raw_query=query)

        # ------------------------------------------------------------------
        # System Power Control Intents (Shutdown / Restart / Sleep)
        # ------------------------------------------------------------------
        if any(kw in text for kw in [
            "shutdown pc", "pc shutdown", "shutdown laptop", "laptop shutdown",
            "computer shutdown", "shutdown computer", "turn off pc", "turn off the pc",
            "turn off computer", "turn off laptop", "pc band karo", "laptop band karo",
            "computer band karo", "system band karo", "pc band kar do", "laptop band kar do",
            "computer band kar do", "power off pc", "power off"
        ]) or (("shutdown" in text or "band" in text) and any(w in text for w in ["pc", "laptop", "computer", "system"])):
            return SystemIntent(action="shutdown_pc", params={"confirm": "yes", "delay_seconds": 30}, raw_query=query)

        if any(kw in text for kw in [
            "restart pc", "pc restart", "restart laptop", "laptop restart",
            "computer restart", "restart computer", "reboot pc", "reboot computer",
            "pc reboot", "pc restart karo", "pc restart kar do", "laptop restart karo"
        ]) or (("restart" in text or "reboot" in text) and any(w in text for w in ["pc", "laptop", "computer", "system"])):
            return SystemIntent(action="restart_pc", params={"confirm": "yes", "delay_seconds": 30}, raw_query=query)

        if any(kw in text for kw in [
            "sleep pc", "pc sleep", "sleep computer", "put pc to sleep", "computer sleep"
        ]):
            return SystemIntent(action="sleep_pc", raw_query=query)

        # ------------------------------------------------------------------
        # Guard: Do NOT immediately execute commands containing explicit future
        # schedule delays or exact clock times (let TaskScheduler handle them)
        # ------------------------------------------------------------------
        _num_tok = r"(?:\d+(?:\.\d+)?|\b(?:ek|aik|do|teen|char|paanch|panch|chhe|che|saat|aath|nau|das|pandrah|bees|tees|chalis|pachas|saath|aadha|aadhe|half|dedh|dhai|one|two|three|four|five|ten|fifteen|twenty|thirty)\b)"
        _unit_tok = r"(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|mint|h|hr|hrs|hour|hours|ghanta|ghante|ghanto)"
        if (
            re.search(rf"\b(?:after|in)\s+{_num_tok}\s*{_unit_tok}\b", text)
            or re.search(rf"(?:^|\s){_num_tok}\s*{_unit_tok}\s*(?:k(?:e|a|i|ai)\s*)?(?:ba+d|later|from\s+now|mein|me|mai)\b", text)
            or re.search(r"\b\d{1,2}\s*(?::\s*\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b", text)
            or re.search(r"\b\d{1,2}(?:\s*:\s*\d{2})?\s*(?:baj\s*kar|bajke|baje)\b", text)
            or re.search(r"\b(?:exact|exect|fix|fixed|sharp|at|on)\s+\d{1,2}\s*:\s*\d{2}\b", text)
            or re.search(r"\b(?:subah|morning|dopahar|afternoon|sham|shaam|evening|raat|night)\s+(?:ko\s+)?\d{1,2}(?::\d{2})?\b", text)
            or re.search(r"\b(?:kal|tomorrow|parso)\s+(?:subah|morning|dopahar|afternoon|sham|shaam|evening|raat|night|\d{1,2}\s*(?:baje|am|pm))", text)
            or re.search(r"\b(?:schedule|alarm|timer|remind(?:er)?)\b", text)
        ):
            return SystemIntent(action="unknown", matched=False, raw_query=query)


        # ------------------------------------------------------------------
        # -1. Hand Gesture Intelligence Intents
        # ------------------------------------------------------------------
        is_gesture = any(w in text for w in ["gesture", "gestures", "hand gesture", "जेस्चर", "हैंड जेस्चर"])
        if is_gesture or (("camera" in text or "कैमरा" in text) and any(w in text for w in ["gesture", "hand", "हाथ", "ishara", "ishare"])):
            if any(w in text for w in ["start", "on", "enable", "chalu", "kholo", "shuru", "चालू", "शुरू"]):
                preview = any(w in text for w in ["preview", "window", "hud", "dikhao", "screen"])
                return SystemIntent(action="start_gesture_control", params={"preview": preview}, raw_query=query)
            if any(w in text for w in ["stop", "off", "disable", "band", "close", "rok", "roko", "बंद", "रोको"]):
                return SystemIntent(action="stop_gesture_control", params={}, raw_query=query)
            if any(w in text for w in ["status", "check", "kitna", "kya", "state", "स्टेटस"]):
                return SystemIntent(action="get_gesture_status", params={}, raw_query=query)

        # ------------------------------------------------------------------
        # 0. Peripheral Status Intents
        # ------------------------------------------------------------------
        if any(phrase in text for phrase in ["peripheral status", "peripherals status", "bluetooth and wifi", "connection status"]):
            return SystemIntent(action="get_peripheral_status", raw_query=query)

        # ------------------------------------------------------------------
        # 1. Keyboard Backlight Intents
        # ------------------------------------------------------------------
        is_kbl = bool(
            any(kw in text for kw in [
                "keyboard", "keybord", "key board", "keypad", "backlight", "back light",
                "key light", "keypad light", "kbl", "laptop light", "कीबोर्ड"
            ]) or (
                ("light" in text or "लाइट" in text) and any(k in text for k in ["key", "board", "bord", "कीबोर्ड"])
            ) or (
                ("light" in text or "लाइट" in text) and not any(d in text for d in ["screen", "display", "monitor", "स्क्रीन", "डिस्प्ले"]) and
                any(w in text for w in ["chalu", "kholo", "jalao", "bujhao", "chaloo", "jala", "bujha", "चालू", "जलाओ", "बुझाओ"])
            )
        )

        if is_kbl:
            # ── Read current brightness ──────────────────────────────────
            if any(kw in text for kw in ["kitni", "kitna", "check", "status", "get", "what", "current", "show", "read", "batao", "tell", "कितनी", "कितना"]):
                return SystemIntent(action="get_keyboard_backlight", raw_query=query)

            # ── Save to flash ────────────────────────────────────────────
            if any(kw in text for kw in ["save", "persist", "flash"]):
                return SystemIntent(action="save_keyboard_backlight", raw_query=query)

            # ── Turn off / Zero ──────────────────────────────────────────
            if any(kw in text for kw in ["off", "disable", "turn off", "band", "bund", "bandh", "bujhao", "bujha", "bujhado", "close", "shut", "zero", "shunya", "बंद", "बुझाओ", "शून्य"]) or re.search(r"\b0\s*%?\b", text):
                return SystemIntent(action="set_keyboard_backlight", params={"level": 0, "mode": "off"}, raw_query=query)

            # ── Turn on / Full / Max ─────────────────────────────────────
            if any(kw in text for kw in ["full", "maximum", "max", "poora", "poori", "pure", "highest", "ekdam tez", "sau percent", "100%", "फुल", "पूरा", "पूरी"]) or \
               any(kw in text for kw in ["on", "enable", "turn on", "chalu", "chaloo", "vhalu", "valoo", "start", "open", "kholo", "khol", "jalao", "jala", "jalado", "jalayein", "चालू", "जलाओ"]):
                mode = "static" if any(w in text for w in ["static", "single", "white", "plain"]) else "rainbow"
                return SystemIntent(action="set_keyboard_backlight", params={"level": 100, "mode": mode}, raw_query=query)

            # ── Low ──────────────────────────────────────────────────────
            if any(kw in text for kw in ["low", "dheema", "dheemi", "bilkul kam", "minimum", "min", "लो", "धीमा", "धीमी"]) and not any(kw in text for kw in ["by", "thoda kam", "ghata"]):
                mode = "rainbow"
                return SystemIntent(action="set_keyboard_backlight", params={"level": 25, "mode": mode}, raw_query=query)

            # ── Specific percentage / number ─────────────────────────────
            lvl = extract_level(text)
            if lvl is not None and not any(w in text for w in ["increase", "badhao", "decrease", "kam", "ghata", "बढ़ा", "कम"]):
                mode = "rainbow" if any(w in text for w in ["rainbow", "wave", "multi", "flow", "color"]) else "rainbow"
                return SystemIntent(action="set_keyboard_backlight", params={"level": min(100, max(0, lvl)), "mode": mode}, raw_query=query)

            # ── Increase brightness ──────────────────────────────────────
            if any(kw in text for kw in ["up", "increase", "raise", "brighter", "badhao", "badha", "zyada", "tez", "बढ़ाओ", "बढ़ा", "ज्यादा", "तेज"]):
                delta = lvl if (lvl and any(w in text for w in ["by", "point", "percent"])) else 25
                return SystemIntent(action="adjust_keyboard_backlight", params={"delta": delta}, raw_query=query)

            # ── Decrease brightness ──────────────────────────────────────
            if any(kw in text for kw in ["down", "decrease", "lower", "dim", "kam", "ghata", "ghataao", "dheema", "कम", "घटाओ", "धीमा"]):
                delta = lvl if (lvl and any(w in text for w in ["by", "point", "percent"])) else 25
                return SystemIntent(action="adjust_keyboard_backlight", params={"delta": -delta}, raw_query=query)

        # ------------------------------------------------------------------
        # 2. Display Brightness Intents
        # ------------------------------------------------------------------
        is_brightness = bool(
            any(kw in text for kw in [
                "brightness", "brightnes", "screen light", "display light", "screen ki light",
                "display ki light", "screen brightness", "display brightness", "monitor brightness",
                "screen ki brightness", "display ki brightness", "ब्राइटनेस", "स्क्रीन लाइट", "स्क्रीन की ब्राइटनेस"
            ]) or (
                ("screen" in text or "स्क्रीन" in text) and any(w in text for w in ["light", "brightness", "brightnes", "chamak", "लाइट", "ब्राइटनेस", "चमक"])
            ) or (
                ("display" in text or "डिस्प्ले" in text) and any(w in text for w in ["light", "brightness", "brightnes", "chamak", "लाइट", "ब्राइटनेस", "चमक"])
            ) or (
                ("monitor" in text or "मॉनिटर" in text) and any(w in text for w in ["light", "brightness", "brightnes", "लाइट", "ब्राइटनेस"])
            )
        )

        if is_brightness:
            # ── Read current brightness ──────────────────────────────────
            if any(kw in text for kw in ["get", "what", "check", "current", "show", "status", "kitni", "kitna", "batao", "tell", "कितनी", "कितना"]):
                return SystemIntent(action="get_display_brightness", raw_query=query)

            # ── Full / Maximum ───────────────────────────────────────────
            if any(kw in text for kw in ["full", "maximum", "max", "poora", "poori", "highest", "ekdam tez", "sau percent", "100%", "फुल", "पूरा", "पूरी"]):
                return SystemIntent(action="set_display_brightness", params={"level": 100}, raw_query=query)

            # ── Low ──────────────────────────────────────────────────────
            if any(kw in text for kw in ["low", "dheemi", "dheema", "minimum", "min", "लो", "धीमा", "धीमी"]) and not any(kw in text for kw in ["by", "thoda kam", "ghata", "decrease"]):
                return SystemIntent(action="set_display_brightness", params={"level": 15}, raw_query=query)

            # ── Zero / Off ───────────────────────────────────────────────
            if any(kw in text for kw in ["zero", "shunya", "bilkul kam", "band", "off", "शून्य", "बंद"]) or re.search(r"\b0\s*%?\b", text):
                return SystemIntent(action="set_display_brightness", params={"level": 0}, raw_query=query)

            # ── Specific percentage / number ─────────────────────────────
            lvl = extract_level(text)
            if lvl is not None and not any(w in text for w in ["increase", "badhao", "decrease", "kam", "ghata", "बढ़ा", "कम"]):
                return SystemIntent(action="set_display_brightness", params={"level": min(100, max(0, lvl))}, raw_query=query)

            # ── Increase brightness ──────────────────────────────────────
            if any(kw in text for kw in ["increase", "brighter", "turn up", "boost", "badhao", "badha", "tez", "up", "raise", "बढ़ाओ", "बढ़ा", "तेज"]):
                delta = lvl if (lvl and any(w in text for w in ["by", "point", "percent"])) else 15
                return SystemIntent(action="adjust_display_brightness", params={"delta": delta}, raw_query=query)

            # ── Decrease brightness ──────────────────────────────────────
            if any(kw in text for kw in ["decrease", "dim", "lower", "darker", "kam", "ghata", "down", "dheema", "कम", "घटाओ", "धीमा"]):
                delta = lvl if (lvl and any(w in text for w in ["by", "point", "percent"])) else 15
                return SystemIntent(action="adjust_display_brightness", params={"delta": -delta}, raw_query=query)

        # ------------------------------------------------------------------
        # 3. Audio Volume Intents (English + Hinglish + Hindi)
        # ------------------------------------------------------------------
        # 3a. Mute / Unmute
        if any(kw in text for kw in [
            "unmute volume", "unmute audio", "unmute sound", "unmute karo", "unmute",
            "off mute", "disable mute", "awaz chalu", "sound chalu", "अनम्यूट", "आवाज़ चालू", "आवाज चालू"
        ]):
            return SystemIntent(action="toggle_audio_mute", params={"mute": False}, raw_query=query)

        if any(kw in text for kw in [
            "mute volume", "mute audio", "mute sound", "mute kar", "mute",
            "awaz band", "sound band", "म्यूट", "आवाज़ बंद", "आवाज बंद"
        ]):
            return SystemIntent(action="toggle_audio_mute", params={"mute": True}, raw_query=query)

        # Check if query is audio/volume related
        is_audio = any(kw in text for kw in [
            "volume", "sound", "audio", "awaz", "awaaz", "aawaz",
            "वॉल्यूम", "वोल्यूम", "आवाज़", "आवाज", "साउंड", "ऑडियो"
        ])
        if is_audio:
            # Status / Query current volume
            if any(kw in text for kw in ["get", "what", "check", "current", "show", "status", "kitna", "kitni", "batao", "tell", "कितना", "कितनी"]):
                return SystemIntent(action="get_audio_volume", raw_query=query)

            # Full / Maximum volume
            if any(kw in text for kw in ["full", "maximum", "max", "poora", "poori", "pure", "highest", "ekdam tez", "sau percent", "100%", "फुल", "पूरा", "पूरी", "मैक्स"]):
                return SystemIntent(action="set_audio_volume", params={"level": 100}, raw_query=query)

            # Low volume
            if any(kw in text for kw in ["low", "dheemi", "dheema", "minimum", "min", "लो", "धीमा", "धीमी"]) and not any(kw in text for kw in ["by", "thoda kam", "ghata", "decrease"]):
                return SystemIntent(action="set_audio_volume", params={"level": 15}, raw_query=query)

            # Zero / Minimum / Off
            if any(kw in text for kw in ["zero", "shunya", "bilkul kam", "शून्य", "बिल्कुल कम"]) or re.search(r"\b0\s*%?\b", text):
                return SystemIntent(action="set_audio_volume", params={"level": 0}, raw_query=query)

            # Specific percentage or number (e.g. 'volume ko 50 par set karo', 'volume 80%', 'sound 70')
            lvl = extract_level(text)
            if lvl is not None and not any(w in text for w in ["increase", "badhao", "decrease", "kam", "ghata", "बढ़ा", "कम"]):
                return SystemIntent(action="set_audio_volume", params={"level": min(100, max(0, lvl))}, raw_query=query)

            # Increase volume (volume badhao, awaz badhao, sound up, etc.)
            if any(kw in text for kw in ["increase", "badhao", "badha", "up", "raise", "louder", "tez", "high", "बढ़ाओ", "बढ़ा", "तेज"]):
                delta = lvl if (lvl and any(w in text for w in ["by", "point", "percent"])) else (5 if any(s in text for s in ["thoda", "thodi", "zara", "bit", "थोड़ा", "थोड़ी"]) else 10)
                return SystemIntent(action="adjust_audio_volume", params={"delta": delta}, raw_query=query)

            # Decrease volume (volume kam karo, awaz kam, sound down, etc.)
            if any(kw in text for kw in ["decrease", "kam", "ghata", "down", "lower", "softer", "dheemi", "dheema", "कम", "घटाओ", "धीमा", "धीमी"]):
                delta = lvl if (lvl and any(w in text for w in ["by", "point", "percent"])) else (5 if any(s in text for s in ["thoda", "thodi", "zara", "bit", "थोड़ा", "थोड़ी"]) else 10)
                return SystemIntent(action="adjust_audio_volume", params={"delta": -delta}, raw_query=query)

        # ------------------------------------------------------------------
        # 4. Peripheral Connection Intents
        # ------------------------------------------------------------------
        if "bluetooth" in text or "bt" in text.split():
            if any(kw in text for kw in ["on", "enable", "connect", "start", "turn on", "chalu", "vhalu"]):
                return SystemIntent(action="set_bluetooth_state", params={"enable": True}, raw_query=query)
            if any(kw in text for kw in ["off", "disable", "disconnect", "stop", "turn off", "band"]):
                return SystemIntent(action="set_bluetooth_state", params={"enable": False}, raw_query=query)
            if any(kw in text for kw in ["status", "check", "state"]):
                return SystemIntent(action="get_peripheral_status", raw_query=query)

        if "wifi" in text or "wi-fi" in text or "wireless" in text:
            if any(kw in text for kw in ["on", "enable", "connect", "start", "turn on", "chalu", "vhalu"]):
                return SystemIntent(action="set_wifi_state", params={"enable": True}, raw_query=query)
            if any(kw in text for kw in ["off", "disable", "disconnect", "stop", "turn off", "band"]):
                return SystemIntent(action="set_wifi_state", params={"enable": False}, raw_query=query)
            if any(kw in text for kw in ["status", "check", "state"]):
                return SystemIntent(action="get_peripheral_status", raw_query=query)

        # ------------------------------------------------------------------
        # 5. WhatsApp Messaging Intents (Hinglish + English)
        # ------------------------------------------------------------------
        if "whatsapp" in text or ("message" in text and any(w in text for w in ["bhejo", "bhej", "send", "karo", "do", "msg"])):
            phone_or_contact = ""
            msg_body = ""

            m_hinglish = re.search(r"([a-z0-9\s]+?)\s+ko\s+(?:whatsapp\s+(?:par|per|pe)\s+)?(?:message|msg)\s+(?:bhejo|bhej|karo|do|bhejdo)\s*(.*)", text)
            if m_hinglish:
                phone_or_contact = m_hinglish.group(1).replace("whatsapp", "").strip()
                msg_body = m_hinglish.group(2).strip()
                msg_body = re.sub(r"^(?:do|to|de|dene)\s+", "", msg_body).strip()

            if not phone_or_contact:
                m_english = re.search(r"(?:send|msg|message)\s+(?:a\s+)?(?:whatsapp\s+)?(?:message\s+)?(?:to\s+)?([a-z0-9\s]+?)\s+(?:saying|with text|text|message)?\s*(.*)", text)
                if m_english:
                    phone_or_contact = m_english.group(1).replace("whatsapp", "").replace("send", "").strip()
                    msg_body = m_english.group(2).strip()
                    msg_body = re.sub(r"^(?:do|to|de|dene)\s+", "", msg_body).strip()

            if phone_or_contact:
                if not msg_body:
                    msg_body = "Hello from ERA!"
                return SystemIntent(action="open_whatsapp", params={"phone": phone_or_contact, "message": msg_body}, raw_query=query)

        # ------------------------------------------------------------------
        # 6. Phone Link Device Intents (Calls, SMS/Messages, File Transfer, Status)
        # ------------------------------------------------------------------
        if any(kw in text for kw in ["call", "dial", "phone lagao", "phonelink", "phone link", "fon lagao", "call karo", "call lagao"]):
            digit_m = re.search(r"(\+?\d[\d\s\-]{6,15}\d|\b\d{10}\b|\b\d{5}\s*\d{5}\b)", text)
            if digit_m:
                clean_num = re.sub(r"[^\d+]", "", digit_m.group(1))
                return SystemIntent(
                    action="make_phone_call",
                    params={"phone": clean_num},
                    raw_query=query,
                )

            cleaned_text = text
            for filler in ["phone link", "phonelink", "windows phone link"]:
                cleaned_text = cleaned_text.replace(filler, "")

            m_ko = re.search(r"([a-z0-9\s]+?)\s+(?:ko|pe|par)\s+(?:call|phone|dial)", cleaned_text)
            if m_ko:
                contact = m_ko.group(1).strip()
                contact = re.sub(r"^(?:is|us|mera|meri|mujhe|please|se)\s+", "", contact).strip()
                if contact and contact not in ["call", "karo", "do", "lagao", "se", "number"]:
                    return SystemIntent(action="make_phone_call", params={"phone": contact}, raw_query=query)

            m_call_after = re.search(r"(?:call|dial|phone lagao|fon lagao)\s+(?:to\s+)?([a-z0-9\s]+)", cleaned_text)
            if m_call_after:
                contact = m_call_after.group(1).strip()
                contact = re.sub(r"\s+(?:karo|do|lagao|bhejo|please)$", "", contact).strip()
                contact = re.sub(r"^(?:to|ko|pe|par|se)\s+", "", contact).strip()
                if contact and contact not in ["karo", "do", "lagao", "please", "call"]:
                    return SystemIntent(action="make_phone_call", params={"phone": contact}, raw_query=query)

        if any(kw in text for kw in ["phone link message", "phone message", "sms read", "messages padho", "sms padho", "read sms", "read message"]):
            return SystemIntent(action="read_phone_messages", raw_query=query)

        if any(kw in text for kw in ["file transfer", "photo transfer", "phone file", "phone photo", "phone link file", "transfer file"]):
            return SystemIntent(action="transfer_phone_files", raw_query=query)

        if "phone link" in text and any(kw in text for kw in ["status", "check", "connected", "connect", "state", "link", "karo", "do"]):
            return SystemIntent(action="get_phone_link_status", raw_query=query)

        return SystemIntent(action="unknown", matched=False, raw_query=query)
