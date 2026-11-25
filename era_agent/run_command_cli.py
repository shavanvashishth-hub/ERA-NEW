"""CLI command runner for ERA Agent commands.
Allows zero-latency, error-free out-of-process command execution without fragile -c string escaping.
"""
import sys
import json
from pathlib import Path

# Ensure era_agent is on path
agent_dir = Path(__file__).resolve().parent
if str(agent_dir) not in sys.path:
    sys.path.insert(0, str(agent_dir))

try:
    from commands import registry
except ImportError:
    from era_agent.commands import registry

def main():
    if len(sys.argv) < 2:
        print("Usage: python run_command_cli.py <command_name> [json_params]")
        sys.exit(1)

    cmd = sys.argv[1]
    params = {}
    if len(sys.argv) > 2:
        raw = sys.argv[2].strip()
        try:
            params = json.loads(raw)
        except Exception:
            try:
                import ast
                params = ast.literal_eval(raw)
            except Exception:
                try:
                    import re
                    fixed = re.sub(r'([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:', r'\1"\2":', raw)
                    params = json.loads(fixed)
                except Exception:
                    params = {}

    res = registry.execute(cmd, **params)
    print(res.message)
    sys.exit(0 if res.success else 1)

if __name__ == "__main__":
    main()
