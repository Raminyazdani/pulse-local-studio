"""Cold double-launch readiness without starting a server or another writer."""
from __future__ import annotations

from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import portable_runtime as launcher


class FakeClock:
    def __init__(self):
        self.now = 0.

    def monotonic(self):
        return self.now

    def sleep(self, duration):
        self.now += duration


class PortableWorkspaceWaitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pulse-launch-readiness-")
        self.addCleanup(self.temporary.cleanup)
        self.record = Path(self.temporary.name) / "server.json"
        self.record.write_text(json.dumps({"port": 8877, "pid": 123, "token": "test-token"}), "utf-8")
        self.key = "fixture-workspace"

    def run_wait(self, read_health, timeout=45):
        clock = FakeClock()
        with patch.object(launcher.time, "monotonic", side_effect=clock.monotonic), \
                patch.object(launcher.time, "sleep", side_effect=clock.sleep), \
                patch.object(launcher, "local_json", side_effect=lambda url, **kwargs: read_health(clock, url, kwargs)):
            result = launcher.wait_existing_workspace(self.record, self.key, timeout)
        return result, clock

    def test_cold_owner_that_becomes_ready_after_the_old_15_second_limit_is_reused(self):
        for ready_at in (18, 30):
            with self.subTest(ready_at=ready_at):
                def health(clock, url, options):
                    self.assertEqual(url, "http://127.0.0.1:8877/api/health")
                    self.assertLessEqual(options["timeout"], 1.5)
                    if clock.now < ready_at:
                        raise OSError("Owner is still importing NumPy/SciPy")
                    return {"ok": True, "portable": True, "workspaceKey": self.key}

                before = self.record.read_bytes()
                result, clock = self.run_wait(health)
                self.assertEqual(result, "http://127.0.0.1:8877")
                self.assertGreaterEqual(clock.now, ready_at)
                self.assertLess(clock.now, 45)
                self.assertEqual(self.record.read_bytes(), before)

    def test_wrong_workspace_nonportable_or_unhealthy_response_never_gets_reused(self):
        for response in ({"ok": True, "portable": True, "workspaceKey": "another-folder"},
                         {"ok": True, "portable": False, "workspaceKey": self.key},
                         {"ok": False, "portable": True, "workspaceKey": self.key},
                         {"portable": True, "workspaceKey": self.key}, []):
            with self.subTest(response=response):
                result, clock = self.run_wait(lambda *_args: response, timeout=2)
                self.assertIsNone(result)
                self.assertAlmostEqual(clock.now, 2)

    def test_health_request_time_is_bounded_by_remaining_monotonic_deadline(self):
        def health(clock, _url, options):
            self.assertGreater(options["timeout"], 0)
            self.assertLessEqual(options["timeout"], min(1.5, 2 - clock.now))
            clock.now += options["timeout"]
            raise OSError("Cold or stalled local response")

        result, clock = self.run_wait(health, timeout=2)
        self.assertIsNone(result)
        self.assertAlmostEqual(clock.now, 2)

    def test_missing_malformed_or_invalid_runtime_record_is_never_written_or_probed(self):
        for content in (None, "not JSON", "[]", '{"port":true}', '{"port":80}', '{"port":70000}', '{"port":"8877"}'):
            with self.subTest(content=content):
                self.record.unlink(missing_ok=True)
                if content is not None:
                    self.record.write_text(content, "utf-8")
                result, clock = self.run_wait(lambda *_args: self.fail("Malformed record must not make a health request"), timeout=.4)
                self.assertIsNone(result)
                self.assertAlmostEqual(clock.now, .4)
                self.assertEqual(self.record.read_text("utf-8") if self.record.exists() else None, content)

    def test_mutex_loser_only_reuses_ready_owner_without_starting_or_writing(self):
        data = (Path(self.temporary.name) / "workspace").resolve()
        runtime = data / "runtime"
        runtime.mkdir(parents=True)
        record = runtime / "server.json"
        record.write_text(self.record.read_text("utf-8"), "utf-8")
        before = record.read_bytes()
        key = hashlib.sha256(str(data.resolve()).casefold().encode("utf-8")).hexdigest()[:24]
        for ready in ("http://127.0.0.1:8877", None):
            with self.subTest(ready=ready), ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, {}, clear=False))
                stack.enter_context(patch.object(launcher.sys, "argv", ["Pulse.exe", "--no-browser", "--data-dir", str(data)]))
                stack.enter_context(patch.object(launcher, "local_json", side_effect=OSError("Starting")))
                mutex = stack.enter_context(patch.object(launcher, "acquire_workspace_mutex", return_value=False))
                wait = stack.enter_context(patch.object(launcher, "wait_existing_workspace", return_value=ready))
                listen = stack.enter_context(patch.object(launcher.socket, "socket"))
                browser = stack.enter_context(patch.object(launcher.webbrowser, "open"))
                notify = stack.enter_context(patch.object(launcher, "notify"))
                stack.enter_context(patch.object(launcher.logging, "basicConfig"))
                self.assertEqual(launcher.main(), 0 if ready else 1)
                mutex.assert_called_once_with(key)
                wait.assert_called_once_with(record, key)
                listen.assert_not_called()
                browser.assert_not_called()
                self.assertEqual(record.read_bytes(), before)
                if ready:
                    notify.assert_not_called()
                else:
                    self.assertIn("already starting", notify.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
