"""Phone Link Integration for Era Agent.

Enables Era to interface with Windows Phone Link (Microsoft.YourPhone)
to place phone calls, answer incoming calls, reject incoming calls,
read messages, transfer files/photos, and check connection status.
"""

from __future__ import annotations

import ctypes
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Global state for incoming call monitoring
_incoming_call_state = {
    "ringing": False,
    "caller": "",
    "timestamp": 0.0,
    "notification_id": None,
}
_incoming_monitor_started = False
_monitor_lock = threading.Lock()


def _ensure_default_desktop():
    """Switches thread desktop to WinSta0\\Default so UI and automation operate on visible screen."""
    try:
        user32 = ctypes.windll.user32
        h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
        if h_desk:
            user32.SetThreadDesktop(h_desk)
    except Exception as exc:
        logger.debug("Desktop switch error: %s", exc)


def _force_window_foreground(hwnd: int):
    """Bypasses Windows SetForegroundWindow lock by simulating an Alt key event."""
    try:
        user32 = ctypes.windll.user32
        user32.keybd_event(0x12, 0, 0, 0)  # Alt down
        user32.keybd_event(0x12, 0, 2, 0)  # Alt up
        user32.ShowWindow(hwnd, 9)          # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
        user32.BringWindowToTop(hwnd)
    except Exception as exc:
        logger.debug("Force foreground error: %s", exc)


def is_phone_bt_audio_connected() -> bool:
    """Checks if mobile device Bluetooth Hands-Free audio endpoint is physically connected."""
    ps_code = """
    $devices = Get-PnpDevice -FriendlyName '*Hands-Free HF Audio*' -ErrorAction SilentlyContinue
    $connected = $false
    foreach ($d in $devices) {
        if ($d.Status -eq 'OK' -and $d.Problem -eq 'CM_PROB_NONE') {
            $connected = $true
            break
        }
    }
    $connected
    """
    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_code],
            capture_output=True,
            text=True,
            timeout=4,
        )
        return "True" in res.stdout
    except Exception:
        return False


class PhoneLinkControl:
    """Manages automation and interaction with Windows Phone Link."""

    PACKAGE_NAME = "Microsoft.YourPhone"
    TEMP_MEDIA_DIR = Path(
        os.path.expandvars(r"%LOCALAPPDATA%\Packages\Microsoft.YourPhone_8wekyb3d8bbwe\TempState\medias")
    )
    LOCAL_STATE_DIR = Path(
        os.path.expandvars(r"%LOCALAPPDATA%\Packages\Microsoft.YourPhone_8wekyb3d8bbwe\LocalState")
    )

    @classmethod
    def is_installed(cls) -> bool:
        """Checks if Microsoft.YourPhone package is installed on Windows."""
        try:
            cmd = 'powershell -NoProfile -Command "Get-AppxPackage -Name *YourPhone*"'
            res = subprocess.run(cmd, capture_output=True, text=True, shell=True, timeout=5)
            return "Microsoft.YourPhone" in res.stdout
        except Exception as exc:
            logger.warning("Error checking Phone Link installation: %s", exc)
            return False

    @classmethod
    def is_running(cls) -> bool:
        """Checks if Phone Link process (PhoneExperienceHost.exe) is currently running."""
        try:
            cmd = 'powershell -NoProfile -Command "Get-Process -Name PhoneExperienceHost -ErrorAction SilentlyContinue"'
            res = subprocess.run(cmd, capture_output=True, text=True, shell=True, timeout=5)
            return "PhoneExperienceHost" in res.stdout
        except Exception as exc:
            logger.warning("Error checking Phone Link running status: %s", exc)
            return False

    @classmethod
    def get_status(cls) -> Tuple[bool, Dict[str, Any], str]:
        """Returns connection and application status of Phone Link."""
        installed = cls.is_installed()
        running = cls.is_running()
        bt_connected = is_phone_bt_audio_connected()

        media_count = 0
        if cls.TEMP_MEDIA_DIR.exists():
            media_count = len(list(cls.TEMP_MEDIA_DIR.glob("*")))

        # Check linked device metadata
        device_meta_path = Path(
            os.path.expandvars(r"%LOCALAPPDATA%\Packages\Microsoft.YourPhone_8wekyb3d8bbwe\LocalCache\DeviceMetadataStorage.json")
        )
        linked_device_name = "OPPO A57"
        is_linked = False
        if device_meta_path.exists():
            try:
                data = json.loads(device_meta_path.read_text(encoding="utf-8"))
                for dev_list in data.get("DeviceMetadatas", {}).values():
                    for item in dev_list:
                        meta = item.get("Metadata", {}).get("Metadata", {})
                        if meta.get("DisplayName"):
                            linked_device_name = meta.get("DisplayName")
                            is_linked = item.get("IsLinked", False)
                            break
            except Exception:
                pass

        data = {
            "installed": installed,
            "running": running,
            "is_linked": is_linked,
            "device_name": linked_device_name,
            "bluetooth_connected": bt_connected,
            "cached_media_files": media_count,
            "package_name": cls.PACKAGE_NAME,
            "incoming_call": _incoming_call_state,
        }

        if not installed:
            return False, data, "Windows Phone Link (Microsoft.YourPhone) is not installed on this system."

        status_str = f"running and linked to {linked_device_name} (Bluetooth: {'Connected' if bt_connected else 'Disconnected'})"
        return True, data, f"Phone Link is {status_str}."

    @classmethod
    def _find_phone_window(cls) -> Optional[int]:
        """Finds top-level Phone Link window handle."""
        _ensure_default_desktop()
        import win32gui

        phone_hwnd = None

        def enum_cb(h, _):
            nonlocal phone_hwnd
            cn = win32gui.GetClassName(h)
            t = win32gui.GetWindowText(h)
            if cn == "WinUIDesktopWin32WindowClass" and ("Phone" in t or "Link" in t):
                phone_hwnd = h

        win32gui.EnumWindows(enum_cb, None)
        return phone_hwnd

    @classmethod
    def _ensure_phone_link_open(cls) -> Optional[int]:
        """Launches Phone Link Calls view and waits for the window to appear."""
        _ensure_default_desktop()
        import win32gui

        hwnd = cls._find_phone_window()
        if hwnd and win32gui.IsWindowVisible(hwnd):
            _force_window_foreground(hwnd)
            return hwnd

        # Launch Calls view via protocol
        try:
            subprocess.Popen(["cmd.exe", "/c", "start", "ms-phone:calls"], shell=True)
        except Exception:
            try:
                os.startfile("ms-phone:calls")
            except Exception:
                pass

        # Wait up to 4 seconds for window to show
        for _ in range(35):
            time.sleep(0.1)
            hwnd = cls._find_phone_window()
            if hwnd:
                _force_window_foreground(hwnd)
                return hwnd

        return hwnd

    @classmethod
    def find_green_call_button(cls, bbox=None) -> Optional[Tuple[int, int]]:
        """Scans the screen or window for Phone Link's vibrant green circular call/accept button."""
        try:
            from PIL import ImageGrab
            _ensure_default_desktop()
            im = ImageGrab.grab(bbox=bbox)
            offset_x = bbox[0] if bbox else 0
            offset_y = bbox[1] if bbox else 0

            try:
                import numpy as np
                arr = np.array(im).astype(int)
                # Robust green detection covering Phone Link light & dark Fluent themes:
                mask = (
                    (arr[:, :, 1] > 90)
                    & (arr[:, :, 1] > arr[:, :, 0] + 25)
                    & (arr[:, :, 1] > arr[:, :, 2] + 25)
                    & (arr[:, :, 0] < 160)
                    & (arr[:, :, 2] < 160)
                )
                if bbox is None and arr.shape[0] >= 1000:
                    mask[1035:, :] = False
                ys, xs = np.where(mask)
                if len(xs) < 25:
                    return None
                pts = list(zip(xs, ys))
            except Exception:
                green_pixels = []
                width, height = im.size
                for y in range(height):
                    if bbox is None and height >= 1000 and y >= 1035:
                        continue
                    for x in range(width):
                        r, g, b = im.getpixel((x, y))[:3]
                        if g > 90 and g > r + 25 and g > b + 25 and r < 160 and b < 160:
                            green_pixels.append((x, y))
                if len(green_pixels) < 25:
                    return None
                pts = green_pixels

            clusters = []
            step = 1 if len(pts) < 1000 else 2
            for pt in pts[::step]:
                for cl in clusters:
                    if abs(pt[0] - cl["cx"]) < 35 and abs(pt[1] - cl["cy"]) < 35:
                        cl["pts"].append(pt)
                        break
                else:
                    clusters.append({"cx": pt[0], "cy": pt[1], "pts": [pt]})

            valid = [c for c in clusters if len(c["pts"]) >= 25]
            valid.sort(key=lambda c: len(c["pts"]), reverse=True)
            if valid:
                pts_in_cl = valid[0]["pts"]
                return (
                    sum(p[0] for p in pts_in_cl) // len(pts_in_cl) + offset_x,
                    sum(p[1] for p in pts_in_cl) // len(pts_in_cl) + offset_y,
                )
        except Exception as exc:
            logger.debug("Error finding green call button: %s", exc)
        return None

    @classmethod
    def find_red_call_button(cls, bbox=None) -> Optional[Tuple[int, int]]:
        """Scans the screen or window for Phone Link's vibrant red circular end/decline call button."""
        try:
            from PIL import ImageGrab
            _ensure_default_desktop()
            im = ImageGrab.grab(bbox=bbox)
            offset_x = bbox[0] if bbox else 0
            offset_y = bbox[1] if bbox else 0

            try:
                import numpy as np
                arr = np.array(im)
                mask = (arr[:, :, 0] > 170) & (arr[:, :, 1] < 60) & (arr[:, :, 2] < 60)
                # Exclude Windows taskbar area if scanning full primary screen
                if bbox is None and arr.shape[0] >= 1000:
                    mask[1035:, :] = False
                ys, xs = np.where(mask)
                if len(xs) < 30:
                    return None
                pts = list(zip(xs, ys))
            except Exception:
                red_points = []
                width, height = im.size
                for y in range(height):
                    if bbox is None and height >= 1000 and y >= 1035:
                        continue
                    for x in range(width):
                        r, g, b = im.getpixel((x, y))[:3]
                        if r > 170 and g < 60 and b < 60:
                            red_points.append((x, y))
                if len(red_points) < 30:
                    return None
                pts = red_points

            clusters = []
            step = 1 if len(pts) < 1000 else 2
            for pt in pts[::step]:
                for cl in clusters:
                    if abs(pt[0] - cl["cx"]) < 35 and abs(pt[1] - cl["cy"]) < 35:
                        cl["pts"].append(pt)
                        break
                else:
                    clusters.append({"cx": pt[0], "cy": pt[1], "pts": [pt]})

            valid = [c for c in clusters if len(c["pts"]) >= 25]
            valid.sort(key=lambda c: len(c["pts"]), reverse=True)
            if valid:
                pts_in_cl = valid[0]["pts"]
                return (
                    sum(p[0] for p in pts_in_cl) // len(pts_in_cl) + offset_x,
                    sum(p[1] for p in pts_in_cl) // len(pts_in_cl) + offset_y,
                )
        except Exception as exc:
            logger.debug("Error finding red call button: %s", exc)
        return None

    @classmethod
    def make_call(cls, phone_or_contact: str) -> Tuple[bool, str]:
        """
        Initiates a phone call via Windows Phone Link.
        Dials specified contact or number directly and reliably.
        NEVER dials random contacts if not found.
        """
        if not phone_or_contact:
            return False, "Boss, kripya contact ka naam ya phone number batayein jise call lagana hai."

        clean_target = str(phone_or_contact).strip()
        # Clean speech conversational filler words
        clean_target_name = re.sub(
            r"\b(call|phone|lagao|laga|karo|kar|ko|pe|par|please|mila|milao|kisi|number)\b",
            "",
            clean_target,
            flags=re.IGNORECASE,
        ).strip()
        if not clean_target_name:
            clean_target_name = clean_target

        digits_only = re.sub(r"[^\d]", "", clean_target)

        dial_digits = None
        display_name = clean_target_name

        # Case 1: Direct 10+ digit number provided
        if len(digits_only) >= 10:
            dial_digits = digits_only[-10:]
            display_name = dial_digits
        else:
            # Case 2: Contact name lookup
            resolved_phone = cls._resolve_contact_phone(clean_target) or cls._resolve_contact_phone(clean_target_name)
            if resolved_phone:
                contact_digits = re.sub(r"[^\d]", "", resolved_phone)
                if len(contact_digits) >= 10:
                    dial_digits = contact_digits[-10:]
                    display_name = f"{clean_target_name} ({dial_digits})"

        if not dial_digits:
            logger.warning("Contact '%s' not found in contacts list and no valid 10-digit number given.", clean_target)
            return False, f"Boss, aapke contacts me '{clean_target_name}' nahi mila. Kripya unka phone number bata dijiye, mai turant call laga dungi."

        try:
            import pyautogui
            import win32gui

            _ensure_default_desktop()

            phone_hwnd = None

            logger.info("Dialing via tel: protocol for %s (%s)", display_name, dial_digits)
            os.system(f"start tel:{dial_digits}")

            for _ in range(30):
                time.sleep(0.12)
                hwnds = []
                def cb(h, _):
                    if win32gui.IsWindowVisible(h):
                        cn = win32gui.GetClassName(h)
                        t = win32gui.GetWindowText(h)
                        if any(k in t.lower() or k in cn.lower() for k in ["phone", "link", "call on", "winui"]):
                            hwnds.append(h)
                win32gui.EnumWindows(cb, None)
                if hwnds:
                    phone_hwnd = hwnds[0]
                    break

            if phone_hwnd:
                _force_window_foreground(phone_hwnd)
            time.sleep(0.3)

            # --- DYNAMICALLY LOCATE AND CLICK THE GREEN CALL BUTTON ---
            btn = None
            for _ in range(16):
                btn = cls.find_green_call_button()
                if btn:
                    break
                time.sleep(0.15)

            if btn:
                cx, cy = btn
                logger.info("Found Green Call button at (%d, %d). Clicking to dial...", cx, cy)
                pyautogui.click(cx, cy)
                time.sleep(0.2)
                pyautogui.press("enter")
            else:
                logger.warning("Green call button not visually found, attempting enter fallback on focused call window")
                if phone_hwnd:
                    _force_window_foreground(phone_hwnd)
                    pyautogui.press("enter")

            # Double check if call dialog still remains on screen after 0.8s
            time.sleep(0.8)
            retry_btn = cls.find_green_call_button()
            if retry_btn:
                logger.info("Retrying click on Green Call button at (%d, %d)...", retry_btn[0], retry_btn[1])
                pyautogui.click(retry_btn[0], retry_btn[1])
                time.sleep(0.15)
                pyautogui.press("enter")

            time.sleep(0.5)

            # Check if Bluetooth audio is connected
            bt_ok = is_phone_bt_audio_connected()
            if not bt_ok:
                return True, (
                    f"Phone Link me {display_name} ko call laga diya hai, boss. "
                    "Agar call audio phone me switch na ho toh phone ka Bluetooth connect kar lijiye."
                )

            return True, f"Successfully calling {display_name} via Phone Link!"

        except Exception as exc:
            logger.error("Failed to place call via Phone Link: %s", exc)
            return False, f"Failed to place call via Phone Link: {exc}"
            logger.error("Failed to place call via Phone Link: %s", exc)
            return False, f"Failed to place call via Phone Link: {exc}"

    @classmethod
    def answer_call(cls) -> Tuple[bool, str]:
        """
        Accepts / answers an incoming phone call received on Phone Link.
        """
        try:
            import pyautogui
            import win32gui
            import win32process
            import psutil

            _ensure_default_desktop()

            # 1. Scan for Green Accept Call button on screen (toast banner or call window)
            g = None
            for _ in range(8):
                g = cls.find_green_call_button()
                if g:
                    logger.info("Found Green Accept Call button at (%d, %d). Clicking...", g[0], g[1])
                    pyautogui.click(g[0], g[1])
                    time.sleep(0.2)
                    break
                time.sleep(0.12)

            # 2. Check and focus any Phone Link or incoming call window
            phone_pids = [p.pid for p in psutil.process_iter(["name", "pid"]) if "phone" in p.info["name"].lower()]
            call_hwnds = []

            def enum_cb(h, _):
                if win32gui.IsWindowVisible(h):
                    _, pid = win32process.GetWindowThreadProcessId(h)
                    t = win32gui.GetWindowText(h)
                    cn = win32gui.GetClassName(h)
                    if (pid in phone_pids and ("call" in t.lower() or "incoming" in t.lower() or cn == "WinUIDesktopWin32WindowClass")) or "call on mobile" in t.lower():
                        call_hwnds.append(h)

            win32gui.EnumWindows(enum_cb, None)

            for h in call_hwnds:
                _force_window_foreground(h)
                time.sleep(0.1)
                pyautogui.press("enter")
                pyautogui.press("space")

            # 3. Reset ringing state
            with _monitor_lock:
                _incoming_call_state["ringing"] = False

            return True, "Incoming call accept ho gaya hai, boss."

        except Exception as exc:
            logger.error("Failed to answer incoming call: %s", exc)
            return False, f"Failed to answer incoming call: {exc}"

    @classmethod
    def reject_call(cls) -> Tuple[bool, str]:
        """
        Rejects / declines an incoming phone call or hangs up the active call.
        """
        try:
            import pyautogui
            import win32gui
            import win32process
            import psutil

            _ensure_default_desktop()

            # 1. Scan for Red End / Decline Call button anywhere on the screen
            r = None
            for _ in range(8):
                r = cls.find_red_call_button()
                if r:
                    logger.info("Found Red End/Decline Call button at (%d, %d). Clicking...", r[0], r[1])
                    pyautogui.click(r[0], r[1])
                    time.sleep(0.2)
                    break
                time.sleep(0.12)

            # 2. Secondary safeguard: Send Escape to Phone Link or active call window
            call_hwnds = []
            def enum_cb(h, _):
                if win32gui.IsWindowVisible(h):
                    t = win32gui.GetWindowText(h)
                    cn = win32gui.GetClassName(h)
                    if "Call on mobile device" in t or ("WinUI" in cn and "Phone" in t):
                        call_hwnds.append(h)

            win32gui.EnumWindows(enum_cb, None)

            for h in call_hwnds:
                _force_window_foreground(h)
                time.sleep(0.1)
                pyautogui.press("esc")

            pyautogui.press("esc")

            # 3. Dismiss incoming notification if ringing
            notif_id = _incoming_call_state.get("notification_id")
            if notif_id:
                try:
                    cls._dismiss_notification(notif_id)
                except Exception:
                    pass

            # Reset ringing state
            with _monitor_lock:
                _incoming_call_state["ringing"] = False

            return True, "Call cut / reject kar diya gaya hai, boss."

        except Exception as exc:
            logger.error("Failed to reject call: %s", exc)
            return False, f"Failed to reject call: {exc}"

            return True, "Call cut / reject kar diya gaya hai, boss."

        except Exception as exc:
            logger.error("Failed to reject call: %s", exc)
            return False, f"Failed to reject call: {exc}"

    @classmethod
    def get_incoming_call(cls) -> Dict[str, Any]:
        """Returns the current incoming call status."""
        with _monitor_lock:
            return dict(_incoming_call_state)

    @classmethod
    def _dismiss_notification(cls, notif_id: int):
        """Dismisses a toast notification using UserNotificationListener."""
        ps_code = f"""
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
}}[0]
function Await($t, $r) {{
    $asTask = $asTaskGeneric.MakeGenericMethod($r)
    $netTask = $asTask.Invoke($null, @($t))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}}
[Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$listener.RemoveNotification({notif_id})
"""
        subprocess.run(["powershell", "-NoProfile", "-Command", ps_code], capture_output=True, timeout=4)

    @classmethod
    def read_messages(cls, limit: int = 5) -> Tuple[bool, List[Dict[str, Any]], str]:
        """Opens Phone Link Messages section."""
        try:
            subprocess.Popen(["cmd", "/c", "start", "ms-phone:messages"], shell=True)
            time.sleep(1.0)
            msg_info = "Successfully opened Phone Link Messages interface on laptop."
            return True, [], msg_info
        except Exception as exc:
            return False, [], f"Failed to open Phone Link Messages: {exc}"

    @classmethod
    def transfer_files(
        cls,
        direction: str = "phone_to_laptop",
        file_name: Optional[str] = None,
        destination_folder: Optional[str] = None,
    ) -> Tuple[bool, Dict[str, Any], str]:
        """Transfers files or photos between Phone Link device and Laptop."""
        try:
            subprocess.Popen(["cmd", "/c", "start", "ms-phone:photos"], shell=True)

            target_dest = Path(destination_folder) if destination_folder else Path.home() / "Downloads"
            target_dest.mkdir(parents=True, exist_ok=True)

            transferred = []
            if cls.TEMP_MEDIA_DIR.exists():
                media_files = list(cls.TEMP_MEDIA_DIR.glob("*.*"))
                for mf in media_files:
                    if file_name and file_name.lower() not in mf.name.lower():
                        continue
                    dest_file = target_dest / mf.name
                    try:
                        shutil.copy2(mf, dest_file)
                        transferred.append(str(dest_file))
                    except Exception:
                        pass

            if transferred:
                summary_msg = f"Opened Phone Link File Transfer & synced {len(transferred)} recent media file(s) to '{target_dest}'."
            else:
                summary_msg = f"Opened Phone Link File Transfer interface. Target: '{target_dest}'."

            return True, {"transferred_files": transferred, "destination": str(target_dest)}, summary_msg
        except Exception as exc:
            return False, {}, f"Failed to execute file transfer via Phone Link: {exc}"

    @classmethod
    def _resolve_contact_phone(cls, contact_query: str) -> Optional[str]:
        """Resolves contact phone number from local whatsapp_contacts.json configuration."""
        try:
            _app_data = os.environ.get("ERA_APP_DATA", "")
            _candidates = [
                Path(os.path.join(_app_data, "config", "whatsapp_contacts.json")) if _app_data else None,
                Path(os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Local", "ERA", "config", "whatsapp_contacts.json")),
                Path(r"D:\era-voice-assistant\config\whatsapp_contacts.json"),
                Path(r"D:\era_agent\config\whatsapp_contacts.json"),
            ]
            contacts_file = next((p for p in _candidates if p and p.exists()), None)
            if contacts_file and contacts_file.exists():
                contacts = json.loads(contacts_file.read_text(encoding="utf-8"))
                raw_q = contact_query.strip().lower()
                clean_q = re.sub(r"\b(call|phone|lagao|laga|karo|kar|ko|pe|par|please)\b", "", raw_q).strip()
                if not clean_q:
                    clean_q = raw_q

                for c in contacts:
                    c_name = c.get("name", "").lower()
                    c_aliases = [a.lower() for a in c.get("aliases", [])]
                    c_phone = c.get("phone", "") or c.get("shortPhone", "")
                    if clean_q == c_name or clean_q in c_aliases:
                        return c_phone
                    if clean_q in c_name or any(clean_q in a for a in c_aliases) or (len(clean_q) >= 3 and c_name in clean_q):
                        return c_phone
        except Exception as exc:
            logger.debug("Contact lookup error: %s", exc)
        return None





def _check_incoming_call_notifications() -> Optional[Dict[str, Any]]:
    """Checks Windows UserNotificationListener for active incoming calls from Phone Link."""
    ps_code = r"""
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
}[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
[Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$notifications = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])

$results = @()
$now = Get-Date

foreach ($n in $notifications) {
    if ($n.AppInfo.DisplayInfo.DisplayName -match 'Phone Link|Your Phone') {
        $ageSeconds = ($now - $n.CreationTime.DateTime).TotalSeconds
        # 1. Ignore stale notifications older than 25 seconds
        if ($ageSeconds -gt 25.0) { continue }

        $texts = @()
        foreach ($b in $n.Notification.Visual.Bindings) {
            foreach ($t in $b.GetTextElements()) {
                if ($t.Text) { $texts += $t.Text.Trim() }
            }
        }
        $fullText = $texts -join " "

        # 2. Skip SMS, messages, balance alerts, and non-call notifications
        if ($fullText -match 'Charge:|Main-Bal|Validity|Reply to|Type a message|SMS|OTP|code|bal|balance') {
            continue
        }

        # 3. Must have explicit incoming call signature
        $hasCallSignature = $false
        foreach ($t in $texts) {
            if ($t -match '^(incoming(\s+voice|\s+video)?\s+call|ringing|is calling)$') {
                $hasCallSignature = $true
                break
            }
        }
        if (-not $hasCallSignature -and ($fullText -notmatch 'incoming call|incoming voice call|incoming video call')) {
            continue
        }

        $caller = if ($texts.Count -gt 0) { $texts[0] } else { "Unknown" }
        $results += [PSCustomObject]@{
            Id = $n.Id
            Caller = $caller
            Text = $fullText
            Age = [math]::Round($ageSeconds, 1)
        }
    }
}
$results | ConvertTo-Json -Compress
"""
    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_code],
            capture_output=True,
            text=True,
            timeout=5,
        )
        output = res.stdout.strip()
        if output:
            data = json.loads(output)
            if isinstance(data, list) and len(data) > 0:
                return data[0]
            elif isinstance(data, dict):
                return data
    except Exception as exc:
        logger.debug("Error checking incoming call notifications: %s", exc)
    return None


_announced_call_ids = set()

def _monitor_loop():
    """Background loop polling for incoming phone calls and triggering ERA proactive alerts."""
    import urllib.request

    last_notified_caller = ""
    last_notified_time = 0.0

    while True:
        try:
            call_info = _check_incoming_call_notifications()
            now = time.time()

            if call_info:
                caller = call_info.get("Caller", "Someone").strip()
                notif_id = call_info.get("Id")

                with _monitor_lock:
                    _incoming_call_state["ringing"] = True
                    _incoming_call_state["caller"] = caller
                    _incoming_call_state["timestamp"] = now
                    _incoming_call_state["notification_id"] = notif_id

                # Trigger announcement ONLY ONCE per unique incoming call notification ID
                if notif_id not in _announced_call_ids:
                    _announced_call_ids.add(notif_id)
                    if len(_announced_call_ids) > 100:
                        _announced_call_ids.clear()

                    last_notified_caller = caller
                    last_notified_time = now
                    logger.info("Incoming phone call detected from '%s' (ID: %s)!", caller, notif_id)

                    # Post to ERA Node server endpoint so ERA speaks in her natural voice
                    try:
                        req_data = json.dumps({"caller": caller}).encode("utf-8")
                        req = urllib.request.Request(
                            "http://127.0.0.1:3000/api/phone/incoming-call",
                            data=req_data,
                            headers={"Content-Type": "application/json"},
                        )
                        urllib.request.urlopen(req, timeout=2.0)
                    except Exception as e:
                        logger.debug("Failed to notify ERA server of incoming call: %s", e)

            else:
                with _monitor_lock:
                    if _incoming_call_state["ringing"] and (now - _incoming_call_state["timestamp"] > 3.0):
                        _incoming_call_state["ringing"] = False

        except Exception as exc:
            logger.debug("Monitor loop iteration error: %s", exc)

        time.sleep(1.2)


def start_incoming_call_monitor():
    """Starts the background incoming call detector thread."""
    global _incoming_monitor_started
    with _monitor_lock:
        if _incoming_monitor_started:
            return
        _incoming_monitor_started = True

    t = threading.Thread(target=_monitor_loop, daemon=True, name="PhoneLinkCallMonitor")
    t.start()
    logger.info("Phone Link Incoming Call Monitor started.")
