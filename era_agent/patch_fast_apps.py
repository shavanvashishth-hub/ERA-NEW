from pathlib import Path

path = Path(r"d:\era_agent\commands\system_commands.py")
content = path.read_text(encoding="utf-8")

# In _find_app_path, right after line candidate.exists(): return str(candidate)
target = '    candidate = Path(clean_name)\n    if candidate.exists():\n        return str(candidate)'

replacement = '''    candidate = Path(clean_name)
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
        return "mspaint.exe"'''

if target in content:
    content = content.replace(target, replacement, 1)
    path.write_text(content, encoding="utf-8")
    print("Updated fast app paths in _find_app_path")

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
    print("Could not find target in system_commands.py")
