"""Immediate Task & Hardware Action Controller for Hand Gestures.

Translates real-time hand metrics into instant system automation:
- Fingers away from palm (Spread Expanding / Open Palm) -> Screen Brightness UP
- Fingers towards palm (Spread Contracting / Closed Fist) -> Screen Brightness DOWN
- Palm Clockwise Rotation -> Master Volume UP
- Palm Anti-Clockwise Rotation -> Master Volume DOWN
- Victory / Peace (✌️) -> Toggle Audio Mute
- Closed Fist (✊) -> Media Play / Pause
- Thumbs Up (👍) -> Next Track / Volume UP
- Thumbs Down (👎) -> Previous Track / Volume DOWN
"""

from __future__ import annotations

import collections
import ctypes
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    from controls.audio import AudioControl
    from controls.display import DisplayControl
except ImportError:
    from era_agent.controls.audio import AudioControl
    from era_agent.controls.display import DisplayControl

from .gesture_detector import HandData

logger = logging.getLogger("era.gestures.controller")

# Virtual key codes for Windows media simulation
VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_PLAY_PAUSE = 0xB3


def _send_virtual_key(vk_code: int) -> None:
    """Sends a hardware keypress and release event via Win32 keybd_event."""
    try:
        ctypes.windll.user32.keybd_event(vk_code, 0, 0, 0)
        time.sleep(0.02)
        ctypes.windll.user32.keybd_event(vk_code, 0, 0x0002, 0)
    except Exception as exc:
        logger.debug("Failed to send key %s: %s", vk_code, exc)


@dataclass
class ActionEvent:
    action: str  # e.g. "BRIGHTNESS_UP", "VOLUME_DOWN"
    details: str  # human-readable message
    value: Optional[int] = None
    timestamp: float = field(default_factory=time.time)


class GestureActionController:
    """Translates hand gestures into immediate, silky-smooth system control actions."""

    def __init__(
        self,
        brightness_step: int = 5,
        volume_step: int = 4,
        rotation_threshold_deg: float = 3.5,
        spread_threshold: float = 0.035,
        action_cooldown_sec: float = 0.12,
    ) -> None:
        self.brightness_step = brightness_step
        self.volume_step = volume_step
        self.rotation_threshold_deg = rotation_threshold_deg
        self.spread_threshold = spread_threshold
        self.action_cooldown_sec = action_cooldown_sec

        # Rate limiting and accumulators
        self._last_brightness_time: float = 0.0
        self._last_volume_time: float = 0.0
        self._last_discrete_time: float = 0.0
        self._last_rot_motion_time: float = 0.0

        self._rotation_accumulator: float = 0.0
        self._spread_history: collections.deque[Tuple[float, float]] = collections.deque(maxlen=10)

        # Hold trackers for discrete gestures
        self._gesture_start_times: Dict[str, float] = {}

        # Live history and callbacks
        self.recent_events: List[ActionEvent] = []
        self.on_action_callback: Optional[Callable[[ActionEvent], None]] = None

        # Cached hardware states
        self.current_brightness: int = 50
        self.current_volume: int = 50
        self.is_muted: bool = False
        self._refresh_hardware_state()

    def _refresh_hardware_state(self) -> None:
        """Refreshes cached brightness and volume levels."""
        try:
            _, b, _ = DisplayControl.get_brightness()
            self.current_brightness = b
        except Exception:
            pass

        try:
            _, v, _ = AudioControl.get_volume()
            self.current_volume = v
        except Exception:
            pass

    def _emit_event(self, action: str, details: str, value: Optional[int] = None) -> ActionEvent:
        event = ActionEvent(action=action, details=details, value=value, timestamp=time.time())
        self.recent_events.append(event)
        if len(self.recent_events) > 50:
            self.recent_events.pop(0)

        logger.info("GESTURE ACTION: %s | %s", action, details)
        if self.on_action_callback:
            try:
                self.on_action_callback(event)
            except Exception as e:
                logger.error("Error in action callback: %s", e)
        return event

    def process_hand(self, hand: HandData) -> Optional[ActionEvent]:
        """Analyzes hand metrics and triggers immediate hardware actions."""
        now = time.time()
        triggered_event: Optional[ActionEvent] = None

        # =====================================================================
        # 1. DISCRETE GESTURES (Victory, Thumbs Up/Down, Pointing Up)
        # =====================================================================
        gesture = hand.gesture_name
        score = hand.gesture_score

        if gesture and gesture not in ("None", "Open_Palm", "Closed_Fist") and score >= 0.55:
            if gesture not in self._gesture_start_times:
                self._gesture_start_times[gesture] = now

            hold_time = now - self._gesture_start_times[gesture]

            # Fast hold trigger (0.16s = ~2 frames at 10-15 FPS)
            if hold_time >= 0.16:
                if gesture == "Victory" and (now - self._last_discrete_time) >= 0.50:
                    ok, msg = AudioControl.toggle_mute()
                    self.is_muted = not self.is_muted
                    triggered_event = self._emit_event(
                        "TOGGLE_MUTE",
                        f"Victory (✌️) detected -> Audio {'muted' if self.is_muted else 'unmuted'}",
                    )
                    self._last_discrete_time = now
                    self._gesture_start_times.clear()
                    return triggered_event

                elif gesture == "Thumb_Up" and (now - self._last_discrete_time) >= 0.25:
                    ok, msg = AudioControl.adjust_volume(+self.volume_step)
                    new_vol = min(100, self.current_volume + self.volume_step)
                    self.current_volume = new_vol
                    _send_virtual_key(VK_MEDIA_NEXT_TRACK)
                    triggered_event = self._emit_event(
                        "VOLUME_UP",
                        f"Thumbs Up (👍) detected -> Volume {new_vol}%",
                        new_vol,
                    )
                    self._last_discrete_time = now
                    self._gesture_start_times.clear()
                    return triggered_event

                elif gesture == "Thumb_Down" and (now - self._last_discrete_time) >= 0.25:
                    ok, msg = AudioControl.adjust_volume(-self.volume_step)
                    new_vol = max(0, self.current_volume - self.volume_step)
                    self.current_volume = new_vol
                    _send_virtual_key(VK_MEDIA_PREV_TRACK)
                    triggered_event = self._emit_event(
                        "VOLUME_DOWN",
                        f"Thumbs Down (👎) detected -> Volume {new_vol}%",
                        new_vol,
                    )
                    self._last_discrete_time = now
                    self._gesture_start_times.clear()
                    return triggered_event

                elif gesture == "Pointing_Up" and (now - self._last_discrete_time) >= 0.20:
                    ok, msg = DisplayControl.adjust_brightness(+self.brightness_step)
                    new_b = min(100, self.current_brightness + self.brightness_step)
                    self.current_brightness = new_b
                    triggered_event = self._emit_event(
                        "BRIGHTNESS_UP",
                        f"Pointing Up (☝️) detected -> Brightness {new_b}%",
                        new_b,
                    )
                    self._last_discrete_time = now
                    self._gesture_start_times.clear()
                    return triggered_event
        else:
            self._gesture_start_times.clear()

        # =====================================================================
        # 2. PALM ROTATION / TILT -> VOLUME CONTROL (Clockwise = UP, Anti-CW = DOWN)
        # =====================================================================
        if abs(hand.angle_delta_deg) > 0.4:
            self._rotation_accumulator += hand.angle_delta_deg
            self._last_rot_motion_time = now

        # Active rotation motion or sustained side tilt
        is_tilting_cw = hand.palm_angle_deg < 68.0 and hand.angle_delta_deg <= 0.4
        is_tilting_ccw = hand.palm_angle_deg > 112.0 and hand.angle_delta_deg >= -0.4

        is_cw_active = (self._rotation_accumulator <= -self.rotation_threshold_deg) or is_tilting_cw
        is_ccw_active = (self._rotation_accumulator >= self.rotation_threshold_deg) or is_tilting_ccw
        is_rotating = is_cw_active or is_ccw_active or (abs(self._rotation_accumulator) >= 3.0)

        # Clockwise -> Volume UP
        if is_cw_active:
            if now - self._last_volume_time >= self.action_cooldown_sec:
                ok, msg = AudioControl.adjust_volume(+self.volume_step)
                new_vol = min(100, self.current_volume + self.volume_step)
                self.current_volume = new_vol
                self._last_volume_time = now
                triggered_event = self._emit_event(
                    "VOLUME_UP",
                    f"Palm Clockwise -> Volume increased to {new_vol}%",
                    new_vol,
                )
            if self._rotation_accumulator <= -self.rotation_threshold_deg:
                self._rotation_accumulator += self.rotation_threshold_deg
            return triggered_event

        # Anti-Clockwise -> Volume DOWN
        elif is_ccw_active:
            if now - self._last_volume_time >= self.action_cooldown_sec:
                ok, msg = AudioControl.adjust_volume(-self.volume_step)
                new_vol = max(0, self.current_volume - self.volume_step)
                self.current_volume = new_vol
                self._last_volume_time = now
                triggered_event = self._emit_event(
                    "VOLUME_DOWN",
                    f"Palm Anti-Clockwise -> Volume decreased to {new_vol}%",
                    new_vol,
                )
            if self._rotation_accumulator >= self.rotation_threshold_deg:
                self._rotation_accumulator -= self.rotation_threshold_deg
            return triggered_event

        elif (now - self._last_rot_motion_time) > 0.25:
            self._rotation_accumulator *= 0.80

        # =====================================================================
        # 3. FINGER SPREAD & OPEN/FIST -> BRIGHTNESS (Away = UP, Towards = DOWN)
        # =====================================================================
        has_prev = len(self._spread_history) >= 1
        history_delta = hand.finger_spread - self._spread_history[0][1] if has_prev else 0.0
        self._spread_history.append((now, hand.finger_spread))

        # Check explicit delta/motion
        is_expanding_motion = has_prev and ((hand.spread_delta >= self.spread_threshold) or (history_delta >= self.spread_threshold) or hand.is_expanding)
        is_contracting_motion = has_prev and ((hand.spread_delta <= -self.spread_threshold) or (history_delta <= -self.spread_threshold) or hand.is_contracting)

        # Open Palm vs Closed Fist classification
        is_open_palm = (hand.gesture_name == "Open_Palm" and score >= 0.50) or (hand.finger_spread >= 1.12)
        is_closed_fist = (hand.gesture_name == "Closed_Fist" and score >= 0.50) or (hand.finger_spread <= 0.90)

        # Track hold streaks
        if is_open_palm:
            self._open_streak = getattr(self, "_open_streak", 0) + 1
        else:
            self._open_streak = 0

        if is_closed_fist:
            self._fist_streak = getattr(self, "_fist_streak", 0) + 1
        else:
            self._fist_streak = 0

        # 3A. Contracting Motion or Closed Fist Hold -> Brightness DOWN
        if not is_rotating and (is_contracting_motion or (is_closed_fist and self._fist_streak >= 2)):
            if now - self._last_brightness_time >= 0.15:
                ok, msg = DisplayControl.adjust_brightness(-self.brightness_step)
                new_b = max(0, self.current_brightness - self.brightness_step)
                self.current_brightness = new_b
                self._last_brightness_time = now
                triggered_event = self._emit_event(
                    "BRIGHTNESS_DOWN",
                    f"Fingers moved towards palm (Closed Fist) -> Brightness decreased to {new_b}%",
                    new_b,
                )
                self._spread_history.clear()

        # 3B. Expanding Motion or Open Palm Hold -> Brightness UP
        elif not is_rotating and (is_expanding_motion or (is_open_palm and self._open_streak >= 2)):
            if now - self._last_brightness_time >= 0.15:
                ok, msg = DisplayControl.adjust_brightness(+self.brightness_step)
                new_b = min(100, self.current_brightness + self.brightness_step)
                self.current_brightness = new_b
                self._last_brightness_time = now
                triggered_event = self._emit_event(
                    "BRIGHTNESS_UP",
                    f"Fingers moved away from palm (Open Palm) -> Brightness increased to {new_b}%",
                    new_b,
                )
                self._spread_history.clear()

        return triggered_event
