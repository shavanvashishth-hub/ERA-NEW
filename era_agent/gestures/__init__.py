"""ERA Hand Gesture Intelligence Package.

Provides real-time camera-based hand tracking, finger-to-palm spread detection,
palm rotation monitoring, and instant hardware action execution.
"""

from .gesture_controller import ActionEvent, GestureActionController
from .gesture_detector import HandData, HandGestureDetector
from .gesture_service import GestureService
from .hud_renderer import HUDRenderer

__all__ = [
    "GestureService",
    "HandGestureDetector",
    "GestureActionController",
    "HUDRenderer",
    "HandData",
    "ActionEvent",
]
