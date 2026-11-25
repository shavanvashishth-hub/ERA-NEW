"""ERA Custom Vocabulary and Phonetic Entity Manager.

Maintains configurable vocabulary terms, application names, founder entities,
development tools, system actions, and user-defined targets.
Builds the Whisper ASR initial_prompt conditioning string and provides
safe, calibrated alias resolution without forced replacement.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

log = logging.getLogger("era.vocabulary")


@dataclass
class VocabularyItem:
    canonical_name: str
    category: str  # "app", "entity", "verb", "tool", "folder", "user_custom"
    aliases: List[str] = field(default_factory=list)
    hindi_devanagari: List[str] = field(default_factory=list)
    hinglish_variants: List[str] = field(default_factory=list)
    description: str = ""
    system_target: Optional[str] = None  # Executable or command parameter if applicable


# Default Core ERA Vocabulary Specifications
CORE_VOCABULARY: List[VocabularyItem] = [
    # Assistant & Creator Entities
    VocabularyItem(
        canonical_name="ERA",
        category="entity",
        aliases=["era", "eira", "ira", "eera", "eyra", "aira", "aera"],
        hindi_devanagari=["एरा", "इरा", "ईरा"],
        hinglish_variants=["era", "eira", "ira"],
        description="Evolving Responsive Assistant",
    ),
    VocabularyItem(
        canonical_name="Evolving Responsive Assistant",
        category="entity",
        aliases=["evolving responsive assistant"],
        hindi_devanagari=[],
        hinglish_variants=["evolving responsive assistant"],
        description="Full formal name of ERA AI Assistant",
    ),
    VocabularyItem(
        canonical_name="Shavan",
        category="entity",
        aliases=["shavan", "shravan", "savan", "shawan"],
        hindi_devanagari=["शवन", "श्रवण", "सावन"],
        hinglish_variants=["shavan", "shravan"],
        description="Creator and Principal Architect of ERA",
    ),
    VocabularyItem(
        canonical_name="NavoraX",
        category="entity",
        aliases=["navorax", "navora x", "navora"],
        hindi_devanagari=["नवोराएक्स", "नवोरा"],
        hinglish_variants=["navorax", "navora x"],
        description="Flagship technology brand and parent organization",
    ),
    VocabularyItem(
        canonical_name="HopinGo",
        category="entity",
        aliases=["hopingo", "hop in go", "hopin go"],
        hindi_devanagari=["होपिंगो", "होप इन गो"],
        hinglish_variants=["hopingo", "hop in go"],
        description="Ecosystem platform and mobility intelligence service",
    ),

    # Developer & AI Tools
    VocabularyItem(
        canonical_name="Python",
        category="tool",
        aliases=["python", "python3", "py"],
        hindi_devanagari=["पायथन", "पाइथन"],
        hinglish_variants=["python", "paythan"],
        description="Python programming environment",
        system_target="python",
    ),
    VocabularyItem(
        canonical_name="Antigravity",
        category="tool",
        aliases=["antigravity", "anti-gravity", "anti gravity"],
        hindi_devanagari=["एंटीग्रेविटी", "एंटी ग्रेविटी"],
        hinglish_variants=["antigravity"],
        description="Google Antigravity autonomous development environment",
    ),
    VocabularyItem(
        canonical_name="Codex",
        category="tool",
        aliases=["codex", "code x"],
        hindi_devanagari=["कोडेक्स"],
        hinglish_variants=["codex"],
        description="Codex developer engine",
    ),
    VocabularyItem(
        canonical_name="Claude",
        category="tool",
        aliases=["claude", "claud", "clod"],
        hindi_devanagari=["क्लॉड", "क्लाउड"],
        hinglish_variants=["claude"],
        description="Anthropic Claude AI system",
    ),

    # Applications
    VocabularyItem(
        canonical_name="Google Chrome",
        category="app",
        aliases=["chrome", "google chrome", "browser", "chrom"],
        hindi_devanagari=["गूगल क्रोम", "क्रोम", "ब्राउज़र", "ब्राउजर"],
        hinglish_variants=["chrome", "google chrome", "browser", "krome"],
        description="Google Chrome web browser",
        system_target="chrome",
    ),
    VocabularyItem(
        canonical_name="Opera",
        category="app",
        aliases=["opera", "opera browser", "opera gx"],
        hindi_devanagari=["ओपेरा", "ओपेरा ब्राउज़र", "ओपेरा ब्राउजर"],
        hinglish_variants=["opera", "opera browser", "opera gx"],
        description="Opera web browser",
        system_target="opera",
    ),
    VocabularyItem(
        canonical_name="VS Code",
        category="app",
        aliases=["vs code", "vscode", "visual studio code", "code editor", "code", "versus code", "vs", "vee ess code", "vs-code", "var sis code", "varsis code", "वर्से स्कोड", "वर्सेस कोड"],
        hindi_devanagari=["वीएस कोड", "विजुअल स्टूडियो कोड", "कोड", "वर सिस कोद", "वरसिस कोड", "वर्सिस कोड", "वर सिस कोड", "वी एस कोड", "वर्से स्कोड", "वर्सेस कोड"],
        hinglish_variants=["vs code", "vscode", "visual studio code", "code", "versus code", "vs", "varsis code", "var sis code"],
        description="Microsoft Visual Studio Code",
        system_target="vscode",
    ),
    VocabularyItem(
        canonical_name="Notepad",
        category="app",
        aliases=["notepad", "notes", "text editor", "not bad", "note pad"],
        hindi_devanagari=["नोटपैड", "नोट्स"],
        hinglish_variants=["notepad", "noteped", "notes", "not bad"],
        description="Windows Notepad application",
        system_target="notepad",
    ),
    VocabularyItem(
        canonical_name="WhatsApp",
        category="app",
        aliases=["whatsapp", "whats app", "wa", "वोट्साप", "वाट्साप", "वाट्सएप"],
        hindi_devanagari=["व्हाट्सएप", "व्हाट्सएप्प", "वोट्साप", "वाट्साप", "वाट्सएप"],
        hinglish_variants=["whatsapp", "whats app"],
        description="WhatsApp Desktop messaging platform",
        system_target="whatsapp",
    ),
    VocabularyItem(
        canonical_name="Calculator",
        category="app",
        aliases=["calculator", "calc"],
        hindi_devanagari=["कैलकुलेटर", "कैलक"],
        hinglish_variants=["calculator", "calc"],
        description="Windows Calculator application",
        system_target="calculator",
    ),
    VocabularyItem(
        canonical_name="File Explorer",
        category="app",
        aliases=["file explorer", "explorer", "files", "my computer"],
        hindi_devanagari=["फाइल एक्सप्लोरर", "एक्सप्लोरर", "फाइल्स"],
        hinglish_variants=["file explorer", "explorer", "files"],
        description="Windows File Explorer",
        system_target="explorer",
    ),
    VocabularyItem(
        canonical_name="Spotify",
        category="app",
        aliases=["spotify", "music player", "songs"],
        hindi_devanagari=["स्पॉटिफाई", "स्पॉटीफाई"],
        hinglish_variants=["spotify"],
        description="Spotify streaming music player",
        system_target="spotify",
    ),
    VocabularyItem(
        canonical_name="YouTube",
        category="app",
        aliases=["youtube", "yt"],
        hindi_devanagari=["यूट्यूब", "युटुब"],
        hinglish_variants=["youtube", "yt"],
        description="YouTube media platform",
        system_target="https://www.youtube.com",
    ),
    VocabularyItem(
        canonical_name="Camera",
        category="app",
        aliases=["camera", "webcam"],
        hindi_devanagari=["कैमरा", "वेबकैम"],
        hinglish_variants=["camera", "webcam"],
        description="Windows Camera application",
        system_target="camera",
    ),
    VocabularyItem(
        canonical_name="Terminal",
        category="app",
        aliases=["terminal", "windows terminal", "console"],
        hindi_devanagari=["टर्मिनल"],
        hinglish_variants=["terminal"],
        description="Windows Terminal",
        system_target="terminal",
    ),
    VocabularyItem(
        canonical_name="PowerShell",
        category="app",
        aliases=["powershell", "posh", "pwsh"],
        hindi_devanagari=["पावरशेल"],
        hinglish_variants=["powershell"],
        description="Windows PowerShell prompt",
        system_target="powershell",
    ),
    VocabularyItem(
        canonical_name="Task Manager",
        category="app",
        aliases=["task manager", "taskmgr"],
        hindi_devanagari=["टास्क मैनेजर"],
        hinglish_variants=["task manager", "taskmgr"],
        description="Windows Task Manager",
        system_target="task manager",
    ),
    VocabularyItem(
        canonical_name="Settings",
        category="app",
        aliases=["settings", "control panel", "pc settings"],
        hindi_devanagari=["सेटिंग्स", "सेटिंग"],
        hinglish_variants=["settings", "setting"],
        description="Windows Settings panel",
        system_target="settings",
    ),
    VocabularyItem(
        canonical_name="Paint",
        category="app",
        aliases=["paint", "mspaint"],
        hindi_devanagari=["पेंट"],
        hinglish_variants=["paint"],
        description="Microsoft Paint",
        system_target="paint",
    ),

    # Standard User Folders
    VocabularyItem(
        canonical_name="Downloads",
        category="folder",
        aliases=["downloads", "download folder", "downloads folder"],
        hindi_devanagari=["डाउनलोड्स", "डाउनलोड"],
        hinglish_variants=["downloads", "download folder"],
        description="User Downloads folder",
        system_target="downloads",
    ),
    VocabularyItem(
        canonical_name="Documents",
        category="folder",
        aliases=["documents", "document folder", "docs"],
        hindi_devanagari=["डॉक्यूमेंट्स", "दस्तावेज़"],
        hinglish_variants=["documents", "docs"],
        description="User Documents folder",
        system_target="documents",
    ),
    VocabularyItem(
        canonical_name="Desktop",
        category="folder",
        aliases=["desktop", "desktop folder"],
        hindi_devanagari=["डेस्कटॉप"],
        hinglish_variants=["desktop"],
        description="User Desktop folder",
        system_target="desktop",
    ),
    VocabularyItem(
        canonical_name="Pictures",
        category="folder",
        aliases=["pictures", "photos", "images folder"],
        hindi_devanagari=["पिक्चर्स", "फ़ोटो"],
        hinglish_variants=["pictures", "photos"],
        description="User Pictures folder",
        system_target="pictures",
    ),
]


class VocabularyManager:
    """Manages custom vocabulary items, initial prompts for ASR, and entity resolution."""

    def __init__(self, storage_path: Optional[Path] = None) -> None:
        self.storage_path = storage_path or Path(__file__).parent / "custom_vocabulary.json"
        self._items: Dict[str, VocabularyItem] = {}
        self._alias_lookup: Dict[str, str] = {}  # lowercase alias -> canonical_name
        self._load_core()
        self._load_user_custom()

    def _load_core(self) -> None:
        for item in CORE_VOCABULARY:
            self._register_item(item)

    def _register_item(self, item: VocabularyItem) -> None:
        self._items[item.canonical_name] = item
        # Map canonical name
        self._alias_lookup[item.canonical_name.lower().strip()] = item.canonical_name
        # Map all aliases
        for alias in item.aliases:
            self._alias_lookup[alias.lower().strip()] = item.canonical_name
        # Map Hinglish variants
        for variant in item.hinglish_variants:
            self._alias_lookup[variant.lower().strip()] = item.canonical_name
        # Map Devanagari variants
        for dev in item.hindi_devanagari:
            self._alias_lookup[dev.strip()] = item.canonical_name

    def _load_user_custom(self) -> None:
        if not self.storage_path.exists():
            return
        try:
            with open(self.storage_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    for d in data:
                        item = VocabularyItem(**d)
                        self._register_item(item)
            log.info(f"Loaded {len(data)} user-defined vocabulary items from {self.storage_path}")
        except Exception as e:
            log.warn(f"Failed to load custom vocabulary from {self.storage_path}: {e}")

    def save_user_custom(self) -> None:
        try:
            user_items = [
                asdict(item) for item in self._items.values() if item.category == "user_custom"
            ]
            with open(self.storage_path, "w", encoding="utf-8") as f:
                json.dump(user_items, f, indent=2, ensure_ascii=False)
        except Exception as e:
            log.error(f"Failed to persist custom vocabulary: {e}")

    def add_custom_item(
        self,
        canonical_name: str,
        category: str = "user_custom",
        aliases: Optional[List[str]] = None,
        system_target: Optional[str] = None,
        description: str = "",
    ) -> VocabularyItem:
        """Adds or updates a custom vocabulary entry and persists it."""
        item = VocabularyItem(
            canonical_name=canonical_name.strip(),
            category=category,
            aliases=[a.strip() for a in (aliases or []) if a.strip()],
            system_target=system_target,
            description=description,
        )
        self._register_item(item)
        self.save_user_custom()
        return item

    def get_whisper_initial_prompt(self, max_tokens: int = 220) -> str:
        """Constructs a rich initial_prompt string to bias Whisper ASR decoding.

        Whisper uses the initial_prompt token conditioning to correctly recognize
        specific names, acronyms, and Hindi/Hinglish terms rather than hallucinating
        similar sounding English words.
        """
        # Concise, high-value bilingual tokens to prime Whisper ASR for ERA commands
        prime_tokens = [
            "ERA", "VS Code", "WhatsApp", "Google Chrome", "Opera", "Notepad",
            "Calculator", "Terminal", "PowerShell", "Settings",
            "left screen", "right screen", "split screen",
            "स्क्रीन", "बाएँ", "दाएँ", "सेट करो", "खोलो", "बंद करो",
            "brightness", "volume", "keyboard backlight", "screenshot",
            "aawaz badhao", "volume kam karo", "mute karo",
            "Shavan", "NavoraX", "HopinGo", "Python", "Antigravity"
        ]
        # Append user custom items if any
        for item in self._items.values():
            if item.category == "user_custom" and item.canonical_name not in prime_tokens:
                prime_tokens.append(item.canonical_name)

        return ", ".join(prime_tokens[:max_tokens])

    def resolve_alias(self, text: str, min_confidence: float = 0.85) -> Optional[Tuple[VocabularyItem, float]]:
        """Safely maps a candidate word/phrase to a known VocabularyItem without blind replacement.

        Returns (VocabularyItem, match_confidence) or None.
        """
        if not text:
            return None
        norm = text.lower().strip()
        norm_clean = re.sub(r"[^\w\s-]", "", norm)

        # 1. Exact alias match
        if norm in self._alias_lookup:
            canonical = self._alias_lookup[norm]
            return self._items[canonical], 1.0
        if norm_clean in self._alias_lookup:
            canonical = self._alias_lookup[norm_clean]
            return self._items[canonical], 0.98

        # 2. Devanagari exact match
        raw_strip = text.strip()
        if raw_strip in self._alias_lookup:
            canonical = self._alias_lookup[raw_strip]
            return self._items[canonical], 1.0

        # 3. Normalized Token Overlap / Substring Check
        for canonical, item in self._items.items():
            can_lower = canonical.lower()
            if norm_clean == can_lower:
                return item, 1.0
            for alias in item.aliases:
                a_lower = alias.lower()
                if norm_clean == a_lower:
                    return item, 0.95
                if len(a_lower) >= 4 and norm_clean == a_lower:
                    return item, 0.90

        # 4. Levenshtein / Edit distance match (guarded to avoid replacing completely different words)
        best_item: Optional[VocabularyItem] = None
        best_sim = 0.0

        for canonical, item in self._items.items():
            candidates = [canonical.lower()] + [a.lower() for a in item.aliases] + [v.lower() for v in item.hinglish_variants]
            for cand in candidates:
                if abs(len(cand) - len(norm_clean)) > 2:
                    continue
                sim = self._similarity_ratio(norm_clean, cand)
                if sim > best_sim:
                    best_sim = sim
                    best_item = item

        if best_item and best_sim >= min_confidence:
            return best_item, best_sim

        return None

    @staticmethod
    def _similarity_ratio(s1: str, s2: str) -> float:
        """Computes Ratcliff-Obershelp similarity ratio without requiring external dependencies."""
        if s1 == s2:
            return 1.0
        if not s1 or not s2:
            return 0.0
        try:
            import difflib
            return difflib.SequenceMatcher(None, s1, s2).ratio()
        except Exception:
            return 0.0

    def list_all_items(self) -> List[Dict[str, Any]]:
        return [asdict(item) for item in self._items.values()]


# Global singleton instance
vocabulary_manager = VocabularyManager()
