"""Unified System Control Manager for Era Agent.

Orchestrates DisplayControl, AudioControl, PeripheralControl, KeyboardControl,
and IntentParser into a single clean system management interface.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Tuple

from .audio import AudioControl
from .display import DisplayControl
from .intent_parser import IntentParser, SystemIntent
from .keyboard import KeyboardControl
from .peripherals import PeripheralControl
from .phone_link import PhoneLinkControl

logger = logging.getLogger(__name__)


class SystemControlManager:
    """Central orchestrator for all system control functions and natural language processing."""

    @classmethod
    def execute_intent(cls, action: str, params: Dict[str, Any]) -> Tuple[bool, str]:
        """Executes a structured system action by name with given parameters.

        Returns:
            Tuple of (success: bool, message: str)
        """
        action_name = action.strip().lower()

        # Display Brightness
        if action_name == "set_display_brightness":
            raw = params.get("level") if params.get("level") is not None else (params.get("brightness") if params.get("brightness") is not None else params.get("percentage", 50))
            try:
                level = int(raw)
            except (ValueError, TypeError):
                level = 50
            return DisplayControl.set_brightness(level)

        if action_name == "adjust_display_brightness":
            raw = params.get("delta") if params.get("delta") is not None else (params.get("amount") if params.get("amount") is not None else params.get("change", 10))
            try:
                delta = int(raw)
            except (ValueError, TypeError):
                delta = 10
            return DisplayControl.adjust_brightness(delta)

        if action_name == "get_display_brightness":
            ok, val, msg = DisplayControl.get_brightness()
            return ok, msg

        # Audio Volume & Mute
        if action_name == "set_audio_volume":
            raw = params.get("level") if params.get("level") is not None else (params.get("volume") if params.get("volume") is not None else params.get("percentage", 50))
            try:
                level = int(raw)
            except (ValueError, TypeError):
                level = 50
            return AudioControl.set_volume(level)

        if action_name == "adjust_audio_volume":
            raw = params.get("delta") if params.get("delta") is not None else (params.get("amount") if params.get("amount") is not None else params.get("change", 10))
            try:
                delta = int(raw)
            except (ValueError, TypeError):
                delta = 10
            return AudioControl.adjust_volume(delta)

        if action_name == "toggle_audio_mute":
            mute = params.get("mute", None)
            return AudioControl.toggle_mute(mute)

        if action_name == "get_audio_volume":
            ok, val, msg = AudioControl.get_volume()
            return ok, msg

        # Peripheral Connections (Bluetooth / Wi-Fi)
        if action_name == "set_bluetooth_state":
            enable = params.get("enable", True)
            return PeripheralControl.set_bluetooth_state(enable)

        if action_name == "set_wifi_state":
            enable = params.get("enable", True)
            return PeripheralControl.set_wifi_state(enable)

        if action_name == "get_peripheral_status":
            ok, data, msg = PeripheralControl.get_peripheral_status()
            return ok, msg

        # Keyboard Backlight
        if action_name == "set_keyboard_backlight":
            raw = params.get("level") if params.get("level") is not None else (params.get("brightness") if params.get("brightness") is not None else (params.get("backlight") if params.get("backlight") is not None else params.get("percentage", 50)))
            try:
                level = int(raw)
            except (ValueError, TypeError):
                level = 50
            mode = params.get("mode", "rainbow")
            return KeyboardControl.set_keyboard_backlight(level, mode=mode)

        if action_name in ("enable_manual_keyboard_control", "reset_keyboard_control", "manual_keyboard"):
            return KeyboardControl.enable_manual_control()

        # Hand Gesture Control
        if action_name in ("start_gesture_control", "start_gestures", "enable_gesture_control", "enable_gestures"):
            try:
                from gestures import GestureService
            except ImportError:
                from era_agent.gestures import GestureService
            cam = params.get("camera", 0)
            prev = params.get("preview", False)
            service = GestureService.get_instance()
            res = service.start(camera_id=int(cam), preview=bool(prev))
            return res["success"], res["message"]

        if action_name in ("stop_gesture_control", "stop_gestures", "disable_gesture_control", "disable_gestures"):
            try:
                from gestures import GestureService
            except ImportError:
                from era_agent.gestures import GestureService
            service = GestureService.get_instance()
            res = service.stop()
            return res["success"], res["message"]

        if action_name in ("get_gesture_status", "gesture_status", "check_gestures"):
            try:
                from gestures import GestureService
            except ImportError:
                from era_agent.gestures import GestureService
            service = GestureService.get_instance()
            status = service.get_status()
            msg = f"Hand gesture intelligence is {'ONLINE' if status['running'] else 'OFFLINE'} (FPS: {status['fps']}, Hands: {status['hands_detected']})."
            return True, msg

        if action_name == "adjust_keyboard_backlight":
            raw = params.get("delta") if params.get("delta") is not None else (params.get("amount") if params.get("amount") is not None else params.get("change", 25))
            try:
                delta = int(raw)
            except (ValueError, TypeError):
                delta = 25
            return KeyboardControl.adjust_keyboard_backlight(delta)

        if action_name == "get_keyboard_backlight":
            ok, val, msg = KeyboardControl.get_keyboard_backlight()
            return ok, msg

        if action_name == "save_keyboard_backlight":
            return KeyboardControl.save_keyboard_backlight()

        # Phone Link Device Integration
        if action_name in ("make_phone_call", "make_call", "call_phone", "dial"):
            target = params.get("phone") or params.get("number") or params.get("contact") or params.get("target")
            return PhoneLinkControl.make_call(target)

        if action_name in ("answer_phone_call", "accept_phone_call", "answer_call", "accept_call", "pick_up_call"):
            return PhoneLinkControl.answer_call()

        if action_name in ("reject_phone_call", "decline_phone_call", "reject_call", "decline_call", "cut_call", "hangup_call"):
            return PhoneLinkControl.reject_call()

        if action_name in ("get_incoming_call", "check_incoming_call"):
            data = PhoneLinkControl.get_incoming_call()
            return True, f"Incoming call status: {data}"

        if action_name in ("read_phone_messages", "read_messages", "get_phone_messages"):
            limit = params.get("limit", 5)
            ok, data, msg = PhoneLinkControl.read_messages(limit)
            return ok, msg

        if action_name in ("transfer_phone_files", "transfer_files", "sync_phone_files"):
            direction = params.get("direction", "phone_to_laptop")
            file_name = params.get("file_name") or params.get("filename")
            dest = params.get("destination") or params.get("dest")
            ok, data, msg = PhoneLinkControl.transfer_files(direction, file_name, dest)
            return ok, msg

        if action_name in ("get_phone_link_status", "phone_link_status", "check_phone_link"):
            ok, data, msg = PhoneLinkControl.get_status()
            return ok, msg

        # WhatsApp Messaging
        if action_name == "open_whatsapp":
            phone = params.get("phone") or params.get("contact") or params.get("recipient")
            msg = params.get("message") or params.get("text") or params.get("msg") or "Hello"
            try:
                from commands.system_commands import open_whatsapp
                res = open_whatsapp(phone=phone, message=msg)
                return res.success, res.message
            except Exception as exc:
                return False, f"Failed to execute open_whatsapp: {exc}"

        # Shutdown Cancellation
        if action_name in ("cancel_shutdown", "abort_shutdown"):
            try:
                from commands.system_commands import cancel_shutdown
                res = cancel_shutdown()
                return res.success, res.message
            except Exception as exc:
                return False, f"Failed to cancel shutdown: {exc}"

        return False, f"Unknown system control action: '{action}'"

    @classmethod
    def execute_natural_language(cls, query: str) -> Tuple[bool, str]:
        """Parses and executes a natural language query for system functions.

        Example queries:
            - "increase brightness"
            - "set volume to 75%"
            - "turn on bluetooth"
            - "mute audio"

        Returns:
            Tuple of (success: bool, message: str)
        """
        intent: SystemIntent = IntentParser.parse(query)
        if not intent.matched or intent.action == "unknown":
            return False, f"Could not interpret system control request: '{query}'"

        logger.info("Natural language intent matched: action='%s', params=%s", intent.action, intent.params)
        return cls.execute_intent(intent.action, intent.params)
