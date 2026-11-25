"""Glassmorphic Cyberpunk HUD & Gesture Overlay for ERA Agent.

Draws hand skeletal landmarks, real-time volume dials, brightness gauges,
active gesture indicators, and triggered action pulses onto video frames.
"""

from __future__ import annotations

import math
import time
from typing import List, Optional, Tuple

import cv2
import numpy as np

from .gesture_controller import ActionEvent
from .gesture_detector import HAND_CONNECTIONS, DetectionResult, HandData

# Color palette (BGR)
COLOR_CYAN = (255, 230, 0)
COLOR_GOLD = (50, 190, 245)
COLOR_EMERALD = (80, 220, 100)
COLOR_ROSE = (100, 100, 245)
COLOR_WHITE = (245, 245, 245)
COLOR_DARK_BG = (20, 20, 24)
COLOR_ACCENT = (235, 160, 50)


class HUDRenderer:
    """Renders high-tech visual overlay and telemetry gauges onto video frames."""

    def __init__(self) -> None:
        self._last_action_event: Optional[ActionEvent] = None
        self._action_display_until: float = 0.0

    def register_action(self, event: ActionEvent) -> None:
        self._last_action_event = event
        self._action_display_until = time.time() + 2.0

    def render(
        self,
        frame: np.ndarray,
        detection: DetectionResult,
        current_brightness: int,
        current_volume: int,
        fps: float,
    ) -> np.ndarray:
        h, w, _ = frame.shape
        out = frame.copy()

        # 1. Draw Hand Landmarks & Skeletons
        for hand in detection.hands:
            self._draw_hand_skeleton(out, hand)
            self._draw_hand_telemetry(out, hand)

        # 2. Draw Top Bar (Branding & FPS)
        self._draw_top_bar(out, fps, len(detection.hands))

        # 3. Draw Side Gauges (Brightness & Volume HUD)
        self._draw_hardware_gauges(out, current_brightness, current_volume, detection.hands)

        # 4. Draw Action Toast Banner if recently triggered
        if self._last_action_event and time.time() < self._action_display_until:
            self._draw_action_toast(out, self._last_action_event)

        return out

    def _draw_hand_skeleton(self, frame: np.ndarray, hand: HandData) -> None:
        # Draw skeleton connections
        for start_idx, end_idx in HAND_CONNECTIONS:
            p1 = hand.landmarks[start_idx]
            p2 = hand.landmarks[end_idx]
            cv2.line(frame, (p1.px, p1.py), (p2.px, p2.py), COLOR_CYAN, 2, cv2.LINE_AA)

        # Draw joints
        for i, pt in enumerate(hand.landmarks):
            # Fingertips larger and gold
            if i in (4, 8, 12, 16, 20):
                cv2.circle(frame, (pt.px, pt.py), 6, COLOR_GOLD, -1, cv2.LINE_AA)
                cv2.circle(frame, (pt.px, pt.py), 8, COLOR_WHITE, 1, cv2.LINE_AA)
            elif i == 0:  # Wrist
                cv2.circle(frame, (pt.px, pt.py), 7, COLOR_EMERALD, -1, cv2.LINE_AA)
            else:
                cv2.circle(frame, (pt.px, pt.py), 3, (200, 200, 200), -1, cv2.LINE_AA)

    def _draw_hand_telemetry(self, frame: np.ndarray, hand: HandData) -> None:
        x1, y1, x2, y2 = hand.bbox

        # Bounding box corners
        corner_len = 16
        color = COLOR_GOLD if hand.gesture_name != "None" else COLOR_CYAN
        # Top-left
        cv2.line(frame, (x1, y1), (x1 + corner_len, y1), color, 2)
        cv2.line(frame, (x1, y1), (x1, y1 + corner_len), color, 2)
        # Top-right
        cv2.line(frame, (x2, y1), (x2 - corner_len, y1), color, 2)
        cv2.line(frame, (x2, y1), (x2, y1 + corner_len), color, 2)
        # Bottom-left
        cv2.line(frame, (x1, y2), (x1 + corner_len, y2), color, 2)
        cv2.line(frame, (x1, y2), (x1, y2 - corner_len), color, 2)
        # Bottom-right
        cv2.line(frame, (x2, y2), (x2 - corner_len, y2), color, 2)
        cv2.line(frame, (x2, y2), (x2, y2 - corner_len), color, 2)

        # Hand Badge Label
        label = f"{hand.handedness}"
        if hand.gesture_name and hand.gesture_name != "None":
            label += f" | {hand.gesture_name} ({int(hand.gesture_score * 100)}%)"

        bg_w = max(130, len(label) * 9 + 14)
        cv2.rectangle(frame, (x1, max(0, y1 - 24)), (x1 + bg_w, max(20, y1)), (15, 15, 18), -1)
        cv2.putText(frame, label, (x1 + 6, max(14, y1 - 7)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, COLOR_WHITE, 1, cv2.LINE_AA)

        # Dynamic indicators below hand
        status_items = []
        if hand.is_rotating_cw:
            status_items.append("ROTATING CW [VOL +]")
        elif hand.is_rotating_ccw:
            status_items.append("ROTATING CCW [VOL -]")

        if hand.is_expanding:
            status_items.append("FINGERS OUT [BRIGHT +]")
        elif hand.is_contracting:
            status_items.append("FINGERS IN [BRIGHT -]")

        if status_items:
            subtext = " | ".join(status_items)
            cv2.putText(frame, subtext, (x1, min(frame.shape[0] - 10, y2 + 18)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, COLOR_EMERALD, 1, cv2.LINE_AA)

    def _draw_top_bar(self, frame: np.ndarray, fps: float, hand_count: int) -> None:
        w = frame.shape[1]
        # Dark top ribbon
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, 38), (10, 12, 16), -1)
        cv2.addWeighted(overlay, 0.75, frame, 0.25, 0, frame)

        # Header Title
        cv2.putText(frame, "ERA INTELLIGENCE", (14, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, COLOR_GOLD, 2, cv2.LINE_AA)
        cv2.putText(frame, "HAND GESTURE CORE", (178, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.50, COLOR_WHITE, 1, cv2.LINE_AA)

        # Status pills on right
        status_text = f"HANDS: {hand_count}  |  FPS: {int(fps)}"
        cv2.putText(frame, status_text, (w - 180, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.44, (190, 190, 195), 1, cv2.LINE_AA)

    def _draw_hardware_gauges(
        self,
        frame: np.ndarray,
        brightness: int,
        volume: int,
        hands: List[HandData],
    ) -> None:
        h, w, _ = frame.shape

        # ==========================================
        # LEFT HUD: BRIGHTNESS GAUGE (0-100%)
        # ==========================================
        bx, by, bw, bh = 18, 55, 30, 160
        # Glass backdrop
        overlay = frame.copy()
        cv2.rectangle(overlay, (bx - 8, by - 10), (bx + bw + 65, by + bh + 30), (12, 14, 18), -1)
        cv2.addWeighted(overlay, 0.70, frame, 0.30, 0, frame)

        # Border
        cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), (60, 65, 75), 1)

        # Brightness filled bar
        fill_h = int((brightness / 100.0) * bh)
        cv2.rectangle(frame, (bx + 2, by + bh - fill_h), (bx + bw - 2, by + bh - 2), COLOR_GOLD, -1)

        # Text labels
        cv2.putText(frame, "DISP", (bx - 2, by - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (180, 180, 180), 1, cv2.LINE_AA)
        cv2.putText(frame, f"{brightness}%", (bx + bw + 8, by + bh - fill_h + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.44, COLOR_GOLD, 1, cv2.LINE_AA)

        # Motion Arrow indicator if fingers expanding or contracting
        if any(h.is_expanding for h in hands):
            cv2.putText(frame, "UP ^", (bx + bw + 8, by + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.45, COLOR_EMERALD, 1, cv2.LINE_AA)
        elif any(h.is_contracting for h in hands):
            cv2.putText(frame, "DN v", (bx + bw + 8, by + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.45, COLOR_ROSE, 1, cv2.LINE_AA)

        # ==========================================
        # RIGHT HUD: VOLUME GAUGE (0-100%)
        # ==========================================
        vx, vy, vw, vh = w - 85, 55, 30, 160
        # Glass backdrop
        overlay = frame.copy()
        cv2.rectangle(overlay, (vx - 45, vy - 10), (vx + vw + 10, vy + vh + 30), (12, 14, 18), -1)
        cv2.addWeighted(overlay, 0.70, frame, 0.30, 0, frame)

        # Border
        cv2.rectangle(frame, (vx, vy), (vx + vw, vy + vh), (60, 65, 75), 1)

        # Volume filled bar
        v_fill_h = int((volume / 100.0) * vh)
        cv2.rectangle(frame, (vx + 2, vy + vh - v_fill_h), (vx + vw - 2, vy + vh - 2), COLOR_CYAN, -1)

        # Text labels
        cv2.putText(frame, "VOL", (vx + 2, vy - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (180, 180, 180), 1, cv2.LINE_AA)
        cv2.putText(frame, f"{volume}%", (vx - 42, vy + vh - v_fill_h + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.44, COLOR_CYAN, 1, cv2.LINE_AA)

        # Rotation indicator
        if any(h.is_rotating_cw for h in hands):
            cv2.putText(frame, "CW >>", (vx - 42, vy + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.40, COLOR_EMERALD, 1, cv2.LINE_AA)
        elif any(h.is_rotating_ccw for h in hands):
            cv2.putText(frame, "<< CCW", (vx - 42, vy + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.40, COLOR_ROSE, 1, cv2.LINE_AA)

    def _draw_action_toast(self, frame: np.ndarray, event: ActionEvent) -> None:
        h, w, _ = frame.shape
        toast_w, toast_h = min(560, w - 40), 44
        tx = (w - toast_w) // 2
        ty = h - toast_h - 18

        # Glass panel
        overlay = frame.copy()
        cv2.rectangle(overlay, (tx, ty), (tx + toast_w, ty + toast_h), (18, 22, 28), -1)
        cv2.addWeighted(overlay, 0.85, frame, 0.15, 0, frame)

        # Emerald accent left bar
        cv2.rectangle(frame, (tx, ty), (tx + 5, ty + toast_h), COLOR_EMERALD, -1)
        cv2.rectangle(frame, (tx, ty), (tx + toast_w, ty + toast_h), (50, 60, 75), 1)

        # Action tag
        cv2.putText(frame, f"ACTION: {event.action}", (tx + 16, ty + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.48, COLOR_EMERALD, 1, cv2.LINE_AA)
        # Action details
        cv2.putText(frame, event.details, (tx + 16, ty + 35), cv2.FONT_HERSHEY_SIMPLEX, 0.40, COLOR_WHITE, 1, cv2.LINE_AA)
