import ctypes
import time
import win32gui
import pyautogui
from PIL import ImageGrab

user32 = ctypes.windll.user32
h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
user32.SetThreadDesktop(h_desk)

hwnds = []
def cb(hwnd, _):
    if win32gui.IsWindowVisible(hwnd):
        cn = win32gui.GetClassName(hwnd)
        t = win32gui.GetWindowText(hwnd)
        if "WinUI" in cn and ("Phone" in t or "Link" in t):
            hwnds.append(hwnd)

win32gui.EnumWindows(cb, None)
phone_hwnd = hwnds[0] if hwnds else None

if phone_hwnd:
    user32.keybd_event(0x12, 0, 0, 0)
    user32.keybd_event(0x12, 0, 2, 0)
    win32gui.ShowWindow(phone_hwnd, 9)
    win32gui.SetForegroundWindow(phone_hwnd)
    time.sleep(0.3)

    rect = win32gui.GetWindowRect(phone_hwnd)
    left, top, right, bottom = rect
    width = right - left
    height = bottom - top

    call_btn_x = left + int(width * 0.588)
    call_btn_y = top + int(height * 0.789)
    print(f"Clicking Green Call Button at ({call_btn_x}, {call_btn_y})...")
    pyautogui.click(call_btn_x, call_btn_y)
    time.sleep(1.5)

im = ImageGrab.grab()
im.save(r"D:\era_agent\scripts\calling_screen.png")
print("Saved calling_screen.png")
