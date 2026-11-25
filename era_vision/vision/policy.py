"""Decides WHEN to call the (expensive) vision provider.

Rules, in order:
  1. Hourly budget guard: rejects if hourly limit exceeded.
  2. Cooldown guard: enforces minimum interval between calls.
  3. Window/App change: triggers immediate analysis when budget & cooldown allow.
  4. Volatility suppression: suppresses rapid volatile noise.
  5. Pixel change: triggers analysis when significant visual change is detected.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass


@dataclass
class PolicyDecision:
    should_analyze: bool
    reason: str


class AnalysisPolicy:
    def __init__(self, max_calls_per_hour: int = 3600, min_seconds_between_analysis: float = 1.0) -> None:
        self.max_calls_per_hour = max_calls_per_hour
        self.min_seconds_between_analysis = min_seconds_between_analysis
        self._call_timestamps: deque[float] = deque()
        self._last_analysis_at: float | None = None

    def _calls_in_last_hour(self, now: float) -> int:
        cutoff = now - 3600.0
        while self._call_timestamps and self._call_timestamps[0] < cutoff:
            self._call_timestamps.popleft()
        return len(self._call_timestamps)

    def calls_this_hour(self, now: float | None = None) -> int:
        return self._calls_in_last_hour(now if now is not None else time.time())

    def decide(
        self,
        *,
        window_changed: bool,
        pixel_changed: bool,
        is_volatile: bool,
        now: float | None = None,
    ) -> PolicyDecision:
        now = now if now is not None else time.time()

        # Guard 1: Hourly budget check
        if self._calls_in_last_hour(now) >= self.max_calls_per_hour:
            return PolicyDecision(False, "hourly_budget_exhausted")

        # Guard 2: Minimum cooldown between analyses
        if self._last_analysis_at is not None and (now - self._last_analysis_at) < self.min_seconds_between_analysis:
            return PolicyDecision(False, "cooldown_active")

        # Trigger 1: Active window switch
        if window_changed:
            return PolicyDecision(True, "window_changed")

        # Guard 3: Volatile change suppression
        if is_volatile:
            return PolicyDecision(False, "volatile_backoff")

        # Trigger 2: Pixel change detected
        if pixel_changed:
            return PolicyDecision(True, "pixel_change")

        return PolicyDecision(False, "no_change")

    def record_call(self, now: float | None = None) -> None:
        now = now if now is not None else time.time()
        self._call_timestamps.append(now)
        self._last_analysis_at = now
