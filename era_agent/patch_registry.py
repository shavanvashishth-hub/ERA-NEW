from pathlib import Path

targets = [
    Path(r"d:\era_agent\commands\registry.py"),
    Path(r"d:\era_agent\era_agent\commands\registry.py"),
    Path(r"C:\Users\MSI\AppData\Local\Programs\ERA AI Assistant\resources\era_services\era_agent\commands\registry.py"),
    Path(r"C:\Users\MSI\AppData\Local\Programs\ERA AI Assistant\resources\era_services\era_agent\era_agent\commands\registry.py"),
    Path(r"C:\Users\MSI\AppData\Local\Programs\ERA AI Assistant\resources\era_services\era_agent\Era Agent by VS Code\commands\registry.py"),
]

old_block = '''@dataclass
class CommandResult:
    """Represents the outcome of executing a single command."""

    success: bool
    message: str'''

new_block = '''@dataclass
class CommandResult:
    """Represents the outcome of executing a single command."""

    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None'''

for t in targets:
    if t.exists():
        text = t.read_text(encoding="utf-8")
        if "data: Optional[Dict[str, Any]] = None" not in text:
            if old_block in text:
                text = text.replace(old_block, new_block, 1)
            else:
                # regex replacement
                import re
                text = re.sub(r'class CommandResult:\s+"""[^"]*"""\s+success:\s*bool\s+message:\s*str',
                              'class CommandResult:\n    """Represents the outcome of executing a single command."""\n    success: bool\n    message: str\n    data: Optional[Dict[str, Any]] = None', text)
            t.write_text(text, encoding="utf-8")
            print(f"Patched {t}")
        else:
            print(f"Already patched {t}")

# Also update api_server.py in both places
api_targets = [
    Path(r"d:\era_agent\api_server.py"),
    Path(r"C:\Users\MSI\AppData\Local\Programs\ERA AI Assistant\resources\era_services\era_agent\api_server.py"),
]
for at in api_targets:
    if at.exists():
        txt = at.read_text(encoding="utf-8")
        # Ensure ExecuteResponse has data
        txt = txt.replace(
            "class ExecuteResponse(BaseModel):\n    success: bool\n    message: str\n",
            "class ExecuteResponse(BaseModel):\n    success: bool\n    message: str\n    data: Optional[Dict[str, Any]] = None\n"
        )
        txt = txt.replace(
            "return ExecuteResponse(success=result.success, message=result.message)",
            "return ExecuteResponse(success=result.success, message=result.message, data=getattr(result, 'data', None))"
        )
        at.write_text(txt, encoding="utf-8")
        print(f"Patched {at}")
