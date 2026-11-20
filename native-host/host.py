"""On-demand Chrome native host. Accepts one fixed launch action, never commands."""
from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INSTALL_DIR = ROOT / ".browser-launcher"
HOST_NAME = "com.paper_reader.launcher"
MAX_MESSAGE_BYTES = 4096


def read_message(stream):
    header = stream.read(4)
    if len(header) != 4:
        raise ValueError("啟動訊息不完整。")
    length = struct.unpack("=I", header)[0]
    if not 0 < length <= MAX_MESSAGE_BYTES:
        raise ValueError("啟動訊息長度不正確。")
    payload = stream.read(length)
    if len(payload) != length:
        raise ValueError("啟動訊息不完整。")
    return json.loads(payload.decode("utf-8"))


def write_message(stream, value):
    payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("=I", len(payload)) + payload)
    stream.flush()


def validate_request(message):
    if not isinstance(message, dict) or set(message) != {"action", "port"} or message["action"] != "ensure-running":
        raise ValueError("不支援的啟動要求。")
    port = message["port"]
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("連接埠必須介於 1024 與 65535。")
    return port


def allowed_origin(origin):
    try:
        manifest = json.loads((INSTALL_DIR / f"{HOST_NAME}.json").read_text(encoding="utf-8"))
        return origin in manifest["allowed_origins"]
    except (OSError, ValueError, KeyError):
        return False


def reader_ready(port):
    # Loopback must not go through the user's HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = f"http://127.0.0.1:{port}"
    try:
        try:
            with opener.open(base + "/api/health", timeout=0.7) as response:
                value = json.loads(response.read(65536))
                return isinstance(value, dict) and value.get("app") == "paper-reader"
        except urllib.error.HTTPError as error:
            if error.code != 404:
                return False
            # Reuse older readers too; never interrupt a running AI job.
            with opener.open(base + "/api/settings", timeout=0.7) as response:
                value = json.loads(response.read(65536))
                return (isinstance(value, dict) and isinstance(value.get("data_dir"), str)
                        and isinstance(value.get("models"), list) and isinstance(value.get("tasks"), list))
    except (OSError, ValueError):
        return False


def port_in_use(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


@contextmanager
def launch_lock(port, timeout=25):
    """Serialize simultaneous clicks across Chrome's separate host processes."""
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    with (INSTALL_DIR / f"launch-{port}.lock").open("a+b") as lock:
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        deadline = time.monotonic() + timeout
        while True:
            lock.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("論文伴讀仍在啟動，請稍後按「重試」。")
                time.sleep(0.2)
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def ensure_running(port, timeout=20):
    with launch_lock(port):
        if reader_ready(port):
            return {"ok": True, "port": port, "started": False}
        if port_in_use(port):
            raise RuntimeError(f"連接埠 {port} 已被其他程式佔用，請在連線設定選擇其他連接埠。")
        env = os.environ.copy()
        env.update(PYTHONUTF8="1", PAPER_READER_PORT=str(port))
        # Chrome may have been opened before Claude was added to the PATH.
        env["PATH"] = str(Path.home() / ".local" / "bin") + os.pathsep + env.get("PATH", "")
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
        with (INSTALL_DIR / "reader.log").open("ab") as log:
            process = subprocess.Popen(
                [sys.executable, str(ROOT / "server.py"), "--no-browser", "--strict-port"],
                cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                close_fds=True, **options,
            )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if reader_ready(port):
                return {"ok": True, "port": port, "started": True, "pid": process.pid}
            if process.poll() is not None:
                raise RuntimeError("論文伴讀啟動失敗，請確認 Python 與 PyMuPDF 已安裝；詳細原因記錄在 .browser-launcher/reader.log。")
            time.sleep(0.2)
        raise RuntimeError("論文伴讀啟動時間較長，請稍後按「重試」。")


def main():
    if os.name == "nt":
        import msvcrt
        for stream in (sys.stdin, sys.stdout):
            msvcrt.setmode(stream.fileno(), os.O_BINARY)
    try:
        if len(sys.argv) < 2 or not allowed_origin(sys.argv[1]):
            raise ValueError("這個擴充功能尚未登記，請重新安裝自動啟動元件。")
        port = validate_request(read_message(sys.stdin.buffer))
        result = ensure_running(port)
    except Exception as error:
        result = {"ok": False, "error": str(error)}
    write_message(sys.stdout.buffer, result)


if __name__ == "__main__":
    main()
