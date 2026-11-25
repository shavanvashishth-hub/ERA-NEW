import time
import os
import sys
import ctypes
from datetime import datetime, timezone
from pycaw.pycaw import AudioUtilities, IAudioMeterInformation

LOG_FILE = r"C:\Users\MSI\AppData\Local\ERA\logs\audio_monitor.log"
os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)

def log(msg):
    ts = datetime.now(timezone.utc).isoformat()
    entry = f"[{ts}] {msg}\n"
    print(entry, end="", flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(entry)
    except Exception as e:
        print(f"Log write error: {e}", flush=True)

def run():
    ctypes.windll.ole32.CoInitialize(None)
    log("[AUDIO-MONITOR] Started WASAPI real-time audio session peak monitor.")
    last_reported = {}
    
    try:
        while True:
            try:
                sessions = AudioUtilities.GetAllSessions()
                now = time.time()
                for s in sessions:
                    try:
                        p = s.Process
                        pid = p.pid if p else 0
                        pname = p.name() if p else "System Sound (PID 0)"
                        meter = s._ctl.QueryInterface(IAudioMeterInformation)
                        peak = meter.GetPeakValue()
                        
                        if peak > 0.01:
                            last_t = last_reported.get(pid, 0)
                            if now - last_t >= 0.15:  # Rate limit reporting per process to every 150ms
                                log(f"[AUDIO-PEAK] Process: '{pname}' (PID: {pid}) | Peak: {peak:.4f}")
                                last_reported[pid] = now
                    except Exception:
                        pass
                time.sleep(0.02)
            except Exception as e:
                time.sleep(0.1)
    finally:
        ctypes.windll.ole32.CoUninitialize()

if __name__ == "__main__":
    run()
