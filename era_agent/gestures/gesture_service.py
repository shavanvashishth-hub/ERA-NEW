"""Background Camera & Hand Gesture Service for ERA Agent.

Manages video capture, real-time gesture detection, instant hardware execution,
and live video streaming / preview.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, Generator, Optional

import cv2
import numpy as np

from .gesture_controller import GestureActionController
from .gesture_detector import HandGestureDetector
from .hud_renderer import HUDRenderer

logger = logging.getLogger("era.gestures.service")


class GestureService:
    """Thread-safe background service that runs camera-based hand gesture intelligence."""

    _instance: Optional["GestureService"] = None
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> "GestureService":
        with cls._lock:
            if cls._instance is None:
                cls._instance = GestureService()
            return cls._instance

    def __init__(self) -> None:
        self.detector = HandGestureDetector()
        self.controller = GestureActionController()
        self.renderer = HUDRenderer()

        # Connect controller events to renderer toasts
        self.controller.on_action_callback = self.renderer.register_action

        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._is_running = False
        self._preview_enabled = False
        self._camera_id = 0
        self._mirror = True

        # Telemetry & streaming frame
        self._latest_jpeg: Optional[bytes] = None
        self._frame_lock = threading.Lock()
        self._fps: float = 0.0
        self._hands_count: int = 0
        self._last_detected_gesture: str = "None"
        self._frames_processed: int = 0

    def is_running(self) -> bool:
        return self._is_running and self._thread is not None and self._thread.is_alive()

    def start(self, camera_id: int = 0, preview: bool = False, mirror: bool = True) -> Dict[str, Any]:
        """Starts the hand gesture service in the background."""
        with self._lock:
            if self.is_running():
                return {
                    "success": True,
                    "message": "Gesture service is already running.",
                    "status": self.get_status(),
                }

            self._camera_id = camera_id
            self._preview_enabled = preview
            self._mirror = mirror
            self._stop_event.clear()
            self._is_running = True

            self._thread = threading.Thread(
                target=self._run_loop,
                name="EraGestureServiceThread",
                daemon=True,
            )
            self._thread.start()
            logger.info("Gesture service started on camera index %s (preview=%s)", camera_id, preview)

            # Wait briefly for thread startup
            time.sleep(0.3)
            return {
                "success": True,
                "message": f"Gesture service started successfully on camera {camera_id}.",
                "status": self.get_status(),
            }

    def stop(self) -> Dict[str, Any]:
        """Stops the hand gesture service."""
        with self._lock:
            if not self.is_running():
                return {
                    "success": True,
                    "message": "Gesture service is not currently running.",
                    "status": self.get_status(),
                }

            self._stop_event.set()
            if self._thread:
                self._thread.join(timeout=2.5)
            self._is_running = False
            self._thread = None
            logger.info("Gesture service stopped.")

            return {
                "success": True,
                "message": "Gesture service stopped successfully.",
                "status": self.get_status(),
            }

    def get_status(self) -> Dict[str, Any]:
        """Returns the current operational status and hardware metrics."""
        return {
            "running": self.is_running(),
            "camera_id": self._camera_id,
            "preview_enabled": self._preview_enabled,
            "fps": round(self._fps, 1),
            "hands_detected": self._hands_count,
            "last_gesture": self._last_detected_gesture,
            "current_brightness": self.controller.current_brightness,
            "current_volume": self.controller.current_volume,
            "frames_processed": self._frames_processed,
            "recent_actions": [
                {"action": e.action, "details": e.details, "timestamp": e.timestamp}
                for e in self.controller.recent_events[-5:]
            ],
        }

    def get_latest_jpeg(self) -> Optional[bytes]:
        """Thread-safe retrieval of the latest processed frame in JPEG format."""
        with self._frame_lock:
            return self._latest_jpeg

    def generate_mjpeg_stream(self) -> Generator[bytes, None, None]:
        """Yields multipart MJPEG stream for web browsers and Electron."""
        while self.is_running():
            jpeg = self.get_latest_jpeg()
            if jpeg:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
                )
            time.sleep(0.04)  # ~25 FPS stream cap

    def _run_loop(self) -> None:
        """Core video processing loop."""
        # On Windows, try cv2.CAP_DSHOW for near-instant driver start and low latency
        cap = cv2.VideoCapture(self._camera_id, cv2.CAP_DSHOW)
        if not cap.isOpened():
            cap = cv2.VideoCapture(self._camera_id)
        if not cap.isOpened():
            logger.error("Could not open camera %s", self._camera_id)
            self._is_running = False
            return

        # Crucial for real-time responsiveness: buffer size = 1 eliminates frame queue delay
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        cap.set(cv2.CAP_PROP_FPS, 30)

        prev_time = time.time()
        fps_smoothing = 0.9

        window_name = "ERA Hand Gesture Intelligence"
        if self._preview_enabled:
            cv2.namedWindow(window_name, cv2.WINDOW_AUTOSIZE)
            try:
                cv2.setWindowProperty(window_name, cv2.WND_PROP_TOPMOST, 1)
            except Exception:
                pass

        try:
            while not self._stop_event.is_set():
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.01)
                    continue

                self._frames_processed += 1
                now = time.time()
                dt = now - prev_time
                prev_time = now
                if dt > 0:
                    current_fps = 1.0 / dt
                    self._fps = (self._fps * fps_smoothing) + (current_fps * (1.0 - fps_smoothing))

                # Process hand gestures and landmarks
                detection, mirrored_frame = self.detector.process_frame(frame, mirror=self._mirror)
                self._hands_count = len(detection.hands)

                # Process actions for each detected hand
                for hand in detection.hands:
                    if hand.gesture_name != "None":
                        self._last_detected_gesture = hand.gesture_name
                    self.controller.process_hand(hand)

                # Render futuristic HUD overlay
                annotated = self.renderer.render(
                    frame=mirrored_frame,
                    detection=detection,
                    current_brightness=self.controller.current_brightness,
                    current_volume=self.controller.current_volume,
                    fps=self._fps,
                )

                # Encode JPEG for web/UI streaming
                ret_enc, jpeg_buf = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
                if ret_enc:
                    with self._frame_lock:
                        self._latest_jpeg = jpeg_buf.tobytes()

                # Desktop preview window if enabled
                if self._preview_enabled:
                    cv2.imshow(window_name, annotated)
                    key = cv2.waitKey(1) & 0xFF
                    if key == ord("q") or key == 27:  # 'q' or ESC
                        break

        except Exception as exc:
            logger.error("Unhandled exception in gesture loop: %s", exc, exc_info=True)
        finally:
            cap.release()
            if self._preview_enabled:
                cv2.destroyAllWindows()
            self._is_running = False
            logger.info("Gesture capture loop terminated.")
