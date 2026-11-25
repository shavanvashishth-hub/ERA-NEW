import ctypes
import os
import subprocess
import time
import win32gui
from PIL import ImageGrab

user32 = ctypes.windll.user32
h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
user32.SetThreadDesktop(h_desk)

print("Launching start tel:8650685881...")
os.system("start tel:8650685881")
time.sleep(2)

im = ImageGrab.grab()
im.save(r"D:\era_agent\scripts\test_tel_protocol.png")
print("Saved tel protocol screenshot!")
