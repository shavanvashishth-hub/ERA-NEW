import ctypes
import time
import win32gui
from PIL import ImageGrab

user32 = ctypes.windll.user32
h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
user32.SetThreadDesktop(h_desk)

def bring_to_front():
    phone_hwnd = None
    def enum_cb(h, _):
        nonlocal phone_hwnd
        if win32gui.GetClassName(h) == "WinUIDesktopWin32WindowClass" and "Phone Link" in win32gui.GetWindowText(h):
            phone_hwnd = h
    win32gui.EnumWindows(enum_cb, None)
    
    if phone_hwnd:
        print("Found Phone Link HWND:", phone_hwnd)
        user32.ShowWindow(phone_hwnd, 9) # SW_RESTORE
        user32.SetForegroundWindow(phone_hwnd)
        time.sleep(1)
        im = ImageGrab.grab()
        im.save(r"D:\era_agent\scripts\test_out\phone_link_foreground.png")
        print("Brought to front and saved screenshot!")
    else:
        print("Phone Link window not found!")

bring_to_front()
