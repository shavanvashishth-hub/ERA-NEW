import ctypes
import os
import time
import win32gui
import pyautogui
from PIL import ImageGrab

user32 = ctypes.windll.user32
h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
user32.SetThreadDesktop(h_desk)

number = "8650685881"
print(f"Triggering start tel:{number}...")
os.system(f"start tel:{number}")

# Wait up to 3 seconds for Phone Link window to appear
phone_hwnd = None
for i in range(15):
    time.sleep(0.2)
    hwnds = []
    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            cn = win32gui.GetClassName(hwnd)
            t = win32gui.GetWindowText(hwnd)
            if "WinUI" in cn and ("Phone" in t or "Link" in t):
                hwnds.append(hwnd)
    win32gui.EnumWindows(cb, None)
    if hwnds:
        phone_hwnd = hwnds[0]
        print(f"Found Phone Link HWND {phone_hwnd} on attempt {i+1}")
        break

if not phone_hwnd:
    print("Error: Phone Link window not found!")
    exit(1)

# Ensure foreground
user32.keybd_event(0x12, 0, 0, 0)
user32.keybd_event(0x12, 0, 2, 0)
win32gui.ShowWindow(phone_hwnd, 9)
win32gui.SetForegroundWindow(phone_hwnd)
win32gui.BringWindowToTop(phone_hwnd)
time.sleep(0.5)

rect = win32gui.GetWindowRect(phone_hwnd)
left, top, right, bottom = rect
width = right - left
height = bottom - top
print(f"Phone Link Rect: left={left}, top={top}, width={width}, height={height}")

call_btn_x = left + int(width * 0.588)
call_btn_y = top + int(height * 0.789)
print(f"Clicking Green Call Button at ({call_btn_x}, {call_btn_y})...")
pyautogui.click(call_btn_x, call_btn_y)
time.sleep(0.2)
pyautogui.press("enter")

time.sleep(1.5)
im = ImageGrab.grab()
im.save(r"D:\era_agent\scripts\call_placed.png")
print("Saved call_placed.png!")
