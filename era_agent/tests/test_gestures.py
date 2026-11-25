"""Comprehensive Unit Tests for ERA Hand Gesture Recognition & Intelligence Engine."""

import math
import time
import numpy as np
import pytest

from gestures.gesture_detector import (
    HandGestureDetector,
    HandData,
    Point2D,
    LANDMARK_WRIST,
    LANDMARK_MIDDLE_MCP,
    FINGERTIP_INDICES,
)
from gestures.gesture_controller import GestureActionController, ActionEvent
from gestures.hud_renderer import HUDRenderer
from gestures.gesture_service import GestureService


def _create_mock_hand(
    wrist_xy=(0.5, 0.7),
    middle_mcp_xy=(0.5, 0.5),
    finger_spread=1.2,
    angle_deg=90.0,
    angle_delta_deg=0.0,
    spread_delta=0.0,
    gesture_name="None",
    gesture_score=0.0,
) -> HandData:
    """Helper to create synthetic HandData with known geometric properties."""
    lms = []
    for i in range(21):
        lms.append(Point2D(x=0.5, y=0.5, z=0.0, px=320, py=240))
    
    lms[LANDMARK_WRIST] = Point2D(x=wrist_xy[0], y=wrist_xy[1], px=int(wrist_xy[0]*640), py=int(wrist_xy[1]*480))
    lms[LANDMARK_MIDDLE_MCP] = Point2D(x=middle_mcp_xy[0], y=middle_mcp_xy[1], px=int(middle_mcp_xy[0]*640), py=int(middle_mcp_xy[1]*480))
    
    return HandData(
        handedness="Right",
        landmarks=lms,
        bbox=(200, 150, 440, 350),
        palm_center=(0.5, 0.6),
        palm_scale=0.2,
        finger_spread=finger_spread,
        spread_delta=spread_delta,
        is_expanding=(spread_delta > 0.03),
        is_contracting=(spread_delta < -0.03),
        palm_angle_deg=angle_deg,
        angle_delta_deg=angle_delta_deg,
        is_rotating_cw=(angle_delta_deg < -2.2),
        is_rotating_ccw=(angle_delta_deg > 2.2),
        gesture_name=gesture_name,
        gesture_score=gesture_score,
    )


class TestHandGestureDetector:
    def test_detector_initialization(self):
        detector = HandGestureDetector()
        assert detector._recognizer is not None, "MediaPipe recognizer should initialize"

    def test_angle_normalization(self):
        assert HandGestureDetector._normalize_angle_diff(10, 0) == 10
        assert HandGestureDetector._normalize_angle_diff(-10, 0) == -10
        diff = HandGestureDetector._normalize_angle_diff(-175, 175)
        assert abs(diff - 10.0) < 1e-3 or abs(diff + 350.0) < 1e-3

    def test_process_blank_frame(self):
        detector = HandGestureDetector()
        blank = np.zeros((480, 640, 3), dtype=np.uint8)
        result, processed_frame = detector.process_frame(blank)
        assert result is not None
        assert isinstance(result.hands, list)
        assert processed_frame.shape == (480, 640, 3)


class TestGestureActionController:
    def test_finger_spread_brightness_increase(self, monkeypatch):
        controller = GestureActionController(brightness_step=5, spread_threshold=0.04)
        
        adjusted = []
        def mock_adjust(delta):
            adjusted.append(delta)
            return True, f"Brightness adjusted by {delta}"

        monkeypatch.setattr("gestures.gesture_controller.DisplayControl.adjust_brightness", mock_adjust)
        
        # Frame 1: neutral
        hand1 = _create_mock_hand(finger_spread=1.0)
        controller.process_hand(hand1)
        
        # Frame 2: expanding outward
        hand2 = _create_mock_hand(finger_spread=1.06, spread_delta=0.06)
        hand2.is_expanding = True
        evt = controller.process_hand(hand2)
        
        assert evt is not None, "Should trigger BRIGHTNESS_UP event"
        assert evt.action == "BRIGHTNESS_UP"
        assert len(adjusted) >= 1
        assert adjusted[0] == 5

    def test_finger_spread_brightness_decrease(self, monkeypatch):
        controller = GestureActionController(brightness_step=5, spread_threshold=0.04)
        
        adjusted = []
        def mock_adjust(delta):
            adjusted.append(delta)
            return True, f"Brightness adjusted by {delta}"

        monkeypatch.setattr("gestures.gesture_controller.DisplayControl.adjust_brightness", mock_adjust)
        
        # Frame 1: open
        hand1 = _create_mock_hand(finger_spread=1.4)
        controller.process_hand(hand1)
        
        # Frame 2: contracting inward
        hand2 = _create_mock_hand(finger_spread=1.33, spread_delta=-0.07)
        hand2.is_contracting = True
        evt = controller.process_hand(hand2)
        
        assert evt is not None, "Should trigger BRIGHTNESS_DOWN event"
        assert evt.action == "BRIGHTNESS_DOWN"
        assert len(adjusted) >= 1
        assert adjusted[0] == -5

    def test_palm_clockwise_volume_increase(self, monkeypatch):
        controller = GestureActionController(volume_step=4, rotation_threshold_deg=10.0)
        
        adjusted = []
        def mock_adjust(delta):
            adjusted.append(delta)
            return True, f"Volume adjusted by {delta}"

        monkeypatch.setattr("gestures.gesture_controller.AudioControl.adjust_volume", mock_adjust)
        
        # Simulate consecutive clockwise rotation steps (-4 deg each)
        evt = None
        for _ in range(4):
            hand = _create_mock_hand(angle_delta_deg=-4.0)
            res = controller.process_hand(hand)
            if res:
                evt = res
                
        assert evt is not None, "Should trigger VOLUME_UP event for CW rotation"
        assert evt.action == "VOLUME_UP"
        assert len(adjusted) >= 1
        assert adjusted[0] == 4

    def test_palm_anticlockwise_volume_decrease(self, monkeypatch):
        controller = GestureActionController(volume_step=4, rotation_threshold_deg=10.0)
        
        adjusted = []
        def mock_adjust(delta):
            adjusted.append(delta)
            return True, f"Volume adjusted by {delta}"

        monkeypatch.setattr("gestures.gesture_controller.AudioControl.adjust_volume", mock_adjust)
        
        # Simulate consecutive anti-clockwise rotation steps (+4 deg each)
        evt = None
        for _ in range(4):
            hand = _create_mock_hand(angle_delta_deg=4.0)
            res = controller.process_hand(hand)
            if res:
                evt = res
                
        assert evt is not None, "Should trigger VOLUME_DOWN event for CCW rotation"
        assert evt.action == "VOLUME_DOWN"
        assert len(adjusted) >= 1
        assert adjusted[0] == -4

    def test_victory_gesture_mute_toggle(self, monkeypatch):
        controller = GestureActionController()
        
        toggled = []
        def mock_toggle(mute=None):
            toggled.append(True)
            return True, "Mute toggled"

        monkeypatch.setattr("gestures.gesture_controller.AudioControl.toggle_mute", mock_toggle)
        
        t_base = time.time()
        monkeypatch.setattr("gestures.gesture_controller.time.time", lambda: t_base)
        
        hand = _create_mock_hand(gesture_name="Victory", gesture_score=0.95)
        
        # Initial frame (starts hold timer)
        controller.process_hand(hand)
        
        # Advance time by 0.8 seconds
        monkeypatch.setattr("gestures.gesture_controller.time.time", lambda: t_base + 0.8)
        evt = controller.process_hand(hand)
        
        assert evt is not None, "Victory sign held should trigger TOGGLE_MUTE"
        assert evt.action == "TOGGLE_MUTE"
        assert len(toggled) >= 1

    def test_open_palm_gesture_brightness_increase(self, monkeypatch):
        controller = GestureActionController(brightness_step=5)
        adjusted = []
        monkeypatch.setattr("gestures.gesture_controller.DisplayControl.adjust_brightness", lambda d: (adjusted.append(d), (True, "ok"))[1])

        t_base = time.time()
        monkeypatch.setattr("gestures.gesture_controller.time.time", lambda: t_base)
        hand = _create_mock_hand(gesture_name="Open_Palm", gesture_score=0.90, finger_spread=1.25)

        # Frame 1: registers streak
        controller.process_hand(hand)
        # Frame 2: streaks >= 2 -> triggers BRIGHTNESS_UP
        evt = controller.process_hand(hand)

        assert evt is not None
        assert evt.action == "BRIGHTNESS_UP"
        assert len(adjusted) >= 1
        assert adjusted[0] == 5

    def test_closed_fist_gesture_brightness_decrease(self, monkeypatch):
        controller = GestureActionController(brightness_step=5)
        adjusted = []
        monkeypatch.setattr("gestures.gesture_controller.DisplayControl.adjust_brightness", lambda d: (adjusted.append(d), (True, "ok"))[1])

        t_base = time.time()
        monkeypatch.setattr("gestures.gesture_controller.time.time", lambda: t_base)
        hand = _create_mock_hand(gesture_name="Closed_Fist", gesture_score=0.90, finger_spread=0.75)

        controller.process_hand(hand)
        evt = controller.process_hand(hand)

        assert evt is not None
        assert evt.action == "BRIGHTNESS_DOWN"
        assert len(adjusted) >= 1
        assert adjusted[0] == -5

    def test_palm_tilt_clockwise_volume_up(self, monkeypatch):
        controller = GestureActionController(volume_step=4)
        adjusted = []
        monkeypatch.setattr("gestures.gesture_controller.AudioControl.adjust_volume", lambda d: (adjusted.append(d), (True, "ok"))[1])

        # Hand tilted right: angle_deg = 55.0 (< 68.0)
        hand = _create_mock_hand(angle_deg=55.0, angle_delta_deg=0.0)
        evt = controller.process_hand(hand)

        assert evt is not None
        assert evt.action == "VOLUME_UP"
        assert len(adjusted) >= 1
        assert adjusted[0] == 4

    def test_palm_tilt_anticlockwise_volume_down(self, monkeypatch):
        controller = GestureActionController(volume_step=4)
        adjusted = []
        monkeypatch.setattr("gestures.gesture_controller.AudioControl.adjust_volume", lambda d: (adjusted.append(d), (True, "ok"))[1])

        # Hand tilted left: angle_deg = 125.0 (> 112.0)
        hand = _create_mock_hand(angle_deg=125.0, angle_delta_deg=0.0)
        evt = controller.process_hand(hand)

        assert evt is not None
        assert evt.action == "VOLUME_DOWN"
        assert len(adjusted) >= 1
        assert adjusted[0] == -4

    def test_thumbs_up_gesture_volume_increase(self, monkeypatch):
        controller = GestureActionController(volume_step=4)
        adjusted = []
        monkeypatch.setattr("gestures.gesture_controller.AudioControl.adjust_volume", lambda d: (adjusted.append(d), (True, "ok"))[1])

        t_base = time.time()
        monkeypatch.setattr("gestures.gesture_controller.time.time", lambda: t_base)
        hand = _create_mock_hand(gesture_name="Thumb_Up", gesture_score=0.90)

        controller.process_hand(hand)
        monkeypatch.setattr("gestures.gesture_controller.time.time", lambda: t_base + 0.3)
        evt = controller.process_hand(hand)

        assert evt is not None
        assert evt.action == "VOLUME_UP"
        assert len(adjusted) >= 1
        assert adjusted[0] == 4

    def test_pointing_up_brightness_increase(self, monkeypatch):
        controller = GestureActionController(brightness_step=5)
        adjusted = []
        monkeypatch.setattr("gestures.gesture_controller.DisplayControl.adjust_brightness", lambda d: (adjusted.append(d), (True, "ok"))[1])

        t_base = time.time()
        monkeypatch.setattr("gestures.gesture_controller.time.time", lambda: t_base)
        hand = _create_mock_hand(gesture_name="Pointing_Up", gesture_score=0.90)

        controller.process_hand(hand)
        monkeypatch.setattr("gestures.gesture_controller.time.time", lambda: t_base + 0.3)
        evt = controller.process_hand(hand)

        assert evt is not None
        assert evt.action == "BRIGHTNESS_UP"
        assert len(adjusted) >= 1
        assert adjusted[0] == 5


class TestHUDRenderer:
    def test_hud_rendering(self):
        renderer = HUDRenderer()
        dummy_frame = np.zeros((480, 640, 3), dtype=np.uint8)
        
        from gestures.gesture_detector import DetectionResult
        hand = _create_mock_hand(gesture_name="Open_Palm", gesture_score=0.90)
        det = DetectionResult(hands=[hand], processed_time_ms=12.5)
        
        rendered = renderer.render(
            frame=dummy_frame,
            detection=det,
            current_brightness=65,
            current_volume=45,
            fps=32.0,
        )
        assert rendered is not None
        assert rendered.shape == (480, 640, 3)
        assert np.sum(rendered) > 0


class TestGestureService:
    def test_service_lifecycle(self):
        service = GestureService.get_instance()
        assert not service.is_running()
        
        status = service.get_status()
        assert "fps" in status
        assert "current_brightness" in status
        assert "current_volume" in status
