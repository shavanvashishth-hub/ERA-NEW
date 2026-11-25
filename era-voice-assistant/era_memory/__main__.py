"""CLI: python -m era_memory <serve|health|stats|backup|restore|export|consolidate|search> [--dir PATH]"""
import argparse, json, sys

from .memory_api import MemoryServer
from .memory_config import MemoryConfig
from .memory_engine import MemoryEngine


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="era_memory")
    p.add_argument("command", choices=["serve", "health", "stats", "backup", "restore", "export", "consolidate", "search"])
    p.add_argument("arg", nargs="?")
    p.add_argument("--dir"); p.add_argument("--port", type=int)
    a = p.parse_args(argv)
    kw = {}
    if a.dir: kw["storage_dir"] = a.dir
    if a.port: kw["api_port"] = a.port
    cfg = MemoryConfig.from_env(**kw)
    with MemoryEngine(cfg) as e:
        if a.command == "serve":
            s = MemoryServer(e)
            print(f"ERA memory API on http://{cfg.api_host}:{s.port}{cfg.api_prefix}  (token file: {cfg.token_path})")
            try: s.serve_forever()
            except KeyboardInterrupt: pass
            return 0
        out = {"health": e.health_check, "stats": e.get_memory_statistics, "backup": e.backup_memory,
               "export": lambda: e.export_memory(a.arg), "consolidate": e.consolidate_memories,
               "restore": lambda: e.restore_memory(a.arg),
               "search": lambda: [r.to_dict() for r in e.search_memory(a.arg or "")]}[a.command]()
        print(json.dumps(out, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
