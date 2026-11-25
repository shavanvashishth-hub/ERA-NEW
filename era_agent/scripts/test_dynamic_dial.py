import ctypes
import os
import time
import win32gui
import pyautogui
from PIL import ImageGrab

user32 = ctypes.windll.user32
h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
if h_desk:
    user32.SetThreadDesktop(h_desk)

def find_green_call_button(bbox=None):
    im = ImageGrab.grab(bbox=bbox)
    offset_x = bbox[0] if bbox else 0
    offset_y = bbox[1] if bbox else 0
    
    green_pixels = []
    width, height = im.size
    for y in range(height):
        for x in range(width):
            r, g, b = im.getpixel((x, y))[:3]
            if g > 110 and r < 60 and b < 60:
                green_pixels.append((x + offset_x, y + offset_y))

    if len(green_pixels) >= 30:
        xs = [p[0] for p in green_pixels]
        ys = [p[1] for p in green_pixels]
        cx = (min(xs) + max(xs)) // 2
        cy = (min(ys) + max(ys)) // 2
        return cx, cy, len(green_pixels)
    return None

print("Launching tel:8650685881...")
os.system("start tel:8650685881")
time.sleep(1.2)

# Focus window
hwnds = []
def cb(hwnd, _):
    if win32gui.IsWindowVisible(hwnd):
        cn = win32gui.GetClassName(hwnd)
        t = win32gui.GetWindowText(hwnd)
        if "WinUI" in cn and ("Phone" in t or "Link" in t):
            hwnds.append(hwnd)

win32gui.EnumWindows(cb, None)
if hwnds:
    h = hwnds[0]
    user32.keybd_event(0x12, 0, 0, 0)
    user32.keybd_event(0x12, 0, 2, 0)
    win32gui.ShowWindow(h, 9)
    win32gui.SetForegroundWindow(h)
    time.sleep(0.3)

# Search for the green button for up to 3 seconds
btn = None
for attempt in range(10):
    btn = find_green_call_button()
    if btn:
        print(f"Found green button at ({btn[0]}, {btn[1]}) on attempt {attempt+1} with {btn[2]} pixels!")
        break
    time.sleep(0.3)

if btn:
    cx, cy, _ = btn
    print(f"Clicking green call button at ({cx}, {cy})...")
    pyautogui.click(cx, cy)
    time.sleep(0.2)
    pyautogui.press("enter")
    time.sleep(1.5)
    
    # Save proof
    im = ImageGrab.grab()
    im.save(r"D:\era_agent\scripts\dynamic_dial_proof.png")
    print("Saved dynamic_dial_proof.png!")
    
    # End call immediately
    pyautogui.click(242, 158)
    pyautogui.press("esc")
    print("Ended test call.")
else:
    print("Error: Green call button was not detected!")
