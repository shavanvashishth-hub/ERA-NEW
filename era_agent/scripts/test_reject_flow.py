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

def find_red_call_button():
    im = ImageGrab.grab()
    red_points = []
    width, height = im.size
    for y in range(height):
        for x in range(width):
            r, g, b = im.getpixel((x, y))[:3]
            if r > 170 and g < 55 and b < 55:
                red_points.append((x, y))

    clusters = []
    for pt in red_points:
        found = False
        for cl in clusters:
            cx, cy = cl["cx"], cl["cy"]
            if abs(pt[0] - cx) < 40 and abs(pt[1] - cy) < 40:
                cl["pts"].append(pt)
                cl["cx"] = sum(p[0] for p in cl["pts"]) // len(cl["pts"])
                cl["cy"] = sum(p[1] for p in cl["pts"]) // len(cl["pts"])
                found = True
                break
        if not found:
            clusters.append({"cx": pt[0], "cy": pt[1], "pts": [pt]})

    valid = [c for c in clusters if len(c["pts"]) >= 80]
    valid.sort(key=lambda c: len(c["pts"]), reverse=True)
    if valid:
        return valid[0]["cx"], valid[0]["cy"], len(valid[0]["pts"])
    return None

def find_green_call_button():
    im = ImageGrab.grab()
    green_pixels = []
    width, height = im.size
    for y in range(height):
        for x in range(width):
            r, g, b = im.getpixel((x, y))[:3]
            if g > 110 and r < 60 and b < 60:
                green_pixels.append((x, y))

    clusters = []
    for pt in green_pixels:
        found = False
        for cl in clusters:
            cx, cy = cl["cx"], cl["cy"]
            if abs(pt[0] - cx) < 40 and abs(pt[1] - cy) < 40:
                cl["pts"].append(pt)
                cl["cx"] = sum(p[0] for p in cl["pts"]) // len(cl["pts"])
                cl["cy"] = sum(p[1] for p in cl["pts"]) // len(cl["pts"])
                found = True
                break
        if not found:
            clusters.append({"cx": pt[0], "cy": pt[1], "pts": [pt]})

    valid = [c for c in clusters if len(c["pts"]) >= 50]
    valid.sort(key=lambda c: len(c["pts"]), reverse=True)
    if valid:
        return valid[0]["cx"], valid[0]["cy"], len(valid[0]["pts"])
    return None

print("Step 1: Dialing tel:8650685881...")
os.system("start tel:8650685881")
time.sleep(1.2)

# Find and click Green button
for _ in range(10):
    g = find_green_call_button()
    if g:
        print(f"Clicking Green Button at ({g[0]}, {g[1]})...")
        pyautogui.click(g[0], g[1])
        pyautogui.press("enter")
        break
    time.sleep(0.2)

time.sleep(1.5)

# Step 2: Now find and click Red Button to reject/hang up!
print("Step 2: Searching for Red End Button...")
r = None
for _ in range(10):
    r = find_red_call_button()
    if r:
        print(f"Found Red Button at ({r[0]}, {r[1]}) with {r[2]} pixels! Clicking to hang up...")
        pyautogui.click(r[0], r[1])
        time.sleep(0.2)
        break
    time.sleep(0.2)

if not r:
    print("Red button not found via color, sending Esc...")
    pyautogui.press("esc")

time.sleep(1.0)
im_after = ImageGrab.grab()
im_after.save(r"D:\era_agent\scripts\after_hangup_proof.png")
print("Saved after_hangup_proof.png!")
