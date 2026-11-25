"""Offline, rule-based extraction of entities, facts, decisions, tasks, procedures and importance signals.

This is deliberately transparent and dependency-free. Every extraction carries a confidence score; anything
the user did not state first-person is marked 'assumed'. A local LLM can be plugged in via `llm_extractor`
(a callable returning an `Extraction`) without changing the rest of the engine.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Tuple

from .memory_models import Flag, clamp
from .memory_security import wants_no_store
from .memory_text import (STOPWORDS, canon, content_tokens, parse_due, parse_range, split_sentences, tokens)

TECH: Dict[str, str] = {k.lower(): k for k in [
    "Python", "JavaScript", "TypeScript", "React", "Vite", "Tailwind", "Node.js", "FastAPI", "Flask", "SQLite",
    "PostgreSQL", "MongoDB", "Firebase", "Gemini", "OpenAI", "Claude", "Vapi", "WhatsApp", "Windows", "Linux",
    "Android", "Docker", "Git", "GitHub", "Ollama", "Llama", "Whisper", "PyTorch", "TensorFlow", "NumPy", "OpenCV",
    "Antigravity", "Stitch", "Electron", "Tauri", "Chrome", "Notepad", "Arduino", "Raspberry Pi",
]}
TECH["node"] = "Node.js"
TECH["nodejs"] = "Node.js"

_COMMON_CAPS = {"i", "i'm", "i'll", "i've", "i'd", "ok", "okay", "yes", "no", "hey", "hi", "hello", "thanks", "also",
                "but", "and", "so", "then", "let", "lets", "let's", "what", "when", "where", "why", "how", "can",
                "could", "should", "would", "please", "today", "tomorrow", "yesterday", "monday", "tuesday",
                "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april",
                "may", "june", "july", "august", "september", "october", "november", "december", "my", "we",
                "the", "this", "that", "it", "if", "do", "did", "is", "are", "was", "will", "next", "first", "now"}
_TRIVIAL = re.compile(r"^\s*(?:ok(?:ay)?|k|thanks?(?: you)?|thx|ty|yes|yeah|yep|no|nope|nice|cool|great|hi|hello|hey|"
                      r"good (?:morning|night|evening)|bye|got it|sure|alright|hmm+|lol|haha+|fine|done)[.! ]*\s*$", re.I)

_REMEMBER = re.compile(r"\b(remember (?:this|that|to)|don'?t forget|keep in mind|note that|make sure (?:you|to)|"
                       r"never forget|important:)", re.I)
_IMPORTANT = re.compile(r"\b(important|critical|crucial|essential|must|never|always|priority|top priority|key requirement|"
                        r"non-negotiable|strict)\b", re.I)
_URGENT = re.compile(r"\b(urgent|asap|deadline|due (?:on|by|date)|by tomorrow|right away|immediately|time[- ]sensitive)\b", re.I)
_PERSONAL = re.compile(r"\b(my (?:family|mom|dad|mother|father|parents|sister|brother|friend|dream|goal|passion|"
                       r"birthday|hobby|hobbies)|i love|i'm passionate|means a lot|my vision)\b", re.I)
_TEMPORARY = re.compile(r"\b(for now|temporary|temporarily|just for (?:today|now|this)|this once|right now|"
                        r"at the moment|one[- ]off)\b", re.I)

_STOP_OBJ = re.compile(r"^(?:bit|little|lot|big fan|huge|tad|beginner|noob)\b", re.I)
_CLAUSE_END = r"(?=[.!?;,\n]|$| because | but | and then | so that )"

SINGLE_VALUED = {"name", "location", "role", "workplace", "studies", "origin", "goal_primary"}


@dataclass
class ExtractedEntity:
    name: str
    kind: str = "thing"
    confidence: float = 0.6


@dataclass
class ExtractedFact:
    subject: str
    predicate: str
    object: str
    sentence: str
    confidence: float = 0.7
    retract: bool = False
    epistemic: str = "confirmed"

    @property
    def single_valued(self) -> bool:
        return self.predicate in SINGLE_VALUED

    @property
    def fact_key(self) -> str:
        if self.single_valued:
            return f"{canon(self.subject)}|{self.predicate}"
        return f"{canon(self.subject)}|{self.predicate}|{canon(self.object)}"

    def natural(self) -> str:
        s = "The user" if canon(self.subject) == "user" else self.subject
        text = {
            "name": f"{s}'s name is {self.object}", "location": f"{s} lives in {self.object}",
            "origin": f"{s} is from {self.object}", "role": f"{s} is {self.object}",
            "workplace": f"{s} works at {self.object}", "studies": f"{s} studies {self.object}",
            "likes": f"{s} likes {self.object}", "dislikes": f"{s} dislikes {self.object}",
            "uses": f"{s} uses {self.object}", "is_building": f"{s} is building {self.object}",
            "goal": f"{s} wants to {self.object}", "no_longer": f"{s} no longer uses/likes {self.object}",
        }.get(self.predicate)
        if text:
            return text
        if self.predicate.startswith("favorite_"):
            return f"{s}'s favorite {self.predicate[9:].replace('_', ' ')} is {self.object}"
        return f"{self.subject} {self.predicate.replace('_', ' ')} {self.object}"


@dataclass
class ExtractedTask:
    text: str
    due_at: Optional[float] = None
    confidence: float = 0.6


@dataclass
class ExtractedNote:
    text: str
    kind: str                      # decision | procedure | failure | recovery
    confidence: float = 0.6


@dataclass
class Extraction:
    entities: List[ExtractedEntity] = field(default_factory=list)
    topics: List[str] = field(default_factory=list)
    facts: List[ExtractedFact] = field(default_factory=list)
    tasks: List[ExtractedTask] = field(default_factory=list)
    notes: List[ExtractedNote] = field(default_factory=list)
    relations: List[Tuple[str, str, str]] = field(default_factory=list)
    projects: List[str] = field(default_factory=list)
    importance: float = 0.3
    flags: List[str] = field(default_factory=list)
    confidence: float = 0.6
    no_store: bool = False
    trivial: bool = False


@dataclass
class QueryAnalysis:
    intent: str
    entities: List[str]
    topics: List[str]
    words: List[str]
    time_range: Optional[Tuple[float, float]]
    wants_history: bool
    is_reference: bool


def _clean_obj(s: str) -> str:
    s = re.sub(r"^(?:a|an|the|my|our|some)\s+", "", s.strip(), flags=re.I)
    return s.strip(" \t\"'`.,;:!?()")[:80]


def _name_after_called(s: str) -> Optional[str]:
    m = re.search(r"\b(?:called|named|titled)\s+[\"'“]?([A-Za-z0-9][\w.\- ]{0,40}?)[\"'”]?(?:\s*\(|\s*$|[.,;])", s + " ")
    return m.group(1).strip() if m else None


class MemoryExtractor:
    def __init__(self, llm_extractor: Optional[Callable[[str, str], Extraction]] = None):
        self.llm_extractor = llm_extractor

    # ------------------------------------------------------------------ public
    def extract(self, text: str, role: str = "user", known_entities: Optional[Dict[str, Tuple[str, str]]] = None,
                now: float = 0.0) -> Extraction:
        import time as _t
        now = now or _t.time()
        ex = Extraction()
        ex.no_store = wants_no_store(text)
        ex.trivial = bool(_TRIVIAL.match(text)) or len(tokens(text)) == 0
        if self.llm_extractor is not None:
            try:
                out = self.llm_extractor(text, role)
                if isinstance(out, Extraction):
                    out.no_store, out.trivial = ex.no_store, ex.trivial
                    return out
            except Exception:  # never let an optional model break ingestion; fall back to rules
                pass
        from_user = role == "user"
        base_conf = 0.8 if from_user else 0.5
        epi = "confirmed" if from_user else "assumed"

        entities: Dict[str, ExtractedEntity] = {}

        def add_entity(name: str, kind: str = "thing", conf: float = 0.6) -> None:
            name = name.strip(" \t\"'`.,;:!?()")
            c = canon(name)
            if not c or c in STOPWORDS or len(c) < 2 or c.isdigit():
                return
            old = entities.get(c)
            rank = {"project": 4, "technology": 3, "person": 3, "place": 2, "thing": 1}
            if old is None or rank.get(kind, 1) > rank.get(old.kind, 1):
                entities[c] = ExtractedEntity(old.name if old else name, kind, max(conf, old.confidence if old else 0))

        for sent in split_sentences(text):
            question = sent.rstrip().endswith("?")
            hypo = bool(re.match(r"(?i)^(?:if|what if|suppose|maybe|perhaps)\b", sent))
            if from_user and not question and not hypo:
                self._facts(sent, ex, add_entity, base_conf, epi)
                self._tasks(sent, ex, now)
                self._notes(sent, ex, base_conf)
            elif not from_user and not question:
                self._notes(sent, ex, base_conf, assistant=True)
            self._relations(sent, ex, add_entity, base_conf)

        self._numbered_procedure(text, ex, base_conf)
        self._entities(text, add_entity, known_entities)
        ex.entities = list(entities.values())
        ex.projects = list(dict.fromkeys(ex.projects))
        counts = Counter(w for w in content_tokens(text) if len(w) > 3 and not w.isdigit())
        ex.topics = [w for w, _ in counts.most_common(6)]
        self._importance(text, role, ex)
        return ex

    def analyze_query(self, query: str, known_entities: Optional[Dict[str, Tuple[str, str]]] = None,
                      now: float = 0.0, active_entities: Iterable[str] = ()) -> QueryAnalysis:
        import time as _t
        now = now or _t.time()
        ents: Dict[str, str] = {}

        def add(name: str, kind: str = "thing", conf: float = 0.6) -> None:
            ents.setdefault(canon(name), name.strip())

        self._entities(query, add, known_entities)
        q = query.lower()
        is_ref = bool(re.search(r"\b(it|that|this|those|them|the project|that project|the same|again|continue|resume|"
                                r"where were we|last time|earlier|before|previous(?:ly)?|we discussed|we talked|i told you|"
                                r"you remember|as i said|as before|the one)\b", q))
        if is_ref and not ents:
            for a in active_entities:
                add(a)
        if re.search(r"\b(continue|resume|pick up|where (?:were|did) we|carry on|keep going)\b", q):
            intent = "continuation"
        elif re.search(r"\b(improve|plan|design|build|add|implement|create|upgrade|next step|roadmap|strategy|"
                       r"how (?:should|can|do) (?:we|i))\b", q):
            intent = "planning"
        elif re.search(r"\b(remember|recall|did i|did we|what did|what was|what is my|who am i|do you know|told you)\b", q):
            intent = "recall"
        elif query.strip().endswith("?"):
            intent = "question"
        else:
            intent = "statement"
        hist = bool(re.search(r"\b(used to|previously|before|history|old|earlier|changed|switched|no longer|original(?:ly)?|"
                              r"timeline|evolv)\w*", q))
        return QueryAnalysis(intent, list(ents.values()), [w for w, _ in Counter(content_tokens(query)).most_common(6)],
                             [w for w in tokens(query) if w not in STOPWORDS], parse_range(query, now), hist, is_ref)

    # ------------------------------------------------------------------ facts
    def _facts(self, s: str, ex: Extraction, add_entity, conf: float, epi: str) -> None:
        def fact(pred: str, obj: str, c: float = 0.0, subject: str = "user", retract: bool = False) -> None:
            obj = _clean_obj(obj)
            if not obj or len(obj) < 2 or _STOP_OBJ.match(obj):
                return
            ex.facts.append(ExtractedFact(subject, pred, obj, s, c or conf, retract, epi))

        m = re.search(r"\b(?:my name is|call me|i go by|i am called)\s+([^\W\d_][\w'\-]*)", s, re.I)
        if m:
            fact("name", m.group(1), 0.9)
            add_entity(m.group(1), "person", 0.7)
        m = re.search(r"\bi (?:currently )?(?:live|stay|reside) in ([\w\s,.\-]{2,40}?)" + _CLAUSE_END, s, re.I) or \
            re.search(r"\bi(?:'m| am) (?:currently )?based in ([\w\s,.\-]{2,40}?)" + _CLAUSE_END, s, re.I) or \
            re.search(r"\bi (?:moved|relocated|shifted) to ([\w\s,.\-]{2,40}?)" + _CLAUSE_END, s, re.I)
        if m:
            fact("location", m.group(1), 0.8)
            add_entity(m.group(1), "place", 0.6)
        m = re.search(r"\bi(?:'m| am) from ([\w\s,.\-]{2,40}?)" + _CLAUSE_END, s, re.I)
        if m:
            fact("origin", m.group(1), 0.8)
        m = re.search(r"\bi(?:'m| am) (?:currently |now )?(an? [\w\s\-]{3,50}?)" + _CLAUSE_END.replace("|$|", "|$| who | at | in | with |"), s, re.I)
        if m and not re.match(r"an? (?:bit|little|lot|big|huge|beginner)\b", m.group(1), re.I):
            fact("role", m.group(1), 0.75)
        m = re.search(r"\bi work (?:at|for) ([\w\s&.\-]{2,40}?)" + _CLAUSE_END, s, re.I)
        if m:
            fact("workplace", m.group(1), 0.8)
            add_entity(m.group(1), "thing", 0.5)
        m = re.search(r"\bi(?:'m| am)? ?(?:study|studying) ([\w\s,.\-]{2,50}?)" + _CLAUSE_END, s, re.I)
        if m:
            fact("studies", m.group(1), 0.75)

        for m in re.finditer(r"\bmy (?:favou?rite) ([\w ]{2,25}?) is ([\w '\-]{1,40}?)" + _CLAUSE_END, s, re.I):
            fact("favorite_" + re.sub(r"\W+", "_", m.group(1).strip().lower()), m.group(2), 0.8)
        m = re.search(r"\bmy (?:goal|dream|aim|ambition) is (?:to )?([\w\s,.\-']{3,80}?)" + _CLAUSE_END, s, re.I) or \
            re.search(r"\bi want to (?:become|be) ([\w\s,.\-']{3,60}?)" + _CLAUSE_END, s, re.I) or \
            re.search(r"\bi(?:'m| am) aspiring to (?:be |become )?([\w\s,.\-']{3,60}?)" + _CLAUSE_END, s, re.I)
        if m:
            fact("goal", m.group(1), 0.75)

        # building / working on  ->  project
        m = re.search(r"\b(?:i|we)(?:'m| am|'ve been| have been|'re| are)?\s*(?:currently |now |also |still )?"
                      r"(?:building|developing|creating|making|working on|designing|launching)\s+(.+?)"
                      r"(?=[.!?;,\n]|$| using | with | for | that | which | so | because | and )", s, re.I)
        if m:
            raw = m.group(1)
            name = _name_after_called(raw) or re.split(r"\s*\(", raw)[0]
            name = _clean_obj(name)
            if 1 < len(name) <= 60 and not re.match(r"(?i)^(?:it|this|that|something|stuff|things?)$", name):
                fact("is_building", name, 0.8)
                short = " ".join(name.split()[:4])
                kind_name = _name_after_called(raw) or (name if len(name.split()) <= 3 else None)
                if kind_name:
                    ex.projects.append(kind_name)
                    add_entity(kind_name, "project", 0.8)
                else:
                    add_entity(short, "thing", 0.4)
        m = re.search(r"\b(?:the |a |my |our )?project (?:is )?(?:called|named) [\"'“]?([\w.\- ]{1,40}?)[\"'”]?" + _CLAUSE_END, s, re.I)
        if m:
            ex.projects.append(m.group(1).strip())
            add_entity(m.group(1), "project", 0.85)

        # retractions / changes (must run before generic like/use so they win)
        retracted = False
        for pat in (r"\bi (?:no longer|don'?t|do not)\s+(use|like|enjoy|prefer|play|want)\s+(.+?)\s*(?:anymore|any more|now)\b",
                    r"\bi no longer\s+(use|like|enjoy|prefer|want)\s+(.+?)" + _CLAUSE_END,
                    r"\bi (?:stopped|quit|gave up)\s+(using|liking|eating|drinking|playing)\s+(.+?)" + _CLAUSE_END):
            m = re.search(pat, s, re.I)
            if m:
                fact("no_longer", m.group(2), 0.8, retract=True)
                retracted = True
                break
        m = re.search(r"\bi (?:switched|moved|changed)\s+from\s+(.+?)\s+to\s+(.+?)" + _CLAUSE_END, s, re.I)
        if m:
            fact("no_longer", m.group(1), 0.8, retract=True)
            fact("uses", m.group(2), 0.8)
            add_entity(m.group(2), "technology" if canon(m.group(2)) in TECH else "thing", 0.6)
            retracted = True

        if not retracted:
            m = re.search(r"\bi (?:really |absolutely |strongly |always )?(prefer|like|love|enjoy|adore)\s+(.+?)"
                          r"(?=[.!?;\n]|$| because | but | more than | over | than )", s, re.I)
            if m and len(m.group(2).split()) <= 8:
                fact("likes", m.group(2), 0.75)
            m = re.search(r"\bi (?:really |absolutely |strongly )?(hate|dislike|detest)\s+(.+?)" + _CLAUSE_END, s, re.I) or \
                re.search(r"\bi (?:don'?t|do not|dont) (?:really )?(?:like|enjoy|want)\s+(.+?)" + _CLAUSE_END, s, re.I)
            if m:
                fact("dislikes", m.group(m.lastindex), 0.75)
            m = re.search(r"\bi (?:mostly |always |usually |currently )?(?:use|am using|'m using)\s+(.+?)"
                          r"(?=[.!?;,\n]|$| for | to | because | and | but | on )", s, re.I)
            if m:
                obj = _clean_obj(m.group(1))
                fact("uses", obj, 0.7)
                if canon(obj) in TECH:
                    add_entity(TECH[canon(obj)], "technology", 0.8)
        m = re.search(r"\bmy (friend|brother|sister|mom|mother|dad|father|teacher|professor|roommate|boss|colleague|"
                      r"mentor|partner|cousin) (?:is |named |called )?([A-Z][\w'\-]+)", s)
        if m:
            fact(m.group(1).lower(), m.group(2), 0.75)
            add_entity(m.group(2), "person", 0.7)

    # ------------------------------------------------------------------ relations (knowledge graph triples)
    def _relations(self, s: str, ex: Extraction, add_entity, conf: float) -> None:
        pat = (r"\b([A-Z][\w\-]*(?:\s[A-Z][\w\-]*)?)\s+(uses|is built (?:with|on)|runs on|depends on|connects to|talks to|"
               r"integrates with|is powered by|calls)\s+([A-Z][\w.\-]*(?:\s[A-Z][\w.\-]*)?)")
        for m in re.finditer(pat, s):
            a, rel, b = m.group(1), re.sub(r"\s+", "_", m.group(2)), m.group(3)
            if canon(a) in _COMMON_CAPS or canon(b) in _COMMON_CAPS:
                continue
            ex.relations.append((a, rel, b))
            add_entity(a, "technology" if canon(a) in TECH else "thing", 0.6)
            add_entity(b, "technology" if canon(b) in TECH else "thing", 0.6)
            ex.facts.append(ExtractedFact(a, rel, b, s, min(conf, 0.75), False, "confirmed" if conf >= 0.8 else "assumed"))

    # ------------------------------------------------------------------ tasks / decisions / procedures
    def _tasks(self, s: str, ex: Extraction, now: float) -> None:
        if re.search(r"\bi want to (?:become|be)\b", s, re.I):
            return
        m = re.search(r"\b(?:remind me to|don'?t forget to|i (?:need|have|got|plan|intend) to|i(?:'m| am) going to|"
                      r"we (?:need|have|should) to|i (?:must|should|will)|i'll|todo:?|to-do:?|next step is(?: to)?|"
                      r"later,? i(?:'ll| will| want to)?|i want to|i'd like to|let'?s)\s+(.+)", s, re.I)
        if m and len(m.group(1).split()) >= 2:
            if re.match(r"(?i)^(?:use|go with|stick with|choose)\b", m.group(1)) and re.match(r"(?i)let'?s", m.group(0)):
                return  # "let's use X" is a decision, handled in _notes
            text = s.strip()
            conf = 0.7 if re.search(r"(?i)remind me|need to|have to|must|todo|don'?t forget", s) else 0.5
            ex.tasks.append(ExtractedTask(text, parse_due(s, now), conf))

    def _notes(self, s: str, ex: Extraction, conf: float, assistant: bool = False) -> None:
        if not assistant and re.search(r"(?i)\b(?:we|i)\s+(?:have |'ve )?(?:decided|agreed|chose|settled on)\b|\bi(?:'ll| will) go with\b|"
                                       r"\blet'?s (?:use|go with|stick with|choose)\b|\bwe(?:'ll| will| are going to) (?:use|go with)\b|"
                                       r"\bfinal(?:ly)? decision\b", s):
            ex.notes.append(ExtractedNote(s.strip(), "decision", 0.75))
        if re.search(r"(?i)\b(?:the fix was|fixed (?:it )?(?:by|with|using)|solved (?:it )?(?:by|with|using)|resolved (?:it )?by|"
                     r"the solution was|that worked|it worked after|workaround (?:was|is))\b", s):
            ex.notes.append(ExtractedNote(s.strip(), "recovery", 0.7 if not assistant else 0.5))
        elif not assistant and re.search(r"(?i)\b(?:didn'?t work|did not work|doesn'?t work|isn'?t working|is not working|failed|"
                                         r"keeps crashing|error:|traceback|exception)\b", s):
            ex.notes.append(ExtractedNote(s.strip(), "failure", 0.6))

    def _numbered_procedure(self, text: str, ex: Extraction, conf: float) -> None:
        steps = re.findall(r"(?m)^\s*(?:\d+[.)]|[-*•])\s+(.{4,200})$", text)
        numbered = re.findall(r"(?m)^\s*\d+[.)]\s+", text)
        if len(numbered) >= 3 and len(steps) >= 3:
            ex.notes.append(ExtractedNote("Steps: " + " → ".join(s.strip() for s in steps[:12]), "procedure", 0.6))

    # ------------------------------------------------------------------ entities
    def _entities(self, text: str, add, known: Optional[Dict[str, Tuple[str, str]]]) -> None:
        low = text.lower()
        for key, display in TECH.items():
            if re.search(r"(?<![\w])" + re.escape(key) + r"(?![\w])", low):
                add(display, "technology", 0.8)
        for m in re.finditer(r"(?<![\w])((?:[A-Z][A-Za-z0-9_+#\-]*)(?:\s+[A-Z][A-Za-z0-9_+#\-]*){0,3})", text):
            phrase = m.group(1)
            first_word = phrase.split()[0]
            at_start = m.start() == 0 or text[max(0, m.start() - 2):m.start()].strip() in ("", ".", "!", "?")
            words = phrase.split()
            while words and (words[0].lower() in _COMMON_CAPS or words[0].lower() in STOPWORDS):
                words = words[1:]
            if not words:
                continue
            phrase = " ".join(words)
            if len(words) == 1 and at_start and not phrase.isupper() and phrase.lower() not in TECH and \
                    not (known and canon(phrase) in known):
                continue
            if phrase.lower() in _COMMON_CAPS or len(phrase) < 2:
                continue
            kind = "technology" if phrase.lower() in TECH else "thing"
            add(TECH.get(phrase.lower(), phrase), kind, 0.55)
        for m in re.finditer(r"[\"“]([^\"”]{2,40})[\"”]", text):
            if len(m.group(1).split()) <= 4:
                add(m.group(1), "thing", 0.4)
        if known:
            toks = tokens(text)
            seen = set(toks)
            for a, b in zip(toks, toks[1:]):
                seen.add(f"{a} {b}")
            for cn, (_eid, kind) in known.items():
                if cn in seen or (len(cn) > 3 and f" {cn} " in f" {' '.join(toks)} "):
                    add(cn, kind, 0.7)

    # ------------------------------------------------------------------ importance
    def _importance(self, text: str, role: str, ex: Extraction) -> None:
        score = {"user": 0.35, "assistant": 0.2, "tool": 0.15, "system": 0.1}.get(role, 0.25)
        flags: List[str] = []
        if _REMEMBER.search(text):
            score += 0.35; flags.append(Flag.HIGHLY_IMPORTANT.value)
        if _IMPORTANT.search(text):
            score += 0.15
            flags.append(Flag.PROJECT_CRITICAL.value if (ex.projects or ex.tasks) else Flag.HIGHLY_IMPORTANT.value)
        if _URGENT.search(text) or any(t.due_at for t in ex.tasks):
            score += 0.15; flags.append(Flag.TIME_SENSITIVE.value)
        if _PERSONAL.search(text) or any(f.predicate in ("goal", "name") or f.predicate.startswith("favorite_") for f in ex.facts):
            score += 0.15; flags.append(Flag.PERSONALLY_MEANINGFUL.value)
        if _TEMPORARY.search(text):
            score -= 0.1; flags.append(Flag.TEMPORARY.value)
        score += min(0.2, 0.1 * len([f for f in ex.facts if not f.retract]) + 0.2 * len([n for n in ex.notes if n.kind == "decision"])
                     + 0.1 * len(ex.tasks))
        if len(tokens(text)) < 4:
            score -= 0.1
        ex.importance = clamp(score, 0.05, 1.0)
        ex.flags = list(dict.fromkeys(flags))
        ex.confidence = 0.8 if role == "user" else 0.5
