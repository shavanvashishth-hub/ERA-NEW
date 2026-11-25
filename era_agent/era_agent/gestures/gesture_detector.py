"""MediaPipe Hand Gesture & Landmark Detector for ERA Agent.

Detects hands in camera video frames, computes 21 3D landmarks,
extracts finger-to-palm spread distance, computes palm rotation angle (CW/CCW),
and identifies discrete hand gestures.
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger("era.gestures.detector")

# Landmark indices
LANDMARK_WRIST = 0
LANDMARK_THUMB_CMC = 1
LANDMARK_THUMB_MCP = 2
LANDMARK_THUMB_IP = 3
LANDMARK_THUMB_TIP = 4
LANDMARK_INDEX_MCP = 5
LANDMARK_INDEX_PIP = 6
LANDMARK_INDEX_DIP = 7
LANDMARK_INDEX_TIP = 8
LANDMARK_MIDDLE_MCP = 9
LANDMARK_MIDDLE_PIP = 10
LANDMARK_MIDDLE_DIP = 11
LANDMARK_MIDDLE_TIP = 12
LANDMARK_RING_MCP = 13
LANDMARK_RING_PIP = 14
LANDMARK_RING_DIP = 15
LANDMARK_RING_TIP = 16
LANDMARK_PINKY_MCP = 17
LANDMARK_PINKY_PIP = 18
LANDMARK_PINKY_DIP = 19
LANDMARK_PINKY_TIP = 20

FINGERTIP_INDICES = [
    LANDMARK_THUMB_TIP,
    LANDMARK_INDEX_TIP,
    LANDMARK_MIDDLE_TIP,
    LANDMARK_RING_TIP,
    LANDMARK_PINKY_TIP,
]

HAND_CONNECTIONS = [
    # Thumb
    (0, 1), (1, 2), (2, 3), (3, 4),
    # Index
    (0, 5), (5, 6), (6, 7), (7, 8),
    # Middle
    (0, 9), (9, 10), (10, 11), (11, 12),
    # Ring
    (0, 13), (13, 14), (14, 15), (15, 16),
    # Pinky
    (0, 17), (17, 18), (18, 19), (19, 20),
    # Palm base connection
    (5, 9), (9, 13), (13, 17)
]


@dataclass
class Point2D:
    x: float
    y: float
    z: float = 0.0
    px: int = 0
    py: int = 0


@dataclass
class HandData:
    handedness: str  # "Right" or "Left"
    landmarks: List[Point2D]  # 21 points
    bbox: Tuple[int, int, int, int]  # (x_min, y_min, x_max, y_max) in pixel coords
    
    # Palm metrics
    palm_center: Tuple[float, float]  # normalized (cx, cy)
    palm_scale: float  # distance between wrist and middle MCP
    
    # Finger Spread Metric (Distance of fingertips from palm center)
    finger_spread: float  # normalized distance ratio (higher = fingers farther away from palm)
    spread_delta: float  # change in spread from last frame
    is_expanding: bool  # fingers moving away from palm
    is_contracting: bool  # fingers moving closer to palm
    
    # Palm Rotation Metric
    palm_angle_deg: float  # angle in degrees (-180 to 180)
    angle_delta_deg: float  # frame-to-frame angle delta (negative = CW, positive = CCW)
    is_rotating_cw: bool  # Clockwise rotation active
    is_rotating_ccw: bool  # Anti-Clockwise rotation active
    
    # Discrete Gesture
    gesture_name: str  # "Open_Palm", "Closed_Fist", "Pointing_Up", "Thumb_Up", "Thumb_Down", "Victory", "None"
    gesture_score: float  # confidence [0.0, 1.0]


@dataclass
class DetectionResult:
    hands: List[HandData] = field(default_factory=list)
    annotated_frame: Optional[np.ndarray] = None
    processed_time_ms: float = 0.0


class HandGestureDetector:
    """Real-time hand tracker and gesture analyzer powered by Google MediaPipe."""

    def __init__(
        self,
        model_path: Optional[str] = None,
        num_hands: int = 2,
        min_detection_confidence: float = 0.35,
        min_tracking_confidence: float = 0.35,
    ) -> None:
        self.num_hands = num_hands
        self.min_detection_confidence = min_detection_confidence
        self.min_tracking_confidence = min_tracking_confidence

        if not model_path:
            default_path = Path("d:/era_agent/models/gesture_recognizer.task")
            if default_path.exists():
                model_path = str(default_path)
            else:
                model_path = str(Path(__file__).parent.parent / "models" / "gesture_recognizer.task")

        self.model_path = model_path
        self._recognizer = None
        self._init_mediapipe()

        # Smoothing and state tracking per hand
        self._prev_spread: Dict[str, float] = {}
        self._smoothed_spread: Dict[str, float] = {}
        self._prev_angle: Dict[str, float] = {}
        self._smoothed_angle: Dict[str, float] = {}

    def _init_mediapipe(self) -> None:
        """Initializes the MediaPipe GestureRecognizer."""
        try:
            import mediapipe as mp
            from mediapipe.tasks import python
            from mediapipe.tasks.python import vision

            base_options = python.BaseOptions(model_asset_path=self.model_path)
            options = vision.GestureRecognizerOptions(
                base_options=base_options,
                num_hands=self.num_hands,
                min_hand_detection_confidence=self.min_detection_confidence,
                min_tracking_confidence=self.min_tracking_confidence,
            )
            self._recognizer = vision.GestureRecognizer.create_from_options(options)
            logger.info("MediaPipe GestureRecognizer initialized with model: %s", self.model_path)
        except Exception as exc:
            logger.error("Failed to initialize MediaPipe GestureRecognizer: %s", exc)
            self._recognizer = None

    @staticmethod
    def _normalize_angle_diff(curr_deg: float, prev_deg: float) -> float:
        """Computes shortest angular difference in degrees [-180, 180]."""
        diff = curr_deg - prev_deg
        while diff > 180.0:
            diff -= 360.0
        while diff < -180.0:
            diff += 360.0
        return diff

    def process_frame(self, frame_bgr: np.ndarray, mirror: bool = True) -> Tuple[DetectionResult, np.ndarray]:
        """Processes a video frame and returns detected hands and the mirrored frame."""
        import time
        start_t = time.perf_counter()

        # Mirror frame horizontally so camera acts like a natural mirror
        if mirror:
            frame = cv2.flip(frame_bgr, 1)
        else:
            frame = frame_bgr.copy()

        h, w, _ = frame.shape
        result = DetectionResult()

        if self._recognizer is None:
            return result, frame

        try:
            import mediapipe as mp
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            rgb = np.ascontiguousarray(rgb)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            mp_res = self._recognizer.recognize(mp_image)

            if mp_res and mp_res.hand_landmarks:
                for idx, lms in enumerate(mp_res.hand_landmarks):
                    # Handedness
                    handedness_label = "Hand"
                    if idx < len(mp_res.handedness) and mp_res.handedness[idx]:
                        handedness_label = mp_res.handedness[idx][0].category_name

                    # Discrete gesture
                    gesture_name = "None"
                    gesture_score = 0.0
                    if idx < len(mp_res.gestures) and mp_res.gestures[idx]:
                        top_gesture = mp_res.gestures[idx][0]
                        gesture_name = top_gesture.category_name
                        gesture_score = float(top_gesture.score)

                    # Convert landmarks
                    pts: List[Point2D] = []
                    xs, ys = [], []
                    for lm in lms:
                        px = int(np.clip(lm.x * w, 0, w - 1))
                        py = int(np.clip(lm.y * h, 0, h - 1))
                        pts.append(Point2D(x=lm.x, y=lm.y, z=lm.z, px=px, py=py))
                        xs.append(px)
                        ys.append(py)

                    bbox = (max(0, min(xs) - 15), max(0, min(ys) - 15), min(w - 1, max(xs) + 15), min(h - 1, max(ys) + 15))

                    wrist = pts[LANDMARK_WRIST]
                    middle_mcp = pts[LANDMARK_MIDDLE_MCP]

                    # Palm scale (reference length between wrist and middle MCP)
                    scale = math.hypot(middle_mcp.x - wrist.x, middle_mcp.y - wrist.y)
                    scale = max(1e-4, scale)

                    # Palm center
                    cx = (wrist.x + middle_mcp.x) / 2.0
                    cy = (wrist.y + middle_mcp.y) / 2.0

                    # 1. Finger Spread / Distance from Palm
                    tip_dists = [
                        math.hypot(pts[tip_idx].x - cx, pts[tip_idx].y - cy) / scale
                        for tip_idx in FINGERTIP_INDICES
                    ]
                    raw_spread = float(sum(tip_dists) / len(tip_dists))

                    # Exponential Moving Average for spread
                    hand_key = f"{handedness_label}_{idx}"
                    prev_s = self._smoothed_spread.get(hand_key, raw_spread)
                    smooth_spread = 0.60 * raw_spread + 0.40 * prev_s
                    self._smoothed_spread[hand_key] = smooth_spread

                    spread_delta = smooth_spread - self._prev_spread.get(hand_key, smooth_spread)
                    self._prev_spread[hand_key] = smooth_spread

                    # Velocity thresholds for fingers moving away/towards palm (responsive & immediate)
                    is_expanding = (spread_delta > 0.012) or (raw_spread >= 1.15) or (gesture_name == "Open_Palm")
                    is_contracting = (spread_delta < -0.012) or (raw_spread <= 0.90) or (gesture_name == "Closed_Fist")

                    # 2. Palm Rotation (Angle in visual frame where up is +Y)
                    # Vector from wrist to middle MCP
                    dx = middle_mcp.x - wrist.x
                    dy = -(middle_mcp.y - wrist.y)  # invert image Y
                    angle_deg = math.degrees(math.atan2(dy, dx))

                    # Exponential Moving Average for angle smoothing (eliminates jitter)
                    prev_smooth_a = self._smoothed_angle.get(hand_key, angle_deg)
                    smooth_angle = 0.65 * angle_deg + 0.35 * prev_smooth_a
                    self._smoothed_angle[hand_key] = smooth_angle

                    prev_a = self._prev_angle.get(hand_key, smooth_angle)
                    angle_delta = self._normalize_angle_diff(smooth_angle, prev_a)

                    # Filter out sudden crazy jumps (e.g. tracking loss)
                    if abs(angle_delta) > 50.0:
                        angle_delta = 0.0
                    else:
                        self._prev_angle[hand_key] = smooth_angle

                    # In mirrored visual space:
                    # Tilting to right / rotating clockwise decreases visual angle: angle_delta < 0
                    # Tilting to left / rotating anti-clockwise increases visual angle: angle_delta > 0
                    is_rotating_cw = (angle_delta < -1.0) or (smooth_angle < 68.0 and angle_delta <= 0.3)
                    is_rotating_ccw = (angle_delta > 1.0) or (smooth_angle > 112.0 and angle_delta >= -0.3)

                    hand_data = HandData(
                        handedness=handedness_label,
                        landmarks=pts,
                        bbox=bbox,
                        palm_center=(cx, cy),
                        palm_scale=scale,
                        finger_spread=smooth_spread,
                        spread_delta=spread_delta,
                        is_expanding=is_expanding,
                        is_contracting=is_contracting,
                        palm_angle_deg=smooth_angle,
                        angle_delta_deg=angle_delta,
                        is_rotating_cw=is_rotating_cw,
                        is_rotating_ccw=is_rotating_ccw,
                        gesture_name=gesture_name,
                        gesture_score=gesture_score,
                    )
                    result.hands.append(hand_data)

        except Exception as exc:
            logger.warning("Error running hand detection: %s", exc)

        result.processed_time_ms = (time.perf_counter() - start_t) * 1000.0
        return result, frame
