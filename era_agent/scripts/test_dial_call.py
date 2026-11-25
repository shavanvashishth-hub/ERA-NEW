import ctypes
import os
import time
import win32gui
import pyautogui
from PIL import ImageGrab

user32 = ctypes.windll.user32
h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
user32.SetThreadDesktop(h_desk)

print("Dialing tel:8650685881 via protocol...")
os.system("start tel:8650685881")
time.sleep(2.0)

# Find Phone Link window
hwnds = []
def cb(hwnd, _):
    if win32gui.IsWindowVisible(hwnd):
        cn = win32gui.GetClassName(hwnd)
        t = win32gui.GetWindowText(hwnd)
        if "WinUI" in cn and ("Phone" in t or "Link" in t):
            hwnds.append(hwnd)

win32gui.EnumWindows(cb, None)
phone_hwnd = hwnds[0] if hwnds else None
print("Phone HWND:", phone_hwnd)

if phone_hwnd:
    # Bring to foreground
    user32.keybd_event(0x12, 0, 0, 0)
    user32.keybd_event(0x12, 0, 2, 0)
    win32gui.ShowWindow(phone_hwnd, 9)
    win32gui.SetForegroundWindow(phone_hwnd)
    time.sleep(0.4)

    rect = win32gui.GetWindowRect(phone_hwnd)
    left, top, right, bottom = rect
    width = right - left
    height = bottom - top
    print(f"Phone Link Rect: left={left}, top={top}, width={width}, height={height}")

    # The green call button is at left + width * 0.495, top + height * 0.865
    btn_x = int(left + width * 0.495)
    btn_y = int(top + height * 0.865)
    print(f"Clicking Call button at ({btn_x}, {btn_y}) and pressing Enter...")
    pyautogui.click(btn_x, btn_y)
    pyautogui.press("enter")
    time.sleep(1.5)

im = ImageGrab.grab()
im.save(r"D:\era_agent\scripts\dial_call_result.png")
print("Saved D:\\era_agent\\scripts\\dial_call_result.png")
