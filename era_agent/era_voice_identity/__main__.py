"""CLI:  python -m era_voice_identity <command>"""
from __future__ import annotations

import argparse
import json
import logging
import time

from .config import Config
from .engine import VoiceIdentityEngine


def main(argv=None):
    ap = argparse.ArgumentParser(prog="era_voice_identity")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("devices")
    en = sub.add_parser("enroll"); en.add_argument("--samples", type=int, default=5)
    en.add_argument("--seconds", type=float, default=8.0)
    en.add_argument("--append", action="store_true"); en.add_argument("--files", nargs="*")
    ve = sub.add_parser("verify"); ve.add_argument("--seconds", type=float, default=4.0)
    ve.add_argument("--file")
    sub.add_parser("monitor")
    sub.add_parser("status"); sub.add_parser("reset"); sub.add_parser("benchmark")
    ca = sub.add_parser("calibrate"); ca.add_argument("--owner-dir", required=True)
    ca.add_argument("--impostor-dir", required=True); ca.add_argument("--target-far", type=float, default=0.01)
    ev = sub.add_parser("evaluate"); ev.add_argument("--data", required=True)
    ap.add_argument("--device", default="auto"); ap.add_argument("-v", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.v else logging.INFO)
    cfg = Config(device=a.device)

    if a.cmd == "devices":
        from .microphone import list_input_devices
        for d in list_input_devices():
            print(d)
        return
    if a.cmd == "benchmark":
        from . import benchmarks
        print(json.dumps(benchmarks.run(cfg), indent=2)); return
    if a.cmd == "evaluate":
        from .evaluate import evaluate
        print(json.dumps(evaluate(a.data), indent=2)); return

    eng = VoiceIdentityEngine(cfg)
    print(eng.initialize())
    if a.cmd == "enroll":
        if a.files:
            samples = a.files
        else:
            from .enrollment import ENROLLMENT_PROMPTS
            from .microphone import record
            samples = []
            for i in range(a.samples):
                input(f"\n[{i+1}/{a.samples}] {ENROLLMENT_PROMPTS[i % len(ENROLLMENT_PROMPTS)]}\nPress Enter, then speak for {a.seconds:.0f}s...")
                samples.append(record(a.seconds, cfg)); print("recorded.")
        print(json.dumps(eng.enroll_owner(samples, append=a.append), indent=2, default=str))
    elif a.cmd == "verify":
        if a.file:
            audio = a.file
        else:
            from .microphone import record
            input("Press Enter and speak..."); audio = record(a.seconds, cfg)
        print(json.dumps(eng.verify_speaker(audio), indent=2))
    elif a.cmd == "monitor":
        eng.start_monitoring(lambda r: print(json.dumps({k: r[k] for k in ("status", "is_owner", "confidence", "reason")})))
        print("Listening. Ctrl+C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            eng.stop_monitoring()
    elif a.cmd == "status":
        print(json.dumps(eng.get_status(), indent=2, default=str))
    elif a.cmd == "reset":
        print("profile removed" if eng.reset_profile() else "no profile")
    elif a.cmd == "calibrate":
        from pathlib import Path
        files = lambda d: [str(p) for p in sorted(Path(d).glob("*.wav"))]
        print(json.dumps(eng.calibrate_threshold(files(a.owner_dir), files(a.impostor_dir), a.target_far), indent=2))


if __name__ == "__main__":
    main()
