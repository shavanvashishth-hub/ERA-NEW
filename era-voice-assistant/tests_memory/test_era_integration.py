"""End-to-end integration tests for ERA's Human-Inspired Persistent Memory wiring."""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _http_json(url: str, method: str = "GET", body=None, headers=None, timeout: float = 25.0):
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="ignore")
        e.close()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


class AdapterAndServiceTest(unittest.TestCase):
    def setUp(self):
        self.mem_dir = tempfile.mkdtemp(prefix="era_int_mem_")
        self._old_dir = os.environ.get("ERA_MEMORY_DIR")
        os.environ["ERA_MEMORY_DIR"] = self.mem_dir
        import era_memory_adapter as adapter
        adapter.close_engine()
        self.adapter = adapter

    def tearDown(self):
        self.adapter.close_engine()
        if self._old_dir is None:
            os.environ.pop("ERA_MEMORY_DIR", None)
        else:
            os.environ["ERA_MEMORY_DIR"] = self._old_dir
        shutil.rmtree(self.mem_dir, ignore_errors=True)

    def test_adapter_persists_across_restarts_offline_and_hinglish(self):
        # Session 1: tell ERA personal facts and project details
        res = self.adapter.remember_turn(
            "My name is Shavan and I'm building a project called ERA.",
            "Nice to meet you Shavan! I will remember ERA.",
            session_id="sess-1",
            channel="voice",
            idempotency_key="turn-1",
        )
        self.assertTrue(res["stored"])

        # Idempotent retry should not duplicate
        res_dup = self.adapter.remember_turn(
            "My name is Shavan and I'm building a project called ERA.",
            "Nice to meet you Shavan! I will remember ERA.",
            session_id="sess-1",
            channel="voice",
            idempotency_key="turn-1",
        )
        self.assertEqual(res_dup["user"]["skipped_reason"], "duplicate_idempotency_key")

        # Session 2: record a second related memory and a location
        self.adapter.remember_turn("I live in Mathura.", "Got it, boss.", session_id="sess-2", channel="chat")
        self.adapter.remember_turn("ERA needs local AI memory that works offline.", "Agreed!", session_id="sess-2", channel="chat")

        # Simulate complete app shutdown / offline restart
        self.adapter.close_engine()

        # Re-open in new session after restart (no internet)
        from era_memory.memory_security import offline_guard
        with offline_guard():
            brief = self.adapter.startup_brief("sess-3")
            self.assertIn("Shavan", brief)
            self.assertIn("ERA", brief)
            self.assertIn("Mathura", brief)

            ctx_en = self.adapter.context_for("what am I building and what is my name?", session_id="sess-3")
            self.assertIn("Shavan", ctx_en)
            self.assertIn("ERA", ctx_en)

            ctx_hi = self.adapter.context_for("mera naam kya hai aur main kahan rehta hoon?", session_id="sess-3")
            self.assertIn("Shavan", ctx_hi)
            self.assertIn("Mathura", ctx_hi)

            # Fact correction preserves version history
            self.adapter.remember_turn("I moved to Delhi.", "Updated to Delhi, boss!", session_id="sess-3")
            eng = self.adapter.get_engine()
            eng.flush(5.0)
            prof = eng.get_user_profile()["identity"]
            locs = [p["value"] for p in prof if p["predicate"] == "location"]
            self.assertEqual(locs, ["Delhi"])
            ctx_hist = self.adapter.context_for("where did I live before?", session_id="sess-4", include_history=True)
            self.assertIn("Mathura", ctx_hist)

            # Procedural memory from Mission Engine
            pid = self.adapter.record_mission_procedure(
                "Launch desktop dashboard",
                ["Check port 3000", "Open Chrome"],
                outcome="success",
            )
            self.assertIsNotNone(pid)

    def test_memory_service_http_flow(self):
        from era_memory_service import EraMemoryServer
        eng = self.adapter.get_engine()
        eng.cfg.api_port = _free_port()
        srv = EraMemoryServer(eng).start()
        base = f"http://127.0.0.1:{srv.port}/memory"
        headers = {"Authorization": f"Bearer {srv.token}"}
        try:
            st, body = _http_json(f"{base}/health")
            self.assertEqual(st, 200)
            self.assertEqual(body["status"], "ok")

            # Auth required on protected routes
            st, _ = _http_json(f"{base}/turn", "POST", {"user_text": "hi"})
            self.assertEqual(st, 401)

            st, body = _http_json(
                f"{base}/turn",
                "POST",
                {"user_text": "My favorite language is Python and I'm building ERA.", "assistant_text": "Noted!", "session_id": "http-1"},
                headers=headers,
            )
            self.assertEqual(st, 200)
            self.assertTrue(body["stored"])

            st, body = _http_json(
                f"{base}/context-for",
                "POST",
                {"query": "what language do I prefer for ERA?", "session_id": "http-2"},
                headers=headers,
            )
            self.assertEqual(st, 200)
            self.assertIn("Python", body["rendered_text"])

            st, body = _http_json(f"{base}/startup-brief", "POST", {"session_id": "http-2"}, headers=headers)
            self.assertEqual(st, 200)
            self.assertIn("ERA", body["rendered_text"])

            st, b = _http_json(f"{base}/backup", "POST", {"label": "test"}, headers=headers)
            self.assertEqual(st, 200)
            self.assertTrue(b["id"].endswith(".db"))
        finally:
            srv.stop()


class FullNodeAndPythonE2ETest(unittest.TestCase):
    """Spawns the real compiled Node server (dist/server.cjs) + Python memory service across restarts."""

    def setUp(self):
        self.mem_dir = tempfile.mkdtemp(prefix="era_e2e_mem_")
        self.cfg_dir = tempfile.mkdtemp(prefix="era_e2e_cfg_")
        # Create an empty dummy keys.enc so server does not read real keys in offline test
        (Path(self.cfg_dir) / "keys.enc").write_text("invalid", encoding="utf-8")
        self.server_bundle = ROOT / "dist" / "server.cjs"
        if not self.server_bundle.exists():
            self.skipTest("dist/server.cjs not built yet")
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except Exception:
                    p.kill()
            if p.stdout:
                try:
                    p.stdout.close()
                except Exception:
                    pass
        # Ensure loopback memory service spawned by server.cjs is stopped cleanly
        self._kill_port_listener(8765)
        self._kill_port_listener(3000)
        shutil.rmtree(self.mem_dir, ignore_errors=True)
        shutil.rmtree(self.cfg_dir, ignore_errors=True)

    def _kill_port_listener(self, port: int):
        try:
            out = subprocess.check_output(["netstat", "-ano"], text=True, stderr=subprocess.DEVNULL)
            for line in out.splitlines():
                if f"127.0.0.1:{port}" in line and "LISTENING" in line:
                    pid = int(line.strip().split()[-1])
                    if pid > 4:
                        subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"], capture_output=True)
        except Exception:
            pass

    def _start_node_server(self, mem_port: int):
        env = {
            **os.environ,
            "NODE_ENV": "production",
            "ERA_MEMORY_DIR": self.mem_dir,
            "ERA_CONFIG_DIR": self.cfg_dir,
            "ERA_MEMORY_API_PORT": str(mem_port),
            "GEMINI_API_KEY": "",  # force offline / no-cloud test
        }
        p = subprocess.Popen(
            ["node", str(self.server_bundle)],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.procs.append(p)
        deadline = time.time() + 15.0
        while time.time() < deadline:
            try:
                st, b = _http_json("http://127.0.0.1:3000/api/memory/health", timeout=1.0)
                if st == 200 and b.get("status") == "ok":
                    return p
            except Exception:
                pass
            time.sleep(0.25)
        raise AssertionError("Node + Memory server did not become healthy within 15s")

    def test_node_python_restart_and_offline_recall(self):
        self._kill_port_listener(3000)
        mem_port = _free_port()

        # Boot 1: store facts + multi-session turns
        p1 = self._start_node_server(mem_port)
        try:
            st, r1 = _http_json(
                "http://127.0.0.1:3000/api/memory/remember",
                "POST",
                {"text": "My name is Shavan and I am building ERA with FastAPI and SQLite.", "sessionId": "e2e-s1"},
            )
            self.assertEqual(st, 200)
            self.assertTrue(r1["success"])

            st, r2 = _http_json(
                "http://127.0.0.1:3000/api/memory/remember",
                "POST",
                {"text": "I live in Mathura and my secret codename is ZEBRAFISH-E2E.", "sessionId": "e2e-s1"},
            )
            self.assertEqual(st, 200)
            self.assertTrue(r2["success"])

            # Voice session summary endpoint works offline too
            st, vs = _http_json(
                "http://127.0.0.1:3000/api/memory/voice-session-summary",
                "POST",
                {
                    "userEmail": "boss@era.local",
                    "sessionId": "e2e-voice-1",
                    "sessionTranscripts": [
                        {"sender": "user", "text": "I moved to Delhi today."},
                        {"sender": "model", "text": "Noted boss, I have updated your location to Delhi."},
                    ],
                },
            )
            self.assertEqual(st, 200)
            self.assertTrue(vs["success"])
            self.assertIn("Delhi", vs["updatedMemory"])

            st, bk = _http_json("http://127.0.0.1:3000/api/memory/backup", "POST", {"label": "e2e"})
            self.assertEqual(st, 200)
            self.assertTrue(bk["success"])
        finally:
            p1.terminate()
            p1.wait(timeout=5)
            if p1.stdout:
                p1.stdout.close()
            self._kill_port_listener(mem_port)

        # Boot 2 (completely fresh Node + Python processes on SAME disk DB, offline)
        mem_port_2 = _free_port()
        p2 = self._start_node_server(mem_port_2)
        try:
            st, prof = _http_json("http://127.0.0.1:3000/api/memory/profile")
            self.assertEqual(st, 200)
            self.assertEqual(prof["health"]["status"], "ok")
            self.assertIn("Shavan", prof["formattedSummary"])
            self.assertIn("Delhi", prof["formattedSummary"])

            # Offline chatbot fallback recalls connected memories across restart
            st, chat = _http_json(
                "http://127.0.0.1:3000/api/chatbot",
                "POST",
                {"message": "what am I building and what is my name?", "sessionId": "e2e-s2"},
            )
            self.assertEqual(st, 200)
            self.assertTrue(chat["success"])
            self.assertIn("Shavan", chat["text"])
            self.assertIn("ERA", chat["text"])

            # History search finds old superseded location (Mathura)
            st, srch = _http_json(
                "http://127.0.0.1:3000/api/memory/search",
                "POST",
                {"query": "where did I live before Mathura", "includeHistory": True},
            )
            self.assertEqual(st, 200)
            contents = " ".join(x["memory"]["content"] for x in srch["results"])
            self.assertIn("Mathura", contents)

            # Backup + restore check over HTTP
            st, bks = _http_json("http://127.0.0.1:3000/api/memory/backups")
            self.assertEqual(st, 200)
            self.assertTrue(len(bks["backups"]) >= 1)
            bk_id = bks["backups"][0]["id"]
            st, rst = _http_json(
                "http://127.0.0.1:3000/api/memory/restore",
                "POST",
                {"backupId": bk_id, "confirm": True},
            )
            self.assertEqual(st, 200)
            self.assertTrue(rst["success"])
        finally:
            p2.terminate()
            out_log, _ = p2.communicate(timeout=5)
            if p2.stdout:
                p2.stdout.close()
            self._kill_port_listener(mem_port_2)
            # Confirm server logs never leak memory content
            self.assertNotIn("ZEBRAFISH-E2E", out_log)


if __name__ == "__main__":
    unittest.main()
