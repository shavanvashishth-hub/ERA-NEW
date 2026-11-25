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

print("Testing green button detection...")
btn = find_green_call_button()
print("Result on current screen:", btn)
