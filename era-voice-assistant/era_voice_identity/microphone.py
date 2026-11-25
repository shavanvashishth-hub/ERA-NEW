"""Live microphone capture, streaming VAD and utterance segmentation."""
from __future__ import annotations

import collections
import logging
import queue
import threading
import time
from typing import Callable, Optional

import numpy as np

from .audio import SpeechDetector
from .config import Config

log = logging.getLogger("era_voice_identity.mic")


def list_input_devices() -> list:
    import sounddevice as sd
    return [{"index": i, "name": d["name"], "channels": d["max_input_channels"]}
            for i, d in enumerate(sd.query_devices()) if d["max_input_channels"] > 0]


def record(seconds: float, cfg: Config, device: Optional[int] = None) -> np.ndarray:
    import sounddevice as sd
    x = sd.rec(int(seconds * cfg.sample_rate), samplerate=cfg.sample_rate, channels=1,
               dtype="float32", device=device if device is not None else cfg.mic_device)
    sd.wait()
    return x[:, 0]


class StreamingVAD:
    """Frame-by-frame speech decision with an adaptive noise floor."""

    def __init__(self, cfg: Config, detector: SpeechDetector):
        self.cfg, self.det = cfg, detector
        self.floor_db = -70.0
        self._seen = 0

    def is_speech(self, frame: np.ndarray) -> bool:
        e, ratio = self.det.frame_stats(frame.reshape(1, -1))
        e, ratio = float(e[0]), float(ratio[0])
        warm = self._seen < int(500 / self.cfg.frame_ms)         # first 0.5 s calibrates the floor
        self._seen += 1
        thr = max(self.floor_db + self.cfg.vad_margin_db, self.cfg.vad_abs_floor_db)
        speech = (not warm) and e > thr and ratio >= self.cfg.speech_band_ratio_min
        if not speech:
            a = 0.2 if warm else 0.05
            self.floor_db = min(-30.0, (1 - a) * self.floor_db + a * e) if self._seen > 1 else e
        return speech


class UtteranceSegmenter:
    """Turns frames into events:
         ("verify", wave)   enough speech accumulated -> run the model
         ("short", seconds) utterance ended without enough speech
    The model runs once per ~reverify_speech_s of *new* speech, never per frame."""

    def __init__(self, cfg: Config, detector: SpeechDetector):
        self.cfg = cfg
        self.vad = StreamingVAD(cfg, detector)
        self.fs = detector.frame_s
        self.preroll = collections.deque(maxlen=int(0.15 / self.fs) + 1)
        self.max_frames = int((cfg.window_s + 2.0) / self.fs)
        self._reset()

    def _reset(self):
        self.active, self.buf = False, collections.deque(maxlen=self.max_frames)
        self.speech_frames, self.verified_at, self.sil = 0, 0, 0

    def feed(self, frame: np.ndarray) -> list:
        ev = []
        sp = self.vad.is_speech(frame)
        self.preroll.append(frame)
        if sp:
            if not self.active:
                self._reset()
                self.active = True
                self.buf.extend(self.preroll)
            else:
                self.buf.append(frame)
            self.speech_frames += 1
            self.sil = 0
            speech_s = self.speech_frames * self.fs
            new_s = (self.speech_frames - self.verified_at) * self.fs
            if speech_s >= self.cfg.target_speech_s and (self.verified_at == 0 or new_s >= self.cfg.reverify_speech_s):
                n = int(self.cfg.window_s / self.fs)
                ev.append(("verify", np.concatenate(list(self.buf)[-n:])))
                self.verified_at = self.speech_frames
        elif self.active:
            self.buf.append(frame)
            self.sil += 1
            if self.sil * self.fs * 1000 >= self.cfg.hangover_ms:
                speech_s = self.speech_frames * self.fs
                if self.verified_at == 0 and speech_s >= self.cfg.min_report_speech_s:
                    ev.append(("short", speech_s))
                self._reset()
        return ev


class MicrophoneListener:
    """Background capture thread + worker thread. Survives device loss by reopening the stream."""

    def __init__(self, cfg: Config, detector: SpeechDetector,
                 verify_fn: Callable[[np.ndarray], dict],
                 on_result: Optional[Callable[[dict], None]] = None):
        self.cfg, self.verify_fn, self.on_result = cfg, verify_fn, on_result
        self.seg = UtteranceSegmenter(cfg, detector)
        self.q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=400)
        self._stop = threading.Event()
        self._threads: list = []
        self.state = {"running": False, "mic": "closed", "dropped_frames": 0, "restarts": 0,
                      "last_error": None, "verifications": 0}
        self.n = detector.n

    # -- pure logic, hardware-free (used by tests) ----------------------------
    def process_frame(self, frame: np.ndarray) -> None:
        for kind, payload in self.seg.feed(frame):
            if kind == "verify":
                res = self.verify_fn(payload)
                self.state["verifications"] += 1
            else:
                from .verification import make_result
                from .config import Status
                res = make_result(Status.INSUFFICIENT_AUDIO, 0.0,
                                  f"Utterance too short ({payload:.1f}s of speech)")
            self._emit(res)

    def _emit(self, res: dict) -> None:
        if self.on_result:
            try:
                self.on_result(res)
            except Exception:
                log.exception("on_result callback raised")

    # -- threads ----------------------------------------------------------------
    def start(self) -> None:
        if self.state["running"]:
            return
        self._stop.clear()
        self.state["running"] = True
        for target in (self._capture_loop, self._worker_loop):
            t = threading.Thread(target=target, daemon=True, name=f"era-voice-{target.__name__}")
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=3)
        self._threads.clear()
        self.state.update(running=False, mic="closed")

    def _capture_loop(self) -> None:
        import sounddevice as sd
        backoff = 1.0
        while not self._stop.is_set():
            try:
                def cb(indata, frames, t, status):
                    if status:
                        log.debug("mic status: %s", status)
                    try:
                        self.q.put_nowait(indata[:, 0].copy())
                    except queue.Full:
                        self.state["dropped_frames"] += 1
                with sd.InputStream(samplerate=self.cfg.sample_rate, channels=1, dtype="float32",
                                    blocksize=self.n, device=self.cfg.mic_device, callback=cb):
                    self.state.update(mic="open", last_error=None)
                    backoff = 1.0
                    last = self._last_frame = time.monotonic()
                    while not self._stop.is_set():
                        time.sleep(0.25)
                        if time.monotonic() - self._last_frame > self.cfg.mic_stall_s:
                            raise RuntimeError("microphone stopped delivering audio")
            except Exception as exc:
                self.state.update(mic="error", last_error=str(exc))
                self.state["restarts"] += 1
                log.warning("microphone error: %s (retry in %.0fs)", exc, backoff)
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 10.0)
        self.state["mic"] = "closed"

    def _worker_loop(self) -> None:
        self._last_frame = time.monotonic()
        while not self._stop.is_set():
            try:
                frame = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            self._last_frame = time.monotonic()
            try:
                self.process_frame(frame)
            except Exception:
                log.exception("frame processing failed")
