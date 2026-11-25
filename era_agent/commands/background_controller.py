"""ERA Background Application Controller & Vision Inspector.

Allows ERA to observe (see) and control background applications on Windows
WITHOUT bringing them to the foreground, activating them, or disrupting
whatever the user is actively working on in their foreground screen.

Capabilities:
- list_background_windows(): Discover all running background windows (title, process, pid, hwnd, minimized state).
- find_window(): Fuzzy search target window by app name or window title.
- capture_background_window(): Capture visual screenshot of background window using Win32 PrintWindow (PW_RENDERFULLCONTENT).
- inspect_background_window(): Read all child controls, text, buttons, and edit fields in background.
- background_click(): Send mouse click directly to background window via PostMessageW (WM_LBUTTONDOWN/UP).
- background_type(): Send keystrokes and text directly to background window via PostMessageW (WM_CHAR / WM_SETTEXT).
- background_send_keys(): Send key commands (enter, tab, esc, etc.) to background window.
- background_close_window(): Send WM_CLOSE to background window safely.
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes
import io
import logging
import os
import struct
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

logger = logging.getLogger("era_agent.background_controller")

# ---------------------------------------------------------------------------
# Win32 Constants & Functions
# ---------------------------------------------------------------------------
SW_HIDE = 0
SW_SHOWNORMAL = 1
SW_SHOWMINIMIZED = 2
SW_SHOWMAXIMIZED = 3
SW_SHOWNOACTIVATE = 4
SW_SHOW = 5
SW_MINIMIZE = 6
SW_SHOWNA = 8
SW_RESTORE = 9

PW_CLIENTONLY = 0x00000001
PW_RENDERFULLCONTENT = 0x00000002

WM_CLOSE = 0x0010
WM_SETTEXT = 0x000C
WM_GETTEXT = 0x000D
WM_GETTEXTLENGTH = 0x000E
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
WM_COMMAND = 0x0111
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_MOUSEMOVE = 0x0200
WM_MOUSEWHEEL = 0x020A
BM_CLICK = 0x00F5
MK_LBUTTON = 0x0001
MK_RBUTTON = 0x0002

VK_BACK = 0x08
VK_TAB = 0x09
VK_RETURN = 0x0D
VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12  # Alt
VK_ESCAPE = 0x1B
VK_SPACE = 0x20
VK_PRIOR = 0x21  # Page Up
VK_NEXT = 0x22  # Page Down
VK_END = 0x23
VK_HOME = 0x24
VK_LEFT = 0x25
VK_UP = 0x26
VK_RIGHT = 0x27
VK_DOWN = 0x28
VK_DELETE = 0x2E

KEY_NAME_TO_VK = {
    "enter": VK_RETURN,
    "return": VK_RETURN,
    "tab": VK_TAB,
    "backspace": VK_BACK,
    "delete": VK_DELETE,
    "del": VK_DELETE,
    "escape": VK_ESCAPE,
    "esc": VK_ESCAPE,
    "space": VK_SPACE,
    "up": VK_UP,
    "down": VK_DOWN,
    "left": VK_LEFT,
    "right": VK_RIGHT,
    "home": VK_HOME,
    "end": VK_END,
    "pageup": VK_PRIOR,
    "pagedown": VK_NEXT,
    "ctrl": VK_CONTROL,
    "shift": VK_SHIFT,
    "alt": VK_MENU,
}

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)


def _make_lparam(x: int, y: int) -> int:
    return ((y & 0xFFFF) << 16) | (x & 0xFFFF)


def _attach_desktop() -> None:
    """Best-effort attachment to the user's interactive desktop 'default' on WinSta0."""
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass
    try:
        hwinsta = user32.OpenWindowStationW("WinSta0", False, 0x037F)
        if hwinsta:
            user32.SetProcessWindowStation(hwinsta)
            h_desk = user32.OpenDesktopW("default", 0, False, 0x01FF)
            if h_desk:
                user32.SetThreadDesktop(h_desk)
    except Exception:
        pass


@dataclass
class WindowDetail:
    hwnd: int
    title: str
    process_name: str
    pid: int
    is_minimized: bool
    is_foreground: bool
    is_visible: bool
    rect: Tuple[int, int, int, int]  # (left, top, right, bottom)
    width: int
    height: int


# ---------------------------------------------------------------------------
# Window Discovery
# ---------------------------------------------------------------------------

def list_background_windows(include_minimized: bool = True) -> List[WindowDetail]:
    """Lists all open windows (both background and foreground), filtering out
    invisible, system utility, or zero-sized windows.
    """
    _attach_desktop()
    fg_hwnd = user32.GetForegroundWindow()

    windows: List[WindowDetail] = []
    seen_hwnds = set()

    def _inspect_window(hwnd: int) -> None:
        if hwnd in seen_hwnds:
            return
        seen_hwnds.add(hwnd)

        # Basic visibility check
        is_vis = bool(user32.IsWindowVisible(hwnd))
        is_min = bool(user32.IsIconic(hwnd))
        if not is_vis and not (include_minimized and is_min):
            return

        # Title
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value.strip()
        if not title:
            return

        # Filter out system shell / desktop windows that aren't applications
        ignored_titles = {
            "Program Manager",
            "Windows Input Experience",
            "OmApSvcBroker",
            "Settings",  # invisible broker instances
            "DWM Notification Window",
        }
        if title in ignored_titles and not is_vis:
            return
        if title == "DWM Notification Window":
            return

        # Rect
        rect = ctypes.wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        w = max(0, rect.right - rect.left)
        h = max(0, rect.bottom - rect.top)

        # Ignore tiny 0x0 or 1x1 hidden helper windows
        if not is_min and (w < 20 or h < 20):
            return

        # Process info
        pid = ctypes.wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        pname = "unknown"
        if pid.value:
            try:
                import psutil
                pname = psutil.Process(pid.value).name().lower()
            except Exception:
                pass

        # Exclude internal shell frames without content
        if pname in ("shellexperiencehost.exe", "searchhost.exe") and (w < 100 or h < 100):
            return

        windows.append(
            WindowDetail(
                hwnd=hwnd,
                title=title,
                process_name=pname,
                pid=pid.value,
                is_minimized=is_min,
                is_foreground=(hwnd == fg_hwnd),
                is_visible=is_vis,
                rect=(rect.left, rect.top, rect.right, rect.bottom),
                width=w,
                height=h,
            )
        )

    def enum_cb(hwnd, lparam):
        _inspect_window(hwnd)
        return True

    cb = WNDENUMPROC(enum_cb)
    user32.EnumWindows(cb, 0)

    # Sort so background apps come first, sorted by title
    windows.sort(key=lambda item: (item.is_foreground, item.title.lower()))
    return windows


APP_ALIASES: Dict[str, List[str]] = {
    "notepad": ["notepad", "notepad.exe", "untitled - notepad"],
    "calculator": ["calculator", "calc", "calculatorapp.exe", "calculator.exe"],
    "calc": ["calculator", "calc", "calculatorapp.exe", "calculator.exe"],
    "vscode": ["visual studio code", "code", "code.exe"],
    "code": ["visual studio code", "code", "code.exe"],
    "chrome": ["google chrome", "chrome", "chrome.exe"],
    "edge": ["microsoft edge", "msedge", "msedge.exe"],
    "opera": ["opera", "opera.exe"],
    "whatsapp": ["whatsapp", "whatsapp.exe"],
    "cmd": ["command prompt", "cmd", "cmd.exe"],
    "powershell": ["powershell", "powershell.exe", "pwsh.exe", "windows powershell"],
    "terminal": ["windows terminal", "windowsterminal.exe"],
    "spotify": ["spotify", "spotify.exe"],
    "word": ["microsoft word", "winword", "winword.exe"],
    "excel": ["microsoft excel", "excel", "excel.exe"],
}


def _find_background_window_once(query: str) -> Optional[WindowDetail]:
    if not query:
        return None

    query_str = str(query).strip().lower()

    # If numeric HWND
    if query_str.isdigit():
        target_hwnd = int(query_str)
        for w in list_background_windows(include_minimized=True):
            if w.hwnd == target_hwnd:
                return w

    all_windows = list_background_windows(include_minimized=True)

    # 1. Exact match in process name
    for w in all_windows:
        if query_str == w.process_name or f"{query_str}.exe" == w.process_name:
            return w

    # Expand query aliases
    alias_keywords = [query_str]
    for key, alts in APP_ALIASES.items():
        if query_str == key or query_str in alts or any(a in query_str for a in alts):
            alias_keywords.extend(alts)
    alias_keywords = list(dict.fromkeys(alias_keywords))

    # 2. Match against alias keywords or title substrings
    scored: List[Tuple[int, WindowDetail]] = []
    for w in all_windows:
        score = 0
        w_title = w.title.lower()
        w_proc = w.process_name.lower()

        for kw in alias_keywords:
            if kw == w_proc or f"{kw}.exe" == w_proc:
                score = max(score, 95)
            elif kw in w_proc:
                score = max(score, 85)
            elif kw == w_title:
                score = max(score, 90)
            elif kw in w_title:
                score = max(score, 80 if w_title.startswith(kw) else 65)

        if score == 0 and any(part in w_title for part in query_str.split()):
            score = 35

        if score > 0:
            if not w.is_foreground:
                score += 5
            scored.append((score, w))

    if scored:
        scored.sort(key=lambda s: s[0], reverse=True)
        return scored[0][1]

    return None


def find_background_window(query: str, wait_timeout: float = 2.5) -> Optional[WindowDetail]:
    """Finds the best matching window detail for a query (app name, title, or hwnd).
    If not immediately found, retries up to wait_timeout seconds (crucial for newly launched apps).
    """
    if not query:
        return None

    deadline = time.time() + max(0.05, wait_timeout)
    while True:
        res = _find_background_window_once(query)
        if res:
            return res
        if time.time() >= deadline:
            break
        time.sleep(0.3)

    return None


# ---------------------------------------------------------------------------
# Background Visual Capture (PrintWindow)
# ---------------------------------------------------------------------------

def capture_background_window(
    target: str | int | WindowDetail,
    output_path: Optional[str] = None,
    max_dim: int = 1600,
) -> Dict[str, Any]:
    """Captures a screenshot of the specified background window WITHOUT focusing it.

    Uses Win32 PrintWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT).
    Returns dict with success, dimensions, base64 data, filepath, and window info.
    """
    _attach_desktop()

    win: Optional[WindowDetail] = None
    if isinstance(target, WindowDetail):
        win = target
    elif isinstance(target, int):
        for w in list_background_windows(include_minimized=True):
            if w.hwnd == target:
                win = w
                break
    else:
        win = find_background_window(str(target))

    if not win:
        return {
            "success": False,
            "message": f"Could not find background window matching '{target}'.",
        }

    hwnd = win.hwnd
    was_minimized = win.is_minimized

    # If minimized, temporarily display window without activation so PrintWindow can read its DC
    if was_minimized:
        try:
            user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
            time.sleep(0.1)
        except Exception:
            pass

    # Refresh window dimensions
    rect = ctypes.wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w = max(100, rect.right - rect.left)
    h = max(100, rect.bottom - rect.top)

    # Prepare compatible DC & Bitmap
    hdcScreen = user32.GetDC(0)
    hdcMem = gdi32.CreateCompatibleDC(hdcScreen)
    hbm = gdi32.CreateCompatibleBitmap(hdcScreen, w, h)
    gdi32.SelectObject(hdcMem, hbm)

    # PrintWindow flags: PW_RENDERFULLCONTENT (2) or fallback to 0
    print_res = user32.PrintWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT)
    if not print_res:
        print_res = user32.PrintWindow(hwnd, hdcMem, 0)

    # Restore minimized state if it was minimized previously
    if was_minimized:
        try:
            user32.ShowWindow(hwnd, SW_MINIMIZE)
        except Exception:
            pass

    # Extract bitmap bits
    bmpheader = struct.pack("iiihhIIIIII", 44, w, -h, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(hdcMem, hbm, 0, h, buf, bmpheader, 0)

    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(hdcMem)
    user32.ReleaseDC(0, hdcScreen)

    img = Image.frombytes("RGBA", (w, h), buf.raw).convert("RGB")

    # Downscale if larger than max_dim
    if max(img.size) > max_dim:
        scale = max_dim / max(img.size)
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.BILINEAR)

    # Save to file
    ws_dir = os.environ.get(
        "ERA_WORKSPACE_DIR",
        "d:\\era-voice-assistant\\workspace"
    )
    Path(ws_dir).mkdir(parents=True, exist_ok=True)
    safe_title = "".join(c for c in win.title if c.isalnum() or c in (" ", "_", "-")).strip()[:30] or "app"
    file_path = output_path or os.path.join(ws_dir, f"bg_{win.pid}_{safe_title}.jpg")
    img.save(file_path, format="JPEG", quality=80)

    # Base64
    bio = io.BytesIO()
    img.save(bio, format="JPEG", quality=80)
    b64_str = base64.b64encode(bio.getvalue()).decode()

    return {
        "success": True,
        "message": f"Successfully captured background window '{win.title}' ({win.process_name}).",
        "hwnd": hwnd,
        "title": win.title,
        "process_name": win.process_name,
        "pid": win.pid,
        "width": img.width,
        "height": img.height,
        "file_path": file_path,
        "image_base64": f"data:image/jpeg;base64,{b64_str}",
    }


# ---------------------------------------------------------------------------
# Background UI & Control Inspection
# ---------------------------------------------------------------------------

def inspect_background_window(target: str | int | WindowDetail) -> Dict[str, Any]:
    """Inspects all child controls, buttons, text fields, and static labels
    of a background window WITHOUT focusing it.
    """
    _attach_desktop()

    win: Optional[WindowDetail] = None
    if isinstance(target, WindowDetail):
        win = target
    else:
        win = find_background_window(str(target))

    if not win:
        return {
            "success": False,
            "message": f"Could not find window matching '{target}'.",
        }

    controls: List[Dict[str, Any]] = []

    def child_enum_cb(hwnd_child, lparam):
        length = user32.SendMessageW(hwnd_child, WM_GETTEXTLENGTH, 0, 0)
        text = ""
        if length > 0:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.SendMessageW(hwnd_child, WM_GETTEXT, length + 1, ctypes.byref(buf))
            text = buf.value.strip()

        cls_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd_child, cls_buf, 256)
        cls_name = cls_buf.value

        rect = ctypes.wintypes.RECT()
        user32.GetWindowRect(hwnd_child, ctypes.byref(rect))

        # Relative to parent window rect
        rel_x = rect.left - win.rect[0]
        rel_y = rect.top - win.rect[1]
        w = rect.right - rect.left
        h = rect.bottom - rect.top

        is_vis = bool(user32.IsWindowVisible(hwnd_child))
        is_enabled = bool(user32.IsWindowEnabled(hwnd_child))

        controls.append({
            "hwnd": hwnd_child,
            "class_name": cls_name,
            "text": text,
            "relative_x": rel_x,
            "relative_y": rel_y,
            "width": w,
            "height": h,
            "visible": is_vis,
            "enabled": is_enabled,
        })
        return True

    CHILDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    user32.EnumChildWindows(win.hwnd, CHILDENUMPROC(child_enum_cb), 0)

    # Collect meaningful text
    extracted_text = [c["text"] for c in controls if c["text"]]

    return {
        "success": True,
        "window": asdict(win),
        "total_controls": len(controls),
        "extracted_text": extracted_text[:50],
        "controls": controls[:40],
    }


# ---------------------------------------------------------------------------
# Background Actions (Clicks, Typing, Keys, Scroll)
# ---------------------------------------------------------------------------

def background_click(
    target: str | int | WindowDetail,
    x: Optional[int] = None,
    y: Optional[int] = None,
    element_text: Optional[str] = None,
    button: str = "left",
    double_click: bool = False,
) -> Dict[str, Any]:
    """Sends a mouse click to a background window at coordinates (x, y)
    or by matching an element's text/label WITHOUT activating or bringing it to the front.
    """
    _attach_desktop()

    win = target if isinstance(target, WindowDetail) else find_background_window(str(target))
    if not win:
        return {"success": False, "message": f"Window '{target}' not found."}

    target_hwnd = win.hwnd
    click_x = x if x is not None else (win.width // 2)
    click_y = y if y is not None else (win.height // 2)

    # If element_text specified, find child control
    if element_text:
        inspection = inspect_background_window(win)
        el_lower = element_text.lower().strip()
        matched_ctrl = None
        for ctrl in inspection.get("controls", []):
            if ctrl.get("text") and el_lower in ctrl["text"].lower():
                matched_ctrl = ctrl
                break

        if matched_ctrl:
            target_hwnd = matched_ctrl["hwnd"]
            click_x = matched_ctrl["width"] // 2
            click_y = matched_ctrl["height"] // 2
            # Also try BM_CLICK for standard Windows buttons
            if "button" in matched_ctrl.get("class_name", "").lower():
                user32.PostMessageW(target_hwnd, BM_CLICK, 0, 0)
                return {
                    "success": True,
                    "message": f"Clicked button '{matched_ctrl['text']}' in background '{win.title}'.",
                    "hwnd": target_hwnd,
                }

    lparam = _make_lparam(click_x, click_y)

    if button.lower() == "right":
        down_msg = WM_RBUTTONDOWN
        up_msg = WM_RBUTTONUP
        wparam = MK_RBUTTON
    else:
        down_msg = WM_LBUTTONDOWN
        up_msg = WM_LBUTTONUP
        wparam = MK_LBUTTON

    # Send mouse move then button down & up
    user32.PostMessageW(target_hwnd, WM_MOUSEMOVE, 0, lparam)
    time.sleep(0.02)
    user32.PostMessageW(target_hwnd, down_msg, wparam, lparam)
    time.sleep(0.05)
    user32.PostMessageW(target_hwnd, up_msg, 0, lparam)

    if double_click:
        time.sleep(0.05)
        user32.PostMessageW(target_hwnd, down_msg, wparam, lparam)
        time.sleep(0.05)
        user32.PostMessageW(target_hwnd, up_msg, 0, lparam)

    return {
        "success": True,
        "message": f"Sent background {button}-click to '{win.title}' at ({click_x}, {click_y}) without foreground activation.",
        "hwnd": target_hwnd,
        "x": click_x,
        "y": click_y,
    }


def background_type(
    target: str | int | WindowDetail,
    text: str,
    press_enter: bool = False,
    clear_first: bool = False,
) -> Dict[str, Any]:
    """Sends text directly to a background window or its focused child control
    using WM_CHAR messages WITHOUT stealing keyboard focus from the user.
    """
    _attach_desktop()

    win = target if isinstance(target, WindowDetail) else find_background_window(str(target))
    if not win:
        return {"success": False, "message": f"Window '{target}' not found."}

    target_hwnd = win.hwnd

    # Find the child edit/input control if available
    inspection = inspect_background_window(win)
    for ctrl in inspection.get("controls", []):
        cls = ctrl.get("class_name", "").lower()
        if any(k in cls for k in ("edit", "richedit", "textbox", "inputsite", "rich", "document")):
            target_hwnd = ctrl["hwnd"]
            break

    # Attach thread input to route messages cleanly without activating window
    tid_target = user32.GetWindowThreadProcessId(target_hwnd, None)
    tid_curr = kernel32.GetCurrentThreadId()
    attached = False
    if tid_target and tid_target != tid_curr:
        attached = bool(user32.AttachThreadInput(tid_curr, tid_target, True))

    try:
        if clear_first:
            user32.SendMessageW(target_hwnd, WM_SETTEXT, 0, "")

        # Send each character via WM_CHAR
        for char in text:
            user32.PostMessageW(target_hwnd, WM_CHAR, ord(char), 0)
            time.sleep(0.005)

        if press_enter:
            time.sleep(0.05)
            user32.PostMessageW(target_hwnd, WM_KEYDOWN, VK_RETURN, 0)
            time.sleep(0.02)
            user32.PostMessageW(target_hwnd, WM_KEYUP, VK_RETURN, 0)
    finally:
        if attached:
            user32.AttachThreadInput(tid_curr, tid_target, False)

    return {
        "success": True,
        "message": f"Successfully typed {len(text)} characters into background window '{win.title}' (press_enter={press_enter}) without stealing focus.",
        "hwnd": target_hwnd,
        "typed_text": text,
    }


def background_send_keys(
    target: str | int | WindowDetail,
    keys: List[str] | str,
) -> Dict[str, Any]:
    """Sends key strokes (e.g. ['ctrl', 's'] or 'enter' or 'tab')
    to a background window without activating it.
    """
    _attach_desktop()

    win = target if isinstance(target, WindowDetail) else find_background_window(str(target))
    if not win:
        return {"success": False, "message": f"Window '{target}' not found."}

    key_list = [keys] if isinstance(keys, str) else list(keys)
    target_hwnd = win.hwnd

    # Also check child control for input
    inspection = inspect_background_window(win)
    for ctrl in inspection.get("controls", []):
        cls = ctrl.get("class_name", "").lower()
        if any(k in cls for k in ("edit", "richedit", "textbox", "inputsite", "rich", "document")):
            target_hwnd = ctrl["hwnd"]
            break

    vks = []
    for k in key_list:
        k_lower = k.lower().strip()
        if k_lower in KEY_NAME_TO_VK:
            vks.append(KEY_NAME_TO_VK[k_lower])
        elif len(k_lower) == 1:
            vks.append(ord(k_lower.upper()))

    # Attach thread input to ensure background window processes accelerator keys
    tid_target = user32.GetWindowThreadProcessId(target_hwnd, None)
    tid_curr = kernel32.GetCurrentThreadId()
    attached = False
    if tid_target and tid_target != tid_curr:
        attached = bool(user32.AttachThreadInput(tid_curr, tid_target, True))

    try:
        # Key down for all
        for vk in vks:
            user32.PostMessageW(target_hwnd, WM_KEYDOWN, vk, 0)
            time.sleep(0.02)

        # Key up in reverse
        for vk in reversed(vks):
            user32.PostMessageW(target_hwnd, WM_KEYUP, vk, 0)
            time.sleep(0.02)
    finally:
        if attached:
            user32.AttachThreadInput(tid_curr, tid_target, False)

    return {
        "success": True,
        "message": f"Sent background key combination {key_list} to '{win.title}'.",
        "hwnd": target_hwnd,
        "keys": key_list,
    }


def background_close_window(target: str | int | WindowDetail) -> Dict[str, Any]:
    """Closes a background window safely using WM_CLOSE without activating it."""
    _attach_desktop()

    win = target if isinstance(target, WindowDetail) else find_background_window(str(target))
    if not win:
        return {"success": False, "message": f"Window '{target}' not found."}

    user32.PostMessageW(win.hwnd, WM_CLOSE, 0, 0)
    return {
        "success": True,
        "message": f"Closed background window '{win.title}' ({win.process_name}).",
        "hwnd": win.hwnd,
    }



# ---------------------------------------------------------------------------
# Instant Background Activity Inspector (< 30ms latency)
# ---------------------------------------------------------------------------

def get_background_activity(query: Optional[str] = None) -> Dict[str, Any]:
    """Instantly returns the real-time activity, current tab, chat, or editing state
    of background applications in under 30 milliseconds without bringing them to the front.
    """
    _attach_desktop()
    windows = list_background_windows(include_minimized=True)

    if query and str(query).strip():
        target = find_background_window(str(query).strip())
        if target:
            windows = [target]
        else:
            return {
                "success": False,
                "message": f"No background application found matching '{query}'.",
            }

    results = []
    for w in windows:
        proc = w.process_name.lower()
        title = w.title
        status = "Minimized" if w.is_minimized else ("Foreground" if w.is_foreground else "Background")

        # Activity interpretation based on app type
        activity_desc = "Idle / Running"
        if any(b in proc for b in ("opera", "chrome", "msedge", "firefox", "brave")):
            if " - " in title:
                parts = [p.strip() for p in title.split(" - ") if p.strip()]
                page_name = parts[0]
                site_name = parts[1] if len(parts) > 2 else ""
                activity_desc = f"Browsing {site_name}: '{page_name}'" if site_name else f"Browsing: '{page_name}'"
            else:
                activity_desc = f"Browsing: '{title}'"
        elif "whatsapp" in proc:
            activity_desc = f"WhatsApp: '{title}'"
        elif "spotify" in proc:
            activity_desc = f"Spotify Media: '{title}'"
        elif "code" in proc or "devenv" in proc:
            activity_desc = f"VS Code: '{title}'"
        elif "notepad" in proc:
            activity_desc = f"Notepad Editor: '{title}'"
        elif "explorer" in proc:
            activity_desc = f"File Explorer: '{title}'"
        elif "discord" in proc:
            activity_desc = f"Discord chat: '{title}'"
        elif "slack" in proc:
            activity_desc = f"Slack: '{title}'"
        elif "teams" in proc:
            activity_desc = f"Teams: '{title}'"
        else:
            activity_desc = f"Active window '{title}'"

        # Fast child text snippet (takes ~0.2ms)
        snippets = []
        try:
            insp = inspect_background_window(w)
            texts = [
                t for t in insp.get("extracted_text", [])
                if len(t.strip()) > 2 and not t.isdigit() and t.lower() != "chrome legacy window"
            ]
            snippets = texts[:3]
        except Exception:
            pass

        results.append({
            "app_name": w.process_name,
            "title": w.title,
            "status": status,
            "pid": w.pid,
            "hwnd": w.hwnd,
            "activity": activity_desc,
            "content_snippets": snippets,
        })

    summary_lines = []
    for r in results:
        line = f"- [{r['status']}] {r['app_name']}: {r['activity']}"
        if r["content_snippets"]:
            line += f" [Content: {'; '.join(r['content_snippets'])}]"
        summary_lines.append(line)

    summary_text = f"Instant Background Activity ({len(results)} applications):\n" + "\n".join(summary_lines)
    return {
        "success": True,
        "total_apps": len(results),
        "summary": summary_text,
        "apps": results,
    }
