from pathlib import Path

path = Path(r"d:\era_agent\commands\system_commands.py")
content = path.read_text(encoding="utf-8")

new_find_window = '''def _find_window_for_app(app_name: str) -> Optional[int]:
    """Locates the HWND for an application window by app name, process name, or title with guaranteed multi-pass fallback."""
    if not app_name:
        return None
    app_clean = str(app_name).strip().lower()

    user32 = ctypes.windll.user32
    if app_clean in ("active", "current", "this", "foreground", ""):
        fg = user32.GetForegroundWindow()
        if fg and user32.IsWindow(fg):
            return fg
        top = _get_top_app_windows(1)
        return top[0] if top else None

    title_aliases = {
        "vscode": ["code", "visual studio code", "vscode"],
        "vs code": ["code", "visual studio code", "vscode"],
        "code": ["code", "visual studio code", "vscode"],
        "visual studio code": ["code", "visual studio code", "vscode"],
        "vs": ["code", "visual studio code", "vscode"],
        "visual studio": ["code", "visual studio code", "vscode"],
        "chrome": ["chrome", "google chrome"],
        "google chrome": ["chrome", "google chrome"],
        "google": ["chrome", "google chrome"],
        "browser": ["opera", "chrome", "edge", "firefox", "operagx"],
        "edge": ["msedge", "microsoft edge", "edge"],
        "microsoft edge": ["msedge", "microsoft edge", "edge"],
        "msedge": ["msedge", "microsoft edge", "edge"],
        "whatsapp": ["whatsapp"],
        "notepad": ["notepad"],
        "notes": ["notepad"],
        "text editor": ["notepad"],
        "calc": ["calculator"],
        "calculator": ["calculator"],
        "explorer": ["explorer", "file explorer"],
        "file explorer": ["explorer", "file explorer"],
        "files": ["explorer", "file explorer"],
        "this pc": ["explorer", "this pc", "file explorer"],
        "my computer": ["explorer", "this pc", "file explorer"],
        "spotify": ["spotify"],
        "discord": ["discord"],
        "opera": ["opera", "operagx"],
        "operagx": ["opera", "operagx"],
        "opera gx": ["opera", "operagx"],
    }
    targets = title_aliases.get(app_clean, [app_clean])

    # Method 1: Check background_controller
    try:
        from .background_controller import list_background_windows
        wins = list_background_windows(include_minimized=True)
        for t in targets:
            for w in wins:
                proc = w.process_name.lower().replace(".exe", "")
                if t == proc or t in proc or proc in t:
                    return w.hwnd
            for w in wins:
                if t in w.title.lower():
                    return w.hwnd
    except Exception:
        pass

    # Method 2: Check window_manager
    try:
        from .window_manager import find_window_by_name
        found = find_window_by_name(app_name)
        if found:
            return found
    except Exception:
        pass

    # Method 3: Direct EnumWindows matching process_name AND/OR title AND/OR class
    try:
        from ctypes import wintypes
        import psutil

        candidate_hwnds = []
        def _enum_cb(hwnd, lparam):
            if not user32.IsWindow(hwnd):
                return True
            is_vis = user32.IsWindowVisible(hwnd)
            is_min = user32.IsIconic(hwnd)
            if not is_vis and not is_min:
                return True

            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if not pid.value:
                return True

            try:
                pname = psutil.Process(pid.value).name().lower().replace(".exe", "")
            except Exception:
                pname = ""

            l = user32.GetWindowTextLengthW(hwnd)
            title = ""
            if l > 0:
                buf = ctypes.create_unicode_buffer(l + 1)
                user32.GetWindowTextW(hwnd, buf, l + 1)
                title = buf.value.lower()

            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w = max(0, rect.right - rect.left)
            h = max(0, rect.bottom - rect.top)

            for t in targets:
                if t in pname or pname in t or (title and (t in title or title in t)):
                    score = w * h
                    if is_vis: score += 1000000
                    if title: score += 500000
                    candidate_hwnds.append((score, hwnd))
                    break
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user32.EnumWindows(WNDENUMPROC(_enum_cb), 0)
        if candidate_hwnds:
            candidate_hwnds.sort(key=lambda x: x[0], reverse=True)
            return candidate_hwnds[0][1]
    except Exception:
        pass

    return None
'''

start = content.find("def _find_window_for_app(")
end = content.find("\ndef _snap_hwnd(")
if start != -1 and end != -1:
    content = content[:start] + new_find_window + content[end:]
    path.write_text(content, encoding="utf-8")
    print("Updated _find_window_for_app in system_commands.py")

    # Sync
    targets = [
        Path(r"d:\era_agent\era_agent\commands\system_commands.py"),
        Path(r"C:\Users\MSI\AppData\Local\Programs\ERA AI Assistant\resources\era_services\era_agent\commands\system_commands.py"),
        Path(r"C:\Users\MSI\AppData\Local\Programs\ERA AI Assistant\resources\era_services\era_agent\era_agent\commands\system_commands.py"),
        Path(r"C:\Users\MSI\AppData\Local\Programs\ERA AI Assistant\resources\era_services\era_agent\Era Agent by VS Code\commands\system_commands.py"),
    ]
    for t in targets:
        if t.parent.exists():
            t.write_text(content, encoding="utf-8")
            print(f"Synced to {t}")
else:
    print(f"Bounds not found: {start}, {end}")
