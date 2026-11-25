"""System Control commands for Era Agent.

Registers Windows hardware control functions (display brightness, audio volume,
Bluetooth, Wi-Fi, keyboard backlight, and natural language intent parsing)
with the Era Agent command registry.
"""

from __future__ import annotations

from typing import Optional

try:
    from era_agent.controls import SystemControlManager
except ImportError:
    from controls import SystemControlManager

from .registry import CommandParam, CommandResult, registry


@registry.register(
    "set_display_brightness",
    "Sets display brightness level percentage (0 to 100)",
    params=[
        CommandParam("level", "int", "Target brightness level (0-100)", required=False, default=50),
    ],
)
def set_display_brightness(level: Any = None, brightness: Any = None, percentage: Any = None, **kwargs) -> CommandResult:
    raw = level if level is not None else (brightness if brightness is not None else (percentage if percentage is not None else kwargs.get("target", 50)))
    try:
        val = int(raw)
    except (ValueError, TypeError):
        val = 50
    ok, msg = SystemControlManager.execute_intent("set_display_brightness", {"level": val})
    return CommandResult(ok, msg)


@registry.register(
    "adjust_display_brightness",
    "Adjusts display brightness by a relative delta percentage (e.g. +10 or -10)",
    params=[
        CommandParam("delta", "int", "Relative change (+10 or -10)", required=False, default=10),
    ],
)
def adjust_display_brightness(delta: Any = 10, amount: Any = None, change: Any = None, **kwargs) -> CommandResult:
    raw = delta if amount is None and change is None else (amount if amount is not None else change)
    try:
        val = int(raw)
    except (ValueError, TypeError):
        val = 10
    ok, msg = SystemControlManager.execute_intent("adjust_display_brightness", {"delta": val})
    return CommandResult(ok, msg)


@registry.register("get_display_brightness", "Queries the current display brightness level")
def get_display_brightness(**kwargs) -> CommandResult:
    ok, msg = SystemControlManager.execute_intent("get_display_brightness", {})
    return CommandResult(ok, msg)


@registry.register(
    "set_audio_volume",
    "Sets master audio volume percentage (0 to 100)",
    params=[
        CommandParam("level", "int", "Target volume level (0-100)", required=False, default=50),
    ],
)
def set_audio_volume(level: Any = None, volume: Any = None, percentage: Any = None, **kwargs) -> CommandResult:
    raw = level if level is not None else (volume if volume is not None else (percentage if percentage is not None else kwargs.get("target", 50)))
    try:
        val = int(raw)
    except (ValueError, TypeError):
        val = 50
    ok, msg = SystemControlManager.execute_intent("set_audio_volume", {"level": val})
    return CommandResult(ok, msg)


@registry.register(
    "adjust_audio_volume",
    "Adjusts master audio volume by a relative delta percentage (e.g. +10 or -10)",
    params=[
        CommandParam("delta", "int", "Relative change (+10 or -10)", required=False, default=10),
    ],
)
def adjust_audio_volume(delta: Any = 10, amount: Any = None, change: Any = None, **kwargs) -> CommandResult:
    raw = delta if amount is None and change is None else (amount if amount is not None else change)
    try:
        val = int(raw)
    except (ValueError, TypeError):
        val = 10
    ok, msg = SystemControlManager.execute_intent("adjust_audio_volume", {"delta": val})
    return CommandResult(ok, msg)


@registry.register(
    "toggle_audio_mute",
    "Mutes or unmutes master audio",
    params=[
        CommandParam("mute", "bool", "True to mute, False to unmute, None to toggle", required=False),
    ],
)
def toggle_audio_mute(mute: Optional[bool] = None, **kwargs) -> CommandResult:
    ok, msg = SystemControlManager.execute_intent("toggle_audio_mute", {"mute": mute})
    return CommandResult(ok, msg)


@registry.register("get_audio_volume", "Queries the current master audio volume")
def get_audio_volume(**kwargs) -> CommandResult:
    ok, msg = SystemControlManager.execute_intent("get_audio_volume", {})
    return CommandResult(ok, msg)


@registry.register(
    "set_bluetooth_state",
    "Enables or disables Bluetooth radio and services",
    params=[
        CommandParam("enable", "bool", "True to enable Bluetooth, False to disable", required=True, default=True),
    ],
)
def set_bluetooth_state(enable: bool = True, **kwargs) -> CommandResult:
    ok, msg = SystemControlManager.execute_intent("set_bluetooth_state", {"enable": enable})
    return CommandResult(ok, msg)


@registry.register(
    "set_wifi_state",
    "Enables or disables Wi-Fi interface",
    params=[
        CommandParam("enable", "bool", "True to enable Wi-Fi, False to disable", required=True, default=True),
    ],
)
def set_wifi_state(enable: bool = True, **kwargs) -> CommandResult:
    ok, msg = SystemControlManager.execute_intent("set_wifi_state", {"enable": enable})
    return CommandResult(ok, msg)


@registry.register("get_peripheral_status", "Queries current Bluetooth and Wi-Fi status")
def get_peripheral_status(**kwargs) -> CommandResult:
    ok, msg = SystemControlManager.execute_intent("get_peripheral_status", {})
    return CommandResult(ok, msg)


@registry.register(
    "set_keyboard_backlight",
    "Sets keyboard backlight brightness percentage (0 to 100)",
    params=[
        CommandParam("level", "int", "Target brightness level (0-100)", required=False, default=50),
    ],
)
def set_keyboard_backlight(level: Any = None, brightness: Any = None, backlight: Any = None, percentage: Any = None, mode: str = "rainbow", **kwargs) -> CommandResult:
    raw = level if level is not None else (brightness if brightness is not None else (backlight if backlight is not None else (percentage if percentage is not None else 50)))
    try:
        val = int(raw)
    except (ValueError, TypeError):
        val = 50
    ok, msg = SystemControlManager.execute_intent("set_keyboard_backlight", {"level": val, "mode": mode})
    return CommandResult(ok, msg)


@registry.register(
    "adjust_keyboard_backlight",
    "Adjusts keyboard backlight brightness by relative delta (reads actual hardware level first so manual Dragon Center changes are respected)",
    params=[
        CommandParam("delta", "int", "Relative change (+25 or -25)", required=False, default=25),
    ],
)
def adjust_keyboard_backlight(delta: Any = 25, amount: Any = None, change: Any = None, **kwargs) -> CommandResult:
    raw = delta if amount is None and change is None else (amount if amount is not None else change)
    try:
        val = int(raw)
    except (ValueError, TypeError):
        val = 25
    ok, msg = SystemControlManager.execute_intent("adjust_keyboard_backlight", {"delta": val})
    return CommandResult(ok, msg)


@registry.register(
    "get_keyboard_backlight",
    "Returns the current keyboard backlight brightness as read from hardware (respects manual Dragon Center changes)",
)
def get_keyboard_backlight(**kwargs) -> CommandResult:
    ok, msg = SystemControlManager.execute_intent("get_keyboard_backlight", {})
    return CommandResult(ok, msg)


@registry.register(
    "save_keyboard_backlight",
    "Saves the current ERA keyboard backlight setting to MCU flash so it persists after reboot",
)
def save_keyboard_backlight() -> CommandResult:
    ok, msg = SystemControlManager.execute_intent("save_keyboard_backlight", {})
    return CommandResult(ok, msg)


@registry.register(
    "process_natural_language_control",
    "Interprets natural language commands like 'increase brightness' or 'adjust volume' into system controls",
    params=[
        CommandParam("query", "str", "Natural language request string", required=True),
    ],
)
def process_natural_language_control(query: Optional[str] = None) -> CommandResult:
    if not query:
        return CommandResult(False, "No natural language request string provided.")
    ok, msg = SystemControlManager.execute_natural_language(query)
    return CommandResult(ok, msg)


# --------------------------------------------------------------------------
# HAND GESTURE CONTROL COMMANDS
# --------------------------------------------------------------------------

@registry.register(
    "start_gesture_control",
    "Starts the real-time camera hand gesture recognition intelligence engine",
    params=[
        CommandParam("camera", "int", "Camera device index (default 0)", required=False, default=0),
        CommandParam("preview", "bool", "Whether to show visual HUD window (default False)", required=False, default=False),
    ],
)
def start_gesture_control(camera: Any = 0, preview: Any = False, **kwargs) -> CommandResult:
    try:
        from gestures import GestureService
    except ImportError:
        from era_agent.gestures import GestureService

    cam_id = int(camera) if camera is not None else 0
    show_prev = bool(preview) if preview is not None else False
    service = GestureService.get_instance()
    res = service.start(camera_id=cam_id, preview=show_prev)
    return CommandResult(res["success"], res["message"], data=res.get("status"))


@registry.register(
    "stop_gesture_control",
    "Stops the real-time camera hand gesture recognition engine",
)
def stop_gesture_control(**kwargs) -> CommandResult:
    try:
        from gestures import GestureService
    except ImportError:
        from era_agent.gestures import GestureService

    service = GestureService.get_instance()
    res = service.stop()
    return CommandResult(res["success"], res["message"], data=res.get("status"))


@registry.register(
    "get_gesture_status",
    "Returns real-time status of the camera hand gesture recognition engine",
)
def get_gesture_status(**kwargs) -> CommandResult:
    try:
        from gestures import GestureService
    except ImportError:
        from era_agent.gestures import GestureService

    service = GestureService.get_instance()
    status = service.get_status()
    msg = f"Hand gesture service is {'RUNNING' if status['running'] else 'STOPPED'} (FPS: {status['fps']}, Hands: {status['hands_detected']})."
    return CommandResult(True, msg, data=status)

