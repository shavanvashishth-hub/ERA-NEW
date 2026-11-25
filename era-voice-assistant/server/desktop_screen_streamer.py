"""
ERA Desktop Screen Streamer - v3 (High-Speed Continuous Video Feed)
Captures physical Windows desktop using GDI BitBlt + GetDIBits on the interactive 'default' desktop.
Streams compressed JPEG frames (~35KB) + active foreground window telemetry every 1 second to ERA server.
"""

import os
import sys
import time
import struct
import ctypes
import io
import subprocess
import base64
import signal
import json
import logging
from ctypes import wintypes

# ─── Paths ──────────────────────────────────────────────────────────────────
WORKSPACE_DIR = os.environ.get(
    "ERA_WORKSPACE_DIR",
    os.path.join(os.environ.get("LOCALAPPDATA", os.environ.get("USERPROFILE", os.getcwd())), "ERA", "workspace")
)
os.makedirs(WORKSPACE_DIR, exist_ok=True)

CURRENT_SCREEN_PNG = os.path.join(WORKSPACE_DIR, "current_screen.png")
CURRENT_SCREEN_JPG = os.path.join(WORKSPACE_DIR, "current_screen.jpg")
UPLOAD_URL = "http://127.0.0.1:3000/api/screen/upload"
CAPTURE_INTERVAL = 1.0   # 1 frame per second (Gemini Live recommended video rate)
LOG_FILE = os.path.join(WORKSPACE_DIR, "streamer.log")
PID_FILE = os.path.join(WORKSPACE_DIR, "streamer.pid")
TASK_NAME = "ERA_ScreenStreamer"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [ScreenStreamer] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
    ]
)
log = logging.getLogger("streamer")

# ─── Windows API ─────────────────────────────────────────────────────────────
user32 = ctypes.windll.user32
gdi32  = ctypes.windll.gdi32

# 64-bit safe handles
user32.GetDC.restype                 = ctypes.c_void_p
user32.GetDC.argtypes                = [ctypes.c_void_p]
user32.ReleaseDC.restype             = ctypes.c_int
user32.ReleaseDC.argtypes            = [ctypes.c_void_p, ctypes.c_void_p]
user32.GetSystemMetrics.restype      = ctypes.c_int
user32.GetSystemMetrics.argtypes     = [ctypes.c_int]
gdi32.CreateCompatibleDC.restype     = ctypes.c_void_p
gdi32.CreateCompatibleDC.argtypes    = [ctypes.c_void_p]
gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
gdi32.SelectObject.restype           = ctypes.c_void_p
gdi32.SelectObject.argtypes          = [ctypes.c_void_p, ctypes.c_void_p]
gdi32.BitBlt.restype                 = wintypes.BOOL
gdi32.BitBlt.argtypes                = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                        ctypes.c_int, ctypes.c_int, ctypes.c_void_p,
                                        ctypes.c_int, ctypes.c_int, wintypes.DWORD]
gdi32.DeleteDC.restype               = wintypes.BOOL
gdi32.DeleteDC.argtypes              = [ctypes.c_void_p]
gdi32.DeleteObject.restype           = wintypes.BOOL
gdi32.DeleteObject.argtypes          = [ctypes.c_void_p]
gdi32.GetDIBits.restype              = ctypes.c_int
gdi32.GetDIBits.argtypes             = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]


def get_foreground_window_info() -> tuple[str, str]:
    """Returns (title, process_name) of the active foreground window in real time."""
    try:
        h_desk = user32.OpenDesktopW("default", 0, False, 0x01FF)
        if h_desk:
            user32.SetThreadDesktop(h_desk)

        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return ("Desktop", "explorer.exe")

        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value.strip() or "Desktop"

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        proc_name = "unknown"
        if pid.value:
            try:
                import psutil
                proc_name = psutil.Process(pid.value).name()
            except Exception:
                pass
        return (title, proc_name)
    except Exception:
        return ("Desktop", "explorer.exe")


def capture_screen_gdi():
    """
    Capture the physical desktop using GDI BitBlt + GetDIBits on the user's interactive 'default' desktop.
    Returns (raw RGBA bytes, width, height) or None on failure.
    """
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

    try:
        h_desk = user32.OpenDesktopW("default", 0, False, 0x01FF)
        if h_desk:
            user32.SetThreadDesktop(h_desk)
    except Exception:
        pass

    w = user32.GetSystemMetrics(0) or 1920
    h = user32.GetSystemMetrics(1) or 1080

    try:
        hdcScreen = user32.GetDC(0)
        if not hdcScreen:
            return None
        hdcMem = gdi32.CreateCompatibleDC(hdcScreen)
        hbm = gdi32.CreateCompatibleBitmap(hdcScreen, w, h)
        gdi32.SelectObject(hdcMem, hbm)
        gdi32.BitBlt(hdcMem, 0, 0, w, h, hdcScreen, 0, 0, 0x00CC0020)

        bmpheader = struct.pack('iiihhIIIIII', 44, w, -h, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
        buf = ctypes.create_string_buffer(w * h * 4)
        gdi32.GetDIBits(hdcMem, hbm, 0, h, buf, bmpheader, 0)

        gdi32.DeleteObject(hbm)
        gdi32.DeleteDC(hdcMem)
        user32.ReleaseDC(0, hdcScreen)

        return buf.raw, w, h
    except Exception as exc:
        log.warning(f"GDI capture exception: {exc}")
        return None


def bgra_to_jpeg_bytes(raw_bgra: bytes, w: int, h: int, quality: int = 70) -> bytes | None:
    """Convert raw BGRA bytes to compressed JPEG using PIL."""
    try:
        from PIL import Image
        img = Image.frombytes("RGBA", (w, h), raw_bgra, "raw", "BGRA").convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=False)
        return buf.getvalue()
    except Exception as e:
        log.warning(f"JPEG encode error: {e}")
        return None


def bgra_to_png_bytes(raw_bgra: bytes, w: int, h: int) -> bytes | None:
    """Convert raw BGRA bytes to PNG."""
    try:
        from PIL import Image
        img = Image.frombytes("RGBA", (w, h), raw_bgra, "raw", "BGRA").convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False)
        return buf.getvalue()
    except Exception:
        return None


def check_image_valid(data: bytes) -> bool:
    """Return True if image has valid non-black content."""
    try:
        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(data))
        pixels = list(img.get_flattened_data() if hasattr(img, 'get_flattened_data') else img.getdata())
        step = max(1, len(pixels) // 50)
        sampled = pixels[::step]
        non_black = sum(1 for p in sampled if (p[0] if isinstance(p, tuple) else p) > 5)
        return non_black > 5
    except Exception:
        return len(data) > 10000


def upload_frame(jpeg_bytes: bytes, window_info: tuple[str, str]) -> bool:
    """Upload JPEG frame + active window telemetry to ERA server /api/screen/upload."""
    try:
        import urllib.request
        b64 = base64.b64encode(jpeg_bytes).decode()
        data_url = f"data:image/jpeg;base64,{b64}"
        payload = json.dumps({
            "image": data_url,
            "frameData": data_url,
            "mimeType": "image/jpeg",
            "source": "desktop_streamer",
            "window": {
                "title": window_info[0],
                "process": window_info[1]
            },
            "timestamp": time.time()
        }).encode()
        req = urllib.request.Request(
            UPLOAD_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def save_to_disk(jpeg_bytes: bytes, png_bytes: bytes | None = None):
    """Atomically save JPEG and PNG frames to workspace."""
    # Save JPEG
    try:
        tmp_jpg = CURRENT_SCREEN_JPG + ".tmp"
        with open(tmp_jpg, "wb") as f:
            f.write(jpeg_bytes)
        if os.path.exists(CURRENT_SCREEN_JPG):
            try: os.remove(CURRENT_SCREEN_JPG)
            except Exception: pass
        os.rename(tmp_jpg, CURRENT_SCREEN_JPG)
    except Exception:
        pass

    # Save PNG
    if png_bytes:
        try:
            tmp_png = CURRENT_SCREEN_PNG + ".tmp"
            with open(tmp_png, "wb") as f:
                f.write(png_bytes)
            if os.path.exists(CURRENT_SCREEN_PNG):
                try: os.remove(CURRENT_SCREEN_PNG)
                except Exception: pass
            os.rename(tmp_png, CURRENT_SCREEN_PNG)
        except Exception:
            pass


def run_capture_loop():
    """Main continuous 1-second capture loop."""
    log.info(f"Screen streamer active (1 FPS continuous video mode). Workspace: {WORKSPACE_DIR}")

    try:
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass

    consecutive_black = 0
    frames_captured = 0
    last_upload = 0

    def _shutdown(sig, frame):
        log.info("Shutdown signal received.")
        try:
            os.remove(PID_FILE)
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    while True:
        t0 = time.time()
        try:
            result = capture_screen_gdi()
            if result is None:
                consecutive_black += 1
                time.sleep(CAPTURE_INTERVAL)
                continue

            raw_bgra, w, h = result
            jpeg_bytes = bgra_to_jpeg_bytes(raw_bgra, w, h, quality=70)

            if jpeg_bytes is None:
                time.sleep(CAPTURE_INTERVAL)
                continue

            valid = check_image_valid(jpeg_bytes)
            if not valid:
                consecutive_black += 1
                if consecutive_black <= 3 or consecutive_black % 15 == 0:
                    log.warning(f"Black/invalid frame #{consecutive_black} — screen may be locked")
                time.sleep(CAPTURE_INTERVAL)
                continue

            consecutive_black = 0
            frames_captured += 1

            window_info = get_foreground_window_info()

            # Save JPEG every cycle, PNG every 5 cycles
            png_bytes = bgra_to_png_bytes(raw_bgra, w, h) if (frames_captured % 5 == 1) else None
            save_to_disk(jpeg_bytes, png_bytes)

            now = time.time()
            if now - last_upload >= 1.0:   # upload every 1 second
                if upload_frame(jpeg_bytes, window_info):
                    last_upload = now

            if frames_captured % 30 == 1:
                log.info(f"Streamed frame #{frames_captured}, size={len(jpeg_bytes)//1024}KB, {w}x{h}, window='{window_info[0][:30]}'")

        except Exception as e:
            log.error(f"Capture error: {e}", exc_info=True)

        elapsed = time.time() - t0
        sleep_time = max(0.05, CAPTURE_INTERVAL - elapsed)
        time.sleep(sleep_time)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        arg = sys.argv[1].lower()
        if arg == "--capture-once":
            result = capture_screen_gdi()
            if result:
                raw, w, h = result
                jpeg = bgra_to_jpeg_bytes(raw, w, h, quality=75)
                png = bgra_to_png_bytes(raw, w, h)
                win = get_foreground_window_info()
                if jpeg and check_image_valid(jpeg):
                    save_to_disk(jpeg, png)
                    print(f"OK: {len(jpeg)//1024}KB, {w}x{h}, window='{win[0]}'")
                else:
                    print("FAILED: black/invalid image")
            else:
                print("FAILED: GDI returned None")
            sys.exit(0)
        else:
            print("Usage: desktop_screen_streamer.py [--capture-once]")
    else:
        run_capture_loop()
