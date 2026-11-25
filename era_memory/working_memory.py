"""Working memory: short-lived, per-session, in-RAM only. Never written to the permanent store."""
from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional


@dataclass
class WorkingState:
    session_id: str
    turns: Deque[Dict[str, str]] = field(default_factory=lambda: deque(maxlen=20))
    active_entities: "OrderedDict[str, float]" = field(default_factory=OrderedDict)   # name -> last touched
    active_project: Optional[str] = None
    current_task: Optional[str] = None
    active_mission: Optional[str] = None
    current_intent: Optional[str] = None
    recent_memory_ids: Deque[str] = field(default_factory=lambda: deque(maxlen=30))
    touched: float = field(default_factory=time.time)


class WorkingMemory:
    def __init__(self, max_sessions: int = 32, entity_ttl_s: float = 3600.0, max_entities: int = 12):
        self._s: "OrderedDict[str, WorkingState]" = OrderedDict()
        self._lock = threading.RLock()
        self.max_sessions, self.entity_ttl_s, self.max_entities = max_sessions, entity_ttl_s, max_entities

    def _get(self, session_id: str) -> WorkingState:
        with self._lock:
            st = self._s.get(session_id)
            if st is None:
                st = WorkingState(session_id)
                self._s[session_id] = st
                while len(self._s) > self.max_sessions:
                    self._s.popitem(last=False)
            self._s.move_to_end(session_id)
            st.touched = time.time()
            return st

    def observe_turn(self, session_id: str, role: str, text: str, entities: List[str], project: Optional[str] = None,
                     intent: Optional[str] = None) -> None:
        with self._lock:
            st = self._get(session_id)
            st.turns.append({"role": role, "text": text[:500]})
            now = time.time()
            for e in entities:
                st.active_entities.pop(e, None)
                st.active_entities[e] = now
            while len(st.active_entities) > self.max_entities:
                st.active_entities.popitem(last=False)
            if project:
                st.active_project = project
            if intent:
                st.current_intent = intent

    def note_retrieved(self, session_id: str, ids: List[str]) -> None:
        with self._lock:
            self._get(session_id).recent_memory_ids.extend(ids)

    def set_task(self, session_id: str, task: Optional[str]) -> None:
        with self._lock:
            self._get(session_id).current_task = task

    def set_mission(self, session_id: str, mission: Optional[str]) -> None:
        with self._lock:
            self._get(session_id).active_mission = mission

    def set_project(self, session_id: str, project: Optional[str]) -> None:
        with self._lock:
            self._get(session_id).active_project = project

    def snapshot(self, session_id: Optional[str]) -> Dict[str, Any]:
        if not session_id:
            return {}
        with self._lock:
            st = self._s.get(session_id)
            if st is None:
                return {}
            now = time.time()
            ents = [e for e, t in reversed(st.active_entities.items()) if now - t <= self.entity_ttl_s]
            return {"session_id": session_id, "active_entities": ents, "active_project": st.active_project,
                    "current_task": st.current_task, "active_mission": st.active_mission,
                    "current_intent": st.current_intent, "recent_memory_ids": list(st.recent_memory_ids),
                    "recent_turns": list(st.turns)[-6:]}

    def clear(self, session_id: Optional[str] = None) -> None:
        with self._lock:
            if session_id is None:
                self._s.clear()
            else:
                self._s.pop(session_id, None)
