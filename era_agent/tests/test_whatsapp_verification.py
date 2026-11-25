"""Regression tests for WhatsApp Desktop delivery verification and honest error reporting."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from era_agent.commands import system_commands as sc


class _FakePyAutoGUI:
    FAILSAFE = False

    def __init__(self) -> None:
        self.events = []

    def click(self, x, y) -> None:
        self.events.append(("click", x, y))

    def hotkey(self, *keys) -> None:
        self.events.append(("hotkey", keys))

    def press(self, key) -> None:
        self.events.append(("press", key))


class TestWhatsAppVerification(unittest.TestCase):
    def setUp(self) -> None:
        sc._wa_dedup_cache.clear()
        self.fake_pg = _FakePyAutoGUI()

    def _base_patches(self):
        return [
            patch.object(sc, "_attach_winsta", return_value=None),
            patch.object(sc, "_is_whatsapp_desktop_installed", return_value=True),
            patch.object(sc, "_launch_windows_target", return_value=True),
            patch.object(sc, "_record_whatsapp_chat_log"),
            patch.object(sc, "_auto_learn_whatsapp_contact"),
            patch.object(sc, "_read_windows_clipboard", return_value="prev_clip"),
            patch.object(sc, "_copy_to_windows_clipboard", return_value=True),
            patch.object(sc, "time") if False else patch("time.sleep", return_value=None),
            patch("os.startfile", return_value=None, create=True),
            patch.dict(sys.modules, {"pyautogui": self.fake_pg}),
        ]

    def test_fails_honestly_when_whatsapp_window_never_focuses(self) -> None:
        """If WhatsApp opens in background / splash fails foreground check, never report sent."""
        with (
            patch.object(sc, "_attach_winsta"),
            patch.object(sc, "_is_whatsapp_desktop_installed", return_value=True),
            patch.object(sc, "_wait_for_whatsapp_window", return_value=None),
            patch.object(sc, "_record_whatsapp_chat_log") as mock_log,
            patch("os.startfile", return_value=None, create=True),
        ):
            res = sc.open_whatsapp(phone="918650685881", contactName="Bhaiya", message="Test msg")
        self.assertFalse(res.success)
        self.assertIn("NOT sent", res.message)
        mock_log.assert_not_called()
        self.assertEqual(sc._wa_dedup_cache, {})

    def test_fails_honestly_when_whatsapp_is_locked_or_logged_out(self) -> None:
        """Lock/QR screen must immediately fail instead of pressing Enter blindly."""
        with (
            patch.object(sc, "_attach_winsta"),
            patch.object(sc, "_is_whatsapp_desktop_installed", return_value=True),
            patch.object(sc, "_wait_for_whatsapp_window", return_value=12345),
            patch.object(sc, "_ensure_whatsapp_foreground", return_value=12345),
            patch.object(sc, "_inspect_whatsapp_uia", return_value={"ok": True, "lockedOrLoggedOut": True}),
            patch.object(sc, "_send_whatsapp_enter") as mock_enter,
            patch.object(sc, "_record_whatsapp_chat_log") as mock_log,
            patch.object(sc, "_read_windows_clipboard", return_value=""),
            patch.object(sc, "_copy_to_windows_clipboard", return_value=True),
            patch("os.startfile", return_value=None, create=True),
            patch.dict(sys.modules, {"pyautogui": self.fake_pg}),
        ):
            res = sc.open_whatsapp(phone="918650685881", contactName="Bhaiya", message="Hello")
        self.assertFalse(res.success)
        self.assertIn("locked", res.message.lower())
        mock_enter.assert_not_called()
        mock_log.assert_not_called()

    def test_fails_honestly_when_no_composer_ever_appears_on_home_screen(self) -> None:
        """Reproduces user bug: WhatsApp opens home screen without opening chat -> must fail honestly."""
        fake_time = [0.0]

        def _fake_time() -> float:
            fake_time[0] += 2.5
            return fake_time[0]

        with (
            patch.object(sc, "_attach_winsta"),
            patch.object(sc, "_is_whatsapp_desktop_installed", return_value=True),
            patch.object(sc, "_wait_for_whatsapp_window", return_value=12345),
            patch.object(sc, "_ensure_whatsapp_foreground", return_value=12345),
            patch.object(
                sc,
                "_inspect_whatsapp_uia",
                return_value={"ok": True, "hasChatComposer": False, "noResultsFound": True},
            ),
            patch.object(sc, "_send_whatsapp_enter") as mock_enter,
            patch.object(sc, "_record_whatsapp_chat_log") as mock_log,
            patch.object(sc, "_read_windows_clipboard", return_value=""),
            patch.object(sc, "_copy_to_windows_clipboard", return_value=True),
            patch("time.sleep", return_value=None),
            patch("time.time", side_effect=_fake_time),
            patch("os.startfile", return_value=None, create=True),
            patch.dict(sys.modules, {"pyautogui": self.fake_pg}),
        ):
            res = sc.open_whatsapp(phone="918650685881", contactName="Bhaiya", message="Shivani didi call nahi utha rahi")
        self.assertFalse(res.success)
        self.assertIn("NOT sent", res.message)
        mock_enter.assert_not_called()
        mock_log.assert_not_called()

        # Verify failed attempt did NOT poison dedup cache for an immediate retry
        self.assertEqual(sc._wa_dedup_cache, {})

    def test_recovers_dropped_deeplink_text_by_pasting_and_verifies_clear_on_send(self) -> None:
        """If whatsapp://send opens chat without pre-filling &text=, paste text, verify present, send, and verify clear."""
        composer_state = [""]

        def _uia(_hwnd):
            return {
                "ok": True,
                "hasChatComposer": True,
                "composerRect": [400, 700, 1000, 750],
                "composerText": composer_state[0],
                "hasSendButton": True,
                "sendButtonRect": [1010, 700, 1050, 750],
            }

        def _fake_read_current(_hwnd, _cx, _cy, cached_ui=None):
            if cached_ui and cached_ui.get("composerText"):
                return cached_ui["composerText"]
            return composer_state[0]

        def _fake_hotkey(*keys):
            self.fake_pg.hotkey(*keys)
            if keys == ("ctrl", "v"):
                composer_state[0] = "Shivani didi call nahi utha rahi"

        def _fake_send_enter():
            if composer_state[0]:
                composer_state[0] = ""
            return True

        fake_pg = _FakePyAutoGUI()
        fake_pg.hotkey = _fake_hotkey  # type: ignore[method-assign]

        fake_t = [0.0]

        def _ft():
            fake_t[0] += 0.6
            return fake_t[0]

        with (
            patch.object(sc, "_attach_winsta"),
            patch.object(sc, "_is_whatsapp_desktop_installed", return_value=True),
            patch.object(sc, "_wait_for_whatsapp_window", return_value=12345),
            patch.object(sc, "_ensure_whatsapp_foreground", return_value=12345),
            patch.object(sc, "_is_whatsapp_foreground", return_value=True),
            patch.object(sc, "_inspect_whatsapp_uia", side_effect=_uia),
            patch.object(sc, "_read_current_composer_text", side_effect=_fake_read_current),
            patch.object(sc, "_send_whatsapp_enter", side_effect=_fake_send_enter),
            patch.object(sc, "_record_whatsapp_chat_log") as mock_log,
            patch.object(sc, "_read_windows_clipboard", return_value=""),
            patch.object(sc, "_copy_to_windows_clipboard", return_value=True),
            patch("time.sleep", return_value=None),
            patch("time.time", side_effect=_ft),
            patch("os.startfile", return_value=None, create=True),
            patch.dict(sys.modules, {"pyautogui": fake_pg}),
        ):
            res = sc.open_whatsapp(phone="918650685881", contactName="Bhaiya", message="Shivani didi call nahi utha rahi")

        self.assertTrue(res.success)
        self.assertIn("verified sent", res.message.lower())
        mock_log.assert_called_once_with("Bhaiya", "Shivani didi call nahi utha rahi")

    def test_fails_honestly_if_message_stays_stuck_in_draft_box_after_send(self) -> None:
        """If Enter and Send button both fail to clear the composer, report failure instead of lying."""
        fake_t = [0.0]

        def _ft():
            fake_t[0] += 0.6
            return fake_t[0]

        with (
            patch.object(sc, "_attach_winsta"),
            patch.object(sc, "_is_whatsapp_desktop_installed", return_value=True),
            patch.object(sc, "_wait_for_whatsapp_window", return_value=12345),
            patch.object(sc, "_ensure_whatsapp_foreground", return_value=12345),
            patch.object(sc, "_is_whatsapp_foreground", return_value=True),
            patch.object(
                sc,
                "_inspect_whatsapp_uia",
                return_value={
                    "ok": True,
                    "hasChatComposer": True,
                    "composerRect": [400, 700, 1000, 750],
                    "composerText": "Shivani didi call nahi utha rahi",
                    "hasSendButton": True,
                    "sendButtonRect": [1010, 700, 1050, 750],
                },
            ),
            patch.object(sc, "_read_current_composer_text", return_value="Shivani didi call nahi utha rahi"),
            patch.object(sc, "_send_whatsapp_enter", return_value=True),
            patch.object(sc, "_record_whatsapp_chat_log") as mock_log,
            patch.object(sc, "_read_windows_clipboard", return_value=""),
            patch.object(sc, "_copy_to_windows_clipboard", return_value=True),
            patch("time.sleep", return_value=None),
            patch("time.time", side_effect=_ft),
            patch("os.startfile", return_value=None, create=True),
            patch.dict(sys.modules, {"pyautogui": self.fake_pg}),
        ):
            res = sc.open_whatsapp(phone="918650685881", contactName="Bhaiya", message="Shivani didi call nahi utha rahi")

        self.assertFalse(res.success)
        self.assertIn("draft box", res.message.lower())
        mock_log.assert_not_called()

    def test_scenario_b_fails_honestly_on_no_search_results(self) -> None:
        """Contact search returning 'No chats, contacts or messages found' must fail cleanly."""
        with (
            patch.object(sc, "_attach_winsta"),
            patch.object(sc, "_is_whatsapp_desktop_installed", return_value=True),
            patch.object(sc, "_lookup_contact_phone", return_value=None),
            patch.object(sc, "_find_whatsapp_hwnd_and_rect", return_value=(12345, (0, 0, 1200, 800))),
            patch.object(sc, "_is_window_cloaked", return_value=False),
            patch.object(sc, "_ensure_whatsapp_foreground", return_value=12345),
            patch.object(
                sc,
                "_inspect_whatsapp_uia",
                side_effect=[
                    {"ok": True, "lockedOrLoggedOut": False, "searchBoxRect": [50, 80, 300, 115]},
                    {"ok": True, "noResultsFound": True},
                ],
            ),
            patch.object(sc, "_record_whatsapp_chat_log") as mock_log,
            patch.object(sc, "_copy_to_windows_clipboard", return_value=True),
            patch("ctypes.windll.user32.IsWindowVisible", return_value=1),
            patch("time.sleep", return_value=None),
            patch.dict(sys.modules, {"pyautogui": self.fake_pg}),
        ):
            res = sc.open_whatsapp(phone="NonExistentContactXYZ", message="Hello")

        self.assertFalse(res.success)
        self.assertIn("matched", res.message.lower())
        mock_log.assert_not_called()


if __name__ == "__main__":
    unittest.main()
