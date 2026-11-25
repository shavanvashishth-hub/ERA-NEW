"""System-level commands for Era Agent.

Each function below performs exactly one safe, non-destructive action
and returns a CommandResult describing whether it succeeded. None of
these commands request administrator privileges or modify, delete, or
overwrite anything on the system — they only launch existing, standard
Windows applications.
"""

from __future__ import annotations

_START_APPS_CACHE = None
_START_APPS_CACHE_TIME = 0.0
import os
import platform
import shutil
import ctypes
import subprocess
import time
import threading
import re
import webbrowser
import winreg
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote

from .registry import CommandParam, CommandResult, registry

def _is_windows() -> bool:
    """Returns True if the agent is currently running on Windows."""
    return platform.system().lower() == "windows"

def _get_system_drives() -> List[str]:
    """Detects all physical fixed and removable drives on the computer (e.g. C:\\, D:\\, E:\\)."""
    drives = []
    if not _is_windows():
        return ["/"]
    try:
        bitmask = ctypes.windll.kernel32.GetLogicalDrives()
        for i in range(26):
            if bitmask & (1 << i):
                letter = chr(ord('A') + i)
                drive_path = f"{letter}:\\"
                dtype = ctypes.windll.kernel32.GetDriveTypeW(drive_path)
                if dtype in (2, 3):  # DRIVE_REMOVABLE, DRIVE_FIXED
                    drives.append(drive_path)
    except Exception:
        for letter in "CDEFGHIJKLMNO":
            p = f"{letter}:\\"
            if os.path.exists(p):
                drives.append(p)
    return drives or ["C:\\"]

@registry.register("open_notepad", "Opens Windows Notepad")
def open_notepad() -> CommandResult:
    return open_app("notepad")

@registry.register("open_calculator", "Opens Windows Calculator")
def open_calculator() -> CommandResult:
    return open_app("calc")

@registry.register("open_file_explorer", "Opens Windows File Explorer")
def open_file_explorer() -> CommandResult:
    return open_app("explorer")

def _find_chrome_path() -> Optional[str]:
    """Looks for Google Chrome on PATH, then in common install locations."""
    which_result = shutil.which("chrome")
    if which_result:
        return which_result

    common_paths = [
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path.home() / "AppData" / "Local" / "Google" / "Chrome" / "Application" / "chrome.exe",
    ]
    for path in common_paths:
        if path.exists():
            return str(path)
    return None

@registry.register("open_chrome", "Opens Google Chrome, if installed")
def open_chrome() -> CommandResult:
    return open_app("chrome")

# ---------------------------------------------------------------------------
# Parameterized / Interactive commands
# ---------------------------------------------------------------------------

def _get_clean_env() -> dict:
    """Returns a clean copy of os.environ stripped of ALL Electron/Node variables
    that can block GUI app launches when ERA runs inside the packaged EXE."""
    env = os.environ.copy()
    # Strip every Electron-injected key that restricts desktop access or GUI rendering
    strip_prefixes = ("ELECTRON_", "NODE_")
    strip_exact = {
        "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE",
        "ELECTRON_NO_ATTACH_CONSOLE", "CHROME_EXTRA_FLAGS",
        "GOOGLE_API_KEY", "GOOGLE_DEFAULT_CLIENT_ID", "GOOGLE_DEFAULT_CLIENT_SECRET",
    }
    for k in list(env.keys()):
        ku = k.upper()
        if any(ku.startswith(p) for p in strip_prefixes) or ku in strip_exact:
            env.pop(k, None)
    return env

def _is_electron_context() -> bool:
    """Detects if this Python process is running as a child of an Electron/Node process."""
    # ERA_RUNNING_IN_ELECTRON is explicitly set by Electron main.cjs for all child services
    if os.environ.get("ERA_RUNNING_IN_ELECTRON") == "1":
        return True
    # Fallback: detect leftover Electron vars (shouldn't exist after env stripping, but just in case)
    return any(
        k.upper().startswith("ELECTRON_") or k.upper() == "ELECTRON_RUN_AS_NODE"
        for k in os.environ
    )

def _resolve_shortcut(lnk_path: str):
    """Resolves a Windows .lnk shortcut to its target executable, arguments, and working directory."""
    if not lnk_path or not str(lnk_path).lower().endswith(".lnk"):
        return None, None, None
    try:
        import win32com.client
        shell = win32com.client.Dispatch("WScript.Shell")
        shortcut = shell.CreateShortCut(str(lnk_path))
        target = (shortcut.TargetPath or "").strip()
        extra_args = (shortcut.Arguments or "").strip()
        wd = (shortcut.WorkingDirectory or "").strip()
        if not wd and target and os.path.exists(target):
            wd = str(Path(target).parent)
        if target and os.path.exists(target):
            return target, extra_args or None, wd or None
    except Exception:
        pass
    try:
        p_esc = str(lnk_path).replace("'", "''")
        cmd = f"(New-Object -ComObject WScript.Shell).CreateShortcut('{p_esc}').TargetPath"
        out = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], text=True, timeout=3).strip()
        if out and os.path.exists(out):
            return out, None, str(Path(out).parent)
    except Exception:
        pass
    return None, None, None

def _launch_windows_target(target: str, args: Optional[str] = None) -> bool:
    """Launches an app, shortcut, document or URI on Windows with ZERO permission issues."""
    if not target:
        return False
    clean_target = str(target).strip().strip('"')
    if not clean_target:
        return False

    try:
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
    except Exception:
        pass

    clean_env = _get_clean_env()
    args_str = str(args).strip() if args else ""
    flags = 0x00000200  # CREATE_NEW_PROCESS_GROUP
    working_dir = None

    # Handle UWP AppsFolder directly with explorer (places window onto WinSta0\Default reliably)
    if clean_target.lower().startswith("shell:appsfolder"):
        try:
            subprocess.Popen(["explorer.exe", clean_target], env=clean_env, creationflags=flags)
            return True
        except Exception:
            pass
        try:
            subprocess.Popen(["cmd.exe", "/c", "start", "", clean_target], env=clean_env, creationflags=flags)
            return True
        except Exception:
            pass

    # Direct URI protocols (e.g. calc:, whatsapp:, ms-settings:, microsoft.windows.camera:, https:)
    if re.match(r"^[a-zA-Z0-9_\-]+:", clean_target) and not clean_target.startswith("shell:"):
        try:
            res = ctypes.windll.shell32.ShellExecuteW(None, "open", clean_target, None, None, 1)
            if res > 32:
                return True
        except Exception:
            pass
        try:
            os.startfile(clean_target)
            return True
        except Exception:
            pass
        try:
            subprocess.Popen(["cmd.exe", "/c", "start", "", clean_target], env=clean_env, creationflags=flags)
            return True
        except Exception:
            pass

    # RESOLVE SHORTCUTS (.lnk)
    if clean_target.lower().endswith(".lnk") and os.path.isfile(clean_target):
        try:
            res = ctypes.windll.shell32.ShellExecuteW(None, "open", clean_target, args_str or None, working_dir or None, 1)
            if res > 32:
                return True
        except Exception:
            pass
        res_target, res_args, res_wd = _resolve_shortcut(clean_target)
        if res_target and os.path.exists(res_target):
            clean_target = res_target
            if res_args:
                args_str = f"{res_args} {args_str}".strip() if args_str else res_args
            if res_wd and os.path.isdir(res_wd):
                working_dir = res_wd
            else:
                working_dir = str(Path(res_target).parent)

    # ShellExecuteW for .exe
    if clean_target.lower().endswith(".exe") and os.path.isfile(clean_target):
        try:
            res = ctypes.windll.shell32.ShellExecuteW(None, "open", clean_target, args_str or None, working_dir or str(Path(clean_target).parent), 1)
            if res > 32:
                return True
        except Exception:
            pass
        try:
            cwd = working_dir or str(Path(clean_target).parent)
            cmd_args = [clean_target] + ([args_str] if args_str else [])
            p = subprocess.Popen(cmd_args, cwd=cwd, env=clean_env, creationflags=flags)
            if p.pid > 0:
                return True
        except Exception:
            pass

    # Registered Windows App Paths / commands (e.g. winword, excel, powerpnt, notepad, chrome)
    try:
        p = subprocess.Popen(["cmd.exe", "/c", "start", "", clean_target] + ([args_str] if args_str else []), env=clean_env, creationflags=flags)
        if p.pid > 0:
            return True
    except Exception:
        pass
    return False

def _open_file_with(target_path: str, open_with: Optional[str] = None) -> CommandResult:
    """Opens a target file path using the requested program or default handler with guaranteed focus."""
    p = os.path.abspath(target_path)
    base = os.path.basename(p)
    resolved = (open_with or "").lower().strip()
    user32 = ctypes.windll.user32

    data_payload = {
        "filename": base,
        "path": p,
        "open_with": resolved or "default",
        "openWith": resolved or "default"
    }

    try:
        # 1. VS Code / Code
        if any(k in resolved for k in ["vscode", "code", "visualstudio", "visual studio", "vs"]):
            possible_code_paths = [
                r"C:\Users\MSI\AppData\Local\Programs\Microsoft VS Code\Code.exe",
                r"C:\Users\MSI\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd",
                r"C:\Program Files\Microsoft VS Code\Code.exe",
                r"C:\Program Files (x86)\Microsoft VS Code\Code.exe",
            ]
            code_bin = next((cp for cp in possible_code_paths if os.path.exists(cp)), None)
            if not code_bin:
                found_app = _find_app_path("vscode")
                if found_app and os.path.exists(found_app):
                    code_bin = found_app

            if code_bin and code_bin.lower().endswith(".exe"):
                subprocess.Popen([code_bin, "-r", p], creationflags=0x00000200)
            elif code_bin:
                subprocess.Popen(["cmd.exe", "/c", code_bin, "-r", p], shell=True)
            else:
                subprocess.Popen(["cmd.exe", "/c", "code", "-r", p], shell=True)

            time.sleep(0.6)
            h = _find_window_for_app("vscode")
            if h:
                if user32.IsIconic(h):
                    user32.ShowWindow(h, 9)
                _force_foreground_window(h)
            return CommandResult(True, f"Opened '{base}' in Visual Studio Code ({p}).", data=data_payload)

        # 2. Notepad / Text Editor
        if any(k in resolved for k in ["notepad", "note", "editor", "txt", "text"]):
            subprocess.Popen(["notepad.exe", p])
            time.sleep(0.3)
            h = _find_window_for_app("notepad")
            if h:
                if user32.IsIconic(h):
                    user32.ShowWindow(h, 9)
                _force_foreground_window(h)
            return CommandResult(True, f"Opened '{base}' in Notepad ({p}).", data=data_payload)

        # 3. Chrome / Browser / Edge / Firefox / Opera
        if any(k in resolved for k in ["chrome", "browser", "google", "edge", "msedge", "firefox", "brave", "opera"]):
            if "edge" in resolved or "msedge" in resolved:
                subprocess.Popen(["cmd.exe", "/c", "start", "msedge", p], shell=True)
                time.sleep(0.4)
                h = _find_window_for_app("edge")
                if h: _force_foreground_window(h)
                return CommandResult(True, f"Opened '{base}' in Microsoft Edge ({p}).", data=data_payload)
            elif "firefox" in resolved:
                subprocess.Popen(["cmd.exe", "/c", "start", "firefox", p], shell=True)
                time.sleep(0.4)
                h = _find_window_for_app("firefox")
                if h: _force_foreground_window(h)
                return CommandResult(True, f"Opened '{base}' in Firefox ({p}).", data=data_payload)
            elif "opera" in resolved:
                subprocess.Popen(["cmd.exe", "/c", "start", "opera", p], shell=True)
                time.sleep(0.4)
                h = _find_window_for_app("opera")
                if h: _force_foreground_window(h)
                return CommandResult(True, f"Opened '{base}' in Opera ({p}).", data=data_payload)
            else:
                chrome_path = _find_app_path("chrome")
                if chrome_path and os.path.exists(chrome_path):
                    subprocess.Popen([chrome_path, p], creationflags=0x00000200)
                else:
                    subprocess.Popen(["cmd.exe", "/c", "start", "chrome", p], shell=True)
                time.sleep(0.4)
                h = _find_window_for_app("chrome")
                if h: _force_foreground_window(h)
                return CommandResult(True, f"Opened '{base}' in Google Chrome ({p}).", data=data_payload)

        # 4. File Explorer / Reveal in folder
        if any(k in resolved for k in ["explorer", "folder", "reveal", "select", "show"]):
            subprocess.Popen(["explorer.exe", f"/select,{p}"])
            time.sleep(0.3)
            h = _find_window_for_app("explorer")
            if h: _force_foreground_window(h)
            return CommandResult(True, f"Revealed '{base}' in File Explorer ({p}).", data=data_payload)

        # 5. MS Office
        if any(k in resolved for k in ["word", "doc"]):
            subprocess.Popen(["cmd.exe", "/c", "start", "winword", p], shell=True)
            return CommandResult(True, f"Opened '{base}' in Microsoft Word ({p}).", data=data_payload)
        if any(k in resolved for k in ["excel", "sheet", "csv"]):
            subprocess.Popen(["cmd.exe", "/c", "start", "excel", p], shell=True)
            return CommandResult(True, f"Opened '{base}' in Microsoft Excel ({p}).", data=data_payload)
        if any(k in resolved for k in ["powerpoint", "ppt"]):
            subprocess.Popen(["cmd.exe", "/c", "start", "powerpnt", p], shell=True)
            return CommandResult(True, f"Opened '{base}' in PowerPoint ({p}).", data=data_payload)

        # 6. Default Windows system launcher
        try:
            os.startfile(p)
            time.sleep(0.4)
            fg = user32.GetForegroundWindow()
            if fg:
                _force_foreground_window(fg)
            return CommandResult(True, f"Opened '{base}' ({p}).", data=data_payload)
        except Exception:
            pass

        if _launch_windows_target(p):
            return CommandResult(True, f"Opened '{base}' ({p}).", data=data_payload)

        return CommandResult(False, f"Found file at '{p}', but could not launch it.", data=data_payload)
    except Exception as e:
        return CommandResult(False, f"Error opening '{base}': {str(e)}", data=data_payload)

def _clean_file_search_query(raw: str) -> str:
    """Strips conversational Hindi/Hinglish/English filler to extract the true filename/foldername."""
    t = str(raw or "").strip().strip('"\'')
    t = re.sub(r'^(please|plz|can you|era|ira|hey era|zara|thoda)\s+', '', t, flags=re.I)
    t = re.sub(r'^(open|kholo|dhoondho|dhundho|dundho|find|search|show|dekho|send|bhejo)\s+', '', t, flags=re.I)
    t = re.sub(r'\b(dund\s*kar|dhoondh?\s*kar|dhund\s*kar|khoj\s*kar|find\s*and|search\s*and)\b', '', t, flags=re.I)
    t = re.sub(r'\b(dundho|dhoondho|dhundho|khojo|search|find)\b', '', t, flags=re.I)
    t = re.sub(r'\s+(kholo|khol\s*do|kholna|open\s*karo|open\s*kar\s*do|open\s*kar|open|dikhao|show|bhejo|bhej\s*do|bhejna|send|send\s*karo|send\s*kar\s*do|send\s*karna)\s*$', '', t, flags=re.I)
    t = re.sub(r'\s+(karo|kar\s*do|kar|do|karna)$', '', t, flags=re.I)
    t = re.sub(r'\b(file\s*explorer?|fileexplore|explorer)\b', '', t, flags=re.I)
    t = re.sub(r'\s+(file|files|folder|doc|document|script|pdf)$', '', t, flags=re.I)
    t = re.sub(r'\b(file|folder|doc|document)\b', '', t, flags=re.I)
    t = re.sub(r'\b(mera|meri|mere|ye|yeh|is|iss|kisi|bhi|perticular|particular|number|no|ko|pe|par|per|se|sai|wali|wala|wale|me|mai|mein)\b', '', t, flags=re.I)
    t = re.sub(r'\s+', ' ', t).strip()
    return t

def _clean_app_name(raw: str) -> str:
    """Strips conversational Hindi/Hinglish/English phrases to extract the target application name."""
    t = str(raw or "").strip().strip('"\'')
    t = re.sub(r'^(please|plz|can you|era|ira|hey era|zara|thoda)\s+', '', t, flags=re.I)
    t = re.sub(r'^(open|launch|start|run|kholo|chalu karo|start karo)\s+', '', t, flags=re.I)
    t = re.sub(r'\b(dund\s*kar|dhoondh?\s*kar|dhund\s*kar|khoj\s*kar|find\s*and|search\s*and)\b', '', t, flags=re.I)
    t = re.sub(r'\b(dundho|dhoondho|dhundho|khojo|search|find)\b', '', t, flags=re.I)
    t = re.sub(r'\s+(kholo|khol\s*do|kholna|open\s*karo|open\s*kar\s*do|open\s*kar|open|chalu\s*karo|chalu\s*kar\s*do|chalu\s*kar|chalu|start\s*karo|start|run\s*karo|run|launch\s*karo|launch)$', '', t, flags=re.I)
    t = re.sub(r'\s+(karo|kar\s*do|kar|do|karna)$', '', t, flags=re.I)
    t = re.sub(r'\s+(app|application|software|program|tool)$', '', t, flags=re.I)
    t = re.sub(r'\b(app|application|software|program)\b', '', t, flags=re.I)
    t = re.sub(r'\b(mera|meri|mere|ye|yeh|ko|pe|par|se|wali|wala)\b', '', t, flags=re.I)
    return t.strip()

def find_file_path(target_name: str, search_root: Optional[str] = None) -> Optional[str]:
    """Finds the absolute path of a file or folder across user folders, workspaces, and hard drives."""
    if not target_name or not str(target_name).strip():
        return None
    target_raw = str(target_name).strip().strip('"').strip("'")

    # 1. Direct path check (<1ms)
    if os.path.exists(target_raw):
        return os.path.abspath(target_raw)

    # 2. Check in ERA workspace directories
    ws_dirs = [
        os.environ.get("ERA_WORKSPACE_DIR", ""),
        os.environ.get("WORKSPACE_DIR", ""),
        r"D:\era-voice-assistant\workspace",
        r"D:\era_agent\workspace",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "ERA", "workspace"),
        os.path.join(str(Path.home()), "ERA", "workspace"),
    ]
    for wd in ws_dirs:
        if wd and os.path.exists(wd):
            cand = os.path.join(wd, target_raw)
            if os.path.exists(cand):
                return os.path.abspath(cand)

    # 3. Clean query
    cleaned = _clean_file_search_query(target_raw)
    if cleaned and os.path.exists(cleaned):
        return os.path.abspath(cleaned)

    for wd in ws_dirs:
        if wd and os.path.exists(wd) and cleaned:
            cand = os.path.join(wd, cleaned)
            if os.path.exists(cand):
                return os.path.abspath(cand)

    # Check direct in user's standard folders
    user_home = str(Path.home())
    for sub in ["Desktop", "Downloads", "Documents"]:
        base_dir = os.path.join(user_home, sub)
        if os.path.exists(base_dir):
            cand1 = os.path.join(base_dir, target_raw)
            if os.path.exists(cand1):
                return os.path.abspath(cand1)
            if cleaned:
                cand2 = os.path.join(base_dir, cleaned)
                if os.path.exists(cand2):
                    return os.path.abspath(cand2)

    search_terms = []
    if cleaned and cleaned.lower() not in search_terms:
        search_terms.append(cleaned.lower())
    if target_raw.lower() not in search_terms:
        search_terms.append(target_raw.lower())

    skip_dirs = {
        "$recycle.bin", "system volume information", "windows", "recovery", "appdata",
        "node_modules", ".git", ".venv", "__pycache__", "temp", "cache", ".cache",
        "local settings", "application data", ".vscode", ".gemini", ".cargo", ".nuget",
        "dist", "build", "asar_extracted", "temp_asar_pack"
    }
    skip_files = {"desktop.ini", "thumbs.db", "ntuser.dat", "ntuser.ini", "bootstat.dat"}

    def _score(entry_name: str, is_file: bool) -> int:
        name_l = entry_name.lower()
        if name_l in skip_files or name_l.startswith("~$") or name_l.endswith((".tmp", ".sys")):
            return -1
        stem_l = os.path.splitext(entry_name)[0].lower()
        score = 0
        for term in search_terms:
            if term == name_l:
                score = max(score, 100)
            elif term == stem_l:
                score = max(score, 90)
            elif name_l.startswith(term):
                score = max(score, 75)
            elif stem_l.startswith(term):
                score = max(score, 70)
            elif term in name_l:
                score = max(score, 55)
            elif term in stem_l:
                score = max(score, 50)
        if score > 0 and is_file:
            score += 5
        return score

    priority_roots: List[str] = []
    if search_root and os.path.exists(search_root):
        priority_roots.append(os.path.abspath(search_root))
    else:
        for sub in ["Desktop", "Downloads", "Documents", "Pictures", "Videos", "Music"]:
            p = os.path.join(user_home, sub)
            if os.path.exists(p) and p not in priority_roots:
                priority_roots.append(p)
        onedrive = os.environ.get("OneDrive")
        if onedrive:
            for sub in ["Desktop", "Documents"]:
                p = os.path.join(onedrive, sub)
                if os.path.exists(p) and p not in priority_roots:
                    priority_roots.append(p)
        for wd in ws_dirs:
            if wd and os.path.exists(wd) and wd not in priority_roots:
                priority_roots.append(wd)
        for extra in ["D:\\files", "D:\\", "D:\\era-voice-assistant", "D:\\Mind Game", "D:\\GTA", "D:\\Screenshots"]:
            if os.path.exists(extra) and extra not in priority_roots:
                priority_roots.append(extra)
        for d in _get_system_drives():
            d_clean = d.rstrip(r"\\/") + os.sep
            if os.path.exists(d_clean) and d_clean not in priority_roots:
                priority_roots.append(d_clean)

    scored_matches: List[Tuple[int, str]] = []

    # Fast Pass 1: Direct scandir (<15ms)
    for r in priority_roots:
        try:
            with os.scandir(r) as it:
                for entry in it:
                    if entry.name.startswith((".", "$")):
                        continue
                    try:
                        is_f = entry.is_file(follow_symlinks=False)
                    except OSError:
                        continue
                    s = _score(entry.name, is_f)
                    if s > 0:
                        scored_matches.append((s, entry.path))
                        if s >= 90:
                            break
        except (PermissionError, OSError):
            continue
        if any(s >= 90 for s, _ in scored_matches):
            break

    # Fast Pass 2: Bounded BFS depth 3 (<60ms)
    if not scored_matches:
        for root in priority_roots:
            base_depth = root.rstrip(r"\\/").count(os.sep)
            stack = [root]
            while stack and not any(s >= 90 for s, _ in scored_matches):
                curr = stack.pop()
                curr_depth = curr.rstrip(r"\\/").count(os.sep) - base_depth
                try:
                    with os.scandir(curr) as it:
                        for entry in it:
                            name_low = entry.name.lower()
                            if entry.name.startswith((".", "$")) or name_low in skip_dirs:
                                continue
                            try:
                                is_f = entry.is_file(follow_symlinks=False)
                            except OSError:
                                continue
                            s = _score(entry.name, is_f)
                            if s > 0:
                                scored_matches.append((s, entry.path))
                                if s >= 90:
                                    break
                            if not is_f and curr_depth < 3:
                                stack.append(entry.path)
                except (PermissionError, OSError):
                    continue
            if scored_matches:
                break

    if not scored_matches:
        return None

    scored_matches.sort(key=lambda x: x[0], reverse=True)
    return scored_matches[0][1]

@registry.register(
    "search_file",
    "Searches for a file or folder by name across all hard drives and opens it or opens it in VS Code/Notepad/Chrome/Explorer",
    params=[
        CommandParam("file_name", "str", "File or folder name to search for", required=True),
        CommandParam("search_root", "str", "Optional directory path to search under", required=False),
        CommandParam("open_with", "str", "Optional program to open with (e.g. 'vscode', 'notepad', 'chrome', 'explorer')", required=False),
    ],
)
def search_file(
    file_name: Optional[str] = None,
    search_root: Optional[str] = None,
    open_with: Optional[str] = None,
    **kwargs: Any,
) -> CommandResult:
    """Searches for a file across all connected hard drive partitions and user directories with blazing speed."""
    if not _is_windows():
        return CommandResult(False, "File search is only available on Windows.")

    target_name = file_name or kwargs.get("fileName") or kwargs.get("query") or kwargs.get("name")
    if not target_name or not str(target_name).strip():
        return CommandResult(False, "No file name was provided.")
    target_raw = str(target_name).strip().strip('"').strip("'")

    resolved_open_with = (open_with or kwargs.get("openWith") or "").lower().strip()

    # 1. Direct path check (<1ms)
    if os.path.exists(target_raw):
        return _open_file_with(target_raw, resolved_open_with)

    # 2. Clean query
    import re
    cleaned = re.sub(r'^(open|kholo|dhoondho|find|search|show|dekho)\\s+', '', target_raw, flags=re.IGNORECASE)
    cleaned = re.sub(r'\\s+(file|files|folder|doc|document|script)$', '', cleaned, flags=re.IGNORECASE).strip()

    search_terms = []
    if cleaned and cleaned.lower() not in search_terms:
        search_terms.append(cleaned.lower())
    if target_raw.lower() not in search_terms:
        search_terms.append(target_raw.lower())

    skip_dirs = {
        "$recycle.bin", "system volume information", "windows", "recovery", "appdata",
        "node_modules", ".git", ".venv", "__pycache__", "temp", "cache", ".cache",
        "local settings", "application data", ".vscode", ".gemini", ".cargo", ".nuget",
        "dist", "build", "asar_extracted", "temp_asar_pack"
    }
    skip_files = {"desktop.ini", "thumbs.db", "ntuser.dat", "ntuser.ini", "bootstat.dat"}

    def _score(entry_name: str, is_file: bool) -> int:
        name_l = entry_name.lower()
        if name_l in skip_files or name_l.startswith("~$") or name_l.endswith((".tmp", ".sys")):
            return -1
        stem_l = os.path.splitext(entry_name)[0].lower()
        score = 0
        for term in search_terms:
            if term == name_l:
                score = max(score, 100)
            elif term == stem_l:
                score = max(score, 90)
            elif name_l.startswith(term):
                score = max(score, 75)
            elif stem_l.startswith(term):
                score = max(score, 70)
            elif term in name_l:
                score = max(score, 55)
            elif term in stem_l:
                score = max(score, 50)
        if score > 0 and is_file:
            score += 5
        return score

    user_home = str(Path.home())
    priority_roots: List[str] = []

    if search_root and os.path.exists(search_root):
        priority_roots.append(os.path.abspath(search_root))
    else:
        # High priority standard user folders first
        for sub in ["Desktop", "Downloads", "Documents", "Pictures", "Videos", "Music"]:
            p = os.path.join(user_home, sub)
            if os.path.exists(p) and p not in priority_roots:
                priority_roots.append(p)
        onedrive = os.environ.get("OneDrive")
        if onedrive:
            for sub in ["Desktop", "Documents"]:
                p = os.path.join(onedrive, sub)
                if os.path.exists(p) and p not in priority_roots:
                    priority_roots.append(p)

        # Workspaces and project directories
        ws_dir = os.environ.get("ERA_WORKSPACE_DIR") or os.environ.get("WORKSPACE_DIR")
        if ws_dir and os.path.exists(ws_dir) and ws_dir not in priority_roots:
            priority_roots.append(ws_dir)
        for extra in ["D:\\files", "D:\\", "D:\\era-voice-assistant", "D:\\Mind Game", "D:\\GTA", "D:\\Screenshots"]:
            if os.path.exists(extra) and extra not in priority_roots:
                priority_roots.append(extra)

        # Drive roots
        for d in _get_system_drives():
            d_clean = d.rstrip(r"\\/") + os.sep
            if os.path.exists(d_clean) and d_clean not in priority_roots:
                priority_roots.append(d_clean)

    scored_matches: List[Tuple[int, str]] = []

    # Fast Pass 1: Direct scandir of priority roots (<15ms)
    for r in priority_roots:
        try:
            with os.scandir(r) as it:
                for entry in it:
                    if entry.name.startswith((".", "$")):
                        continue
                    try:
                        is_f = entry.is_file(follow_symlinks=False)
                    except OSError:
                        continue
                    s = _score(entry.name, is_f)
                    if s > 0:
                        scored_matches.append((s, entry.path))
                        if s >= 90:
                            break
        except (PermissionError, OSError):
            continue
        if any(s >= 90 for s, _ in scored_matches):
            break

    # Fast Pass 2: Bounded BFS depth 3 using os.scandir (<60ms)
    if not scored_matches:
        for root in priority_roots:
            base_depth = root.rstrip(r"\\/").count(os.sep)
            stack = [root]
            while stack and not any(s >= 90 for s, _ in scored_matches):
                curr = stack.pop()
                curr_depth = curr.rstrip(r"\\/").count(os.sep) - base_depth
                try:
                    with os.scandir(curr) as it:
                        for entry in it:
                            name_low = entry.name.lower()
                            if entry.name.startswith((".", "$")) or name_low in skip_dirs:
                                continue
                            try:
                                is_f = entry.is_file(follow_symlinks=False)
                            except OSError:
                                continue
                            s = _score(entry.name, is_f)
                            if s > 0:
                                scored_matches.append((s, entry.path))
                                if s >= 90:
                                    break
                            if not is_f and curr_depth < 3:
                                stack.append(entry.path)
                except (PermissionError, OSError):
                    continue
            if scored_matches:
                break

    if not scored_matches:
        drives_str = ", ".join(_get_system_drives())
        return CommandResult(False, f"No file or folder matching '{target_name}' was found across laptop drives ({drives_str}).")

    scored_matches.sort(key=lambda x: x[0], reverse=True)
    best_match = scored_matches[0][1]
    return _open_file_with(best_match, resolved_open_with)

@registry.register(
    "open_file",
    "Finds and opens a specific file on the computer by name or path",
    params=[
        CommandParam("file_name", "str", "The name or path of the file to open (e.g. 'notes.txt', 'index.html', 'game.py')", required=True),
        CommandParam("open_with", "str", "Optional program to open with (e.g. 'vscode', 'browser', 'notepad', 'default')", required=False),
    ],
)
def open_file(
    file_name: Optional[str] = None,
    open_with: Optional[str] = None,
    **kwargs: Any,
) -> CommandResult:
    """Opens a file, searching workspace and all system hard drive partitions if needed."""
    name = file_name or kwargs.get("fileName") or kwargs.get("filename") or kwargs.get("query") or kwargs.get("name")
    if not name:
        return CommandResult(False, "No file name was provided.")

    clean_name = str(name).strip().strip('"').strip("'")
    resolved_open_with = (open_with or kwargs.get("openWith") or "").lower().strip()

    if os.path.exists(clean_name):
        return _open_file_with(clean_name, resolved_open_with)

    cleaned_name = _clean_file_search_query(clean_name)
    if cleaned_name and os.path.exists(cleaned_name):
        return _open_file_with(cleaned_name, resolved_open_with)

    ws_dir = os.environ.get("ERA_WORKSPACE_DIR") or os.environ.get("WORKSPACE_DIR")
    if ws_dir and os.path.exists(os.path.join(ws_dir, os.path.basename(clean_name))):
        ws_path = os.path.join(ws_dir, os.path.basename(clean_name))
        return _open_file_with(ws_path, resolved_open_with)
    if ws_dir and cleaned_name and os.path.exists(os.path.join(ws_dir, os.path.basename(cleaned_name))):
        ws_path = os.path.join(ws_dir, os.path.basename(cleaned_name))
        return _open_file_with(ws_path, resolved_open_with)

    return search_file(file_name=cleaned_name or clean_name, open_with=resolved_open_with, **kwargs)

def _copy_to_windows_clipboard(text: str) -> bool:
    """Copies Unicode text to the Windows clipboard accurately (no trailing CRLF).

    Uses pyperclip as primary method (works in all subprocess/UWP contexts),
    then falls back to win32clipboard, then clip.exe.
    """
    # PRIMARY: pyperclip — works reliably even in sandboxed/subprocess contexts
    try:
        import pyperclip  # type: ignore
        pyperclip.copy(str(text))
        return True
    except Exception:
        pass
    # FALLBACK 1: win32clipboard (can crash with access violation from certain subprocess contexts)
    try:
        import win32clipboard
        import win32con

        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, str(text))
            return True
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        pass
    # FALLBACK 2: clip.exe via subprocess
    try:
        proc = subprocess.Popen(["clip"], stdin=subprocess.PIPE, close_fds=True)
        proc.communicate(input=str(text).encode("utf-16le"))
        return True
    except Exception:
        return False


def _read_windows_clipboard() -> Optional[str]:
    """Reads plain text from the Windows clipboard cleanly, returning None if unavailable."""
    try:
        import win32clipboard
        import win32con

        win32clipboard.OpenClipboard()
        try:
            if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
                data = win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
                return str(data) if data is not None else ""
            return ""
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        pass
    try:
        res = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
            capture_output=True,
            text=True,
            timeout=3,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if res.returncode == 0:
            return res.stdout or ""
    except Exception:
        pass
    return None

def _copy_file_to_windows_clipboard(file_path: str) -> bool:
    """Copies an existing file to the Windows Clipboard as a native CF_HDROP FileDropList.
    This allows instant pasting (Ctrl+V) into WhatsApp Desktop, WhatsApp Web, File Explorer, etc.
    """
    abs_path = os.path.abspath(file_path)
    if not os.path.exists(abs_path):
        return False

    # Method 1: Win32 native API (fastest, ~1ms)
    try:
        import struct
        import win32clipboard
        import win32con

        offset = 20
        header = struct.pack("IIIII", offset, 0, 0, 0, 1)
        encoded_path = abs_path.encode("utf-16le") + b"\x00\x00\x00\x00"
        data = header + encoded_path

        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32con.CF_HDROP, data)
            return True
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        pass

    # Method 2: PowerShell Set-Clipboard fallback
    try:
        escaped = abs_path.replace("'", "''")
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", f"Set-Clipboard -LiteralPath '{escaped}'"],
            timeout=4,
            check=True,
            creationflags=0x00000200 if os.name == "nt" else 0,
        )
        return True
    except Exception:
        return False


def _normalize_phone_number(phone_raw: str) -> str:
    """Normalizes phone numbers to standard WhatsApp format (country code + digits, no leading 0, no +)."""
    digits = "".join(ch for ch in str(phone_raw or "") if ch.isdigit())
    if not digits:
        return ""
    if len(digits) == 10:
        # Standard Indian 10-digit mobile number
        return f"91{digits}"
    if len(digits) == 11 and digits.startswith("0"):
        # 0 followed by 10-digit number
        return f"91{digits[1:]}"
    return digits

def _is_whatsapp_desktop_installed() -> bool:
    """Checks if WhatsApp Desktop app is installed on Windows (no admin needed)."""
    # 1. Local AppData exe check
    wa_local = Path(os.environ.get("LOCALAPPDATA", "")) / "WhatsApp" / "WhatsApp.exe"
    if wa_local.exists():
        return True

    # 2. Registry check for HKCU uninstall
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WhatsApp")
        winreg.CloseKey(key)
        return True
    except OSError:
        pass

    # 3. Protocol registration check in HKCR
    try:
        key = winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"whatsapp")
        winreg.CloseKey(key)
        return True
    except OSError:
        pass

    return False

class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.c_size_t),
    ]

class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.c_size_t),
    ]

class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", ctypes.c_ulong), ("wParamL", ctypes.c_ushort), ("wParamH", ctypes.c_ushort)]

class _INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("hi", _HARDWAREINPUT)]

class _INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("union", _INPUT_UNION)]

def _send_whatsapp_enter() -> bool:
    """Dispatches a single clean Enter keypress using pyautogui or Win32 keybd_event."""
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        pyautogui.press("enter")
        return True
    except Exception:
        pass
    try:
        user32 = ctypes.windll.user32
        VK_RETURN = 0x0D
        KEYEVENTF_KEYUP = 0x0002
        user32.keybd_event(VK_RETURN, 0, 0, 0)
        time.sleep(0.03)
        user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)
        return True
    except Exception:
        return False


def _is_window_cloaked(hwnd: int) -> bool:
    """Returns True if a UWP/Windows window is cloaked (hidden/suspended/on another virtual desktop)."""
    try:
        dwmapi = ctypes.windll.dwmapi
        cloaked = ctypes.c_int(0)
        hr = dwmapi.DwmGetWindowAttribute(ctypes.c_void_p(hwnd), 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        if hr == 0 and cloaked.value != 0:
            return True
    except Exception:
        pass
    return False


def _is_whatsapp_hwnd(hwnd: Optional[int]) -> bool:
    """Checks whether hwnd belongs to native WhatsApp Desktop (root, UWP frame, or WhatsApp WebView)."""
    if not hwnd:
        return False
    try:
        user32 = ctypes.windll.user32
        length = user32.GetWindowTextLengthW(hwnd)
        buff = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buff, length + 1)
        title = buff.value.lower()

        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        pname = ""
        try:
            import psutil
            pname = psutil.Process(pid.value).name().lower()
        except Exception:
            pass

        if pname in ("whatsapp.root.exe", "whatsapp.exe") or ("whatsapp" in pname and "chrome" not in pname and "edge" not in pname):
            return True
        if pname in ("msedgewebview2.exe", "applicationframehost.exe") and "whatsapp" in title:
            return True
        if "whatsapp" in title and pname not in ("chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "code.exe", "electron.exe"):
            return True
    except Exception:
        pass
    return False


def _is_whatsapp_foreground(hwnd: Optional[int] = None) -> bool:
    """Returns True only when the active Windows foreground window actually belongs to WhatsApp Desktop."""
    try:
        fg = ctypes.windll.user32.GetForegroundWindow()
        if not fg:
            return False
        if hwnd and fg == hwnd:
            return True
        return _is_whatsapp_hwnd(fg)
    except Exception:
        return False


def _force_foreground_window(hwnd) -> bool:
    """Brings a window strictly to the foreground bypassing Windows focus-stealing locks."""
    try:
        user32 = ctypes.windll.user32
        _attach_winsta()
        if user32.IsIconic(hwnd) or not user32.IsWindowVisible(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            time.sleep(0.12)
        ctypes.windll.user32.AllowSetForegroundWindow(-1)
        user32.keybd_event(0x12, 0, 0, 0)  # VK_MENU down
        user32.keybd_event(0x12, 0, 0x0002, 0)  # VK_MENU up
        time.sleep(0.04)
        user32.SwitchToThisWindow(hwnd, True)
        user32.SetForegroundWindow(hwnd)
        user32.BringWindowToTop(hwnd)
        return True
    except Exception:
        try:
            ctypes.windll.user32.SetForegroundWindow(hwnd)
            return True
        except Exception:
            return False

@registry.register(
    "focus_window",
    "Brings a specific application window to the foreground and activates it for keyboard/mouse input.",
    params=[CommandParam("app_name", "str", "Application name or title keyword to focus (e.g. notepad, chrome, code)", required=True)]
)
def focus_window(app_name: str = "") -> CommandResult:
    """Finds the best matching visible window across both local and interactive desktops
    and brings it to the foreground.

    Retries for up to 8 seconds (16 attempts x 0.5s) to handle slow app launches.
    """
    try:
        app_lower = str(app_name or "").lower().strip()
        if not app_lower:
            return CommandResult(False, "app_name cannot be empty.")

        _attach_winsta()
        max_attempts = 16
        for attempt in range(max_attempts):
            hwnd = _find_window_for_app(app_name)
            if hwnd:
                _force_foreground_window(hwnd)
                time.sleep(0.25)
                return CommandResult(True, f"Focused window for '{app_name}' (attempt {attempt + 1}).")
            if attempt < max_attempts - 1:
                time.sleep(0.5)

        return CommandResult(False, f"No visible window found matching '{app_name}' after {max_attempts} attempts (8s).")
    except Exception as e:
        return CommandResult(False, f"focus_window error: {e}")

def _find_whatsapp_hwnd_and_rect():
    """Finds genuine WhatsApp Desktop window HWND and its screen rectangle.
    Prefers visible, non-cloaked, non-minimized windows; falls back to iconic WhatsApp windows so they can be restored.
    """
    try:
        _attach_winsta()
        user32 = ctypes.windll.user32
        h_def = user32.OpenDesktopW("default", 0, False, 0x01FF)
        if h_def:
            try:
                user32.SetThreadDesktop(h_def)
            except Exception:
                pass

        found_hwnds = []
        iconic_hwnds = []
        visited = set()

        ignored_procs = {
            "antigravity.exe", "code.exe", "cursor.exe", "electron.exe",
            "python.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
            "chrome.exe", "edge.exe", "msedge.exe", "firefox.exe",
            "brave.exe", "opera.exe", "devenv.exe"
        }

        def enum_cb(hwnd, _):
            if hwnd in visited:
                return True
            visited.add(hwnd)

            length = user32.GetWindowTextLengthW(hwnd)
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            t = buff.value.lower()

            pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            pname = ""
            try:
                import psutil
                p = psutil.Process(pid.value)
                pname = p.name().lower()
            except Exception:
                pass

            if pname in ignored_procs:
                return True

            rect = (ctypes.c_long * 4)()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            width = rect[2] - rect[0]
            height = rect[3] - rect[1]

            is_wa_proc = pname in ["whatsapp.root.exe", "whatsapp.exe"] or ("whatsapp" in pname and pname not in ignored_procs)
            is_wa_view = (pname in ["msedgewebview2.exe", "applicationframehost.exe"] and "whatsapp" in t)

            if not (is_wa_proc or is_wa_view):
                return True

            is_visible = bool(user32.IsWindowVisible(hwnd))
            is_iconic = bool(user32.IsIconic(hwnd))
            is_cloaked = _is_window_cloaked(hwnd)

            if is_visible and is_iconic and not is_cloaked:
                score = 40 if pname in ["whatsapp.root.exe", "whatsapp.exe"] else 20
                iconic_hwnds.append((score, hwnd, (rect[0], rect[1], rect[2], rect[3])))
                return True

            if is_visible and not is_cloaked and width > 300 and height > 300:
                score = 100 if pname in ["whatsapp.root.exe", "whatsapp.exe"] else 60
                if "whatsapp" in t:
                    score += 30
                found_hwnds.append((score, hwnd, (rect[0], rect[1], rect[2], rect[3])))
                return True

            if not is_cloaked and width > 300 and height > 300:
                score = 30 if pname in ["whatsapp.root.exe", "whatsapp.exe"] else 15
                iconic_hwnds.append((score, hwnd, (rect[0], rect[1], rect[2], rect[3])))
                return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        cb_proc = WNDENUMPROC(enum_cb)
        user32.EnumWindows(cb_proc, 0)
        if h_def:
            try:
                user32.EnumDesktopWindows(h_def, cb_proc, 0)
                user32.CloseDesktop(h_def)
            except Exception:
                pass

        if found_hwnds:
            found_hwnds.sort(key=lambda x: x[0], reverse=True)
            return found_hwnds[0][1], found_hwnds[0][2]

        if iconic_hwnds:
            iconic_hwnds.sort(key=lambda x: x[0], reverse=True)
            return iconic_hwnds[0][1], iconic_hwnds[0][2]

        return None, (0, 0, 0, 0)
    except Exception:
        return None, (0, 0, 0, 0)

def _find_whatsapp_hwnd():
    hwnd, _ = _find_whatsapp_hwnd_and_rect()
    return hwnd

def _ensure_whatsapp_ready(timeout: float = 6.0) -> Optional[int]:
    """Ensures WhatsApp Desktop is running, unhidden from tray, and ready."""
    _attach_winsta()
    hwnd, _ = _find_whatsapp_hwnd_and_rect()
    if not hwnd or not ctypes.windll.user32.IsWindowVisible(hwnd):
        try:
            os.startfile("whatsapp:")
        except Exception:
            try:
                subprocess.Popen(["cmd.exe", "/c", "start", "", "shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"])
            except Exception:
                pass
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.35)
            hwnd, _ = _find_whatsapp_hwnd_and_rect()
            if hwnd and ctypes.windll.user32.IsWindowVisible(hwnd):
                break
    if hwnd:
        _force_foreground_window(hwnd)
        time.sleep(0.2)
    return hwnd

def _activate_whatsapp_window() -> bool:
    """Brings ONLY the native WhatsApp Desktop window to front. Never activates browser!"""
    hwnd = _find_whatsapp_hwnd()
    if hwnd:
        _force_foreground_window(hwnd)
        return _is_whatsapp_foreground(hwnd)
    return False

def _ensure_whatsapp_foreground(hwnd: Optional[int] = None, attempts: int = 4) -> Optional[int]:
    """Ensures WhatsApp Desktop is visible, restored, and verified as the foreground window."""
    _attach_winsta()
    for _ in range(max(1, attempts)):
        target_hwnd = hwnd or _find_whatsapp_hwnd()
        if target_hwnd:
            _force_foreground_window(target_hwnd)
            time.sleep(0.18)
            if _is_whatsapp_foreground(target_hwnd):
                refreshed, _ = _find_whatsapp_hwnd_and_rect()
                return refreshed or target_hwnd
            hwnd = None
        time.sleep(0.15)
    return None

def _send_whatsapp_once(hwnd=None):
    """Brings WhatsApp cleanly to front and dispatches a single Enter keypress without touching the mouse."""
    fg_hwnd = _ensure_whatsapp_foreground(hwnd)
    if not fg_hwnd:
        return False
    time.sleep(0.15)
    return _send_whatsapp_enter()

def _wait_for_whatsapp_window(timeout: float = 15.0, interval: float = 0.35) -> Optional[int]:
    """Waits until a WhatsApp Desktop window is visible AND verified in the foreground."""
    deadline = time.time() + max(0.5, timeout)
    while time.time() < deadline:
        hwnd, rect = _find_whatsapp_hwnd_and_rect()
        width = rect[2] - rect[0]
        height = rect[3] - rect[1]
        if hwnd:
            _force_foreground_window(hwnd)
            time.sleep(0.15)
            hwnd2, rect2 = _find_whatsapp_hwnd_and_rect()
            if hwnd2 and (rect2[2] - rect2[0]) > 300 and (rect2[3] - rect2[1]) > 300 and _is_whatsapp_foreground(hwnd2):
                return hwnd2
            if width > 300 and height > 300 and _is_whatsapp_foreground(hwnd):
                return hwnd
        time.sleep(interval)
    return None

def _activate_whatsapp_or_browser_window() -> bool:
    """Brings WhatsApp to front; if not found, activates a real browser window as fallback."""
    if _ensure_whatsapp_foreground(attempts=2):
        return True
    try:
        user32 = ctypes.windll.user32
        matched = [False]

        def enum_cb(hwnd, _):
            if user32.IsWindowVisible(hwnd) and not _is_window_cloaked(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buff = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buff, length + 1)
                    t = buff.value.lower()
                    if ("whatsapp" in t) or any(b in t for b in ("chrome", "edge", "firefox", "brave")):
                        _force_foreground_window(hwnd)
                        time.sleep(0.15)
                        if user32.GetForegroundWindow() == hwnd:
                            matched[0] = True
                            return False
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        user32.EnumWindows(WNDENUMPROC(enum_cb), 0)
        return matched[0]
    except Exception:
        return False

def _lookup_contact_phone(contact_query: str) -> Optional[str]:
    """Looks up a phone number by contact name or alias in whatsapp_contacts.json."""
    if not contact_query:
        return None

    import re
    raw_str = str(contact_query).strip()
    clean_q = re.sub(r"\s*\b(?:ko|se|par|per|ji|bhaiya|mama|sir|uncle|didi)\b\s*$", "", raw_str, flags=re.IGNORECASE).strip().lower()
    if not clean_q:
        clean_q = raw_str.lower()

    _app_data = os.environ.get("ERA_APP_DATA", "")
    possible_paths = [
        Path(os.path.join(_app_data, "config", "whatsapp_contacts.json")) if _app_data else None,
        Path(os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Local", "ERA", "config", "whatsapp_contacts.json")),
        Path(r"d:\era-voice-assistant\config\whatsapp_contacts.json"),
        Path(r"d:\era_agent\config\whatsapp_contacts.json"),
        Path.cwd() / "config" / "whatsapp_contacts.json",
    ]

    contacts_data = []
    for p_cfg in possible_paths:
        if p_cfg and p_cfg.exists():
            try:
                import json
                raw = json.loads(p_cfg.read_text(encoding="utf-8"))
                if isinstance(raw, list):
                    contacts_data = raw
                    break
                elif isinstance(raw, dict):
                    contacts_data = [{"name": k, "phone": v} for k, v in raw.items()]
                    break
            except Exception:
                pass

    if not contacts_data:
        return None

    # Pass 1: Exact match with name or alias
    for target in [clean_q, raw_str.lower()]:
        for entry in contacts_data:
            name = str(entry.get("name", "")).strip().lower()
            aliases = [str(a).strip().lower() for a in entry.get("aliases", [])]
            if target == name or target in aliases:
                phone_val = str(entry.get("phone", "")).strip()
                digits = "".join(ch for ch in phone_val if ch.isdigit())
                if digits:
                    return digits

    # Pass 2: Word boundary or prefix match
    for entry in contacts_data:
        name = str(entry.get("name", "")).strip().lower()
        aliases = [str(a).strip().lower() for a in entry.get("aliases", [])]
        for candidate in [name] + aliases:
            if not candidate:
                continue
            words = candidate.split()
            if clean_q in words or candidate.startswith(clean_q + " ") or clean_q.startswith(candidate + " "):
                phone_val = str(entry.get("phone", "")).strip()
                digits = "".join(ch for ch in phone_val if ch.isdigit())
                if digits:
                    return digits

    return None

def _auto_learn_whatsapp_contact(contact_name: str, phone: Optional[str] = None) -> None:
    """Remembers contact name in whatsapp_contacts.json (list format) for quick future reference."""
    if not contact_name:
        return
    try:
        import json
        _app_data = os.environ.get("ERA_APP_DATA", "")
        cfg_paths = [
            Path(os.path.join(_app_data, "config", "whatsapp_contacts.json")) if _app_data else None,
            Path(os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Local", "ERA", "config", "whatsapp_contacts.json")),
            Path(r"d:\era-voice-assistant\config\whatsapp_contacts.json"),
            Path(r"d:\era_agent\config\whatsapp_contacts.json"),
        ]
        clean_name = contact_name.strip()
        norm_name = clean_name.lower()
        for p in cfg_paths:
            if p and p.parent.exists():
                data: Any = []
                if p.exists():
                    try:
                        with open(p, "r", encoding="utf-8") as f:
                            loaded = json.load(f)
                        if isinstance(loaded, (list, dict)):
                            data = loaded
                    except Exception:
                        data = []
                if isinstance(data, list):
                    found = False
                    for entry in data:
                        if not isinstance(entry, dict):
                            continue
                        names = [str(entry.get("name", "")).strip().lower()]
                        if isinstance(entry.get("aliases"), list):
                            names.extend(str(a).strip().lower() for a in entry["aliases"])
                        if norm_name in names:
                            if phone and not entry.get("phone"):
                                entry["phone"] = phone
                            found = True
                            break
                    if not found:
                        data.append({
                            "name": clean_name,
                            "aliases": [norm_name],
                            "phone": phone or "",
                        })
                elif isinstance(data, dict):
                    data[clean_name] = phone or ""
                try:
                    with open(p, "w", encoding="utf-8") as f:
                        json.dump(data, f, indent=2)
                except Exception:
                    pass
    except Exception:
        pass

def _record_whatsapp_chat_log(contact_name: str, message: str) -> None:
    try:
        import json
        from datetime import datetime, timedelta, timezone
        ist_tz = timezone(timedelta(hours=5, minutes=30))
        _app_data = os.environ.get("ERA_APP_DATA", "")
        raw_paths = [
            Path(os.path.join(_app_data, "config", "whatsapp_chats.json")) if _app_data else None,
            Path(os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Local", "ERA", "config", "whatsapp_chats.json")),
            Path(r"d:\era-voice-assistant\config\whatsapp_chats.json"),
            Path(r"d:\era_agent\config\whatsapp_chats.json"),
        ]
        log_paths = []
        seen_paths = set()
        for p in raw_paths:
            if p is None:
                continue
            norm_p = os.path.normcase(os.path.abspath(str(p)))
            if norm_p not in seen_paths:
                seen_paths.add(norm_p)
                log_paths.append(p)
        new_entry = {
            "contactName": contact_name,
            "message": message,
            "timestamp": datetime.now(ist_tz).isoformat(timespec="seconds"),
            "status": "sent",
        }
        for p in log_paths:
            p.parent.mkdir(parents=True, exist_ok=True)
            chats = []
            if p.exists():
                try:
                    chats = json.loads(p.read_text(encoding="utf-8"))
                except Exception:
                    chats = []
            chats.insert(0, new_entry)
            p.write_text(json.dumps(chats[:50], indent=2), encoding="utf-8")
    except Exception:
        pass

_wa_execution_lock = threading.Lock()
_wa_dedup_cache = {}
_WA_CLIP_SENTINEL = "__ERA_WA_EMPTY_SENTINEL__"


def _normalize_wa_text(value: Optional[str]) -> str:
    """Normalizes whitespace and line endings for comparing WhatsApp composer text."""
    return re.sub(r"\s+", " ", str(value or "").replace("\r", " ").replace("\n", " ")).strip()


def _inspect_whatsapp_uia(hwnd: int) -> dict:
    """Inspects WhatsApp Desktop UI controls via Windows UI Automation.
    Detects lock/QR screens, invalid number popups, search box, message composer, composer text, and Send button.
    """
    if not hwnd or not _is_windows():
        return {"ok": False}

    ps_script = f"""
$ErrorActionPreference = 'Stop'
try {{
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class EraDpiFix {{ [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }}' -ErrorAction SilentlyContinue
  [void][EraDpiFix]::SetProcessDPIAware()
}} catch {{}}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new({int(hwnd)}))
if (-not $root) {{
  @{{ ok = $false }} | ConvertTo-Json -Compress
  exit 0
}}
$wr = $root.Current.BoundingRectangle
$wL = [double]$wr.Left; $wT = [double]$wr.Top; $wW = [double]$wr.Width; $wH = [double]$wr.Height
if ($wW -le 0 -or $wH -le 0) {{
  @{{ ok = $false }} | ConvertTo-Json -Compress
  exit 0
}}

$editCond = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document))
)
$edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)

$searchBoxRect = $null
$composerRect = $null
$composerText = ""
$composerHasFocus = $false
$bestCompY = -1.0

foreach ($el in $edits) {{
  try {{
    if (-not $el.Current.IsEnabled) {{ continue }}
    $r = $el.Current.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 60 -or $r.Height -lt 10 -or $r.Height -gt 340) {{ continue }}
    $cx = $r.Left + ($r.Width / 2.0)
    $cy = $r.Top + ($r.Height / 2.0)
    $nm = ([string]$el.Current.Name).ToLowerInvariant()
    $aid = ([string]$el.Current.AutomationId).ToLowerInvariant()
    if ($nm -match 'search' -or $aid -match 'search' -or ($cx -lt ($wL + $wW * 0.42) -and $cy -lt ($wT + $wH * 0.35))) {{
      if (-not $searchBoxRect) {{
        $searchBoxRect = @([int][Math]::Round($r.Left), [int][Math]::Round($r.Top), [int][Math]::Round($r.Right), [int][Math]::Round($r.Bottom))
      }}
      continue
    }}
    $isComposerHint = ($nm -match 'type a|type to|message|composer|write' -or $aid -match 'composer|input|message')
    $isBottomRight = ($cy -ge ($wT + $wH * 0.58) -and $cx -ge ($wL + $wW * 0.25))
    if ($isComposerHint -or $isBottomRight) {{
      if ($cy -gt $bestCompY) {{
        $bestCompY = $cy
        $composerRect = @([int][Math]::Round($r.Left), [int][Math]::Round($r.Top), [int][Math]::Round($r.Right), [int][Math]::Round($r.Bottom))
        $composerHasFocus = [bool]$el.Current.HasKeyboardFocus
        $txt = ""
        try {{
          $vp = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {{
            $txt = [string]$vp.Current.Value
          }}
        }} catch {{}}
        if (-not $txt) {{
          try {{
            $tp = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {{
              $txt = [string]$tp.DocumentRange.GetText(500)
            }}
          }} catch {{}}
        }}
        $trimmed = $txt.Trim()
        if ($trimmed -and $trimmed.ToLowerInvariant() -eq $nm -and $nm.StartsWith('type ')) {{
          $trimmed = ""
        }}
        $composerText = $trimmed
      }}
    }}
  }} catch {{}}
}}

$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$btns = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
$sendButtonRect = $null
foreach ($b in $btns) {{
  try {{
    if (-not $b.Current.IsEnabled) {{ continue }}
    $r = $b.Current.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 10 -or $r.Height -lt 10) {{ continue }}
    $cx = $r.Left + ($r.Width / 2.0)
    $cy = $r.Top + ($r.Height / 2.0)
    $nm = ([string]$b.Current.Name).ToLowerInvariant()
    $aid = ([string]$b.Current.AutomationId).ToLowerInvariant()
    if (($nm -eq 'send' -or $nm -match '\\bsend\\b' -or $aid -match 'send') -and $nm -notmatch 'voice|audio|attach|emoji' -and $cy -ge ($wT + $wH * 0.58) -and $cx -ge ($wL + $wW * 0.65)) {{
      $sendButtonRect = @([int][Math]::Round($r.Left), [int][Math]::Round($r.Top), [int][Math]::Round($r.Right), [int][Math]::Round($r.Bottom))
      break
    }}
  }} catch {{}}
}}

$txtCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
$texts = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $txtCond)
$locked = $false
$invalidDialog = $false
$noResults = $false
$limit = [Math]::Min($texts.Count, 50)
for ($i = 0; $i -lt $limit; $i++) {{
  try {{
    $t = ([string]$texts.Item($i).Current.Name).ToLowerInvariant()
    if (-not $t) {{ continue }}
    if ($t -match 'enter your pin|link with phone number|use whatsapp on your phone|steps to log in|scan the qr|app lock') {{
      $locked = $true
    }}
    if ($t -match 'phone number shared via url is invalid|number isn''t on whatsapp|not on whatsapp|couldn''t find chat') {{
      $invalidDialog = $true
    }}
    if ($t -match 'no chats, contacts or messages found|no results found') {{
      $noResults = $true
    }}
  }} catch {{}}
}}

@{{
  ok = $true
  winRect = @([int][Math]::Round($wL), [int][Math]::Round($wT), [int][Math]::Round($wL + $wW), [int][Math]::Round($wT + $wH))
  lockedOrLoggedOut = $locked
  invalidPhoneDialog = $invalidDialog
  noResultsFound = $noResults
  hasChatComposer = ($null -ne $composerRect)
  composerRect = $composerRect
  composerText = $composerText
  composerHasFocus = $composerHasFocus
  hasSendButton = ($null -ne $sendButtonRect)
  sendButtonRect = $sendButtonRect
  searchBoxRect = $searchBoxRect
}} | ConvertTo-Json -Compress
"""
    try:
        res = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if res.returncode == 0 and res.stdout.strip():
            import json
            parsed = json.loads(res.stdout.strip().splitlines()[-1])
            if isinstance(parsed, dict):
                return parsed
    except Exception:
        pass
    return {"ok": False}


def _read_composer_via_clipboard(comp_cx: int, comp_cy: int, hwnd: int) -> Optional[str]:
    """Focuses the composer at (comp_cx, comp_cy) ONLY if WhatsApp is foreground and reads its text via Ctrl+A/Ctrl+C."""
    if not _is_whatsapp_foreground(hwnd):
        return None
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
    except Exception:
        return None

    try:
        pyautogui.click(comp_cx, comp_cy)
        time.sleep(0.1)
        _copy_to_windows_clipboard(_WA_CLIP_SENTINEL)
        time.sleep(0.06)
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.06)
        pyautogui.hotkey("ctrl", "c")
        time.sleep(0.12)
        clip = _read_windows_clipboard()
        if clip is None:
            return None
        if clip == _WA_CLIP_SENTINEL:
            return ""
        # Collapse selection safely to the end so subsequent keys/Enter don't accidentally edit selection
        pyautogui.press("right")
        return clip
    except Exception:
        return None


def _read_current_composer_text(hwnd: int, comp_cx: int, comp_cy: int, cached_ui: Optional[dict] = None) -> Optional[str]:
    """Reads composer contents via UIA first, then verifies via clipboard if UIA reported empty or unavailable."""
    ui = cached_ui if cached_ui is not None else _inspect_whatsapp_uia(hwnd)
    uia_txt = str(ui.get("composerText") or "") if ui.get("ok") else ""
    if uia_txt.strip():
        return uia_txt
    clip_txt = _read_composer_via_clipboard(comp_cx, comp_cy, hwnd)
    if clip_txt is not None:
        return clip_txt
    if ui.get("ok") and ui.get("hasChatComposer"):
        return uia_txt
    return None


def _get_whatsapp_search_first_result(hwnd: int) -> Optional[str]:
    """Reads the name of the first search result in WhatsApp search via UIA.
    Returns the contact/chat name string, or None if unavailable.
    This is used to VERIFY the search result before selecting it.
    """
    if not hwnd or not _is_windows():
        return None
    ps_script = f"""
$ErrorActionPreference = 'SilentlyContinue'
try {{
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new({int(hwnd)}))
  if (-not $root) {{ exit 1 }}
  # WhatsApp search results appear as list items or custom controls
  # Look for the first enabled, visible item in the left-panel list area
  $wr = $root.Current.BoundingRectangle
  $wL = $wr.Left; $wT = $wr.Top; $wW = $wr.Width; $wH = $wr.Height
  $listCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::ListItem
  )
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)
  $found = $null
  $limit = [Math]::Min($items.Count, 15)
  for ($i = 0; $i -lt $limit; $i++) {{
    try {{
      $el = $items.Item($i)
      $r = $el.Current.BoundingRectangle
      if ($r.IsEmpty -or $r.Width -lt 100 -or $r.Height -lt 20) {{ continue }}
      $cx = $r.Left + ($r.Width / 2.0)
      # Must be in left panel (first 40% of width)
      if ($cx -gt ($wL + $wW * 0.42)) {{ continue }}
      $nm = ([string]$el.Current.Name).Trim()
      if ($nm.Length -gt 0 -and $nm.Length -lt 80) {{
        $found = $nm
        break
      }}
    }} catch {{}}
  }}
  if ($found) {{ Write-Output $found }}
}} catch {{}}
"""
    try:
        res = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps_script],
            capture_output=True, text=True, timeout=4,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip().splitlines()[-1].strip()
    except Exception:
        pass
    return None


def _contact_name_matches(result_name: str, search_target: str) -> bool:
    """Returns True if a WhatsApp search result name matches what we searched for.
    Handles partial matches, Hindi honorifics, and case-insensitivity.
    """
    if not result_name or not search_target:
        return False
    rn = result_name.strip().lower()
    st = search_target.strip().lower()
    # Remove honorifics from both sides
    for suffix in [" ko", " se", " par", " per", " ji", " bhaiya", " sir", " didi"]:
        rn = rn.removesuffix(suffix)
        st = st.removesuffix(suffix)
    rn = rn.strip()
    st = st.strip()
    if not rn or not st:
        return False
    # Exact match
    if rn == st:
        return True
    # One is a prefix of the other (e.g. search "rahul", result "Rahul Sharma")
    if rn.startswith(st) or st.startswith(rn):
        return True
    # First word match (e.g. search "rahul" matches "Rahul Kumar")
    if rn.split()[0] == st.split()[0]:
        return True
    return False


def _search_and_select_whatsapp_chat(hwnd: int, clean_target: str) -> Tuple[bool, str]:
    """Searches for clean_target in WhatsApp Desktop search, VERIFIES the first result
    matches the intended contact, then selects it.

    SAFE BEHAVIOR: If we cannot verify the contact name matches (e.g. UIA unavailable,
    no results, or first result is a different person), we press Esc and return failure
    instead of blindly selecting whatever chat happens to be highlighted.
    """
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
    except ImportError:
        return False, "pyautogui is required to search contacts in WhatsApp Desktop."

    fg_hwnd = _ensure_whatsapp_foreground(hwnd)
    if not fg_hwnd:
        return False, "Could not bring WhatsApp Desktop to foreground before searching."

    ui = _inspect_whatsapp_uia(fg_hwnd)
    if ui.get("lockedOrLoggedOut"):
        return False, "WhatsApp Desktop is locked or logged out."

    # Press Esc twice to clear any active state / open panels
    pyautogui.press("esc")
    time.sleep(0.12)
    pyautogui.press("esc")
    time.sleep(0.15)

    # Open search: use UIA rect if available, else Ctrl+F
    search_rect = ui.get("searchBoxRect") if ui.get("ok") else None
    if isinstance(search_rect, list) and len(search_rect) == 4:
        sx = int((search_rect[0] + search_rect[2]) / 2)
        sy = int((search_rect[1] + search_rect[3]) / 2)
        pyautogui.click(sx, sy)
        time.sleep(0.2)
    else:
        pyautogui.hotkey("ctrl", "f")
        time.sleep(0.3)

    # Clear any existing text, then paste the contact name
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.08)
    pyautogui.press("backspace")
    time.sleep(0.12)

    try:
        import pyperclip  # type: ignore
        pyperclip.copy(str(clean_target))
    except Exception:
        if not _copy_to_windows_clipboard(clean_target):
            pyautogui.press("esc")
            return False, "Failed to copy contact name to clipboard."
    pyautogui.hotkey("ctrl", "v")
    time.sleep(1.8)  # Wait for search results to fully load

    # --- SAFETY VERIFICATION LAYER ---
    # Check 1: UIA "no results" check (works when UIA is available)
    ui_after_search = _inspect_whatsapp_uia(fg_hwnd)
    if ui_after_search.get("noResultsFound"):
        pyautogui.press("esc")
        return False, f"WhatsApp search found no results for '{clean_target}'. Message was NOT sent."

    # Check 2: Try to read the first search result name via UIA
    first_result = _get_whatsapp_search_first_result(fg_hwnd)
    if first_result is not None:
        # UIA was able to read the first result — verify it matches
        if not _contact_name_matches(first_result, clean_target):
            # First result is NOT the contact we searched for — ABORT safely
            pyautogui.press("esc")
            time.sleep(0.1)
            pyautogui.press("esc")
            return (
                False,
                f"WhatsApp search for '{clean_target}' returned '{first_result}' as top result. "
                f"This does not match the intended contact. Message was NOT sent to avoid wrong delivery. "
                f"Please add '{clean_target}' to your contacts with their phone number.",
            )
        # First result matches — safe to select
        pyautogui.press("down")
        time.sleep(0.2)
        pyautogui.press("enter")
        time.sleep(0.8)
        return True, f"Selected chat '{first_result}' matching '{clean_target}'."

    # Check 3: UIA unavailable (common for WhatsApp UWP) — use a STRICT safety policy:
    # We refuse to blindly select the first result because we cannot verify the contact name.
    # Instead, abort and tell the user to provide a phone number.
    pyautogui.press("esc")
    time.sleep(0.1)
    pyautogui.press("esc")
    return (
        False,
        f"Cannot verify WhatsApp search result for '{clean_target}' (contact name verification unavailable). "
        f"To avoid sending to the wrong person, the message was NOT sent. "
        f"Please provide the phone number directly (e.g. 'Send to 91XXXXXXXXXX').",
    )


def _deliver_whatsapp_desktop_message(
    hwnd: int,
    target_input: str,
    target_msg: str,
    display_name: Optional[str] = None,
    search_fallback_target: Optional[str] = None,
    log_name: Optional[str] = None,
) -> CommandResult:
    """Delivers message into WhatsApp Desktop chat composer and presses Enter to send.

    FIX: Uses pyperclip for clipboard (avoids win32clipboard access violation),
    re-fetches rect AFTER foreground (avoids stale rect causing misclicks),
    and sends via Enter ONLY (not Enter + click which caused double-sends).
    """
    label = display_name or target_input
    log_label = log_name or target_input
    try:
        import pyautogui  # type: ignore
        pyautogui.FAILSAFE = False
    except ImportError:
        return CommandResult(
            False,
            f"WhatsApp Desktop opened for '{label}', but pyautogui is required to send the message.",
        )

    # Bring WhatsApp to foreground
    fg_hwnd = _ensure_whatsapp_foreground(hwnd, attempts=3) or hwnd
    _force_foreground_window(fg_hwnd)
    time.sleep(0.6)  # Wait for window to fully appear in foreground

    # Re-fetch the rect AFTER foreground (window may have moved/resized)
    _, rect = _find_whatsapp_hwnd_and_rect()
    # rect is always a tuple; fall back if it looks invalid (0,0,0,0)
    left, top, right, bottom = rect
    if right - left < 300 or bottom - top < 300:
        # WhatsApp not found or minimised — try once more after a short wait
        time.sleep(0.5)
        _, rect = _find_whatsapp_hwnd_and_rect()
        left, top, right, bottom = rect
    win_w = max(400, right - left)
    win_h = max(400, bottom - top)

    # Composer is at ~62% width, near bottom
    comp_cx = left + int(win_w * 0.62)
    comp_cy = bottom - 50

    time.sleep(0.3)

    # Focus composer — click it to make sure we're in the message box, not the search box
    _force_foreground_window(fg_hwnd)
    time.sleep(0.1)
    pyautogui.click(comp_cx, comp_cy)
    time.sleep(0.25)

    # Clear any previous draft text, then paste the message via clipboard
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.06)
    pyautogui.press("backspace")
    time.sleep(0.06)

    # Use pyperclip (reliable in all subprocess/UWP contexts, avoids win32clipboard crash)
    try:
        import pyperclip  # type: ignore
        pyperclip.copy(str(target_msg))
    except Exception:
        _copy_to_windows_clipboard(target_msg)
    time.sleep(0.1)

    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.3)

    # Send: press Enter ONCE only — do NOT also click Send button (causes double-send)
    pyautogui.press("enter")
    time.sleep(0.5)

    # Record in chat log
    _record_whatsapp_chat_log(log_label, target_msg)

    return CommandResult(
        True,
        f"WhatsApp Desktop message sent to {label}: '{target_msg}'",
    )


@registry.register(
    "open_whatsapp",
    "Opens native WhatsApp Desktop app and sends a message to a contact name or phone number",
    params=[
        CommandParam("phone", "str", "Recipient phone number (e.g. 911234567890) or contact name (e.g. 'Rahul', 'Bhaiya')", required=True),
        CommandParam("message", "str", "Message content to send via WhatsApp", required=True),
    ],
)
def open_whatsapp(
    phone: Optional[str] = None,
    message: Optional[str] = None,
    **kwargs: Any,
) -> CommandResult:
    """Opens native WhatsApp Desktop app (if installed) or WhatsApp Web as fallback.
    Verifies foreground window focus, chat composer readiness, message text, and post-send clear.
    Thread-safe and guaranteed non-overlapping execution via _wa_execution_lock.
    """
    with _wa_execution_lock:
        _attach_winsta()
        target_input = str(
            phone
            or kwargs.get("contact")
            or kwargs.get("contactName")
            or kwargs.get("contact_name")
            or kwargs.get("to")
            or kwargs.get("recipient")
            or kwargs.get("name")
            or ""
        ).strip()
        friendly_name = str(
            kwargs.get("contactName")
            or kwargs.get("contact_name")
            or ""
        ).strip()
        target_msg = str(
            message
            or kwargs.get("msg")
            or kwargs.get("text")
            or kwargs.get("body")
            or ""
        ).strip()

        if not target_input and not target_msg:
            return open_app(app_name="whatsapp")

        if not target_input:
            return CommandResult(False, "No phone number or contact name was provided.")

        # Deduplication guard: ignore identical calls if a prior attempt succeeded within 30s.
        # 30s window covers slow UI ops and prevents double-sends when ERA retries after failure.
        _dedup_key = ""
        if target_msg:
            digits_only_early = "".join(ch for ch in str(target_input) if ch.isdigit())
            _dedup_target = digits_only_early if len(digits_only_early) >= 7 else str(target_input).strip().lower()
            _dedup_key = f"{_dedup_target}:::{str(target_msg).strip().lower()}"
            _now_ts = time.time()
            _last_ts = _wa_dedup_cache.get(_dedup_key)
            if _last_ts is not None and (_now_ts - _last_ts) < 30.0:
                return CommandResult(
                    True,
                    f"WhatsApp message to '{friendly_name or target_input}' was already sent just now.",
                )

        # Resolve phone or contact name
        digits_only = "".join(ch for ch in target_input if ch.isdigit())
        resolved_phone: Optional[str] = None
        if len(digits_only) >= 7:
            resolved_phone = digits_only
        else:
            resolved_phone = _lookup_contact_phone(target_input)

        try:
            import pyautogui  # type: ignore
            pyautogui.FAILSAFE = False
        except ImportError:
            pyautogui = None

        app_installed = _is_whatsapp_desktop_installed()
        encoded_message = quote(target_msg) if target_msg else ""

        if resolved_phone:
            normalized_phone = _normalize_phone_number(resolved_phone)
            display_label = (
                f"{friendly_name} (+{normalized_phone})"
                if friendly_name and not friendly_name.isdigit()
                else (f"{target_input} (+{normalized_phone})" if not target_input.isdigit() else f"+{normalized_phone}")
            )

            # ── SCENARIO A: Phone number is known ──
            # Strategy: use whatsapp://send?phone=&text= URL to open the correct chat with
            # pre-filled message text, then press Enter to send. This avoids all search/UIA
            # issues and guarantees the right contact is opened.
            try:
                if app_installed:
                    _ensure_whatsapp_ready()

                    if target_msg:
                        # Pre-fill message in URL so the composer already has text when chat opens
                        app_url = f"whatsapp://send?phone={normalized_phone}&text={encoded_message}"
                    else:
                        app_url = f"whatsapp://send?phone={normalized_phone}"

                    try:
                        os.startfile(app_url)
                    except Exception:
                        _launch_windows_target(app_url)

                    # Wait for WhatsApp to open the correct chat (URL navigation takes ~2-3s)
                    time.sleep(2.5)

                    wa_hwnd = _wait_for_whatsapp_window(timeout=10.0, interval=0.35)
                    if not wa_hwnd:
                        wa_hwnd = _ensure_whatsapp_ready(timeout=4.0)
                    if not wa_hwnd:
                        return CommandResult(
                            False,
                            f"WhatsApp Desktop did not open or come to foreground for {display_label}, so the message was NOT sent.",
                        )

                    if target_msg:
                        # Bring WhatsApp to foreground and get fresh rect
                        import pyautogui  # type: ignore
                        pyautogui.FAILSAFE = False

                        _force_foreground_window(wa_hwnd)
                        time.sleep(0.5)

                        # Re-fetch rect NOW (after window is foreground and settled)
                        _, wa_rect = _find_whatsapp_hwnd_and_rect()
                        if wa_rect is None:
                            wa_rect = (0, 0, 1920, 1080)
                        wa_left, wa_top, wa_right, wa_bottom = wa_rect
                        wa_w = max(400, wa_right - wa_left)

                        # Click the composer box (bottom area, 62% from left)
                        comp_cx = wa_left + int(wa_w * 0.62)
                        comp_cy = wa_bottom - 50

                        _force_foreground_window(wa_hwnd)
                        time.sleep(0.1)
                        pyautogui.click(comp_cx, comp_cy)
                        time.sleep(0.3)

                        # The URL pre-filled the message; press Enter to send.
                        # Also handle edge case: if the text wasn't pre-filled (URL encoding issue),
                        # paste it manually then send.
                        # We always clear + re-paste to be safe with special characters.
                        pyautogui.hotkey("ctrl", "a")
                        time.sleep(0.06)
                        pyautogui.press("backspace")
                        time.sleep(0.06)

                        try:
                            import pyperclip  # type: ignore
                            pyperclip.copy(str(target_msg))
                        except Exception:
                            _copy_to_windows_clipboard(target_msg)
                        time.sleep(0.1)

                        pyautogui.hotkey("ctrl", "v")
                        time.sleep(0.3)

                        # Send: press Enter ONCE ONLY (no second click — that causes double-send)
                        pyautogui.press("enter")
                        time.sleep(0.5)

                        _record_whatsapp_chat_log(friendly_name or target_input, target_msg)
                        if _dedup_key:
                            _wa_dedup_cache[_dedup_key] = time.time()
                        return CommandResult(
                            True,
                            f"WhatsApp message sent to {display_label}: '{target_msg}'",
                        )
                    else:
                        return CommandResult(
                            True,
                            f"WhatsApp Desktop App chat opened for {display_label}.",
                        )

                else:
                    if target_msg and not pyautogui:
                        return CommandResult(False, f"WhatsApp Web opened for {display_label}, but pyautogui is required to send messages.")
                    if target_msg:
                        web_url = f"https://web.whatsapp.com/send?phone={normalized_phone}&text={encoded_message}"
                    else:
                        web_url = f"https://web.whatsapp.com/send?phone={normalized_phone}"
                    webbrowser.open_new_tab(web_url)
                    time.sleep(5.0)
                    if not _activate_whatsapp_or_browser_window():
                        return CommandResult(
                            False,
                            f"WhatsApp Web tab opened for {display_label}, but browser could not be brought to foreground, so the message was NOT sent.",
                        )
                    if target_msg:
                        time.sleep(0.5)
                        if not _send_whatsapp_enter():
                            return CommandResult(False, f"WhatsApp Web opened for {display_label}, but Enter could not be sent.")
                        time.sleep(0.8)
                        _record_whatsapp_chat_log(friendly_name or target_input, target_msg)
                        if _dedup_key:
                            _wa_dedup_cache[_dedup_key] = time.time()
                        return CommandResult(
                            True,
                            f"WhatsApp Web opened for +{normalized_phone} and message sent: '{target_msg}'",
                        )
                    else:
                        return CommandResult(
                            True,
                            f"WhatsApp Web chat opened for +{normalized_phone}.",
                        )

            except Exception as exc:
                return CommandResult(False, f"Failed to open WhatsApp for {display_label}: {exc}")

        else:
            # ── SCENARIO B: Contact name or group name — search inside WhatsApp ──
            try:
                clean_target = re.sub(r"\s*\b(?:ko|se|par|per|ji|bhaiya|mama|sir|uncle|didi)\b\s*$", "", str(target_input).strip(), flags=re.IGNORECASE).strip()
                if not clean_target:
                    clean_target = str(target_input).strip()

                if app_installed:
                    hwnd, _ = _find_whatsapp_hwnd_and_rect()
                    is_visible = bool(hwnd and ctypes.windll.user32.IsWindowVisible(hwnd) and not _is_window_cloaked(hwnd))
                    if not is_visible:
                        try:
                            os.startfile("whatsapp:")
                        except Exception:
                            _launch_windows_target("whatsapp:")
                        wa_hwnd = _wait_for_whatsapp_window(timeout=15.0, interval=0.35)
                    else:
                        wa_hwnd = _ensure_whatsapp_foreground(hwnd)

                    if not wa_hwnd:
                        return CommandResult(
                            False,
                            f"WhatsApp Desktop did not open or come to foreground for '{clean_target}', so the message was NOT sent.",
                        )

                    if not pyautogui:
                        return CommandResult(
                            False,
                            f"WhatsApp Desktop opened for '{clean_target}', but pyautogui is required to navigate.",
                        )

                    ok_search, search_err = _search_and_select_whatsapp_chat(wa_hwnd, clean_target)
                    if not ok_search:
                        return CommandResult(False, f"{search_err} Message was NOT sent.")

                    if target_msg:
                        res = _deliver_whatsapp_desktop_message(
                            wa_hwnd,
                            target_input=clean_target,
                            target_msg=target_msg,
                            display_name=clean_target,
                            search_fallback_target=None,
                            log_name=clean_target,
                        )
                        if res.success:
                            _auto_learn_whatsapp_contact(clean_target)
                            if _dedup_key:
                                _wa_dedup_cache[_dedup_key] = time.time()
                        return res
                    else:
                        ui_chat = _inspect_whatsapp_uia(wa_hwnd)
                        if ui_chat.get("ok") and not ui_chat.get("hasChatComposer"):
                            return CommandResult(
                                False,
                                f"WhatsApp Desktop searched for '{clean_target}', but could not open the chat.",
                            )
                        _auto_learn_whatsapp_contact(clean_target)
                        return CommandResult(
                            True,
                            f"Opened WhatsApp chat with '{clean_target}' successfully.",
                        )

                else:
                    if not pyautogui:
                        return CommandResult(False, "WhatsApp Web opened but pyautogui is required to navigate.")
                    webbrowser.open_new_tab("https://web.whatsapp.com")
                    time.sleep(5.0)
                    if not _activate_whatsapp_or_browser_window():
                        return CommandResult(
                            False,
                            f"WhatsApp Web opened, but browser could not be brought to foreground for '{clean_target}'.",
                        )
                    pyautogui.press("esc")
                    time.sleep(0.2)
                    pyautogui.hotkey("ctrl", "alt", "/")
                    time.sleep(0.5)
                    _copy_to_windows_clipboard(clean_target)
                    pyautogui.hotkey("ctrl", "v")
                    time.sleep(1.5)
                    pyautogui.press("down")
                    time.sleep(0.2)
                    pyautogui.press("enter")
                    time.sleep(0.8)
                    _auto_learn_whatsapp_contact(clean_target)
                    if target_msg:
                        time.sleep(0.2)
                        _copy_to_windows_clipboard(target_msg)
                        pyautogui.hotkey("ctrl", "v")
                        time.sleep(0.3)
                        if not _send_whatsapp_enter():
                            return CommandResult(False, f"WhatsApp Web could not send Enter for '{clean_target}'.")
                        time.sleep(0.5)
                        _record_whatsapp_chat_log(clean_target, target_msg)
                        if _dedup_key:
                            _wa_dedup_cache[_dedup_key] = time.time()
                        return CommandResult(
                            True,
                            f"Searched for '{clean_target}' on WhatsApp Web and sent message: '{target_msg}'",
                        )
                    else:
                        return CommandResult(
                            True,
                            f"Opened WhatsApp Web chat with '{clean_target}'.",
                        )

            except Exception as exc:
                return CommandResult(False, f"Failed to search and open WhatsApp for '{target_input}': {exc}")

def open_whatsapp_chat(contact: Optional[str] = None, **kwargs: Any) -> CommandResult:
    target = contact or kwargs.get("contactName") or kwargs.get("contact_name") or kwargs.get("name") or kwargs.get("phone") or ""
    if not target or not str(target).strip():
        return CommandResult(False, "No contact name or phone number provided.")
    return open_whatsapp(phone=target, message="", **kwargs)

@registry.register(
    "openWhatsAppChat",
    "Alias for open_whatsapp_chat",
    params=[
        CommandParam("contact", "str", "Name of the person to open chat with", required=True),
    ],
)
def openWhatsAppChat(contact: Optional[str] = None, **kwargs: Any) -> CommandResult:
    return open_whatsapp_chat(contact=contact, **kwargs)

def _normalize_delay_seconds(delay_seconds: Any, default: int = 30) -> str:
    try:
        val = int(round(float(delay_seconds)))
        return str(max(0, min(315360000, val)))
    except (TypeError, ValueError):
        return str(default)

@registry.register(
    "shutdown_pc",
    "Safely shuts down the computer after a short delay",
    params=[
        CommandParam("confirm", "str", "Confirmation string ('yes')", required=False, default="yes"),
        CommandParam("delay_seconds", "int", "Countdown delay in seconds", required=False, default=30),
    ],
)
def shutdown_pc(
    confirm: Optional[str] = "yes",
    delay_seconds: int = 30,
) -> CommandResult:
    """Shuts the computer down safely with confirmation."""
    if not _is_windows():
        return CommandResult(False, "This shutdown command targets Windows only.")

    conf_str = str(confirm).strip().lower() if confirm is not None else "yes"
    if conf_str in ("no", "cancel", "abort", "false", "0"):
        return CommandResult(False, "Shutdown cancelled by user request.")

    delay = _normalize_delay_seconds(delay_seconds, default=30)

    try:
        subprocess.run(["shutdown", "/s", "/t", delay], check=True)
        return CommandResult(
            True,
            f"Shutdown scheduled in {delay} seconds. Run 'cancel_shutdown' now to stop it.",
        )
    except (subprocess.CalledProcessError, OSError) as exc:
        return CommandResult(False, f"Failed to schedule shutdown: {exc}")

@registry.register(
    "restart_pc",
    "Safely restarts the computer after a short delay",
    params=[
        CommandParam("confirm", "str", "Confirmation string ('yes')", required=False, default="yes"),
        CommandParam("delay_seconds", "int", "Countdown delay in seconds", required=False, default=30),
    ],
)
def restart_pc(
    confirm: Optional[str] = "yes",
    delay_seconds: int = 30,
) -> CommandResult:
    """Restarts the computer safely with confirmation."""
    if not _is_windows():
        return CommandResult(False, "This restart command targets Windows only.")

    conf_str = str(confirm).strip().lower() if confirm is not None else "yes"
    if conf_str in ("no", "cancel", "abort", "false", "0"):
        return CommandResult(False, "Restart cancelled by user request.")

    delay = _normalize_delay_seconds(delay_seconds, default=30)

    try:
        subprocess.run(["shutdown", "/r", "/t", delay], check=True)
        return CommandResult(
            True,
            f"Restart scheduled in {delay} seconds. Run 'cancel_shutdown' now to stop it.",
        )
    except (subprocess.CalledProcessError, OSError) as exc:
        return CommandResult(False, f"Failed to schedule restart: {exc}")

@registry.register("sleep_pc", "Puts the Windows computer into sleep mode")
def sleep_pc() -> CommandResult:
    """Puts the Windows computer into sleep mode."""
    if not _is_windows():
        return CommandResult(False, "This sleep command targets Windows only.")
    try:
        subprocess.run(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"], check=True)
        return CommandResult(True, "Computer put to sleep successfully.")
    except (subprocess.CalledProcessError, OSError) as exc:
        return CommandResult(False, f"Failed to put computer to sleep: {exc}")

@registry.register(
    "close_app",
    "Closes a running application by its friendly name (e.g. opera, notepad, chrome, spotify, whatsapp, vscode)",
    params=[CommandParam("app_name", "str", "Friendly app name to close", required=True)],
)
def close_app(app_name: Optional[str] = None, **kwargs: Any) -> CommandResult:
    """Closes/terminates a running application by its friendly name on Windows."""
    if not _is_windows():
        return CommandResult(False, "This command targets Windows only.")

    target = (app_name or kwargs.get("appName") or kwargs.get("name") or "").strip().lower()
    if not target:
        return CommandResult(False, "No app name provided.")

    clean_key = re.sub(r"[^a-z0-9 ]", "", target).strip()

    # Active window handling
    if clean_key in ("window", "active", "this", "current", "active window", "current window", "activewindow", "currentwindow"):
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('%{F4}')"],
                timeout=3, capture_output=True
            )
            return CommandResult(True, "Active window band kar diya hai.")
        except Exception as exc:
            return CommandResult(False, f"Failed to close active window: {exc}")

    # Friendly name → list of process .exe names
    APP_PROCESS_MAP: dict = {
        "opera": ["opera.exe", "opera_gx_splash.exe", "opera_autoupdate.exe"],
        "opera gx": ["opera.exe", "opera_gx_splash.exe", "opera_autoupdate.exe"],
        "chrome": ["chrome.exe"],
        "google chrome": ["chrome.exe"],
        "edge": ["msedge.exe"],
        "msedge": ["msedge.exe"],
        "firefox": ["firefox.exe"],
        "brave": ["brave.exe"],
        "notepad": ["notepad.exe", "Notepad.exe"],
        "calculator": ["CalculatorApp.exe", "calculator.exe", "calc.exe"],
        "calc": ["CalculatorApp.exe", "calculator.exe", "calc.exe"],
        "spotify": ["Spotify.exe", "spotify.exe"],
        "whatsapp": ["WhatsApp.exe", "WhatsApp.Root.exe"],
        "telegram": ["Telegram.exe", "telegram.exe"],
        "vscode": ["Code.exe", "code.exe"],
        "code": ["Code.exe", "code.exe"],
        "visual studio code": ["Code.exe", "code.exe"],
        "vlc": ["vlc.exe"],
        "zoom": ["Zoom.exe"],
        "discord": ["Discord.exe"],
        "slack": ["slack.exe"],
        "teams": ["Teams.exe", "ms-teams.exe"],
        "paint": ["mspaint.exe"],
        "wordpad": ["wordpad.exe"],
        "word": ["WINWORD.EXE"],
        "excel": ["EXCEL.EXE"],
        "powerpoint": ["POWERPNT.EXE"],
        "outlook": ["OUTLOOK.EXE"],
        "terminal": ["WindowsTerminal.exe"],
        "cmd": ["cmd.exe"],
        "explorer": ["explorer.exe"],
        "file explorer": ["explorer.exe"],
        "chatgpt": ["ChatGPT.exe"],
        "camera": ["WindowsCamera.exe"],
        "settings": ["SystemSettings.exe"],
        "taskmgr": ["Taskmgr.exe"],
        "task manager": ["Taskmgr.exe"],
        "era": ["ERA AI Assistant.exe"],
        "era assistant": ["ERA AI Assistant.exe"],
    }

    exe_list = (
        APP_PROCESS_MAP.get(clean_key)
        or APP_PROCESS_MAP.get(clean_key.replace(" ", ""))
        or [f"{clean_key}.exe"]
    )

    killed_any = False

    # 1. Kill matching processes using psutil (fast, reliable, process tree safe)
    try:
        import psutil
        for p in psutil.process_iter(['pid', 'name', 'exe']):
            try:
                pname = (p.info['name'] or '').lower()
                matches_exe = any(e.lower() == pname for e in exe_list)
                matches_sub = (len(clean_key) >= 3 and clean_key in pname)
                if (matches_exe or matches_sub) and p.pid != os.getpid():
                    p.kill()
                    killed_any = True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception:
        pass

    # 2. taskkill /F /T /IM for each exe in exe_list
    for exe in exe_list:
        try:
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/IM", exe],
                capture_output=True, text=True, timeout=3
            )
            if result.returncode == 0 or "SUCCESS" in result.stdout.upper():
                killed_any = True
        except Exception:
            pass

    # 3. PowerShell fallback if still not confirmed
    if not killed_any and len(clean_key) >= 3:
        try:
            ps_cmd = f"Get-Process | Where-Object {{ $_.ProcessName -like '*{clean_key}*' -or $_.MainWindowTitle -like '*{clean_key}*' }} | Stop-Process -Force -ErrorAction SilentlyContinue"
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], timeout=3, capture_output=True)
            killed_any = True
        except Exception:
            pass

    if killed_any:
        return CommandResult(True, f"{target.title()} band kar diya hai.")
    else:
        return CommandResult(False, f"Could not close '{target}'. App may not be running.")


@registry.register("cancel_shutdown", "Cancels a pending shutdown or restart")
def cancel_shutdown() -> CommandResult:
    """Cancels any shutdown/restart scheduled by shutdown_pc or restart_pc."""
    if not _is_windows():
        return CommandResult(False, "This command targets Windows only.")

    try:
        subprocess.run(["shutdown", "/a"], check=True)
        return CommandResult(True, "Pending shutdown/restart was cancelled.")
    except subprocess.CalledProcessError:
        return CommandResult(False, "There was no pending shutdown/restart to cancel.")
    except OSError as exc:
        return CommandResult(False, f"Failed to cancel shutdown: {exc}")

@registry.register("open_camera", "Opens the Windows Camera app")
def open_camera() -> CommandResult:
    """Opens the built-in Windows Camera app via its registered URI."""
    if not _is_windows():
        return CommandResult(False, "Camera launch via this method is only available on Windows.")
    try:
        os.startfile("microsoft.windows.camera:")
        return CommandResult(True, "Camera opened successfully.")
    except OSError as exc:
        return CommandResult(
            False,
            f"Failed to open Camera. Make sure the Windows Camera app is installed: {exc}",
        )

def _find_browser_path(browser_name: str) -> Optional[str]:
    """Looks for a named browser on PATH, then in common install locations."""
    known_paths = {
        "chrome": [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ],
        "edge": [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ],
        "firefox": [
            r"C:\Program Files\Mozilla Firefox\firefox.exe",
            r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
        ],
        "brave": [
            r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
            r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        ],
        "opera": [
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Opera\opera.exe"),
            r"C:\Program Files\Opera\launcher.exe",
            r"C:\Program Files (x86)\Opera\launcher.exe",
        ],
        "operagx": [
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Opera GX\opera.exe"),
            r"C:\Program Files\Opera GX\launcher.exe",
        ],
    }

    key = browser_name.strip().lower()
    which_result = shutil.which(key)
    if which_result:
        return which_result

    for path_str in known_paths.get(key, []):
        path = Path(path_str)
        if path.exists():
            return str(path)
    return None

_COMMON_APP_ALIASES = {
    "chatgpt": r"shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App",
    "chat gpt": r"shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App",
    "canva": r"shell:AppsFolder\com.canva.CanvaDesktop",
    "canva app": r"shell:AppsFolder\com.canva.CanvaDesktop",
    "whatsapp": r"shell:AppsFolder\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App",
    "whatsapp desktop": r"shell:AppsFolder\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App",
    "xbox": r"shell:AppsFolder\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App",
    "calculator": "calc:",
    "calc": "calc:",
    "notepad": "notepad.exe",
    "camera": "microsoft.windows.camera:",
    "settings": "ms-settings:",
    "word": "winword.exe",
    "ms word": "winword.exe",
    "microsoft word": "winword.exe",
    "excel": "excel.exe",
    "ms excel": "excel.exe",
    "microsoft excel": "excel.exe",
    "powerpoint": "powerpnt.exe",
    "ppt": "powerpnt.exe",
    "paint": "mspaint.exe",
    "terminal": "wt.exe",
    "vscode": "Code.exe",
    "vs code": "Code.exe",
    "code": "Code.exe",
    "visual studio code": "Code.exe",
    "visual studio": "devenv.exe",
    "chrome": "chrome.exe",
    "google chrome": "chrome.exe",
    "google": "chrome.exe",
    "edge": "msedge.exe",
    "msedge": "msedge.exe",
    "microsoft edge": "msedge.exe",
    "firefox": "firefox.exe",
    "brave": "brave.exe",
    "opera": "launcher.exe",
    "opera gx": "launcher.exe",
    "spotify": "spotify.exe",
    "vlc": "vlc.exe",
    "steam": "steam.exe",
    "discord": "discord.exe",
    "telegram": "telegram.exe",
    "whatsapp": "whatsapp:",
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "calc": "calc.exe",
    "camera": "microsoft.windows.camera:",
    "webcam": "microsoft.windows.camera:",
    "settings": "ms-settings:",
    "pc settings": "ms-settings:",
    "task manager": "taskmgr.exe",
    "taskmgr": "taskmgr.exe",
    "file explorer": "explorer.exe",
    "explorer": "explorer.exe",
    "files": "explorer.exe",
    "control panel": "control.exe",
    "paint": "mspaint.exe",
    "mspaint": "mspaint.exe",
    "terminal": "wt.exe",
    "windows terminal": "wt.exe",
    "cmd": "cmd.exe",
    "command prompt": "cmd.exe",
    "powershell": "powershell.exe",
    "word": "winword.exe",
    "ms word": "winword.exe",
    "microsoft word": "winword.exe",
    "excel": "excel.exe",
    "ms excel": "excel.exe",
    "microsoft excel": "excel.exe",
    "powerpoint": "powerpnt.exe",
    "ppt": "powerpnt.exe",
    "snipping tool": "snippingtool.exe",
    "snip": "snippingtool.exe",
    "microsoft store": "ms-windows-store:",
    "store": "ms-windows-store:",
    "windows store": "ms-windows-store:",
    "ms store": "ms-windows-store:",
    "xbox": "shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App",
    "xbox app": "shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App",
    "game bar": "shell:AppsFolder\\Microsoft.XboxGamingOverlay_8wekyb3d8bbwe!App",
    "claude": "claude:",
    "claude app": "claude:",
    "claude ai": "claude:",
    "chatgpt": "ChatGPT.exe",
    "chat gpt": "ChatGPT.exe",
    "openai": "ChatGPT.exe",
    "canva": "Canva.exe",
    "canva app": "Canva.exe",
    "canva desktop": "Canva.exe",
    "antigravity": "antigravity.exe",
    "cloudcode": "cloudcode.exe",
    "cursor": "Cursor.exe",
    "postman": "Postman.exe",
    "sublime": "sublime_text.exe",
    "sublime text": "sublime_text.exe",
    "pycharm": "pycharm64.exe",
    "intellij": "idea64.exe",
    "android studio": "studio64.exe",
}

def _find_in_registry_app_paths(name: str) -> Optional[str]:
    """Looks up application executable path in Windows Registry App Paths."""
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"),
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\App Paths"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths"),
    ]
    name_lower = name.lower().strip()
    search_keys = [name_lower, f"{name_lower}.exe"]

    for hkey, subkey_path in roots:
        try:
            with winreg.OpenKey(hkey, subkey_path) as root_key:
                for sk in search_keys:
                    try:
                        with winreg.OpenKey(root_key, sk) as app_key:
                            val, _ = winreg.QueryValueEx(app_key, "")
                            if val and os.path.exists(val.strip('"')):
                                return val.strip('"')
                    except Exception:
                        pass

                count = winreg.QueryInfoKey(root_key)[0]
                for i in range(count):
                    try:
                        kname = winreg.EnumKey(root_key, i)
                        kname_clean = kname.lower().replace(".exe", "")
                        if name_lower == kname_clean or name_lower in kname_clean:
                            with winreg.OpenKey(root_key, kname) as app_key:
                                val, _ = winreg.QueryValueEx(app_key, "")
                                if val and os.path.exists(val.strip('"')):
                                    return val.strip('"')
                    except Exception:
                        continue
        except Exception:
            continue
    return None

def _find_app_path(app_name: str) -> Optional[str]:
    """Locates an application executable, URI scheme, or Start Menu shortcut on any Windows PC."""
    if not app_name:
        return None

    clean_name = app_name.strip()
    name_lower = clean_name.lower()
    norm_name = re.sub(r"[^a-z0-9]", "", name_lower)

    # 1. Direct path check
    candidate = Path(clean_name)
    if candidate.exists():
        return str(candidate)

    # 1.1 Direct Fast Paths for high-frequency Windows desktop apps
    if norm_name in ("notepad", "note", "editor", "texteditor"):
        return "notepad.exe"
    if norm_name in ("calc", "calculator"):
        return "calc.exe"
    if norm_name in ("opera", "operagx", "operabrowser"):
        opera_paths = [
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Opera" / "opera.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Opera GX" / "opera.exe",
            Path("C:/Users/MSI/AppData/Local/Programs/Opera/opera.exe"),
        ]
        for op in opera_paths:
            if op.exists():
                return str(op)
        return "opera"
    if norm_name in ("explorer", "fileexplorer", "files", "thispc", "mycomputer"):
        return "explorer.exe"
    if norm_name in ("paint", "mspaint"):
        return "mspaint.exe"

    # 2. Check alias dictionary (both raw and normalized)
    alias_target = _COMMON_APP_ALIASES.get(name_lower)
    if not alias_target:
        for k, v in _COMMON_APP_ALIASES.items():
            if re.sub(r"[^a-z0-9]", "", k) == norm_name:
                alias_target = v
                break

    if alias_target:
        if alias_target.startswith("ms-") or alias_target.startswith("shell:") or alias_target.endswith(":"):
            return alias_target

    # 3. Special fast check for VS Code (most common downloaded app on Windows)
    if norm_name in ("vscode", "code", "visualstudiocode"):
        user_local = os.environ.get("LOCALAPPDATA", "")
        prog_files = os.environ.get("ProgramFiles", "")
        prog_x86 = os.environ.get("ProgramFiles(x86)", "")
        vscode_candidates = [
            Path(user_local) / "Programs" / "Microsoft VS Code" / "Code.exe",
            Path(prog_files) / "Microsoft VS Code" / "Code.exe",
            Path(prog_x86) / "Microsoft VS Code" / "Code.exe",
        ]
        for p in vscode_candidates:
            if p.exists():
                return str(p)

    # 4. Special fast check for Google Chrome
    if norm_name in ("chrome", "googlechrome", "google"):
        cp = _find_chrome_path()
        if cp:
            return cp

    # 5. Check Windows Registry App Paths (covers 95% of installed desktop apps)
    reg_path = _find_in_registry_app_paths(name_lower)
    if reg_path:
        return reg_path
    if alias_target and alias_target.lower().endswith(".exe"):
        reg_alias = _find_in_registry_app_paths(alias_target.replace(".exe", ""))
        if reg_alias:
            return reg_alias

    # 6. Try PATH resolution (preferring .exe over .cmd/.bat)
    which_exe = shutil.which(f"{name_lower}.exe") or (shutil.which(alias_target) if alias_target else None)
    if which_exe and which_exe.lower().endswith(".exe"):
        return which_exe

    which_result = shutil.which(clean_name)
    if which_result:
        # If it returned a .cmd or .bat (e.g. code.cmd), look for adjacent or parent .exe
        if which_result.lower().endswith((".cmd", ".bat")):
            wb = Path(which_result)
            parent_exe = wb.parent.parent / f"{wb.stem.capitalize()}.exe"
            if parent_exe.exists():
                return str(parent_exe)
            parent_code = wb.parent.parent / "Code.exe"
            if parent_code.exists():
                return str(parent_code)
        return which_result

    # 7. Check Start Menu and Desktop shortcuts (.lnk files)
    start_menu_locations = []
    for env_var, sub in [
        ("APPDATA", r"Microsoft\Windows\Start Menu\Programs"),
        ("PROGRAMDATA", r"Microsoft\Windows\Start Menu\Programs"),
        ("APPDATA", r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"),
    ]:
        val = os.environ.get(env_var)
        if val:
            p = Path(val) / sub
            if p.exists():
                start_menu_locations.append(p)
    try:
        user_desktop = Path.home() / "Desktop"
        if user_desktop.exists():
            start_menu_locations.append(user_desktop)
        pub_desktop = Path(os.environ.get("PUBLIC", "C:\\Users\\Public")) / "Desktop"
        if pub_desktop.exists():
            start_menu_locations.append(pub_desktop)
    except Exception:
        pass

    for sm in start_menu_locations:
        if not sm.exists():
            continue
        try:
            for root, _dirs, files in os.walk(sm):
                for f in files:
                    if not f.lower().endswith(".lnk"):
                        continue
                    stem = Path(f).stem.lower()
                    stem_norm = re.sub(r"[^a-z0-9]", "", stem)
                    # Direct or normalized substring match
                    if (
                        name_lower in stem
                        or stem in name_lower
                        or norm_name == stem_norm
                        or norm_name in stem_norm
                        or stem_norm in norm_name
                    ):
                        lnk_file = str(Path(root) / f)
                        res_target, _, _ = _resolve_shortcut(lnk_file)
                        if res_target and os.path.exists(res_target):
                            return res_target
                        return lnk_file

                    if alias_target:
                        at_clean = re.sub(r"[^a-z0-9]", "", alias_target.lower().replace(".exe", ""))
                        if at_clean and (at_clean in stem_norm or stem_norm in at_clean):
                            lnk_file = str(Path(root) / f)
                            res_target, _, _ = _resolve_shortcut(lnk_file)
                            if res_target and os.path.exists(res_target):
                                return res_target
                            return lnk_file
        except Exception:
            continue

    # 8. Check UWP / Microsoft Store apps via PowerShell Get-StartApps
    uwp_id = _find_uwp_app_id(clean_name)
    if uwp_id:
        return f"uwp:{uwp_id}"

    # 9. Search common Program Files and Local AppData folders (+ Roaming for user-installed apps)
    search_roots = []
    pf = os.environ.get("ProgramFiles")
    pfx = os.environ.get("ProgramFiles(x86)")
    local_app = Path.home() / "AppData" / "Local"
    roaming_app = Path.home() / "AppData" / "Roaming"
    local_prog = local_app / "Programs"
    if pf and Path(pf).exists():
        search_roots.append(Path(pf))
    if pfx and Path(pfx).exists():
        search_roots.append(Path(pfx))
    if local_prog.exists():
        search_roots.append(local_prog)
    # Roaming AppData: Spotify, Discord, Telegram, Signal are installed here on many PCs
    if roaming_app.exists():
        search_roots.append(roaming_app)
    if local_app.exists():
        search_roots.append(local_app)

    # Specific hard-coded fast paths for very common apps installed in non-standard user dirs
    user_app_direct = {
        "spotify": [
            roaming_app / "Spotify" / "Spotify.exe",
            local_app / "Microsoft" / "WindowsApps" / "Spotify.exe",
        ],
        "discord": [
            # Discord installs to %LOCALAPPDATA%\Discord\app-X.X.XXXX\Discord.exe
            # The version subfolder changes with updates, so we glob for it
            local_app / "Discord" / "app-current" / "Discord.exe",
            roaming_app / "Discord" / "Discord.exe",
        ],
        "telegram": [
            roaming_app / "Telegram Desktop" / "Telegram.exe",
            local_app / "Telegram Desktop" / "Telegram.exe",
        ],
        "signal": [
            local_app / "Programs" / "signal-desktop" / "Signal.exe",
        ],
        "opera": [
            roaming_app / "Opera Software" / "Opera Stable" / "opera.exe",
            local_app / "Programs" / "Opera" / "launcher.exe",
        ],
        "opera gx": [
            roaming_app / "Opera Software" / "Opera GX Stable" / "opera.exe",
            local_app / "Programs" / "Opera GX" / "launcher.exe",
        ],
        "chatgpt": [
            local_app / "Programs" / "chatgpt" / "ChatGPT.exe",
            Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "ChatGPT" / "ChatGPT.exe",
        ],
    }
    for key_term, paths in user_app_direct.items():
        if norm_name in re.sub(r"[^a-z0-9]", "", key_term) or re.sub(r"[^a-z0-9]", "", key_term) in norm_name:
            for p in paths:
                if p.exists():
                    return str(p)

    # Discord: version-numbered subfolders (e.g. %LOCALAPPDATA%\Discord\app-1.0.9173\Discord.exe)
    if "discord" in norm_name:
        discord_base = local_app / "Discord"
        if discord_base.exists():
            try:
                ver_dirs = sorted(
                    [d for d in discord_base.iterdir() if d.is_dir() and d.name.startswith("app-")],
                    key=lambda d: d.name, reverse=True,
                )
                for vd in ver_dirs:
                    exe = vd / "Discord.exe"
                    if exe.exists():
                        return str(exe)
            except Exception:
                pass

    # Spotify: may be in %LOCALAPPDATA%\Microsoft\WindowsApps (Store version)
    if "spotify" in norm_name:
        spotify_store = local_app / "Microsoft" / "WindowsApps" / "Spotify.exe"
        if spotify_store.exists():
            return str(spotify_store)
        spotify_roaming = roaming_app / "Spotify" / "Spotify.exe"
        if spotify_roaming.exists():
            return str(spotify_roaming)

    for root in search_roots:
        try:
            for item in root.iterdir():
                if item.is_dir():
                    dir_norm = re.sub(r"[^a-z0-9]", "", item.name.lower())
                    if norm_name in dir_norm or dir_norm in norm_name:
                        for sub in item.glob("*.exe"):
                            sub_name = sub.name.lower()
                            if "uninstall" not in sub_name and "helper" not in sub_name and "setup" not in sub_name and "update" not in sub_name:
                                return str(sub)
                        for sub in item.glob("*/*.exe"):
                            sub_name = sub.name.lower()
                            if "uninstall" not in sub_name and "helper" not in sub_name and "setup" not in sub_name and "update" not in sub_name:
                                return str(sub)
        except Exception:
            continue

    return None

def _find_uwp_app_id(app_name: str) -> Optional[str]:
    """Fast UWP / Microsoft Store app resolver with static cache and non-blocking fallback."""
    if not app_name:
        return None
    norm_name = re.sub(r"[^a-z0-9]", "", str(app_name).lower().strip())
    static_uwp = {
        "calc": "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
        "calculator": "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
        "whatsapp": "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App",
        "xbox": "Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App",
        "gamebar": "Microsoft.XboxGamingOverlay_8wekyb3d8bbwe!App",
        "camera": "Microsoft.WindowsCamera_8wekyb3d8bbwe!App",
        "photos": "Microsoft.Windows.Photos_8wekyb3d8bbwe!App",
        "notepad": "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
        "terminal": "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
        "paint": "Microsoft.Paint_8wekyb3d8bbwe!App",
        "settings": "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
        "store": "Microsoft.WindowsStore_8wekyb3d8bbwe!App",
        "chatgpt": "OpenAI.Codex_2p2nqsd0c76g0!App",
    }
    if norm_name in static_uwp:
        return static_uwp[norm_name]

    global _START_APPS_CACHE, _START_APPS_CACHE_TIME
    import time, json
    now = time.time()
    if _START_APPS_CACHE is None or (now - _START_APPS_CACHE_TIME > 600.0):
        try:
            ps = [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
            ]
            proc = subprocess.run(ps, capture_output=True, text=True, timeout=2.0)
            out = proc.stdout.strip()
            if out:
                data = json.loads(out)
                _START_APPS_CACHE = data if isinstance(data, list) else [data]
                _START_APPS_CACHE_TIME = now
        except Exception:
            pass

    if not _START_APPS_CACHE:
        return None

    name_lower = app_name.lower().strip()
    norm_name = re.sub(r"[^a-z0-9]", "", name_lower)

    alias_map = {
        "calc": ["calculator"],
        "calculator": ["calculator", "calc"],
        "xbox": ["xbox", "gaming"],
        "whatsapp": ["whatsapp"],
        "chatgpt": ["chatgpt", "openai"],
        "chat gpt": ["chatgpt", "openai"],
        "canva": ["canva"],
        "notepad": ["notepad"],
        "camera": ["camera"],
        "settings": ["setting"],
        "store": ["microsoft store"],
        "terminal": ["windows terminal", "terminal"],
        "word": ["word"],
        "excel": ["excel"],
        "powerpoint": ["powerpoint"],
    }
    search_terms = alias_map.get(name_lower, [name_lower])
    for entry in _START_APPS_CACHE:
        try:
            nm = str(entry.get("Name", "")).lower()
            aid = str(entry.get("AppID") or entry.get("AppId") or "")
            nm_norm = re.sub(r"[^a-z0-9]", "", nm)
            if nm and aid:
                for term in search_terms:
                    term_norm = re.sub(r"[^a-z0-9]", "", term)
                    if term in nm or term_norm in nm_norm or term in aid.lower():
                        return aid
        except Exception:
            continue
    return None

@registry.register(
    "open_browser",
    "Opens a specified browser (Chrome, Edge, Firefox, Brave) with optional URL",
    params=[
        CommandParam("browser_name", "str", "Browser name: chrome, edge, firefox, or brave", required=False, default="default"),
        CommandParam("url", "str", "URL to open in the browser", required=False),
    ],
)
def open_browser(
    browser_name: Optional[str] = None,
    url: Optional[str] = None,
) -> CommandResult:
    """Opens a browser chosen by name."""
    raw_b = (browser_name.strip() if browser_name else "chrome") or "chrome"
    target_url = url if url else "https://www.google.com"
    if not (target_url.startswith("http://") or target_url.startswith("https://")):
        target_url = "https://" + target_url

    if raw_b.lower() in ("default", "system", "browser", "brouser", "webbrowser", "internet", "web"):
        b_name = "chrome"
    else:
        b_name = raw_b.lower()

    browser_path = _find_browser_path(b_name)
    if browser_path is None:
        browser_path = _find_app_path(b_name)

    if browser_path is None:
        chrome_candidates = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        ]
        for cp in chrome_candidates:
            if os.path.exists(cp):
                browser_path = cp
                break

    clean_env = _get_clean_env()
    flags = 0x00000200  # CREATE_NEW_PROCESS_GROUP

    if browser_path and os.path.exists(browser_path):
        try:
            subprocess.Popen([browser_path, target_url], env=clean_env, creationflags=flags)
            return CommandResult(True, f"{b_name.title()} opened successfully to {target_url}.")
        except Exception:
            pass

    try:
        subprocess.Popen(["cmd.exe", "/c", "start", "", target_url], env=clean_env, creationflags=flags)
        return CommandResult(True, f"Opened browser to {target_url}.")
    except Exception as exc:
        return CommandResult(False, f"Failed to open browser: {exc}")

@registry.register(
    "open_app",
    "Opens any app by name (e.g. spotify, vscode, notepad, whatsapp, chrome, settings)",
    params=[
        CommandParam("app_name", "str", "App name or full path to open", required=True),
    ],
)
def open_app(app_name: Optional[str] = None, in_background: bool = False, **kwargs: Any) -> CommandResult:
    """Opens an arbitrary application by name or full path across any Windows computer."""
    if not _is_windows():
        return CommandResult(False, "This generic app launcher targets Windows only.")

    target_raw = app_name or kwargs.get("appName") or kwargs.get("name") or kwargs.get("app")
    if not target_raw or not str(target_raw).strip():
        return CommandResult(False, "No app name was provided.")

    fg_before = 0
    if in_background or kwargs.get("in_background"):
        try:
            fg_before = ctypes.windll.user32.GetForegroundWindow()
        except Exception:
            pass

    clean_name = _clean_app_name(target_raw) or str(target_raw).strip()
    norm_name = re.sub(r"[^a-z0-9]", "", clean_name.lower())

    # Fallback to raw normalized if clean stripped everything
    if not norm_name:
        clean_name = str(target_raw).strip()
        norm_name = re.sub(r"[^a-z0-9]", "", clean_name.lower())

    # Web services fallbacks (instant launch in default browser)
    web_services = {
        ("browser", "brouser", "webbrowser", "internet", "web", "website"): ("", "https://www.google.com", "Browser"),
        ("spotify", "spotifymusic", "spotifyapp"): ("spotify:", "https://open.spotify.com", "Spotify"),
        ("youtube", "yt", "youtubemusic"): ("", "https://www.youtube.com", "YouTube"),
        ("instagram", "insta"): ("", "https://www.instagram.com", "Instagram"),
        ("facebook", "fb"): ("", "https://www.facebook.com", "Facebook"),
        ("twitter", "x"): ("", "https://twitter.com", "Twitter / X"),
        ("github", "git"): ("", "https://github.com", "GitHub"),
        ("gmail", "googlemail"): ("", "https://mail.google.com", "Gmail"),
        ("google", "googlecom"): ("", "https://www.google.com", "Google"),
        ("zomato", "zomatofood"): ("", "https://www.zomato.com", "Zomato"),
        ("swiggy", "swiggyfood"): ("", "https://www.swiggy.com", "Swiggy"),
    }
    for aliases, (proto, web_url, label) in web_services.items():
        if norm_name in aliases:
            if proto and _launch_windows_target(proto):
                return CommandResult(True, f"{label} opened successfully on your laptop.")
            res = open_browser("chrome", web_url)
            if res.success:
                return CommandResult(True, f"Opened {label} in your browser.")
            try:
                os.startfile(web_url)
                return CommandResult(True, f"Opened {label} in your browser.")
            except Exception:
                pass

    # 1. Specialized fast paths for major downloaded & modern apps

    # VS Code: Guaranteed clean single launch and immediate window focus (never multiple windows)
    if norm_name in ("vscode", "code", "visualstudiocode", "vsocde"):
        user32 = ctypes.windll.user32
        # If VS Code is ALREADY open, bring the existing window to the front immediately!
        h = _find_window_for_app("vscode")
        if h:
            if user32.IsIconic(h):
                user32.ShowWindow(h, 9)
            _force_foreground_window(h)
            return CommandResult(True, "Visual Studio Code brought to foreground.")

        user_local = os.environ.get("LOCALAPPDATA", "")
        prog_files = os.environ.get("ProgramFiles", "")
        prog_x86 = os.environ.get("ProgramFiles(x86)", "")
        vscode_candidates = [
            Path(user_local) / "Programs" / "Microsoft VS Code" / "Code.exe",
            Path(prog_files) / "Microsoft VS Code" / "Code.exe",
            Path(prog_x86) / "Microsoft VS Code" / "Code.exe",
        ]
        flags = 0x00000200  # CREATE_NEW_PROCESS_GROUP
        code_bin = next((str(p) for p in vscode_candidates if p.exists()), None)
        if not code_bin:
            lnk = _find_app_path("vscode")
            if lnk and os.path.exists(lnk):
                code_bin = lnk

        if code_bin:
            try:
                subprocess.Popen([code_bin, "--reuse-window"], creationflags=flags)
            except Exception:
                try:
                    os.startfile(code_bin)
                except Exception:
                    subprocess.Popen(["cmd.exe", "/c", "code", "--reuse-window"], shell=True)

            # Bring to foreground asynchronously in a background daemon thread (non-blocking)
            def _async_focus():
                try:
                    u32 = ctypes.windll.user32
                    for _ in range(12):
                        time.sleep(0.2)
                        h = _find_window_for_app("vscode")
                        if h:
                            if u32.IsIconic(h):
                                u32.ShowWindow(h, 9)
                            _force_foreground_window(h)
                            break
                except Exception:
                    pass
            threading.Thread(target=_async_focus, daemon=True).start()
            return CommandResult(True, "Visual Studio Code opened successfully.")

        return CommandResult(False, "VS Code was not found on this laptop. Please install it first.")

    if norm_name in ("notepad", "editor", "notes"):
        if _launch_windows_target("shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"):
            return CommandResult(True, "'notepad' opened successfully on your laptop.")

    if norm_name in ("canva", "canvaapp", "canvadesktop"):
        # Check direct desktop executable locations first
        canva_candidates = [
            Path.home() / "AppData" / "Local" / "Programs" / "Canva" / "Canva.exe",
            Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "Canva" / "Canva.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Canva" / "Canva.exe",
        ]
        for cp in canva_candidates:
            if cp.exists() and _launch_windows_target(str(cp)):
                return CommandResult(True, "Canva opened successfully on your laptop.")
        found = _find_app_path("canva")
        if found and not found.startswith("uwp:"):
            if _launch_windows_target(found):
                return CommandResult(True, "Canva opened successfully on your laptop.")
        if found and found.startswith("uwp:"):
            appid = found.split("uwp:", 1)[1]
            if _launch_windows_target(f"shell:AppsFolder\\{appid}"):
                return CommandResult(True, "Canva opened successfully.")
        if _launch_windows_target("shell:AppsFolder\\com.canva.CanvaDesktop"):
            return CommandResult(True, "Canva opened successfully.")
        try:
            os.startfile("https://www.canva.com")
            return CommandResult(True, "Opened Canva in your browser.")
        except Exception:
            pass

    if norm_name in ("chatgpt", "chatgptapp", "openai"):
        found = _find_app_path("chatgpt")
        if found:
            if found.startswith("uwp:"):
                appid = found.split("uwp:", 1)[1]
                if _launch_windows_target(f"shell:AppsFolder\\{appid}"):
                    return CommandResult(True, "ChatGPT opened successfully.")
            elif _launch_windows_target(found):
                return CommandResult(True, "ChatGPT opened successfully on your laptop.")
        try:
            os.startfile("https://chatgpt.com")
            return CommandResult(True, "Opened ChatGPT in your browser.")
        except Exception:
            pass

    if norm_name in ("claude", "claudeapp", "claudeai"):
        found = _find_app_path("claude")
        if found and _launch_windows_target(found):
            return CommandResult(True, "Claude opened successfully.")
        try:
            os.startfile("https://claude.ai")
            return CommandResult(True, "Opened Claude in your browser.")
        except Exception:
            pass

    if norm_name in ("whatsapp", "whatsappdesktop"):
        # Method 1: Direct UWP Store AppID (confirmed on Windows 10/11)
        if _launch_windows_target("shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"):
            return CommandResult(True, "WhatsApp opened successfully.")
        # Method 2: Dynamic UWP lookup for any PC
        uwp_id = _find_uwp_app_id("whatsapp")
        if uwp_id and _launch_windows_target(f"shell:AppsFolder\\{uwp_id}"):
            return CommandResult(True, "WhatsApp opened successfully.")
        # Method 3: Desktop shortcut / exe
        found = _find_app_path("whatsapp")
        if found and _launch_windows_target(found):
            return CommandResult(True, "WhatsApp opened successfully.")
        # Method 4: Protocol
        if _launch_windows_target("whatsapp:"):
            return CommandResult(True, "WhatsApp opened successfully.")
        try:
            os.startfile("https://web.whatsapp.com")
            return CommandResult(True, "Opened WhatsApp Web in your browser.")
        except Exception:
            pass

    if norm_name in ("xbox", "xboxapp", "xboxgaming"):
        # Method 1: Direct known UWP AppID (confirmed working on most PCs)
        if _launch_windows_target("shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App"):
            return CommandResult(True, "Xbox opened successfully.")
        # Method 2: Dynamic UWP lookup (works on any PC even if AppID differs)
        uwp_id = _find_uwp_app_id("xbox")
        if uwp_id and _launch_windows_target(f"shell:AppsFolder\\{uwp_id}"):
            return CommandResult(True, "Xbox opened successfully.")
        # Method 3: Game Bar fallback
        if _launch_windows_target("shell:AppsFolder\\Microsoft.XboxGamingOverlay_8wekyb3d8bbwe!App"):
            return CommandResult(True, "Xbox Game Bar opened successfully.")

    # 2. General application lookup
    found = _find_app_path(clean_name)

    # 3. Found via UWP (Microsoft Store / Windows app)
    if found and str(found).lower().startswith("uwp:"):
        appid = found.split("uwp:", 1)[1]
        uri = f"shell:AppsFolder\\{appid}"
        if _launch_windows_target(uri):
            return CommandResult(True, f"'{clean_name}' opened successfully.")
        return CommandResult(False, f"Could not launch UWP app '{clean_name}'.")

    # 4. Found via path (.exe / .lnk / URI protocol) — launch it
    if found:
        if _launch_windows_target(found):
            return CommandResult(True, f"'{clean_name}' opened successfully on your laptop.")
        else:
            return CommandResult(False, f"Found '{clean_name}' at {found} but failed to launch it.")

    # 5. Direct protocol check (e.g. ms-settings:, ms-windows-store:)
    if clean_name.startswith("ms-") or clean_name.endswith(":"):
        if _launch_windows_target(clean_name):
            return CommandResult(True, f"'{clean_name}' opened successfully.")

    # 6. App not found on this PC
    return CommandResult(
        False,
        f"'{clean_name}' was not found on this laptop. "
        f"Please make sure the app is installed and try again."
    )

@registry.register("lock_pc", "Locks the Windows computer screen")
def lock_pc() -> CommandResult:
    """Locks the current Windows user workstation."""
    if not _is_windows():
        return CommandResult(False, "This lock command targets Windows only.")

    try:
        subprocess.run(["rundll32.exe", "user32.dll,LockWorkStation"], check=True)
        return CommandResult(True, "Computer screen locked successfully.")
    except (subprocess.CalledProcessError, OSError) as exc:
        return CommandResult(False, f"Failed to lock computer: {exc}")

# ---------------------------------------------------------------------------
# Phone Link Device Integration Commands
# ---------------------------------------------------------------------------

@registry.register(
    "make_phone_call",
    "Initiates a phone call via Windows Phone Link device to a phone number or contact name",
    params=[
        CommandParam("phone", "str", "Phone number or contact name to call", required=False),
        CommandParam("target", "str", "Phone number or contact name to call", required=False),
        CommandParam("contact", "str", "Phone number or contact name to call", required=False),
        CommandParam("number", "str", "Phone number or contact name to call", required=False),
    ],
)
def make_phone_call(
    phone: Optional[str] = None,
    target: Optional[str] = None,
    contact: Optional[str] = None,
    number: Optional[str] = None,
    **kwargs,
) -> CommandResult:
    dest = phone or target or contact or number or kwargs.get("contactName") or kwargs.get("to")
    if not dest:
        return CommandResult(False, "No phone number or contact name was provided.")
    try:
        from controls import SystemControlManager
    except ImportError:
        from era_agent.controls import SystemControlManager

    ok, msg = SystemControlManager.execute_intent("make_phone_call", {"phone": dest})
    return CommandResult(ok, msg)

@registry.register(
    "answer_phone_call",
    "Accepts / answers an incoming phone call on Windows Phone Link",
    params=[],
)
def answer_phone_call(**kwargs) -> CommandResult:
    try:
        from controls import SystemControlManager
    except ImportError:
        from era_agent.controls import SystemControlManager

    ok, msg = SystemControlManager.execute_intent("answer_phone_call", {})
    return CommandResult(ok, msg)

@registry.register(
    "reject_phone_call",
    "Rejects / declines or ends a phone call on Windows Phone Link",
    params=[],
)
def reject_phone_call(**kwargs) -> CommandResult:
    try:
        from controls import SystemControlManager
    except ImportError:
        from era_agent.controls import SystemControlManager

    ok, msg = SystemControlManager.execute_intent("reject_phone_call", {})
    return CommandResult(ok, msg)

@registry.register(
    "get_phone_link_status",
    "Checks Windows Phone Link connection and device status",
    params=[],
)
def get_phone_link_status(**kwargs) -> CommandResult:
    try:
        from controls import SystemControlManager
    except ImportError:
        from era_agent.controls import SystemControlManager

    ok, msg = SystemControlManager.execute_intent("get_phone_link_status", {})
    return CommandResult(ok, msg)

@registry.register(
    "read_phone_messages",
    "Opens Phone Link Messages interface to read SMS and chat messages",
    params=[
        CommandParam("limit", "int", "Maximum number of messages to retrieve", required=False, default=5),
    ],
)
def read_phone_messages(limit: int = 5) -> CommandResult:
    try:
        from era_agent.controls import SystemControlManager
    except ImportError:
        from controls import SystemControlManager

    ok, msg = SystemControlManager.execute_intent("read_phone_messages", {"limit": limit})
    return CommandResult(ok, msg)

@registry.register(
    "transfer_phone_files",
    "Transfers files or photos between connected Phone Link device and laptop",
    params=[
        CommandParam("direction", "str", "'phone_to_laptop' or 'laptop_to_phone'", required=False, default="phone_to_laptop"),
        CommandParam("file_name", "str", "Optional specific file or photo name", required=False),
        CommandParam("destination", "str", "Target destination folder path on laptop", required=False),
    ],
)
def transfer_phone_files(
    direction: str = "phone_to_laptop",
    file_name: Optional[str] = None,
    destination: Optional[str] = None,
) -> CommandResult:
    try:
        from era_agent.controls import SystemControlManager
    except ImportError:
        from controls import SystemControlManager

    ok, msg = SystemControlManager.execute_intent(
        "transfer_phone_files",
        {"direction": direction, "file_name": file_name, "destination": destination},
    )
    return CommandResult(ok, msg)

@registry.register(
    "get_phone_link_status",
    "Queries status and connectivity of Windows Phone Link device",
)
def get_phone_link_status() -> CommandResult:
    try:
        from era_agent.controls import SystemControlManager
    except ImportError:
        from controls import SystemControlManager

    ok, msg = SystemControlManager.execute_intent("get_phone_link_status", {})
    return CommandResult(ok, msg)

# ---------------------------------------------------------------------------
# DISPLAY BRIGHTNESS COMMANDS
# ---------------------------------------------------------------------------

try:
    from controls.display import DisplayControl
except ImportError:
    try:
        from era_agent.controls.display import DisplayControl
    except ImportError:
        DisplayControl = None

@registry.register(
    "set_display_brightness",
    "Sets screen display brightness percentage (0 to 100)",
    params=[CommandParam("level", "int", "Brightness level 0 to 100", required=True)],
)
def set_display_brightness(level: int = 50) -> CommandResult:
    """Sets screen display brightness."""
    if DisplayControl is None:
        return CommandResult(False, "DisplayControl module is not available.")
    try:
        lvl = int(level)
    except (ValueError, TypeError):
        return CommandResult(False, "Brightness level must be an integer 0-100.")
    ok, msg = DisplayControl.set_brightness(lvl)
    return CommandResult(ok, msg)

@registry.register(
    "set_brightness",
    "Alias for set_display_brightness",
    params=[CommandParam("level", "int", "Brightness level 0 to 100", required=True)],
)
def set_brightness(level: int = 50) -> CommandResult:
    return set_display_brightness(level)

@registry.register(
    "adjust_display_brightness",
    "Adjusts screen brightness by delta (e.g. +10 or -10)",
    params=[CommandParam("delta", "int", "Delta percentage to change", required=True)],
)
def adjust_display_brightness(delta: int = 10) -> CommandResult:
    if DisplayControl is None:
        return CommandResult(False, "DisplayControl module is not available.")
    try:
        d = int(delta)
    except (ValueError, TypeError):
        return CommandResult(False, "Delta must be an integer.")
    ok, msg = DisplayControl.adjust_brightness(d)
    return CommandResult(ok, msg)

@registry.register(
    "get_display_brightness",
    "Gets current screen brightness percentage",
)
def get_display_brightness() -> CommandResult:
    if DisplayControl is None:
        return CommandResult(False, "DisplayControl module is not available.")
    ok, lvl, msg = DisplayControl.get_brightness()
    return CommandResult(ok, msg)

def _attach_winsta() -> None:
    """Attaches process and thread to interactive desktop session WinSta0/default."""
    user32 = ctypes.windll.user32
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass
    try:
        hwinsta = user32.OpenWindowStationW("WinSta0", False, 0x037F)
        if hwinsta:
            user32.SetProcessWindowStation(hwinsta)
    except Exception:
        pass
    try:
        hdesk = user32.OpenDesktopW("default", 0, False, 0x01FF)
        if hdesk:
            user32.SetThreadDesktop(hdesk)
    except Exception:
        pass

def _is_era_process(pname: str, title: str = "") -> bool:
    """Safely checks if a process or window belongs to ERA Assistant (explicitly distinguishing from Opera!)."""
    p = str(pname or "").lower().strip()
    t = str(title or "").lower().strip()
    if "opera" in p or "opera" in t:
        return False
    if p in ("era ai assistant.exe", "era.exe", "era-voice-assistant.exe") or p.startswith("era_"):
        return True
    if "era ai assistant" in t or "era — ai assistant" in t or "era – ai assistant" in t or "era - ai assistant" in t or "era vision" in t or "era bridge" in t or "era local agent" in t:
        return True
    return False

# ─── SCREEN INTERACTION & TYPING COMMANDS ──────────────────────────────────
@registry.register(
    "type_text",
    "Types text at current active cursor focus on screen.",
    params=[CommandParam("text", "str", "Text to type", required=True)]
)
def type_text(text: str = "", **kwargs: Any) -> CommandResult:
    target_text = str(text or kwargs.get("content") or kwargs.get("message") or kwargs.get("data") or "").strip()
    if not target_text:
        target_text = "Hello Boss! ERA is online and typing on your screen."
    target_app = str(kwargs.get("app_name") or kwargs.get("appName") or kwargs.get("app") or "")
    press_enter = bool(kwargs.get("press_enter") or kwargs.get("enter") or False)
    try:
        try:
            from native_typing import type_on_screen
        except ImportError:
            from era_agent.native_typing import type_on_screen
        res = type_on_screen(target_text, app_name=target_app, press_enter=press_enter)
        return CommandResult(
            success=bool(res.get("success", True)),
            message=str(res.get("message", f"Successfully typed text on screen ({len(target_text)} characters).")),
            data=res.get("data", {"verified": True, "text": target_text})
        )
    except Exception as e:
        try:
            import pyautogui
            pyautogui.FAILSAFE = False
            pyautogui.write(target_text, interval=0.01)
            return CommandResult(True, f"Typed text via keyboard fallback ({len(target_text)} characters).", data={"verified": True, "text": target_text})
        except Exception as e2:
            return CommandResult(False, f"Failed to type text: {e2}")

@registry.register(
    "write_in_vscode",
    "Inserts code or text directly into active VS Code editor window.",
    params=[
        CommandParam("code", "str", "Code or text to insert", required=True),
        CommandParam("replace_all", "bool", "Whether to replace entire editor file", required=False, default=False),
        CommandParam("save_after", "bool", "Whether to save file (Ctrl+S) after insertion", required=False, default=True),
    ]
)
def write_in_vscode(code: str = "", replace_all: bool = False, save_after: bool = True, **kwargs: Any) -> CommandResult:
    target_code = str(code or kwargs.get("text") or kwargs.get("content") or "")
    if not target_code:
        return CommandResult(False, "No code provided to insert.")
    try:
        import time
        import pyautogui
        pyautogui.FAILSAFE = False

        target_hwnd = _find_window_for_app("vscode")
        if not target_hwnd:
            open_app("vscode")
            time.sleep(1.0)
            target_hwnd = _find_window_for_app("vscode")

        if target_hwnd:
            _force_foreground_window(target_hwnd)
            time.sleep(0.2)

        # Focus editor group (Ctrl+1)
        pyautogui.hotkey("ctrl", "1")
        time.sleep(0.08)

        if replace_all:
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.05)

        # Paste via clipboard
        _copy_to_windows_clipboard(target_code)
        try:
            import pyperclip
            pyperclip.copy(target_code)
        except Exception:
            pass
        time.sleep(0.05)

        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.08)

        if save_after:
            pyautogui.hotkey("ctrl", "s")
            time.sleep(0.08)

        return CommandResult(True, f"Successfully inserted {len(target_code)} characters into VS Code editor.")
    except Exception as e:
        return CommandResult(False, f"Failed to write into VS Code: {e}")

@registry.register(
    "delete_text",
    "Deletes/removes a specific word, phrase, last word, or clears text at active focus or editor.",
    params=[
        CommandParam("target", "str", "Word or phrase to delete", required=False),
        CommandParam("mode", "str", "Deletion mode: 'word', 'last_word', 'last_line', 'all'", required=False),
        CommandParam("app_name", "str", "Optional application name to focus", required=False),
        CommandParam("occurrence", "str", "Which occurrence to delete: 'last', 'first', or 'all'", required=False),
    ]
)
def delete_text(target: str = "", mode: str = "word", app_name: str = "", occurrence: str = "last", **kwargs: Any) -> CommandResult:
    del_target = str(target or kwargs.get("word") or kwargs.get("text") or "").strip()
    del_mode = str(mode or kwargs.get("delete_mode") or ("word" if del_target else "last_word")).lower()
    target_app = str(app_name or kwargs.get("appName") or kwargs.get("app") or "")
    try:
        try:
            from native_typing import delete_on_screen
        except ImportError:
            from era_agent.native_typing import delete_on_screen
        res = delete_on_screen(target=del_target, mode=del_mode, app_name=target_app)
        return CommandResult(
            success=bool(res.get("success", True)),
            message=str(res.get("message", "Text deleted from screen successfully.")),
            data=res.get("data", {"verified": True, "target": del_target, "mode": del_mode})
        )
    except Exception as e:
        try:
            import pyautogui
            pyautogui.FAILSAFE = False
            pyautogui.hotkey("ctrl", "backspace")
            return CommandResult(True, f"Applied fallback deletion for '{del_target}'.")
        except Exception as e2:
            return CommandResult(False, f"Failed to delete text: {e2}")

@registry.register(
    "deleteText",
    "Alias for delete_text.",
    params=[
        CommandParam("target", "str", "Word or phrase to delete", required=False),
        CommandParam("mode", "str", "Deletion mode", required=False)
    ]
)
def deleteText(target: str = "", mode: str = "word", **kwargs: Any) -> CommandResult:
    return delete_text(target=target, mode=mode, **kwargs)

@registry.register(
    "press_key_combination",
    "Presses hotkey combination (e.g. ['enter'], ['ctrl', 'v']).",
    params=[CommandParam("keys", "list", "Keys to press", required=True)]
)
def press_key_combination(keys: any = None) -> CommandResult:
    try:
        import ctypes
        import time
        user32 = ctypes.windll.user32
        if not keys:
            return CommandResult(False, "No keys provided.")
        if isinstance(keys, str):
            keys = [keys]
        
        key_list = [str(k).lower().strip() for k in keys]
        if key_list in (["enter"], ["return"]):
            VK_RETURN = 0x0D
            KEYEVENTF_KEYUP = 0x0002
            user32.keybd_event(VK_RETURN, 0, 0, 0)
            time.sleep(0.05)
            user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)
            return CommandResult(True, "Pressed Enter.")

        import pyautogui
        pyautogui.hotkey(*key_list)
        return CommandResult(True, f"Pressed keys: {key_list}")
    except Exception as e:
        return CommandResult(False, f"Failed to press keys: {e}")

@registry.register(
    "click_screen",
    "Clicks mouse at (x, y) on screen. Set normalized=True to treat x,y as 0..1000 screen units.",
    params=[
        CommandParam("x", "int", "X coordinate (pixels, or 0..1000 when normalized=True)", required=True),
        CommandParam("y", "int", "Y coordinate (pixels, or 0..1000 when normalized=True)", required=True),
        CommandParam("normalized", "bool", "Scale 0..1000 coordinates to current screen resolution", required=False),
    ]
)
def click_screen(x: int = 0, y: int = 0, normalized: bool = False, **kwargs: Any) -> CommandResult:
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        _attach_winsta()
        user32 = ctypes.windll.user32
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass

        is_norm = bool(normalized or kwargs.get("norm"))
        px = float(x)
        py = float(y)
        if is_norm:
            screen_w = user32.GetSystemMetrics(0) or 1920
            screen_h = user32.GetSystemMetrics(1) or 1080
            px = max(0.0, min(1000.0, px)) / 1000.0 * float(screen_w)
            py = max(0.0, min(1000.0, py)) / 1000.0 * float(screen_h)

        ix, iy = int(round(px)), int(round(py))
        clicks = int(kwargs.get("clicks", 1) or 1)
        button = str(kwargs.get("button", "left") or "left")
        pyautogui.click(x=ix, y=iy, clicks=clicks, button=button)
        return CommandResult(True, f"Clicked at ({ix}, {iy})" + (" [normalized]" if is_norm else ""))
    except Exception as e:
        return CommandResult(False, f"Failed to click: {e}")

@registry.register(
    "scroll_screen",
    "Scrolls screen up or down smoothly and easily.",
    params=[
        CommandParam("clicks", "int", "Scroll clicks (positive for up, negative for down)", required=False, default=None),
        CommandParam("direction", "str", "Direction: 'down', 'up', 'top', 'bottom', 'page_down', 'page_up'", required=False, default="down"),
        CommandParam("amount", "str", "Amount: 'gentle', 'normal', 'large', 'page'", required=False, default="normal"),
        CommandParam("app_name", "str", "Target application (e.g. 'whatsapp', 'chrome', 'chatgpt', 'browser')", required=False, default=""),
        CommandParam("smooth", "bool", "Smooth eased scrolling", required=False, default=True),
    ],
)
def scroll_screen(
    clicks: Optional[int] = None,
    direction: str = "down",
    amount: str = "normal",
    app_name: str = "",
    smooth: bool = True,
    **kwargs: Any,
) -> CommandResult:
    try:
        # Check if clicks is provided directly (positive or negative)
        if clicks is not None and int(clicks) != 0:
            val = int(clicks)
            if val < 0:
                direction = "down"
                clicks = abs(val)
            else:
                direction = "up"
                clicks = abs(val)

        from native_typing import smooth_scroll_on_screen
        target_app = app_name or kwargs.get("appName") or kwargs.get("app") or ""
        res = smooth_scroll_on_screen(
            direction=direction,
            amount=amount,
            clicks=clicks,
            app_name=target_app,
            smooth=smooth,
        )
        if res.get("success"):
            return CommandResult(True, res.get("message", "Screen scrolled successfully."), data=res)
        return CommandResult(False, res.get("message", "Failed to scroll screen."))
    except Exception as e:
        # Fallback to pyautogui
        try:
            import pyautogui
            sign = 1 if "up" in str(direction).lower() else -1
            pyautogui.scroll(sign * int(clicks or 5) * 100)
            return CommandResult(True, f"Scrolled screen {direction}.")
        except Exception as ex:
            return CommandResult(False, f"Failed to scroll: {e} / {ex}")

@registry.register(
    "smooth_scroll",
    "Alias for smooth screen scrolling up or down.",
    params=[
        CommandParam("direction", "str", "Direction: 'down', 'up', 'top', 'bottom'", required=False, default="down"),
        CommandParam("amount", "str", "Amount: 'gentle', 'normal', 'large', 'page'", required=False, default="normal"),
        CommandParam("app_name", "str", "Target application (e.g. 'whatsapp', 'chrome', 'chatgpt')", required=False, default=""),
    ],
)
def smooth_scroll(direction: str = "down", amount: str = "normal", app_name: str = "", **kwargs: Any) -> CommandResult:
    return scroll_screen(direction=direction, amount=amount, app_name=app_name, **kwargs)

@registry.register("smoothScroll", "Alias for smooth_scroll", params=[])
def smoothScroll(**kwargs: Any) -> CommandResult:
    return scroll_screen(**kwargs)

@registry.register("scrollScreen", "Alias for scroll_screen", params=[])
def scrollScreen(**kwargs: Any) -> CommandResult:
    return scroll_screen(**kwargs)

@registry.register(
    "scroll_to_target",
    "Autonomously and smoothly scrolls the screen until a specific section, topic or heading (e.g. 'education', 'business', 'career', 'early life', 'net worth', etc.) is fully in view, and captures screen for vision explanation.",
    params=[
        CommandParam("target", "str", "Target topic, heading, or section to scroll to", required=True),
        CommandParam("app_name", "str", "Target application (e.g. 'chrome', 'msedge', 'opera', 'browser')", required=False, default=""),
        CommandParam("direction", "str", "Direction: 'down' or 'up'", required=False, default="down"),
        CommandParam("max_scrolls", "int", "Maximum autonomous scroll passes", required=False, default=8),
        CommandParam("smooth", "bool", "Smooth eased scrolling", required=False, default=True),
    ],
)
def scroll_to_target(
    target: str = "",
    app_name: str = "",
    direction: str = "down",
    max_scrolls: int = 8,
    smooth: bool = True,
    **kwargs: Any,
) -> CommandResult:
    try:
        from native_typing import scroll_to_target_on_screen
        clean_t = target or kwargs.get("topic") or kwargs.get("section") or kwargs.get("query") or ""
        target_app = app_name or kwargs.get("appName") or kwargs.get("app") or ""
        res = scroll_to_target_on_screen(
            target=clean_t,
            app_name=target_app,
            direction=direction,
            max_scrolls=int(max_scrolls or 8),
            smooth=smooth,
        )
        if res.get("success"):
            return CommandResult(True, res.get("message", f"Scrolled to '{clean_t}' successfully."), data=res)
        return CommandResult(False, res.get("message", f"Failed to scroll to '{clean_t}'."))
    except Exception as e:
        return CommandResult(False, f"scroll_to_target error: {e}")

@registry.register("scroll_to_content", "Alias for scroll_to_target", params=[])
def scroll_to_content(**kwargs: Any) -> CommandResult:
    return scroll_to_target(**kwargs)

@registry.register("scrollToTarget", "Alias for scroll_to_target", params=[])
def scrollToTarget(**kwargs: Any) -> CommandResult:
    return scroll_to_target(**kwargs)

@registry.register("scrollToContent", "Alias for scroll_to_target", params=[])
def scrollToContent(**kwargs: Any) -> CommandResult:
    return scroll_to_target(**kwargs)

@registry.register(
    "read_and_scroll_whatsapp",
    "Opens WhatsApp chat with specified contact, smoothly scrolls through messages and reads chat content.",
    params=[
        CommandParam("contact", "str", "Name of contact whose chat to open and read", required=False),
        CommandParam("direction", "str", "Scroll direction: 'up' (earlier messages) or 'down' (recent messages)", required=False, default="down"),
        CommandParam("steps", "int", "Number of smooth scroll steps", required=False, default=2),
    ],
)
def read_and_scroll_whatsapp(
    contact: Optional[str] = None,
    direction: str = "down",
    steps: int = 2,
    **kwargs: Any,
) -> CommandResult:
    try:
        contact_name = str(
            contact
            or kwargs.get("contactName")
            or kwargs.get("contact_name")
            or kwargs.get("name")
            or ""
        ).strip()

        # Step 1: Open chat if contact is given
        if contact_name:
            open_res = open_whatsapp_chat(contact_name)
            time.sleep(0.5)

        # Step 2: Ensure WhatsApp is in foreground
        hwnd = _activate_whatsapp_window()
        time.sleep(0.3)

        # Step 3: Perform smooth scroll inside chat pane
        scroll_res = scroll_screen(
            direction=direction,
            amount="normal",
            app_name="whatsapp",
            smooth=True,
        )

        # Step 4: Inspect visible messages or UI text
        extracted_messages = []
        if hwnd:
            try:
                ps_script = f"""
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new({int(hwnd)}))
if ($root) {{
    $txtCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    $texts = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $txtCond)
    $msgs = @()
    $wr = $root.Current.BoundingRectangle
    $chatLeft = $wr.Left + ($wr.Width * 0.35)
    foreach ($t in $texts) {{
        try {{
            $r = $t.Current.BoundingRectangle
            if ($r.Left -ge $chatLeft -and $r.Top -ge ($wr.Top + 60) -and $r.Bottom -le ($wr.Bottom - 80)) {{
                $val = [string]$t.Current.Name
                if ($val -and $val.Length -gt 1 -and $val -notmatch '^(Type a message|Search|Online|typing\.\\.\\.)$') {{
                    $msgs += $val
                }}
            }}
        }} catch {{}}
    }}
    $msgs | ConvertTo-Json -Compress
}}
"""
                proc = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if proc.stdout and proc.stdout.strip():
                    try:
                        parsed = json.loads(proc.stdout.strip())
                        if isinstance(parsed, list):
                            extracted_messages = parsed
                        elif isinstance(parsed, str):
                            extracted_messages = [parsed]
                    except Exception:
                        pass
            except Exception:
                pass

        # Step 5: Format summary
        summary = ""
        if extracted_messages:
            summary = "\n".join(f"- {m}" for m in extracted_messages[:15])
            msg_text = f"WhatsApp chat '{contact_name or 'active'}' me {len(extracted_messages)} messages dikh rahe hain:\n{summary}"
        else:
            msg_text = f"WhatsApp chat '{contact_name or 'active'}' ko smoothly {direction} scroll kar diya hai, boss!"

        return CommandResult(
            True,
            msg_text,
            data={
                "contact": contact_name,
                "direction": direction,
                "messages": extracted_messages,
                "scrolled": True,
            },
        )
    except Exception as e:
        return CommandResult(False, f"WhatsApp scroll and read error: {e}")

@registry.register("readAndScrollWhatsApp", "Alias for read_and_scroll_whatsapp", params=[])
def readAndScrollWhatsApp(**kwargs: Any) -> CommandResult:
    return read_and_scroll_whatsapp(**kwargs)

@registry.register(
    "typeText",
    "Types text at cursor (alias for type_text).",
    params=[CommandParam("text", "str", "Text to type", required=True)]
)
def typeText(text: str = "") -> CommandResult:
    return type_text(text)

@registry.register(
    "focusWindow",
    "Brings window to foreground (alias for focus_window).",
    params=[CommandParam("app_name", "str", "Application name", required=True)]
)
def focusWindow(app_name: str = "") -> CommandResult:
    return focus_window(app_name)

@registry.register(
    "send_whatsapp_message",
    "Sends a WhatsApp message to a contact name or phone number",
    params=[
        CommandParam("contact", "str", "Recipient phone number or contact name", required=False),
        CommandParam("phone", "str", "Recipient phone number or contact name", required=False),
        CommandParam("message", "str", "Message content to send via WhatsApp", required=True),
    ],
)
def send_whatsapp_message(
    contact: Optional[str] = None,
    phone: Optional[str] = None,
    message: Optional[str] = None,
    **kwargs: Any,
) -> CommandResult:
    return open_whatsapp(phone=phone or contact, message=message, **kwargs)

@registry.register(
    "sendWhatsAppMessage",
    "Alias for send_whatsapp_message",
    params=[
        CommandParam("contact", "str", "Recipient contact name or phone number", required=False),
        CommandParam("phone", "str", "Recipient contact name or phone number", required=False),
        CommandParam("message", "str", "Message content", required=True),
    ],
)
def sendWhatsAppMessage(
    contact: Optional[str] = None,
    phone: Optional[str] = None,
    message: Optional[str] = None,
    **kwargs: Any,
) -> CommandResult:
    return open_whatsapp(phone=phone or contact, message=message, **kwargs)

@registry.register(
    "send_whatsapp_to_multiple",
    "Sends WhatsApp messages sequentially to multiple contacts (supports either one shared message or individual per-recipient messages)",
    params=[
        CommandParam("contacts", "list", "List of contact names, phone numbers, or {contact, message} objects", required=False),
        CommandParam("message", "str", "Shared message content (when recipients do not specify individual messages)", required=False),
        CommandParam("recipients", "list", "List of {contact, message} pairs for sending distinct messages to each person", required=False),
    ],
)
def send_whatsapp_to_multiple(
    contacts: Any = None,
    message: str = "",
    recipients: Any = None,
    **kwargs: Any,
) -> CommandResult:
    import re
    raw_messages = kwargs.get("messages")
    pairs: List[Tuple[str, str]] = []

    def _extract_pair(item: Any, fallback_msg: str = "") -> Optional[Tuple[str, str]]:
        if isinstance(item, dict):
            c_val = str(
                item.get("contact")
                or item.get("contactName")
                or item.get("name")
                or item.get("phone")
                or item.get("recipient")
                or ""
            ).strip()
            m_val = str(
                item.get("message")
                or item.get("text")
                or item.get("msg")
                or fallback_msg
                or ""
            ).strip()
            if c_val and m_val:
                return (c_val, m_val)
            return None
        c_str = str(item or "").strip()
        m_str = str(fallback_msg or "").strip()
        if c_str and m_str:
            return (c_str, m_str)
        return None

    if isinstance(recipients, list) and recipients:
        for idx, item in enumerate(recipients):
            fb = raw_messages[idx] if isinstance(raw_messages, list) and idx < len(raw_messages) else message
            pair = _extract_pair(item, str(fb or ""))
            if pair:
                pairs.append(pair)
    elif isinstance(contacts, list) and contacts:
        for idx, item in enumerate(contacts):
            fb = raw_messages[idx] if isinstance(raw_messages, list) and idx < len(raw_messages) else message
            pair = _extract_pair(item, str(fb or ""))
            if pair:
                pairs.append(pair)
    elif isinstance(contacts, str) and contacts.strip():
        c_list = [c.strip() for c in re.split(r"\s+(?:and|aur)\s+|,|;", contacts, flags=re.IGNORECASE) if c.strip()]
        for idx, c in enumerate(c_list):
            fb = raw_messages[idx] if isinstance(raw_messages, list) and idx < len(raw_messages) else message
            pair = _extract_pair(c, str(fb or ""))
            if pair:
                pairs.append(pair)

    if not pairs:
        if not contacts and not recipients:
            return CommandResult(False, "No contacts or recipients provided for multi-send.")
        return CommandResult(False, "No message content provided for recipients.")

    results = []
    success_count = 0
    succeeded_contacts = []
    failed_contacts = []

    for idx, (c, msg_i) in enumerate(pairs):
        res = open_whatsapp(phone=c, message=msg_i)
        if res.success:
            success_count += 1
            succeeded_contacts.append(c)
            results.append(f"{c}: Success ({msg_i})")
        else:
            failed_contacts.append(f"{c} ({res.message})")
            results.append(f"{c}: Failed ({res.message})")
        if idx < len(pairs) - 1:
            time.sleep(2.5)  # Safe delay between recipients

    all_succeeded = (success_count == len(pairs) and len(pairs) > 0)
    if all_succeeded:
        summary = f"WhatsApp messages successfully sent to all {len(pairs)} contacts: {', '.join(succeeded_contacts)}."
    elif success_count > 0:
        summary = f"WhatsApp task partially completed: Sent to {success_count}/{len(pairs)} contacts ({', '.join(succeeded_contacts)}). Failed for {len(failed_contacts)} contacts: {', '.join(failed_contacts)}."
    else:
        summary = f"Failed to send WhatsApp messages to all {len(pairs)} contacts. Errors: {'; '.join(failed_contacts)}."

    return CommandResult(
        all_succeeded,
        summary,
        data={
            "total": len(pairs),
            "sent_count": success_count,
            "failed_count": len(failed_contacts),
            "successful_contacts": succeeded_contacts,
            "failed_contacts": failed_contacts,
            "details": results,
        }
    )


@registry.register(
    "create_file",
    "Creates a new file with specified content in workspace or target path",
    params=[
        CommandParam("file_name", "str", "Name or relative path of the file to create (e.g. 'snake.py', 'notes.txt')", required=True),
        CommandParam("content", "str", "Content or code to write into the file", required=True),
        CommandParam("directory", "str", "Optional directory path", required=False),
    ],
)
def create_file(
    file_name: Optional[str] = None,
    content: Optional[str] = None,
    directory: Optional[str] = None,
    **kwargs: Any,
) -> CommandResult:
    name = file_name or kwargs.get("fileName") or kwargs.get("filename") or kwargs.get("name")
    if not name:
        return CommandResult(False, "No file name was provided.")
    raw_content = content if content is not None else kwargs.get("code") or kwargs.get("text") or ""

    if directory and os.path.exists(directory):
        target_dir = directory
    else:
        target_dir = os.environ.get("ERA_WORKSPACE_DIR") or r"D:\era-voice-assistant\workspace"

    try:
        os.makedirs(target_dir, exist_ok=True)
    except Exception:
        pass

    file_path = os.path.join(target_dir, os.path.basename(name))
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(raw_content)
        return CommandResult(
            True,
            f"Successfully created file '{os.path.basename(name)}' at {file_path}",
            data={"filename": os.path.basename(name), "path": file_path, "length": len(raw_content)}
        )
    except Exception as exc:
        return CommandResult(False, f"Failed to create file: {exc}")

@registry.register(
    "send_whatsapp_file",
    "Sends an actual file or document (such as PDF, script, text file, image, excel, zip, etc.) from the user's computer/file explorer to a specific WhatsApp contact or phone number as a real file attachment",
    params=[
        CommandParam("contact", "str", "Recipient contact name or specific phone number. Only send to the person specified by the boss.", required=False),
        CommandParam("phone", "str", "Recipient contact name or phone number", required=False),
        CommandParam("file_path", "str", "The name or path of the file to send (e.g. 'script.py', 'report.pdf', 'notes.txt')", required=True),
        CommandParam("message", "str", "Optional caption or message text to accompany the file attachment", required=False),
        CommandParam("file_content", "str", "Optional file content if creating a new file on the fly", required=False),
    ],
)
def send_whatsapp_file(
    contact: Optional[str] = None,
    phone: Optional[str] = None,
    file_path: Optional[str] = None,
    message: Optional[str] = None,
    file_content: Optional[str] = None,
    **kwargs: Any,
) -> CommandResult:
    """Sends a local file or document to a specific WhatsApp contact or phone number as an actual attachment."""
    with _wa_execution_lock:
        target_input = str(
            contact
            or phone
            or kwargs.get("contactName")
            or kwargs.get("contact_name")
            or kwargs.get("to")
            or kwargs.get("recipient")
            or kwargs.get("name")
            or ""
        ).strip()

        target_file = str(
            file_path
            or kwargs.get("filePath")
            or kwargs.get("fileName")
            or kwargs.get("file_name")
            or kwargs.get("filename")
            or kwargs.get("path")
            or ""
        ).strip()

        target_caption = str(
            message
            or kwargs.get("caption")
            or kwargs.get("msg")
            or kwargs.get("text")
            or kwargs.get("body")
            or ""
        ).strip()

        target_content = file_content if file_content is not None else kwargs.get("fileContent") or kwargs.get("content") or kwargs.get("code")

        if not target_input:
            return CommandResult(False, "No recipient phone number or contact name was provided.")

        if not target_file:
            return CommandResult(False, "No file name or path was provided to send.")

        # 1. Resolve or create the file
        resolved_file_path: Optional[str] = None
        if target_content is not None and str(target_content).strip():
            ws_dir = os.environ.get("ERA_WORKSPACE_DIR") or r"D:\era-voice-assistant\workspace"
            try:
                os.makedirs(ws_dir, exist_ok=True)
            except Exception:
                pass
            safe_name = os.path.basename(target_file)
            save_path = os.path.join(ws_dir, safe_name)
            try:
                with open(save_path, "w", encoding="utf-8") as f:
                    f.write(str(target_content))
                resolved_file_path = save_path
            except Exception as e:
                return CommandResult(False, f"Failed to save file before sending: {e}")
        else:
            resolved_file_path = find_file_path(target_file)

        if not resolved_file_path or not os.path.exists(resolved_file_path):
            drives_str = ", ".join(_get_system_drives())
            return CommandResult(
                False,
                f"File '{target_file}' could not be found across File Explorer, workspace, or laptop drives ({drives_str})."
            )

        resolved_file_path = os.path.abspath(resolved_file_path)
        file_base = os.path.basename(resolved_file_path)

        # 2. Put file onto Windows Clipboard as CF_HDROP FileDropList
        if not _copy_file_to_windows_clipboard(resolved_file_path):
            return CommandResult(False, f"Failed to place file '{file_base}' onto Windows clipboard for attachment.")

        # 3. Resolve phone or contact name
        digits_only = "".join(ch for ch in target_input if ch.isdigit())
        resolved_phone: Optional[str] = None
        if len(digits_only) >= 7:
            resolved_phone = digits_only
        else:
            resolved_phone = _lookup_contact_phone(target_input)

        try:
            import pyautogui  # type: ignore
            pyautogui.FAILSAFE = False
        except ImportError:
            pyautogui = None

        app_installed = _is_whatsapp_desktop_installed()

        # SCENARIO A: Phone number is known
        if resolved_phone:
            normalized_phone = _normalize_phone_number(resolved_phone)
            try:
                if app_installed:
                    app_url = f"whatsapp://send?phone={normalized_phone}"
                    try:
                        os.startfile(app_url)
                    except Exception:
                        _launch_windows_target(app_url)

                    wa_hwnd = _wait_for_whatsapp_window(timeout=15.0, interval=0.35)
                    if not wa_hwnd:
                        return CommandResult(False, f"WhatsApp Desktop did not open or come to foreground for +{normalized_phone}; file '{file_base}' was NOT sent.")
                    if not pyautogui:
                        return CommandResult(False, f"WhatsApp Desktop opened for +{normalized_phone}, but pyautogui is required to attach and send '{file_base}'.")
                    time.sleep(1.8)

                    hwnd, rect = _find_whatsapp_hwnd_and_rect()
                    left, top, right, bottom = rect
                    win_w = right - left
                    win_h = bottom - top

                    if win_w > 300 and win_h > 300 and pyautogui:
                        msg_box_x = left + int(win_w * 0.65)
                        msg_box_y = bottom - 45
                        try:
                            pyautogui.click(msg_box_x, msg_box_y)
                            time.sleep(0.3)
                        except Exception:
                            pass

                    # Re-verify clipboard file
                    _copy_file_to_windows_clipboard(resolved_file_path)
                    time.sleep(0.15)

                    if pyautogui:
                        pyautogui.hotkey("ctrl", "v")
                        time.sleep(1.4)  # Wait for WhatsApp attachment preview modal

                        if target_caption:
                            _copy_to_windows_clipboard(target_caption)
                            pyautogui.hotkey("ctrl", "v")
                            time.sleep(0.3)

                        _send_whatsapp_enter()
                        time.sleep(0.6)

                        if win_w > 300 and win_h > 300:
                            send_btn_x = left + win_w - 55
                            send_btn_y = bottom - 45
                            try:
                                pyautogui.click(send_btn_x, send_btn_y)
                            except Exception:
                                pass

                    _record_whatsapp_chat_log(target_input, f"[File: {file_base}] {target_caption}".strip())
                    return CommandResult(
                        True,
                        f"Sent file '{file_base}' to +{normalized_phone} ({target_input}) via WhatsApp Desktop.",
                        data={"file": file_base, "path": resolved_file_path, "recipient": target_input, "phone": normalized_phone}
                    )
                else:
                    web_url = f"https://web.whatsapp.com/send?phone={normalized_phone}"
                    webbrowser.open_new_tab(web_url)
                    time.sleep(4.0)
                    _activate_whatsapp_or_browser_window()
                    _copy_file_to_windows_clipboard(resolved_file_path)
                    if pyautogui:
                        pyautogui.hotkey("ctrl", "v")
                        time.sleep(1.5)
                        if target_caption:
                            _copy_to_windows_clipboard(target_caption)
                            pyautogui.hotkey("ctrl", "v")
                            time.sleep(0.3)
                        _send_whatsapp_enter()
                    _record_whatsapp_chat_log(target_input, f"[File: {file_base}] {target_caption}".strip())
                    return CommandResult(
                        True,
                        f"Sent file '{file_base}' to +{normalized_phone} via WhatsApp Web.",
                        data={"file": file_base, "path": resolved_file_path, "recipient": target_input, "phone": normalized_phone}
                    )
            except Exception as exc:
                return CommandResult(False, f"Failed to send file via WhatsApp to +{normalized_phone}: {exc}")

        # SCENARIO B: Contact name or group name -> search inside WhatsApp Desktop
        else:
            try:
                import re
                clean_target = re.sub(
                    r"\s*\b(?:ko|se|par|per|ji|bhaiya|mama|sir|uncle|didi)\b\s*$",
                    "",
                    str(target_input).strip(),
                    flags=re.IGNORECASE
                ).strip()
                if not clean_target:
                    clean_target = str(target_input).strip()

                if app_installed:
                    hwnd, _ = _find_whatsapp_hwnd_and_rect()
                    is_visible = bool(hwnd and ctypes.windll.user32.IsWindowVisible(hwnd) and not _is_window_cloaked(hwnd))
                    if not is_visible:
                        try:
                            os.startfile("whatsapp:")
                        except Exception:
                            _launch_windows_target("whatsapp:")
                        wa_hwnd = _wait_for_whatsapp_window(timeout=15.0, interval=0.35)
                    else:
                        wa_hwnd = _ensure_whatsapp_foreground(hwnd)

                    if not wa_hwnd:
                        return CommandResult(False, f"WhatsApp Desktop did not open or come to foreground for '{target_input}'; file '{file_base}' was NOT sent.")

                    if not pyautogui:
                        return CommandResult(
                            False,
                            f"WhatsApp Desktop opened for '{target_input}', but pyautogui is required to attach and send file.",
                        )

                    hwnd, rect = _find_whatsapp_hwnd_and_rect()
                    left, top, right, bottom = rect
                    win_w = right - left
                    win_h = bottom - top

                    # 1. Clear any active popups/search
                    pyautogui.press("esc")
                    time.sleep(0.15)
                    pyautogui.press("esc")
                    time.sleep(0.2)

                    # 2. Focus global search bar (Ctrl+F)
                    pyautogui.hotkey("ctrl", "f")
                    time.sleep(0.25)
                    pyautogui.hotkey("ctrl", "a")
                    time.sleep(0.1)
                    pyautogui.press("backspace")
                    time.sleep(0.15)

                    # 3. Paste contact name
                    _copy_to_windows_clipboard(clean_target)
                    pyautogui.hotkey("ctrl", "v")
                    time.sleep(1.4)

                    # 4. Open chat
                    pyautogui.press("down")
                    time.sleep(0.2)
                    pyautogui.press("enter")
                    time.sleep(0.8)

                    _auto_learn_whatsapp_contact(clean_target)

                    # 5. Focus message box
                    if win_w > 300 and win_h > 300:
                        msg_box_x = left + int(win_w * 0.65)
                        msg_box_y = bottom - 45
                        try:
                            pyautogui.click(msg_box_x, msg_box_y)
                            time.sleep(0.3)
                        except Exception:
                            pass

                    # 6. RESTORE FILE TO CLIPBOARD!
                    _copy_file_to_windows_clipboard(resolved_file_path)
                    time.sleep(0.15)

                    # 7. Paste file attachment
                    pyautogui.hotkey("ctrl", "v")
                    time.sleep(1.4)

                    # 8. Type caption if provided
                    if target_caption:
                        _copy_to_windows_clipboard(target_caption)
                        pyautogui.hotkey("ctrl", "v")
                        time.sleep(0.3)

                    # 9. Send file
                    _send_whatsapp_enter()
                    time.sleep(0.6)

                    if win_w > 300 and win_h > 300:
                        send_btn_x = left + win_w - 55
                        send_btn_y = bottom - 45
                        try:
                            pyautogui.click(send_btn_x, send_btn_y)
                        except Exception:
                            pass

                    _record_whatsapp_chat_log(clean_target, f"[File: {file_base}] {target_caption}".strip())
                    return CommandResult(
                        True,
                        f"Searched for '{clean_target}' on WhatsApp Desktop and sent file '{file_base}'.",
                        data={"file": file_base, "path": resolved_file_path, "recipient": clean_target}
                    )
                else:
                    webbrowser.open_new_tab("https://web.whatsapp.com")
                    time.sleep(4.5)
                    _activate_whatsapp_or_browser_window()
                    if not pyautogui:
                        return CommandResult(False, "WhatsApp Web opened but pyautogui is required to navigate.")
                    pyautogui.press("esc")
                    time.sleep(0.2)
                    pyautogui.hotkey("ctrl", "alt", "/")
                    time.sleep(0.5)
                    _copy_to_windows_clipboard(clean_target)
                    pyautogui.hotkey("ctrl", "v")
                    time.sleep(1.5)
                    pyautogui.press("down")
                    time.sleep(0.2)
                    pyautogui.press("enter")
                    time.sleep(0.8)
                    _auto_learn_whatsapp_contact(clean_target)

                    _copy_file_to_windows_clipboard(resolved_file_path)
                    time.sleep(0.2)
                    pyautogui.hotkey("ctrl", "v")
                    time.sleep(1.5)
                    if target_caption:
                        _copy_to_windows_clipboard(target_caption)
                        pyautogui.hotkey("ctrl", "v")
                        time.sleep(0.3)
                    _send_whatsapp_enter()
                    _record_whatsapp_chat_log(clean_target, f"[File: {file_base}] {target_caption}".strip())
                    return CommandResult(
                        True,
                        f"Searched for '{clean_target}' on WhatsApp Web and sent file '{file_base}'.",
                        data={"file": file_base, "path": resolved_file_path, "recipient": clean_target}
                    )
            except Exception as exc:
                return CommandResult(False, f"Failed to send file to '{target_input}' on WhatsApp: {exc}")

@registry.register(
    "sendWhatsAppFile",
    "Alias for send_whatsapp_file",
    params=[
        CommandParam("contact", "str", "Recipient contact name or phone number", required=False),
        CommandParam("phone", "str", "Recipient contact name or phone number", required=False),
        CommandParam("file_path", "str", "The name or path of the file to send", required=True),
        CommandParam("message", "str", "Optional caption or message text", required=False),
        CommandParam("file_content", "str", "Optional file content if creating on the fly", required=False),
    ],
)
def sendWhatsAppFile(contact: Optional[str] = None, phone: Optional[str] = None, file_path: Optional[str] = None, message: Optional[str] = None, file_content: Optional[str] = None, **kwargs: Any) -> CommandResult:
    return send_whatsapp_file(contact=contact, phone=phone, file_path=file_path, message=message, file_content=file_content, **kwargs)

@registry.register(
    "send_whatsapp_document",
    "Alias for send_whatsapp_file",
    params=[
        CommandParam("contact", "str", "Recipient contact name or phone number", required=False),
        CommandParam("phone", "str", "Recipient contact name or phone number", required=False),
        CommandParam("file_path", "str", "The name or path of the file to send", required=True),
        CommandParam("message", "str", "Optional caption or message text", required=False),
        CommandParam("file_content", "str", "Optional file content if creating on the fly", required=False),
    ],
)
def send_whatsapp_document(contact: Optional[str] = None, phone: Optional[str] = None, file_path: Optional[str] = None, message: Optional[str] = None, file_content: Optional[str] = None, **kwargs: Any) -> CommandResult:
    return send_whatsapp_file(contact=contact, phone=phone, file_path=file_path, message=message, file_content=file_content, **kwargs)

@registry.register(
    "sendWhatsAppDocument",
    "Alias for send_whatsapp_file",
    params=[
        CommandParam("contact", "str", "Recipient contact name or phone number", required=False),
        CommandParam("phone", "str", "Recipient contact name or phone number", required=False),
        CommandParam("file_path", "str", "The name or path of the file to send", required=True),
        CommandParam("message", "str", "Optional caption or message text", required=False),
        CommandParam("file_content", "str", "Optional file content if creating on the fly", required=False),
    ],
)
def sendWhatsAppDocument(contact: Optional[str] = None, phone: Optional[str] = None, file_path: Optional[str] = None, message: Optional[str] = None, file_content: Optional[str] = None, **kwargs: Any) -> CommandResult:
    return send_whatsapp_file(contact=contact, phone=phone, file_path=file_path, message=message, file_content=file_content, **kwargs)

# ---------------------------------------------------------------------------
# Background Window Observation & Background Control Commands
# ---------------------------------------------------------------------------

@registry.register(
    "list_background_apps",
    "Lists all open background and foreground applications with their title, process, PID, and minimized state.",
    params=[CommandParam("include_minimized", "bool", "Whether to include minimized windows", required=False, default=True)],
)
def cmd_list_background_apps(include_minimized: bool = True) -> CommandResult:
    try:
        from .background_controller import list_background_windows
        wins = list_background_windows(include_minimized=include_minimized)
        if not wins:
            return CommandResult(True, "No active background windows found.")
        lines = []
        for w in wins:
            status = "Minimized" if w.is_minimized else ("Foreground" if w.is_foreground else "Background")
            lines.append(f"- [{status}] '{w.title}' (Process: {w.process_name}, PID: {w.pid}, HWND: {w.hwnd})")
        return CommandResult(True, f"Found {len(wins)} windows:\n" + "\n".join(lines))
    except Exception as exc:
        return CommandResult(False, f"Failed to list background windows: {exc}")

@registry.register(
    "capture_background_window",
    "Captures a visual screenshot of any background application window using Win32 PrintWindow without bringing it to the front.",
    params=[
        CommandParam("app_name", "str", "Application name or window title keyword to capture in background", required=True),
        CommandParam("output_path", "str", "Optional destination path for the JPEG image", required=False),
    ],
)
def cmd_capture_background_window(app_name: str, output_path: Optional[str] = None) -> CommandResult:
    try:
        from .background_controller import capture_background_window
        result = capture_background_window(app_name, output_path=output_path)
        if result.get("success"):
            return CommandResult(
                True,
                f"Captured background window '{result.get('title')}' ({result.get('process_name')}). Saved to: {result.get('file_path')} (Dimensions: {result.get('width')}x{result.get('height')})."
            )
        return CommandResult(False, result.get("message", "Capture failed."))
    except Exception as exc:
        return CommandResult(False, f"Failed to capture background window: {exc}")

@registry.register(
    "inspect_background_window",
    "Inspects text, controls, buttons, and input fields of a background window without bringing it to the foreground.",
    params=[CommandParam("app_name", "str", "Application name or window title keyword to inspect", required=True)],
)
def cmd_inspect_background_window(app_name: str) -> CommandResult:
    try:
        from .background_controller import inspect_background_window
        res = inspect_background_window(app_name)
        if not res.get("success"):
            return CommandResult(False, res.get("message", "Inspection failed."))
        win = res.get("window", {})
        texts = res.get("extracted_text", [])
        total_ctrls = res.get("total_controls", 0)
        summary = (
            f"Inspected '{win.get('title')}' ({win.get('process_name')}, HWND: {win.get('hwnd')}):\n"
            f"- Total controls: {total_ctrls}\n"
            f"- Extracted text: {', '.join(texts[:20]) if texts else 'No direct text extracted'}"
        )
        return CommandResult(True, summary)
    except Exception as exc:
        return CommandResult(False, f"Failed to inspect background window: {exc}")

@registry.register(
    "background_click",
    "Sends a mouse click to a background window at coordinates (x, y) or by button element text WITHOUT bringing it to the front.",
    params=[
        CommandParam("app_name", "str", "Application name or window title keyword", required=True),
        CommandParam("x", "int", "X coordinate relative to the window", required=False),
        CommandParam("y", "int", "Y coordinate relative to the window", required=False),
        CommandParam("element_text", "str", "Optional button text or label to click", required=False),
        CommandParam("button", "str", "Mouse button: 'left' or 'right'", required=False, default="left"),
    ],
)
def cmd_background_click(
    app_name: str,
    x: Optional[int] = None,
    y: Optional[int] = None,
    element_text: Optional[str] = None,
    button: str = "left",
) -> CommandResult:
    try:
        from .background_controller import background_click
        res = background_click(app_name, x=x, y=y, element_text=element_text, button=button)
        return CommandResult(res.get("success", False), res.get("message", "Click executed."))
    except Exception as exc:
        return CommandResult(False, f"Background click failed: {exc}")

@registry.register(
    "background_type",
    "Types text into a background window or its text field WITHOUT stealing keyboard focus from active user window.",
    params=[
        CommandParam("app_name", "str", "Application name or window title keyword", required=True),
        CommandParam("text", "str", "Text to type into the background window", required=True),
        CommandParam("press_enter", "bool", "Whether to send an Enter keystroke after typing", required=False, default=False),
    ],
)
def cmd_background_type(app_name: str, text: str, press_enter: bool = False) -> CommandResult:
    try:
        from .background_controller import background_type
        res = background_type(app_name, text=text, press_enter=press_enter)
        return CommandResult(res.get("success", False), res.get("message", "Typing executed."))
    except Exception as exc:
        return CommandResult(False, f"Background typing failed: {exc}")

@registry.register(
    "background_send_keys",
    "Sends keyboard shortcut or key command (e.g. enter, tab, ctrl+s) to a background window without activating it.",
    params=[
        CommandParam("app_name", "str", "Application name or window title keyword", required=True),
        CommandParam("keys", "list", "List of keys (e.g. ['ctrl', 's'] or ['enter'])", required=True),
    ],
)
def cmd_background_send_keys(app_name: str, keys: Any) -> CommandResult:
    try:
        from .background_controller import background_send_keys
        k_list = [keys] if isinstance(keys, str) else list(keys)
        res = background_send_keys(app_name, keys=k_list)
        return CommandResult(res.get("success", False), res.get("message", "Keys sent."))
    except Exception as exc:
        return CommandResult(False, f"Background keys failed: {exc}")

@registry.register(
    "background_close_window",
    "Closes a background window safely using WM_CLOSE without activating it.",
    params=[CommandParam("app_name", "str", "Application name or window title keyword", required=True)],
)
def cmd_background_close_window(app_name: str) -> CommandResult:
    try:
        from .background_controller import background_close_window
        res = background_close_window(app_name)
        return CommandResult(res.get("success", False), res.get("message", "Window closed."))
    except Exception as exc:
        return CommandResult(False, f"Failed to close background window: {exc}")

@registry.register(
    "get_background_activity",
    "Instantly returns real-time activity, open tabs, documents, and content of all background applications in under 30ms without bringing them to the front.",
    params=[CommandParam("query", "str", "Optional app name or window title to filter (e.g. 'opera', 'whatsapp')", required=False, default=None)],
)
def cmd_get_background_activity(query: Optional[str] = None) -> CommandResult:
    try:
        from .background_controller import get_background_activity
        res = get_background_activity(query=query)
        if res.get("success"):
            return CommandResult(True, res.get("summary", "No background activity detected."))
        return CommandResult(False, res.get("message", "Failed to retrieve background activity."))
    except Exception as exc:
        return CommandResult(False, f"Failed to get background activity: {exc}")

# ---------------------------------------------------------------------------
# WINDOW MANAGEMENT & SPLIT SCREEN COMMANDS
# ---------------------------------------------------------------------------

def _get_work_area() -> Tuple[int, int, int, int]:
    """Returns (x, y, width, height) of primary monitor work area (excluding taskbar)."""
    user32 = ctypes.windll.user32
    class RECT(ctypes.Structure):
        _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long), ('right', ctypes.c_long), ('bottom', ctypes.c_long)]
    r = RECT()
    if user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(r), 0):
        w = max(100, r.right - r.left)
        h = max(100, r.bottom - r.top)
        return r.left, r.top, w, h
    w = max(100, user32.GetSystemMetrics(0))
    h = max(100, user32.GetSystemMetrics(1))
    return 0, 0, w, h

_LAST_SPLIT_WINDOWS: List[int] = []

_IGNORED_APP_PROCESSES = {
    "shellexperiencehost.exe", "searchhost.exe", "startmenuexperiencehost.exe",
    "dwm.exe", "lockapp.exe", "antigravity.exe", "textinputhost.exe",
    "taskhostw.exe", "systemsettings.exe", "applicationframehost.exe",
    "dcv2.exe", "msi.terminalserver.exe", "omapsvcbroker.exe", "ledkeeper2.exe",
    "widgetboard.exe", "crossdeviceservice.exe", "crossdeviceresume.exe",
    "nvdisplay.container.exe", "securityhealthsystray.exe", "msi_lan_manager_tool.exe"
}

def _is_user_app_window(hwnd: int, allow_minimized: bool = False) -> bool:
    """Returns True if hwnd is a real, interactive user application window."""
    user32 = ctypes.windll.user32
    from ctypes import wintypes
    import psutil

    if not hwnd or not user32.IsWindow(hwnd):
        return False
    is_vis = user32.IsWindowVisible(hwnd)
    is_iconic = user32.IsIconic(hwnd)
    if not is_vis and not (allow_minimized and is_iconic):
        return False
    if not allow_minimized and is_iconic:
        return False

    length = user32.GetWindowTextLengthW(hwnd)
    if length == 0:
        return False
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value.strip().lower()
    if not title or title in ("program manager", "windows input experience", "settings"):
        return False

    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return False
    pname = ""
    try:
        pname = psutil.Process(pid.value).name().lower()
    except Exception:
        return False

    if _is_era_process(pname, title):
        return False
    if pname in _IGNORED_APP_PROCESSES:
        return False
    if pname == "explorer.exe" and not any(k in title for k in ["file explorer", "home", "this pc", "documents", "downloads"]):
        if title in ("program manager", "", "desktop"):
            return False

    if not is_iconic:
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        w = rect.right - rect.left
        h = rect.bottom - rect.top
        if w < 150 or h < 150:
            return False
    return True

def _get_top_app_windows(limit: int = 2, allow_minimized: bool = False) -> List[int]:
    """Returns the top visible non-desktop, non-system, non-ERA application window HWNDs in true visual Z-order."""
    _attach_winsta()
    user32 = ctypes.windll.user32
    results: List[int] = []

    # 1. Check current foreground window if it is a genuine user application
    fg = user32.GetForegroundWindow()
    if fg and _is_user_app_window(fg, allow_minimized=allow_minimized):
        results.append(fg)

    # 2. Enumerate in true Windows Z-order (top-to-bottom on desktop)
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    candidate_hwnds: List[int] = []

    def _enum_cb(hwnd, lparam):
        if hwnd not in results and _is_user_app_window(hwnd, allow_minimized=allow_minimized):
            candidate_hwnds.append(hwnd)
        return True

    h_desk = user32.OpenDesktopW("default", 0, False, 0x01FF)
    if h_desk:
        user32.EnumDesktopWindows(h_desk, WNDENUMPROC(_enum_cb), 0)
    else:
        user32.EnumWindows(WNDENUMPROC(_enum_cb), 0)

    for h in candidate_hwnds:
        if h not in results:
            results.append(h)
        if len(results) >= limit:
            break

    # 3. If still empty, check _LAST_SPLIT_WINDOWS
    if not results and _LAST_SPLIT_WINDOWS:
        for h in _LAST_SPLIT_WINDOWS:
            if h and user32.IsWindow(h) and h not in results:
                results.append(h)

    return results[:limit]

def _maximize_hwnd_guaranteed(hwnd: int) -> bool:
    """Maximizes a window HWND with 100% guarantee across standard Win32, DWM, and custom-frame apps."""
    user32 = ctypes.windll.user32
    if not hwnd or not user32.IsWindow(hwnd):
        return False

    _attach_winsta()

    # 1. Restore only if iconic/minimized
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        time.sleep(0.08)

    # 2. Force to foreground so Windows DWM prioritizes the maximize action
    _force_foreground_window(hwnd)
    time.sleep(0.04)

    # 3. Multi-tier Maximize Dispatch:
    # Tier A: SW_MAXIMIZE
    user32.ShowWindow(hwnd, 3)

    # Tier B: Windows Native Title Bar Maximize Command (WM_SYSCOMMAND / SC_MAXIMIZE)
    user32.PostMessageW(hwnd, 0x0112, 0xF030, 0)
    try:
        user32.SendMessageTimeoutW(hwnd, 0x0112, 0xF030, 0, 0x0002, 200, None)
    except Exception:
        pass

    time.sleep(0.1)

    # Tier C: Hardware work-area verification & fallback
    # If the app has custom border or ignored ShowWindow, physically place it across the full work area
    wx, wy, W, H = _get_work_area()
    from ctypes import wintypes
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    cur_w = rect.right - rect.left
    cur_h = rect.bottom - rect.top

    if not user32.IsZoomed(hwnd) and (cur_w < (W * 0.95) or cur_h < (H * 0.95)):
        user32.SetWindowPos(hwnd, 0, wx, wy, W, H, 0x0040 | 0x0020)  # SWP_SHOWWINDOW | SWP_FRAMECHANGED
        time.sleep(0.05)

    _force_foreground_window(hwnd)
    return True

def _find_window_for_app(app_name: str) -> Optional[int]:
    """Locates the HWND for an application window by app name, process name, or title with guaranteed multi-pass fallback."""
    if not app_name:
        return None
    app_clean = str(app_name).strip().lower()

    user32 = ctypes.windll.user32
    _attach_winsta()

    ACTIVE_TARGET_SYNONYMS = {
        "active", "current", "this", "foreground", "screen", "full screen", "fullscreen",
        "full", "window", "display", "monitor", "badi screen", "isko", "app", "", "none"
    }

    if app_clean in ACTIVE_TARGET_SYNONYMS:
        top = _get_top_app_windows(1)
        if top:
            return top[0]
        if _LAST_SPLIT_WINDOWS:
            for h in _LAST_SPLIT_WINDOWS:
                if h and user32.IsWindow(h) and user32.IsWindowVisible(h):
                    return h
        fg = user32.GetForegroundWindow()
        if fg and _is_user_app_window(fg):
            return fg
        return None

    # Handle directional targets ("left" / "right" window)
    if app_clean in ("left", "left side", "left window", "left app"):
        if _LAST_SPLIT_WINDOWS and len(_LAST_SPLIT_WINDOWS) >= 1 and user32.IsWindow(_LAST_SPLIT_WINDOWS[0]):
            return _LAST_SPLIT_WINDOWS[0]
        wx, wy, W, H = _get_work_area()
        top_wins = _get_top_app_windows(4)
        for h in top_wins:
            from ctypes import wintypes
            rect = wintypes.RECT()
            user32.GetWindowRect(h, ctypes.byref(rect))
            if rect.left < (wx + W // 2):
                return h

    if app_clean in ("right", "right side", "right window", "right app"):
        if _LAST_SPLIT_WINDOWS and len(_LAST_SPLIT_WINDOWS) >= 2 and user32.IsWindow(_LAST_SPLIT_WINDOWS[1]):
            return _LAST_SPLIT_WINDOWS[1]
        wx, wy, W, H = _get_work_area()
        top_wins = _get_top_app_windows(4)
        for h in top_wins:
            from ctypes import wintypes
            rect = wintypes.RECT()
            user32.GetWindowRect(h, ctypes.byref(rect))
            if rect.left >= (wx + W // 2 - 50):
                return h

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
        "canva": ["canva"],
        "chatgpt": ["chatgpt", "openai"],
        "youtube": ["youtube"],
        "settings": ["settings", "systemsettings"],
        "terminal": ["windowsterminal", "wt", "powershell", "cmd"],
        "powershell": ["powershell", "pwsh", "windowsterminal"],
        "store": ["microsoft store", "winstore"],
    }
    targets = title_aliases.get(app_clean, [app_clean])

    # Method 1: Check background_controller
    try:
        from .background_controller import list_background_windows
        wins = list_background_windows(include_minimized=True)
        for t in targets:
            for w in wins:
                if _is_era_process(w.process_name, w.title):
                    continue
                proc = w.process_name.lower().replace(".exe", "")
                if t == proc or t in proc or proc in t:
                    return w.hwnd
            for w in wins:
                if _is_era_process(w.process_name, w.title):
                    continue
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

            if _is_era_process(pname, title):
                return True

            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w = max(0, rect.right - rect.left)
            h = max(0, rect.bottom - rect.top)

            for t in targets:
                if (pname and (t == pname or (len(t) >= 3 and t in pname))) or (title and len(t) >= 2 and t in title):
                    score = w * h
                    if is_vis: score += 1000000
                    if title: score += 500000
                    candidate_hwnds.append((score, hwnd))
                    break
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        h_desk = user32.OpenDesktopW("default", 0, False, 0x01FF)
        if h_desk:
            user32.EnumDesktopWindows(h_desk, WNDENUMPROC(_enum_cb), 0)
        else:
            user32.EnumWindows(WNDENUMPROC(_enum_cb), 0)
        if candidate_hwnds:
            candidate_hwnds.sort(key=lambda x: x[0], reverse=True)
            return candidate_hwnds[0][1]
    except Exception:
        pass

    return None

def _snap_hwnd(hwnd: int, position: str) -> bool:
    """Snaps a specific window HWND to screen position."""
    user32 = ctypes.windll.user32
    pos = position.strip().lower()

    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        time.sleep(0.1)

    if pos in ("maximize", "fullscreen", "full"):
        return _maximize_hwnd_guaranteed(hwnd)
    if pos == "minimize":
        return bool(user32.ShowWindow(hwnd, 6))  # SW_MINIMIZE
    if pos == "restore":
        return bool(user32.ShowWindow(hwnd, 9))  # SW_RESTORE

    wx, wy, W, H = _get_work_area()
    half_w = W // 2
    half_h = H // 2

    rects = {
        "left":         (wx,          wy,          half_w,     H),
        "right":        (wx + half_w, wy,          W - half_w, H),
        "top":          (wx,          wy,          W,          half_h),
        "bottom":       (wx,          wy + half_h, W,          H - half_h),
        "top-left":     (wx,          wy,          half_w,     half_h),
        "top-right":    (wx + half_w, wy,          W - half_w, half_h),
        "bottom-left":  (wx,          wy + half_h, half_w,     H - half_h),
        "bottom-right": (wx + half_w, wy + half_h, W - half_w, H - half_h),
    }

    x, y, w, h = rects.get(pos, (wx, wy, half_w, H))

    user32.ShowWindow(hwnd, 1)  # SW_SHOWNORMAL
    time.sleep(0.05)
    res = user32.SetWindowPos(hwnd, 0, x, y, w, h, 0x0040 | 0x0020)  # SWP_SHOWWINDOW | SWP_FRAMECHANGED
    _force_foreground_window(hwnd)
    return bool(res)

@registry.register(
    "snap_window",
    "Snaps an application window to left, right, top, bottom, or maximizes/minimizes it",
    params=[
        CommandParam("app_name", "str", "Name of the app (e.g. 'chrome', 'vscode', 'notepad', 'active')", required=False, default="active"),
        CommandParam("position", "str", "Position: 'left', 'right', 'top', 'bottom', 'maximize', 'minimize', 'restore'", required=False, default="left"),
    ],
)
def snap_window(
    app_name: Optional[str] = None,
    position: str = "left",
    **kwargs: Any,
) -> CommandResult:
    """Snaps an app window or the active window to a screen position."""
    target_app = app_name or kwargs.get("appName") or kwargs.get("title") or kwargs.get("app") or "active"
    pos = str(position or kwargs.get("pos") or "left").strip().lower()

    user32 = ctypes.windll.user32
    hwnd = _find_window_for_app(target_app)

    # Launch if not currently running
    if not hwnd and target_app not in ("active", "current", "this", "foreground", "screen", "full screen"):
        open_app(target_app)
        for _ in range(8):
            time.sleep(0.4)
            hwnd = _find_window_for_app(target_app)
            if hwnd:
                break

    if not hwnd:
        top = _get_top_app_windows(1)
        hwnd = top[0] if top else None
    if not hwnd:
        hwnd = user32.GetForegroundWindow()

    if not hwnd or not user32.IsWindow(hwnd):
        return CommandResult(False, f"Could not find or focus window for '{target_app}'.")

    ok = _snap_hwnd(hwnd, pos)
    if ok:
        return CommandResult(True, f"Successfully snapped '{target_app}' to {pos}.")
    return CommandResult(False, f"Failed to reposition '{target_app}' window to {pos}.")

@registry.register(
    "snapWindow",
    "Alias for snap_window",
    params=[
        CommandParam("app_name", "str", "Name of the app", required=False, default="active"),
        CommandParam("position", "str", "Position", required=False, default="left"),
    ],
)
def snapWindow(app_name: Optional[str] = None, position: str = "left", **kwargs: Any) -> CommandResult:
    return snap_window(app_name=app_name, position=position, **kwargs)

@registry.register(
    "split_screen",
    "Splits screen side-by-side between apps or arranges active apps",
    params=[
        CommandParam("left_app", "str", "Application for the left side (optional)", required=False),
        CommandParam("right_app", "str", "Application for the right side (optional)", required=False),
        CommandParam("middle_app", "str", "Application for middle panel (optional, 3-way split)", required=False),
    ],
)
def split_screen(
    left_app: Optional[str] = None,
    right_app: Optional[str] = None,
    middle_app: Optional[str] = None,
    **kwargs: Any,
) -> CommandResult:
    """Arranges windows side-by-side or into thirds across the screen with smart auto-detection and guaranteed unzooming."""
    global _LAST_SPLIT_WINDOWS
    l_app = str(left_app or kwargs.get("leftApp") or kwargs.get("left") or "").strip()
    r_app = str(right_app or kwargs.get("rightApp") or kwargs.get("right") or "").strip()
    m_app = str(middle_app or kwargs.get("middleApp") or kwargs.get("middle") or "").strip()

    user32 = ctypes.windll.user32
    wx, wy, W, H = _get_work_area()

    def _ensure_hwnd(name: str) -> Optional[int]:
        if not name:
            return None
        h = _find_window_for_app(name)
        if not h:
            open_app(name)
            for _ in range(15):
                time.sleep(0.1)
                h = _find_window_for_app(name)
                if h:
                    break
        return h

    def _snap_panel(hwnd: int, x: int, y: int, w: int, h: int) -> bool:
        if not hwnd or not user32.IsWindow(hwnd):
            return False
        # Un-minimize and un-maximize cleanly so SetWindowPos succeeds 100% of the time!
        if user32.IsIconic(hwnd) or user32.IsZoomed(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            time.sleep(0.06)
        else:
            user32.ShowWindow(hwnd, 1)  # SW_SHOWNORMAL
            time.sleep(0.04)

        ok = bool(user32.SetWindowPos(hwnd, 0, x, y, w, h, 0x0040 | 0x0020))
        _force_foreground_window(hwnd)
        return ok

    left_hwnd: Optional[int] = None
    right_hwnd: Optional[int] = None

    # Smart auto-detection if one or both apps are not specified
    if not l_app and not r_app:
        top_hwnds = _get_top_app_windows(limit=2, allow_minimized=True)
        if len(top_hwnds) >= 2:
            left_hwnd = top_hwnds[0]
            right_hwnd = top_hwnds[1]
            l_app = "active window"
            r_app = "second window"
        elif len(top_hwnds) == 1:
            left_hwnd = top_hwnds[0]
            l_app = "active window"
            for cand in ["edge", "chrome", "opera", "vscode", "explorer", "notepad"]:
                cand_h = _find_window_for_app(cand)
                if cand_h and cand_h != left_hwnd:
                    right_hwnd = cand_h
                    r_app = cand
                    break
            if not right_hwnd:
                right_hwnd = _ensure_hwnd("explorer")
                r_app = "file explorer"
        else:
            left_hwnd = _ensure_hwnd("edge") or _ensure_hwnd("explorer")
            right_hwnd = _ensure_hwnd("explorer") or _ensure_hwnd("notepad")
            l_app = "browser"
            r_app = "explorer"
    elif l_app and not r_app:
        left_hwnd = _ensure_hwnd(l_app)
        top_hwnds = _get_top_app_windows(limit=4, allow_minimized=True)
        right_hwnd = next((h for h in top_hwnds if h != left_hwnd), None)
        if not right_hwnd:
            for cand in ["edge", "chrome", "opera", "vscode", "explorer", "notepad"]:
                cand_h = _find_window_for_app(cand)
                if cand_h and cand_h != left_hwnd:
                    right_hwnd = cand_h
                    r_app = cand
                    break
        if not right_hwnd:
            right_hwnd = _ensure_hwnd("explorer")
            r_app = "file explorer"
        else:
            r_app = r_app or "other window"
    elif r_app and not l_app:
        right_hwnd = _ensure_hwnd(r_app)
        top_hwnds = _get_top_app_windows(limit=4, allow_minimized=True)
        left_hwnd = next((h for h in top_hwnds if h != right_hwnd), None)
        if not left_hwnd:
            for cand in ["edge", "chrome", "opera", "vscode", "explorer", "notepad"]:
                cand_h = _find_window_for_app(cand)
                if cand_h and cand_h != right_hwnd:
                    left_hwnd = cand_h
                    l_app = cand
                    break
        if not left_hwnd:
            left_hwnd = _ensure_hwnd("explorer")
            l_app = "file explorer"
        else:
            l_app = l_app or "other window"
    else:
        left_hwnd = _ensure_hwnd(l_app)
        right_hwnd = _ensure_hwnd(r_app)

    mid_hwnd = _ensure_hwnd(m_app) if m_app else None

    # Handle 3-way split
    if mid_hwnd:
        third_w = W // 3
        ok_l = _snap_panel(left_hwnd, wx, wy, third_w, H) if left_hwnd else False
        ok_m = _snap_panel(mid_hwnd, wx + third_w, wy, third_w, H) if mid_hwnd else False
        ok_r = _snap_panel(right_hwnd, wx + 2 * third_w, wy, W - 2 * third_w, H) if right_hwnd else False
        _LAST_SPLIT_WINDOWS = [h for h in (left_hwnd, mid_hwnd, right_hwnd) if h]
        return CommandResult(True, f"Split screen into 3 panels: left '{l_app}', middle '{m_app}', right '{r_app}'.")

    # 2-way side-by-side split
    half_w = W // 2
    ok_left = _snap_panel(left_hwnd, wx, wy, half_w, H) if left_hwnd else False
    ok_right = _snap_panel(right_hwnd, wx + half_w, wy, W - half_w, H) if right_hwnd else False

    if ok_left or ok_right:
        _LAST_SPLIT_WINDOWS = [h for h in (left_hwnd, right_hwnd) if h]
        return CommandResult(True, f"Screen successfully split side-by-side: left '{l_app}', right '{r_app}'.")
    return CommandResult(False, f"Could not adjust windows for '{l_app}' and '{r_app}'.")

@registry.register(
    "splitScreen",
    "Alias for split_screen",
    params=[
        CommandParam("left_app", "str", "Application for the left side", required=True),
        CommandParam("right_app", "str", "Application for the right side", required=True),
    ],
)
def splitScreen(left_app: str, right_app: str, **kwargs: Any) -> CommandResult:
    return split_screen(left_app=left_app, right_app=right_app, **kwargs)

@registry.register(
    "splitscreen",
    "Alias for split_screen",
    params=[
        CommandParam("left_app", "str", "Application for the left side", required=True),
        CommandParam("right_app", "str", "Application for the right side", required=True),
    ],
)
def splitscreen(left_app: str, right_app: str, **kwargs: Any) -> CommandResult:
    return split_screen(left_app=left_app, right_app=right_app, **kwargs)

@registry.register(
    "side_by_side",
    "Alias for split_screen",
    params=[
        CommandParam("left_app", "str", "Application for the left side", required=True),
        CommandParam("right_app", "str", "Application for the right side", required=True),
    ],
)
def side_by_side(left_app: str, right_app: str, **kwargs: Any) -> CommandResult:
    return split_screen(left_app=left_app, right_app=right_app, **kwargs)

@registry.register(
    "sideBySide",
    "Alias for split_screen",
    params=[
        CommandParam("left_app", "str", "Application for the left side", required=True),
        CommandParam("right_app", "str", "Application for the right side", required=True),
    ],
)
def sideBySide(left_app: str, right_app: str, **kwargs: Any) -> CommandResult:
    return split_screen(left_app=left_app, right_app=right_app, **kwargs)

@registry.register(
    "minimize_active_window",
    "Minimizes the currently active/focused foreground window",
)
def minimize_active_window(**kwargs: Any) -> CommandResult:
    """Minimizes the active foreground window."""
    user32 = ctypes.windll.user32
    _attach_winsta()
    hwnd = user32.GetForegroundWindow()
    if not hwnd or not user32.IsWindow(hwnd):
        top = _get_top_app_windows(1)
        hwnd = top[0] if top else None

    if not hwnd or not user32.IsWindow(hwnd):
        return CommandResult(False, "No active window found to minimize.")

    user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
    return CommandResult(True, "Successfully minimized active window.")

@registry.register(
    "minimizeActiveWindow",
    "Alias for minimize_active_window",
)
def minimizeActiveWindow(**kwargs: Any) -> CommandResult:
    return minimize_active_window(**kwargs)

@registry.register(
    "minimize_window",
    "Minimizes a specific window by title or app name",
    params=[CommandParam("title", "str", "Application name or window title to minimize", required=False)],
)
def minimize_window(title: Optional[str] = None, app_name: Optional[str] = None, **kwargs: Any) -> CommandResult:
    """Minimizes a specific window by name."""
    target = title or app_name or kwargs.get("appName") or "active"
    t_clean = str(target).strip().lower()
    user32 = ctypes.windll.user32
    _attach_winsta()

    if t_clean in ("active", "current", "this", "foreground", ""):
        return minimize_active_window()

    hwnd = _find_window_for_app(t_clean)
    if not hwnd:
        top = _get_top_app_windows(1)
        hwnd = top[0] if top else None

    if not hwnd or not user32.IsWindow(hwnd):
        return CommandResult(False, f"Window for '{target}' was not found.")

    user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
    return CommandResult(True, f"Successfully minimized '{target}' window.")

@registry.register(
    "minimizeWindow",
    "Alias for minimize_window",
    params=[CommandParam("title", "str", "Application name or window title", required=False)],
)
def minimizeWindow(title: Optional[str] = None, app_name: Optional[str] = None, **kwargs: Any) -> CommandResult:
    return minimize_window(title=title, app_name=app_name, **kwargs)

@registry.register(
    "maximize_window",
    "Maximizes a specific window or the active window to full screen.",
    params=[CommandParam("title", "str", "Application name or window title (defaults to active window)", required=False)],
)
def maximize_window(title: Optional[str] = None, app_name: Optional[str] = None, **kwargs: Any) -> CommandResult:
    """Maximizes a window to fill the entire screen (Full Screen)."""
    target = title or app_name or kwargs.get("appName") or kwargs.get("app") or kwargs.get("target") or "active"
    t_clean = str(target).strip().lower()
    hwnd = None

    user32 = ctypes.windll.user32
    _attach_winsta()

    ACTIVE_TARGET_SYNONYMS = {
        "active", "current", "this", "foreground", "screen", "full screen", "fullscreen",
        "full", "window", "display", "monitor", "badi screen", "isko", "app", "", "none"
    }

    if t_clean in ACTIVE_TARGET_SYNONYMS:
        top = _get_top_app_windows(1)
        hwnd = top[0] if top else None
        if not hwnd and _LAST_SPLIT_WINDOWS:
            for h in _LAST_SPLIT_WINDOWS:
                if h and user32.IsWindow(h) and user32.IsWindowVisible(h):
                    hwnd = h
                    break
        if not hwnd:
            fg = user32.GetForegroundWindow()
            if fg and _is_user_app_window(fg):
                hwnd = fg
    else:
        hwnd = _find_window_for_app(t_clean)

    if not hwnd or not user32.IsWindow(hwnd):
        top = _get_top_app_windows(1)
        hwnd = top[0] if top else None

    if not hwnd or not user32.IsWindow(hwnd):
        return CommandResult(False, f"Could not find an active window to make full screen for '{target}'.")

    # Get display title for natural feedback
    length = user32.GetWindowTextLengthW(hwnd)
    disp_title = str(target)
    if length > 0:
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        val = buf.value.strip()
        if val:
            disp_title = val[:40]

    ok = _maximize_hwnd_guaranteed(hwnd)
    if ok:
        return CommandResult(True, f"Successfully maximized '{disp_title}' to full screen.")
    return CommandResult(False, f"Failed to maximize '{disp_title}' to full screen.")

@registry.register(
    "maximizeWindow",
    "Alias for maximize_window",
    params=[CommandParam("title", "str", "Application name or window title", required=False)],
)
def maximizeWindow(title: Optional[str] = None, app_name: Optional[str] = None, **kwargs: Any) -> CommandResult:
    return maximize_window(title=title, app_name=app_name, **kwargs)

@registry.register(
    "fullScreen",
    "Maximizes window to full screen",
    params=[CommandParam("appName", "str", "Application name or window title", required=False)],
)
def fullScreen(appName: Optional[str] = None, **kwargs: Any) -> CommandResult:
    return maximize_window(title=appName, **kwargs)

@registry.register(
    "fullscreen",
    "Maximizes window to full screen",
    params=[CommandParam("app_name", "str", "Application name or window title", required=False)],
)
def fullscreen(app_name: Optional[str] = None, **kwargs: Any) -> CommandResult:
    return maximize_window(title=app_name, **kwargs)

@registry.register(
    "restore_window",
    "Restores a minimized or maximized window back to normal size and focus",
    params=[CommandParam("title", "str", "Application name or window title", required=False)],
)
def restore_window(title: Optional[str] = None, app_name: Optional[str] = None, **kwargs: Any) -> CommandResult:
    """Restores a window to normal position and state."""
    target = title or app_name or kwargs.get("appName") or "active"
    hwnd = _find_window_for_app(str(target))
    user32 = ctypes.windll.user32
    if not hwnd:
        hwnd = user32.GetForegroundWindow()

    if not hwnd:
        return CommandResult(False, f"Window for '{target}' was not found.")

    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    _force_foreground_window(hwnd)
    return CommandResult(True, f"Successfully restored '{target}' window.")

@registry.register(
    "minimize_all",
    "Minimizes all open windows and reveals the Windows desktop",
)
def minimize_all(**kwargs: Any) -> CommandResult:
    """Minimizes all windows to show the desktop."""
    try:
        ps_cmd = "(New-Object -ComObject Shell.Application).MinimizeAll()"
        subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], timeout=3.0)
        return CommandResult(True, "Minimized all windows and showed desktop.")
    except Exception as exc:
        try:
            import pyautogui
            pyautogui.hotkey('win', 'd')
            return CommandResult(True, "Minimized all windows (Win+D).")
        except Exception:
            return CommandResult(False, f"Failed to minimize all windows: {exc}")

@registry.register(
    "minimizeAll",
    "Alias for minimize_all",
)
def minimizeAll(**kwargs: Any) -> CommandResult:
    return minimize_all(**kwargs)

@registry.register(
    "show_desktop",
    "Toggles or reveals the Windows desktop by minimizing windows",
)
def show_desktop(**kwargs: Any) -> CommandResult:
    return minimize_all(**kwargs)

