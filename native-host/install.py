"""Register this checkout's on-demand launcher for one Windows user."""
import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST_NAME = "com.paper_reader.launcher"
REGISTRY_KEY = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"


def prepare(extension_ids, root=ROOT, python=sys.executable):
    if not extension_ids or any(not re.fullmatch(r"[a-p]{32}", item) for item in extension_ids):
        raise ValueError("請貼上 Chrome 顯示的 32 個小寫英文字母識別碼（a 到 p）。")
    directory = root / ".browser-launcher"
    directory.mkdir(parents=True, exist_ok=True)
    wrapper = directory / "host.cmd"
    # Quotes protect spaces and shell metacharacters; %% preserves literal % in
    # Windows paths, and delayed expansion stays disabled for literal !.
    quote = lambda value: '"' + str(value).replace('%', '%%') + '"'
    wrapper.write_text(
        '@echo off\nsetlocal DisableDelayedExpansion\nchcp 65001 >nul\n'
        + quote(python) + ' ' + quote(root / 'native-host' / 'host.py') + ' %*\n',
        encoding="utf-8", newline="\r\n",
    )
    manifest = directory / f"{HOST_NAME}.json"
    manifest.write_text(json.dumps({
        "name": HOST_NAME, "description": "Start the local Paper Reader on demand",
        "path": str(wrapper), "type": "stdio",
        "allowed_origins": [f"chrome-extension://{item}/" for item in dict.fromkeys(extension_ids)],
    }, indent=2), encoding="utf-8")
    return manifest


def register(manifest):
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest))


def uninstall():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY) as key:
            installed = winreg.QueryValueEx(key, "")[0]
        expected = ROOT / ".browser-launcher" / f"{HOST_NAME}.json"
        if Path(installed).resolve() != expected.resolve():
            raise ValueError("登記的是另一份論文伴讀，請從那個資料夾解除安裝。")
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY)
    except FileNotFoundError:
        pass


def main():
    parser = argparse.ArgumentParser(description="安裝論文伴讀的 Chrome 自動啟動元件（不需管理員權限）")
    parser.add_argument("--extension-id", action="append", help="Chrome 擴充功能識別碼，可重複指定")
    parser.add_argument("--prepare-only", action="store_true", help="只準備檔案，不登記到 Windows")
    parser.add_argument("--uninstall", action="store_true", help="解除本資料夾的自動啟動登記，保留書庫")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("此安裝程式目前支援 Windows。")
    try:
        if args.uninstall:
            uninstall()
            print("已解除自動啟動登記。書庫與桌面捷徑保留。")
            return
        import pymupdf  # Verify this exact interpreter can run the reader.
        extension_ids = args.extension_id or [input("請貼上 Chrome 論文伴讀擴充功能的識別碼：").strip()]
        manifest = prepare(extension_ids)
        if not args.prepare_only:
            register(manifest)
        print("自動啟動元件檔案：" + str(manifest))
        print("準備完成，尚未登記。" if args.prepare_only else "安裝完成！請重新載入 Chrome 擴充功能，之後點選 PDF 即可自動啟動。")
    except Exception as error:
        print("安裝失敗：" + str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
