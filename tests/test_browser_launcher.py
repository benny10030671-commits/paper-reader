import importlib.util
import io
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "native-host" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host, installer = load("host"), load("install")


class BrowserLauncherTests(unittest.TestCase):
    def test_binary_protocol_and_limits(self):
        value = {"ok": False, "error": "繁體中文\n錯誤"}
        stream = io.BytesIO()
        host.write_message(stream, value)
        self.assertEqual(host.read_message(io.BytesIO(stream.getvalue())), value)
        for invalid in (b"", b"\x01", struct.pack("=I", 5000), struct.pack("=I", 5) + b"{}"):
            with self.assertRaises(ValueError):
                host.read_message(io.BytesIO(invalid))

    def test_only_fixed_action_and_valid_port_are_accepted(self):
        self.assertEqual(host.validate_request({"action": "ensure-running", "port": 8791}), 8791)
        for value in ({"action": "run", "port": 8791}, {"action": "ensure-running", "port": 8791, "command": "anything"}, [],
                      *({"action": "ensure-running", "port": p} for p in (True, 0, 65536, 1.5, "8791"))):
            with self.assertRaises(ValueError):
                host.validate_request(value)

    def test_installer_pins_origin_and_interpreter_and_requires_valid_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "reader ! & % 測試"
            manifest = installer.prepare(["a" * 32], root, Path("C:/Python Folder/python.exe"))
            config = json.loads(manifest.read_text())
            self.assertEqual(config["allowed_origins"], ["chrome-extension://" + "a" * 32 + "/"])
            wrapper = Path(config["path"]).read_text(encoding="utf-8")
            self.assertIn('"C:', wrapper)
            self.assertIn("DisableDelayedExpansion", wrapper)
            self.assertIn("%%", wrapper)
            with patch.object(host, "INSTALL_DIR", manifest.parent):
                self.assertTrue(host.allowed_origin(config["allowed_origins"][0]))
                self.assertFalse(host.allowed_origin("https://example.com/"))
            with self.assertRaises(ValueError):
                installer.prepare(["../invalid"], root)

    def test_running_reader_is_not_restarted(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(host, "INSTALL_DIR", Path(tmp)), \
             patch.object(host, "reader_ready", return_value=True), patch.object(host.subprocess, "Popen") as launch:
            self.assertEqual(host.ensure_running(8791), {"ok": True, "port": 8791, "started": False})
            launch.assert_not_called()

    def test_occupied_port_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(host, "INSTALL_DIR", Path(tmp)), \
             patch.object(host, "reader_ready", return_value=False), patch.object(host, "port_in_use", return_value=True), \
             patch.object(host.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(RuntimeError, "佔用"):
                host.ensure_running(8791)
            launch.assert_not_called()

    def test_real_host_starts_reader_once_and_reader_survives_host_exit(self):
        # Separate checkout/data/port: never stop or write to the user's reader.
        with tempfile.TemporaryDirectory(prefix="reader-launch-", ignore_cleanup_errors=True) as tmp:
            root = Path(tmp) / "論文 reader"
            (root / "native-host").mkdir(parents=True)
            shutil.copyfile(ROOT / "native-host" / "host.py", root / "native-host" / "host.py")
            shutil.copyfile(ROOT / "server.py", root / "server.py")
            manifest = installer.prepare(["a" * 32], root)
            origin = "chrome-extension://" + "a" * 32 + "/"
            wrapper = json.loads(manifest.read_text())["path"]
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            packet = io.BytesIO()
            host.write_message(packet, {"action": "ensure-running", "port": port})
            env = {**os.environ, "PAPER_READER_DATA": str(root / "data"), "PYTHONUTF8": "1"}
            if os.name == "nt":
                command = f'"{os.environ["COMSPEC"]}" /d /s /c ""{wrapper}" {origin}"'
                options = {"creationflags": subprocess.CREATE_NO_WINDOW}
            else:
                command, options = [sys.executable, str(root / "native-host" / "host.py"), origin], {}
            processes, replies = [], []
            try:
                for _ in range(2):
                    processes.append(subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, **options))
                # Feed both before waiting: overlapping clicks must share one server.
                for process in processes:
                    process.stdin.write(packet.getvalue())
                    process.stdin.close()
                    process.stdin = None
                for process in processes:
                    output, errors = process.communicate(timeout=30)
                    self.assertEqual(process.returncode, 0, errors.decode(errors="replace"))
                    reply = host.read_message(io.BytesIO(output))
                    replies.append(reply)
                    self.assertTrue(reply["ok"], reply)
                self.assertEqual(sum(reply["started"] for reply in replies), 1)
                self.assertTrue(host.reader_ready(port), "Reader must remain running after both native hosts exit")
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=5)
                for reply in replies:
                    if reply.get("started") and reply.get("pid"):
                        os.kill(reply["pid"], signal.SIGTERM)
                deadline = time.monotonic() + 5
                while host.port_in_use(port) and time.monotonic() < deadline:
                    time.sleep(0.1)


if __name__ == "__main__":
    unittest.main()
