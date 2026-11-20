"""論文伴讀 (paper-reader) — a local, single-user Moonlight-style paper reader.

Serves a PDF reader UI on 127.0.0.1 only. AI features (summary, translation,
explanations, chat, quiz, auto-highlight, references) run through the local
`claude` CLI in headless mode, so no API key is needed.

Run:  python server.py            (then open http://127.0.0.1:8791)
"""
from __future__ import annotations

import base64
import difflib
import hashlib
import html
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
import urllib.error
import urllib.request
import uuid
import webbrowser
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlparse

import pymupdf

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
# LOCAL is this computer's own folder: settings.json and location.json (which library to use).
# DATA is the library itself (papers/ + library.json): LOCAL by default, or a folder that a
# desktop sync client (OneDrive, Google Drive for desktop…) syncs — see "library location".
LOCAL = Path(os.environ.get("PAPER_READER_DATA", ROOT / "data"))
SETTINGS_FILE = LOCAL / "settings.json"
LOCATION_FILE = LOCAL / "location.json"


def _library_root() -> tuple[Path, str | None]:
    """(library folder, configured folder that is missing right now — e.g. the sync drive is offline)."""
    try:
        want = json.loads(LOCATION_FILE.read_text(encoding="utf-8")).get("library_dir")
    except (FileNotFoundError, json.JSONDecodeError, AttributeError):
        want = None
    if not want:
        return LOCAL, None
    return (Path(want), None) if Path(want).is_dir() else (LOCAL, want)


DATA, LIB_MISSING = _library_root()
PAPERS = DATA / "papers"
PORT = int(os.environ.get("PAPER_READER_PORT", "8791"))

MODELS = [  # ids verified with `claude -p --model <id>` on 2026-09-29
    {"id": "claude-opus-5-5", "label": "Opus 5.5"},
    {"id": "claude-sonnet-5-5", "label": "Sonnet 5.5"},
    {"id": "claude-fable-5-2", "label": "Fable 5.2"},  # verified 2026-11-10 (every effort, incl. "off")
    {"id": "claude-fable-5-1", "label": "Fable 5.1"},
    {"id": "claude-haiku-4-5-20251001", "label": "Haiku 4.5"},
]
MODEL_ALIAS = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5", "haiku": "claude-haiku-4-5-20251001",
               "fable": "claude-fable-5-2"}
# "off" sets MAX_THINKING_TOKENS=0 (no extended thinking); the rest map to `claude --effort <level>`
EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"]
TASKS = ["analysis", "translate", "quick", "explain", "chat", "quiz", "note", "classify"]

DEFAULT_SETTINGS = {
    **{f"model_{t}": "claude-opus-5-5" for t in TASKS},
    # 摘要／關鍵字／自動高亮、版面翻譯、選取翻譯與參考文獻、解釋、對話、測驗、Skill 筆記、書庫分類
    "effort_analysis": "low", "effort_translate": "off", "effort_quick": "off",
    "effort_explain": "low", "effort_chat": "medium", "effort_quiz": "low", "effort_note": "medium",
    "effort_classify": "low",
    "concurrency": 4,             # 背景同時執行的 claude 行程數
    "auto_translate": True,       # 上傳後（摘要完成時）自動在背景翻譯全文
    "auto_classify": True,        # 摘要完成後自動把論文歸入書庫分類
    "vault_dir": str(Path.home() / "Documents" / "PaperBrain" / "paper-reading"),  # 「存到 PaperBrain」的目的地
}

CLAUDE = shutil.which("claude")
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
MAX_CONTEXT_CHARS = 180_000

# Note-writing skills run as full agentic `claude -p` sessions with the skill loaded via --plugin-dir
SKILL_ROOT = Path.home() / ".claude" / "skills"
T2N_REPO = Path(os.environ.get("T2N_REPO") or Path.home() / "Tools" / "textbook-to-note")
T2N_CORPUS = Path(os.environ.get("T2N_OUTPUT_DIR") or T2N_REPO / "output")
DPN_SCRIPTS = SKILL_ROOT / "deeppapernote" / "skills" / "deeppapernote" / "scripts"
DPN_TMP = Path(os.environ.get("DEEPPAPERNOTE_OUTPUT_DIR") or Path.home() / "dpn_tmp")  # short: Windows 260-char paths
NOTE_SKILLS = {
    "dpn": {"label": "DeepPaperNote", "skill": "deeppapernote:deeppapernote",
            "plugin": SKILL_ROOT / "deeppapernote", "subdir": "DeepPaperNote"},
    "t2n": {"label": "textbook-to-note", "skill": "textbook-to-note:textbook-to-note",
            "plugin": SKILL_ROOT / "textbook-to-note", "subdir": "textbook-to-note"},
}
T2N_TEMPLATES = ["auto", "疾病", "藥物", "檢查", "技術", "評估工具", "自由結構"]
AGENT_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,Skill"
AGENT_TIMEOUT = 3 * 3600

SYSTEM_BASE = (
    "你是資深的學術論文伴讀助理，讀者是台灣的臨床醫師研究者。"
    "一律使用繁體中文（台灣用語，例如：資料、品質、網路、軟體、透析、加護病房、隨機分派），"
    "絕對不可使用簡體字或中國大陸用語。醫學用語依台灣習慣，例如：心臟超音波（不說超音波心動圖）、"
    "信賴區間（不說置信區間）、統合分析（不說薈萃分析）、世代研究（不說隊列研究）、族群（不說人群）、"
    "品質（不說質量，但 LV mass 譯為左心室質量）、介入（不說干預）、追蹤（不說隨訪）、終點（不說結局指標）。"
    "專有名詞、藥名、縮寫首次出現時可在括號附英文原文。"
    "只根據提供的論文內容回答；論文沒有寫的內容要明說「論文未提及」，不得捏造數據或引用。"
)


# ---------------------------------------------------------------- utilities

class LLMError(Exception):
    pass


_file_lock = threading.RLock()


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def settings() -> dict:
    s = dict(DEFAULT_SETTINGS)
    s.update(read_json(SETTINGS_FILE, {}) or {})
    for t in TASKS:  # older settings stored bare aliases ("opus")
        s[f"model_{t}"] = MODEL_ALIAS.get(s[f"model_{t}"], s[f"model_{t}"])
        if s[f"effort_{t}"] not in EFFORTS:
            s[f"effort_{t}"] = DEFAULT_SETTINGS[f"effort_{t}"]
    return s


def pdir(pid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", pid or ""):
        raise KeyError(pid)
    d = PAPERS / pid
    if not d.is_dir():
        raise KeyError(pid)
    return d


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# ---------------------------------------------------------------- claude CLI

# Background jobs (full translation, auto-highlight…) and interactive requests (selection
# translate, explain, chat, quiz) draw from separate pools so a running full-paper
# translation never makes a click wait in line.
_bg_slots = threading.BoundedSemaphore(max(1, int(settings()["concurrency"])))
_ui_slots = threading.BoundedSemaphore(3)
_bg_local = threading.local()


def run_claude(prompt: str, system: str, task: str, *, model: str | None = None, effort: str | None = None,
               tools: str | None = None, add_dir: Path | None = None, on_text=None, timeout: int = 900) -> str:
    """Run one headless `claude -p` turn and return the final text.

    Always streams (stream-json) so `on_text` can forward text deltas to the browser.
    `--strict-mcp-config` with an empty config keeps the account's MCP connectors out of the
    process: measured 12k → 0.4k input tokens and ~1.5 s less start-up per call.
    """
    if not CLAUDE:
        raise LLMError("找不到 claude CLI，請確認已安裝並登入 Claude Code。")
    s = settings()
    model = MODEL_ALIAS.get(model or "", model) or s[f"model_{task}"]
    effort = effort if effort in EFFORTS else s[f"effort_{task}"]
    args = [CLAUDE, "-p", "--model", model, "--no-session-persistence", "--setting-sources", "",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--system-prompt", system,
            "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    args += ["--tools", tools, "--allowedTools", tools] if tools else ["--tools", ""]
    if add_dir:
        args += ["--add-dir", str(add_dir)]
    env = dict(os.environ)
    if effort == "off":
        env["MAX_THINKING_TOKENS"] = "0"
    else:
        args += ["--effort", effort]
    result, noise = None, []
    with (_bg_slots if getattr(_bg_local, "on", False) else _ui_slots):
        p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             cwd=str(LOCAL), env=env, creationflags=CREATE_NO_WINDOW)
        timer = threading.Timer(timeout, p.kill)
        timer.start()
        try:
            p.stdin.write(prompt.encode("utf-8"))
            p.stdin.close()
            for raw in p.stdout:
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    noise.append(raw.decode("utf-8", "replace").strip())
                    continue
                kind = ev.get("type")
                if kind == "stream_event" and on_text:
                    e = ev.get("event") or {}
                    if e.get("type") == "content_block_delta" and (e.get("delta") or {}).get("type") == "text_delta":
                        on_text(e["delta"]["text"])
                elif kind == "result":
                    result = ev
            p.wait()
        finally:
            timer.cancel()
    if result is None:
        raise LLMError(f"claude CLI 沒有回傳結果（逾時或中斷）：{' '.join(noise)[:300]}")
    if result.get("is_error"):
        raise LLMError(str(result.get("result") or "claude 回報錯誤")[:400])
    return (result.get("result") or "").strip()


def parse_json(text: str):
    t = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if m:
        t = m.group(1).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    for o, c in (("{", "}"), ("[", "]")):
        i, j = t.find(o), t.rfind(c)
        if i != -1 and j > i:
            try:
                return json.loads(t[i:j + 1])
            except json.JSONDecodeError:
                pass
    raise LLMError("模型沒有回傳可解析的 JSON")


def llm_json(prompt: str, system: str, task: str, retries: int = 1):
    for attempt in range(retries + 1):
        out = run_claude(prompt, system, task)
        try:
            return parse_json(out)
        except LLMError:
            if attempt == retries:
                raise
            prompt += "\n\n（上一次的輸出不是合法 JSON。這次請只輸出 JSON，前後不要有任何其他文字。）"


# ---------------------------------------------------------------- PDF layout

ABBREV = {"e.g.", "i.e.", "al.", "vs.", "Fig.", "Figs.", "fig.", "Eq.", "Eqs.", "Ref.", "Refs.",
          "No.", "approx.", "cf.", "Dr.", "ca.", "Tab.", "Suppl.", "resp.", "Inc.", "Ltd.", "Co.",
          "St.", "Vol.", "pp.", "ed.", "eds.", "Jr.", "Sr.", "Prof.", "Mr.", "Ms.", "U.S.", "min."}
REF_HEAD = re.compile(r"^\s*(references|reference|bibliography|literature cited|參考文獻)\s*$", re.I)


def _join(words: list) -> str:
    """Join PyMuPDF word tuples into text, undoing end-of-line hyphenation."""
    out = ""
    prev = None
    for w in words:
        tok = w[4]
        if prev is None:
            out = tok
        elif (prev[5], prev[6]) != (w[5], w[6]) and re.search(r"[\-­]$", out) and tok[:1].islower():
            out = out[:-1] + tok
        else:
            out += " " + tok
        prev = w
    return out.replace("­", "")


def _union(rects: list) -> list:
    return [round(min(r[0] for r in rects), 2), round(min(r[1] for r in rects), 2),
            round(max(r[2] for r in rects), 2), round(max(r[3] for r in rects), 2)]


def _line_rects(words: list) -> list:
    lines: dict = {}
    for w in words:
        lines.setdefault((w[5], w[6]), []).append(w[:4])
    return [_union(v) for v in lines.values()]


def _sentences(words: list) -> list:
    sents, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        # "haemodialysis.1–3" — a superscript citation glued after the full stop still ends the sentence
        tok = re.sub(r"(?<=[A-Za-z)\]%])([.?!])\d{1,3}(?:[–\-,]\d{1,3})*$", r"\1", w[4])
        tok = tok.rstrip(")]\"'”’")
        nxt = words[i + 1][4] if i + 1 < len(words) else ""
        if (tok.endswith((".", "?", "!")) and tok not in ABBREV
                and not re.fullmatch(r"[A-Z]\.", tok)
                and (not nxt or nxt[:1].isupper() or nxt[:1].isdigit() or nxt[:1] in "([“\"")):
            sents.append(cur)
            cur = []
    if cur:
        sents.append(cur)
    return sents


def build_layout(pdf_path: Path) -> dict:
    doc = pymupdf.open(pdf_path)
    pages, in_refs, sid = [], False, 0
    for pno, page in enumerate(doc):
        words = page.get_text("words")
        groups: dict = {}
        for w in words:
            groups.setdefault(w[5], []).append(w)
        blocks, sents = [], []
        for bno, ws in groups.items():
            text = _join(ws).strip()
            if not text:
                continue
            if REF_HEAD.match(text):
                in_refs = True
            lines = _line_rects(ws)
            heights = sorted(r[3] - r[1] for r in lines)
            blocks.append({"id": f"b{bno}", "bbox": _union(lines), "lh": round(heights[len(heights) // 2], 2),
                           "n": len(lines), "text": text, "ref": in_refs})
            if not in_refs:
                for s in _sentences(ws):
                    st = _join(s).strip()
                    if len(s) >= 6:
                        sents.append({"id": f"s{sid}", "text": st, "rects": _line_rects(s)})
                        sid += 1
        pages.append({"w": round(page.rect.width, 2), "h": round(page.rect.height, 2),
                      "blocks": blocks, "sents": sents})
    return {"pages": pages}


def guess_title(pdf_path: Path, fallback: str) -> str:
    doc = pymupdf.open(pdf_path)
    t = (doc.metadata or {}).get("title") or ""
    if len(t) > 12 and not re.search(r"untitled|microsoft word|\.docx?$|\.pdf$", t, re.I):
        return t.strip()
    try:
        spans = [s for b in doc[0].get_text("dict")["blocks"] for l in b.get("lines", [])
                 for s in l["spans"] if s["text"].strip() and s["bbox"][1] < doc[0].rect.height * 0.6]
        if spans:
            big = max(s["size"] for s in spans)
            title = " ".join(s["text"].strip() for s in spans if s["size"] >= big - 0.6)
            if len(title) > 8:
                return re.sub(r"\s+", " ", title)[:300]
    except Exception:
        pass
    return fallback


def full_text(pid: str) -> str:
    d = pdir(pid)
    cached = d / "fulltext.txt"
    if cached.exists():
        return cached.read_text(encoding="utf-8")
    layout = read_json(d / "layout.json")
    parts = []
    for i, pg in enumerate(layout["pages"]):
        parts.append(f"=== 第 {i + 1} 頁 (p.{i + 1}) ===")
        parts.extend(b["text"] for b in pg["blocks"])
    text = "\n".join(parts)
    cached.write_text(text, encoding="utf-8")
    return text


def context_text(pid: str) -> str:
    t = full_text(pid)
    if len(t) > MAX_CONTEXT_CHARS:
        t = t[:MAX_CONTEXT_CHARS] + "\n…（全文過長，以下截斷）"
    return t


# ---------------------------------------------------------------- jobs

JOBS: dict = {}
_jobs_lock = threading.Lock()
EXEC = ThreadPoolExecutor(max_workers=16)


def job_set(pid: str, name: str, **kw) -> None:
    with _jobs_lock:
        JOBS.setdefault(pid, {}).setdefault(name, {}).update(kw)


def start_job(pid: str, name: str, fn, *args) -> bool:
    with _jobs_lock:
        j = JOBS.setdefault(pid, {}).get(name)
        if j and j.get("status") == "running":
            return False
        JOBS[pid][name] = {"status": "running", "error": None, "progress": None, "started": time.time()}

    def wrap():
        _bg_local.on = True
        try:
            fn(pid, *args)
            job_set(pid, name, status="done")
        except Exception as e:  # noqa: BLE001 — surface every failure to the UI
            traceback.print_exc()
            job_set(pid, name, status="error", error=str(e))

    EXEC.submit(wrap)
    return True


def jobs_of(pid: str) -> dict:
    with _jobs_lock:
        return json.loads(json.dumps(JOBS.get(pid, {})))


# ---------------------------------------------------------------- AI tasks

def task_analyze(pid: str) -> None:
    prompt = f"""以下是一篇學術論文的全文（依頁碼標示）。請產生伴讀資料，只輸出一個 JSON 物件，格式如下：
{{
 "title": "論文原文標題",
 "title_zh": "標題的繁體中文翻譯",
 "meta": {{"authors": "作者（原文，超過三位寫第一作者 et al.）", "authors_full": "全部作者（原文拼寫、依原文順序，以「; 」分隔）", "journal": "期刊或會議名稱", "year": "年份", "volume": "", "pages": "", "doi": "只有全文中明確出現 DOI 才填，否則空字串", "study_type": "研究設計（例如：隨機對照試驗、前瞻性世代研究、系統性回顧與統合分析、綜論、觀點文章）"}},
 "tldr": ["三行摘要第 1 行（開頭放一個貼切的 emoji）", "第 2 行", "第 3 行"],
 "summary": "Markdown 結構化摘要，依序使用小標：### 研究背景與問題、### 方法、### 主要結果、### 結論與臨床意義、### 限制。主要結果要保留關鍵數字（效應量、信賴區間、p 值）並用（p.頁碼）標出處。約 500–900 字。",
 "keywords": [{{"term": "英文術語", "zh": "繁體中文譯名", "definition": "一到兩句繁中解釋它在本文脈絡中的意義"}}],
 "questions": ["讀完這篇值得追問的問題 1", "問題 2", "問題 3"]
}}
keywords 請給 10–15 個本文最核心的術語。

<paper>
{context_text(pid)}
</paper>"""
    data = llm_json(prompt, SYSTEM_BASE, "analysis")
    data["generated"] = now_iso()
    write_json(pdir(pid) / "analysis.json", data)
    meta_path = pdir(pid) / "meta.json"
    with _file_lock:
        meta = read_json(meta_path, {})
        if data.get("title"):
            meta["title"] = data["title"]
        if data.get("title_zh"):
            meta["title_zh"] = data["title_zh"]
        if (data.get("meta") or {}).get("authors_full"):
            meta.update(authors_full=str(data["meta"]["authors_full"])[:2000], authors_checked=True)
        first_time = not meta.get("auto_translated")
        meta["auto_translated"] = True
        write_json(meta_path, meta)
    # translate after the summary so the keyword glossary keeps terms consistent
    if first_time and settings()["auto_translate"]:
        start_job(pid, "translate", task_translate_all, 0)
    if not meta.get("category") and settings()["auto_classify"]:
        start_job(pid, "classify", task_classify_paper)


def _glossary(pid: str) -> str:
    a = read_json(pdir(pid) / "analysis.json") or {}
    kws = [f"{k.get('term')} → {k.get('zh')}" for k in a.get("keywords", []) if k.get("term") and k.get("zh")]
    return "\n".join(kws) if kws else "（無）"


_inflight: set = set()
_inflight_lock = threading.Lock()
PARTIAL: dict = {}  # (pid, page) -> {block_id: zh} while that page is still streaming


class _LineCollector:
    """Turns streamed '[b3] 譯文' lines into {block_id: text}; stray continuation lines join the previous block."""

    def __init__(self, ids: set, sink: dict):
        self.ids, self.sink, self.buf, self.last = ids, sink, "", None

    def feed(self, text: str) -> None:
        self.buf += text
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            self._take(line)

    def close(self) -> None:
        self._take(self.buf)
        self.buf = ""

    def _take(self, line: str) -> None:
        m = re.match(r"\s*\[(b\d+)\]\s?(.*)$", line)
        if m and m.group(1) in self.ids:
            self.last = m.group(1)
            self.sink[self.last] = m.group(2).strip()
        elif line.strip() and self.last:
            self.sink[self.last] = (self.sink[self.last] + line.strip()).strip()


def translate_page(pid: str, pno: int) -> None:
    d = pdir(pid)
    out = d / "trans" / f"p{pno:04d}.json"
    if out.exists():
        return
    with _inflight_lock:
        if (pid, pno) in _inflight:
            return
        _inflight.add((pid, pno))
    try:
        layout = read_json(d / "layout.json")
        blocks = [b for b in layout["pages"][pno]["blocks"] if not b["ref"] and re.search(r"[A-Za-z]{2}", b["text"])]
        result: dict = {}
        if blocks:
            listing = "\n".join(f"[{b['id']}] {b['text']}" for b in blocks)
            prompt = f"""把以下論文第 {pno + 1} 頁的文字區塊翻譯成繁體中文（台灣用語、學術語氣、忠於原文、不增刪內容）。
規則：
- 依原順序，每個區塊輸出一行：「[id] 譯文」。譯文寫在同一行，不可換行；不要輸出任何其他文字。
- 數字、單位、統計值、試驗名稱、引用編號（例如 [6,7] 或上標 1–3）原樣保留。
- 若區塊是純作者名單、機構地址、電子郵件、網址、版權宣告、頁首頁尾、期刊資訊、只有數學式或數字，只輸出「[id]」不接譯文。
- 術語請與此術語表一致：
{_glossary(pid)}

區塊：
{listing}"""
            partial: dict = {}
            PARTIAL[(pid, pno)] = partial
            live = _LineCollector({b["id"] for b in blocks}, partial)
            text = run_claude(prompt, SYSTEM_BASE, "translate", on_text=live.feed)
            final = _LineCollector({b["id"] for b in blocks}, result)  # parse the full text again: authoritative
            final.feed(text + "\n")
            if not result:
                raise LLMError(f"第 {pno + 1} 頁的翻譯輸出格式不符")
        write_json(out, {"page": pno, "t": result, "generated": now_iso()})
    finally:
        PARTIAL.pop((pid, pno), None)
        with _inflight_lock:
            _inflight.discard((pid, pno))


def _as_bg(fn, *args):
    _bg_local.on = True
    return fn(*args)


def task_translate_all(pid: str, start: int = 0) -> None:
    d = pdir(pid)
    n = len(read_json(d / "layout.json")["pages"])
    start = max(0, min(start, n - 1))
    order = list(range(start, n)) + list(range(0, start))
    todo = [p for p in order if not (d / "trans" / f"p{p:04d}.json").exists()]
    done = n - len(todo)
    job_set(pid, "translate", progress=[done, n])
    errors = []
    with ThreadPoolExecutor(max_workers=max(1, int(settings()["concurrency"]))) as ex:
        futs = [ex.submit(_as_bg, translate_page, pid, p) for p in todo]
        for f in futs:
            try:
                f.result()
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))
            done += 1
            job_set(pid, "translate", progress=[done, n])
    if errors:
        raise LLMError(f"{len(errors)} 頁翻譯失敗：{errors[0]}")


HL_CATS = {"novelty": "新穎性", "method": "方法", "result": "結果"}


def task_autohighlight(pid: str) -> None:
    d = pdir(pid)
    layout = read_json(d / "layout.json")
    index, parts = {}, []
    for pno, pg in enumerate(layout["pages"]):
        if not pg["sents"]:
            continue
        parts.append(f"=== p.{pno + 1} ===")
        for s in pg["sents"]:
            index[s["id"]] = (pno, s)
            parts.append(f"[{s['id']}] {s['text']}")
    if not index:
        raise LLMError("這份 PDF 沒有可用的文字層（可能是掃描檔）")
    listing = "\n".join(parts)[:MAX_CONTEXT_CHARS]
    prompt = f"""以下是論文逐句編號的內文。請挑出讀者最該注意的 15–25 句，分成三類：
- novelty：本研究的新穎之處、研究缺口、核心主張
- method：關鍵的研究設計、族群、介入、測量或分析方法
- result：主要結果與結論（優先挑有數字的）
每句附一句繁體中文短評（20 字以內，說明為什麼重要）。
只輸出 JSON：{{"h":[{{"id":"s12","cat":"novelty","note":"……"}}]}}

{listing}"""
    data = llm_json(prompt, SYSTEM_BASE, "analysis")
    out = []
    for it in data.get("h", []) if isinstance(data, dict) else []:
        sid, cat = str(it.get("id")), it.get("cat")
        if sid in index and cat in HL_CATS:
            pno, s = index[sid]
            out.append({"id": sid, "cat": cat, "page": pno, "rects": s["rects"], "text": s["text"],
                        "note": it.get("note", "")})
    out.sort(key=lambda h: (h["page"], h["rects"][0][1] if h["rects"] else 0))
    write_json(d / "autohl.json", {"items": out, "generated": now_iso()})


def task_references(pid: str) -> None:
    d = pdir(pid)
    layout = read_json(d / "layout.json")
    ref_text = "\n".join(b["text"] for pg in layout["pages"] for b in pg["blocks"] if b["ref"])
    if len(ref_text) < 200:  # no heading detected — fall back to the last pages
        ref_text = "\n".join(b["text"] for pg in layout["pages"][-3:] for b in pg["blocks"])
    prompt = f"""以下是一篇論文的參考文獻區段（可能夾雜其他文字）。請擷取每一筆參考文獻，保持原文（不要翻譯），依編號排序。
只輸出 JSON：{{"refs":[{{"n":1,"authors":"第一作者姓 et al.","title":"文章標題","journal":"期刊","year":"2020","doi":"有寫才填"}}]}}
若文獻沒有編號（作者-年份制），n 依出現順序編號。

{ref_text[:120_000]}"""
    data = llm_json(prompt, SYSTEM_BASE, "quick")
    refs = data.get("refs", []) if isinstance(data, dict) else []
    write_json(d / "refs.json", {"refs": refs, "generated": now_iso()})


def _is_heading(b: dict) -> bool:
    t = b["text"].strip()
    return len(t) < 90 and b["n"] <= 2 and not re.search(r"[.。:：]$", t)


def _block_section(pid: str, page: int, bid: str) -> tuple[str, list]:
    """Text of one block; for a heading, the heading plus the paragraphs under it on that page."""
    blocks = read_json(pdir(pid) / "layout.json")["pages"][page]["blocks"]
    idx = next((i for i, b in enumerate(blocks) if b["id"] == bid), None)
    if idx is None:
        raise ValueError("找不到這個段落")
    b = blocks[idx]
    parts = [b["text"]]
    if _is_heading(b):
        for nb in blocks[idx + 1:]:
            if _is_heading(nb) or nb["ref"] or sum(map(len, parts)) > 3000:
                break
            parts.append(nb["text"])
    return "\n".join(parts)[:4000], b["bbox"]


_HEAD_RE = re.compile(r"^\s*(標題|類型)[:：]\s*(.*)$")
_KIND = {"文本": "text", "表格": "table", "數學公式": "formula"}


def explain_text(pid: str, page: int, text: str | None = None, block: str | None = None,
                 anchor: list | None = None, on_text=None) -> dict:
    if block:
        text, anchor = _block_section(pid, page, block)
        where = f"在論文第 {page + 1} 頁點了這個段落（或章節）"
    else:
        where = f"在論文第 {page + 1} 頁選取了下面這段內容"
    prompt = f"""讀者{where}，請在整篇論文的脈絡下解釋。
輸出格式：
第一行：「標題：」加上 15 字以內、點出這段重點的標題（例如：透析範式的轉變）。
第二行：「類型：文本」「類型：表格」或「類型：數學公式」擇一。
第三行起用 Markdown 說明：這段在說什麼、關鍵術語或符號的意思、在本文論證中的角色；表格或公式要逐項說明如何解讀。數學式用 $...$。不要重複貼出原文。

<selection>
{text}
</selection>

<paper>
{context_text(pid)}
</paper>"""
    for attempt in range(2):
        out = run_claude(prompt, SYSTEM_BASE, "explain", on_text=on_text)
        first = out.lstrip().split("\n", 1)[0]
        # A rare degenerate answer (seen once: a few unrelated bullet words) skips the required header
        # and is short — retry once and tell the browser to discard what it streamed.
        if _HEAD_RE.match(first) or len(out) > 400 or attempt:
            break
        if on_text and hasattr(on_text, "reset"):
            on_text.reset()
    title, kind, lines = "", "text", out.splitlines()
    for _ in range(5):  # header lines 標題／類型, possibly separated by blank lines
        if lines and not lines[0].strip():
            lines.pop(0)
            continue
        m = _HEAD_RE.match(lines[0]) if lines else None
        if not m:
            break
        if m.group(1) == "標題":
            title = m.group(2).strip().strip("「」*")
        else:
            kind = _KIND.get(m.group(2).strip().strip("*"), "text")
        lines.pop(0)
    item = {"type": kind, "page": page, "source": text, "title": title, "answer": "\n".join(lines).strip()}
    if anchor:
        item["bbox"] = anchor
    return _save_explanation(pid, item)


def explain_image(pid: str, png_b64: str, page: int, anchor: list | None = None, on_text=None) -> dict:
    d = pdir(pid)
    img_dir = d / "images"
    img_dir.mkdir(exist_ok=True)
    name = f"{int(time.time())}-{uuid.uuid4().hex[:6]}.png"
    (img_dir / name).write_bytes(base64.b64decode(png_b64.split(",")[-1]))
    layout = read_json(d / "layout.json")
    page_text = "\n".join(b["text"] for b in layout["pages"][page]["blocks"])
    prompt = f"""請先用 Read 工具讀取圖片 {img_dir / name}，讀完之前不要輸出任何文字。這是讀者從論文第 {page + 1} 頁框選的區域（可能是圖、表、流程圖或公式）。
第一行輸出「標題：」加上 15 字以內的標題，第二行起用 Markdown 以繁體中文說明：
1. 這是什麼（圖/表的類型與主題）
2. 如何閱讀（座標軸、分組、欄位、圖例、符號）
3. 重點發現（引用圖中的具體數字）
4. 它如何支持論文的主張
下面是同一頁的文字（含圖說），供你對照：
<page_text>
{page_text[:20_000]}
</page_text>"""
    out = run_claude(prompt, SYSTEM_BASE, "explain", tools="Read", add_dir=img_dir, on_text=on_text)
    title, lines = "", out.splitlines()
    if lines and (m := _HEAD_RE.match(lines[0])):
        title = m.group(2).strip().strip("「」*")
        lines.pop(0)
    item = {"type": "image", "page": page, "source": "", "image": name, "title": title,
            "answer": "\n".join(lines).strip()}
    if anchor:
        item["bbox"] = anchor
    return _save_explanation(pid, item)


def _save_explanation(pid: str, item: dict) -> dict:
    item.update({"id": uuid.uuid4().hex[:10], "created": now_iso()})
    path = pdir(pid) / "explanations.json"
    with _file_lock:
        items = read_json(path, [])
        items.insert(0, item)
        write_json(path, items)
    return item


def quick_translate(text: str, on_text=None) -> str:
    prompt = f"""把下面這段論文文字翻成通順的繁體中文（台灣用語），保留數字、統計值與引用編號。只輸出譯文。

{text}"""
    return run_claude(prompt, SYSTEM_BASE, "quick", on_text=on_text)


def chat(pid: str, message: str, model: str | None = None, effort: str | None = None, on_text=None) -> dict:
    path = pdir(pid) / "chat.json"
    history = read_json(path, [])
    recent = history[-12:]
    convo = "\n\n".join(f"{'讀者' if m['role'] == 'user' else '助理'}：{m['content']}" for m in recent)
    prompt = f"""你正在陪讀者讀這篇論文。回答時：
- 用 Markdown，先給直接答案再補充；精簡、具體。
- 引用論文內容時標出頁碼，格式（p.頁碼）。
- 若問題超出論文內容，可以用一般醫學知識補充，但要明確標示「以下為論文外的一般知識」。

<paper>
{context_text(pid)}
</paper>

<conversation>
{convo or '（尚無）'}
</conversation>

讀者的新問題：{message}"""
    s = settings()
    model = MODEL_ALIAS.get(model or "", model) or s["model_chat"]
    effort = effort if effort in EFFORTS else s["effort_chat"]
    answer = run_claude(prompt, SYSTEM_BASE, "chat", model=model, effort=effort, on_text=on_text)
    label = next((m["label"] for m in MODELS if m["id"] == model), model)
    with _file_lock:
        history = read_json(path, [])
        history.append({"role": "user", "content": message, "ts": now_iso()})
        reply = {"role": "assistant", "content": answer, "model": f"{label}・{effort}", "ts": now_iso()}
        history.append(reply)
        write_json(path, history)
    return reply


def make_quiz(pid: str, n: int, difficulty: str) -> dict:
    level = "較難：考細節、數字判讀、研究設計的推論與限制" if difficulty == "hard" else "基本：考核心問題、主要方法與主要結果"
    prompt = f"""根據這篇論文出 {n} 題四選一的選擇題，難度{level}。題目與選項用繁體中文，只有一個正確答案，干擾選項要合理。
只輸出 JSON：{{"questions":[{{"q":"題目","options":["A","B","C","D"],"answer":0,"explanation":"為什麼正確、其他為何錯","page":3}}]}}
answer 是正確選項的索引（0–3），page 是依據所在頁碼。

<paper>
{context_text(pid)}
</paper>"""
    data = llm_json(prompt, SYSTEM_BASE, "quiz")
    quiz = {"questions": data.get("questions", []) if isinstance(data, dict) else [],
            "n": n, "difficulty": difficulty, "generated": now_iso()}
    write_json(pdir(pid) / "quiz.json", quiz)
    return quiz


# ---------------------------------------------------------------- markdown export / Obsidian vault

TITLE_STOP = {"a", "an", "the", "of", "in", "on", "for", "and", "or", "to", "with", "by", "at", "from", "is",
              "are", "as", "its", "into", "via", "does", "do", "how", "what", "why", "who", "when", "toward",
              "towards", "versus", "vs", "between", "among", "after", "before", "during"}
CAT_ZH = {"novelty": "新穎性", "method": "方法", "result": "結果"}
TYPE_ZH = {"text": "文本", "image": "圖片", "table": "表格", "formula": "數學公式"}


class VaultConflict(Exception):
    pass


def citekey(pid: str) -> str:
    """author + year + first title keyword — the vault's citekeyFormat (e.g. murray2025comparison)."""
    d = pdir(pid)
    meta = read_json(d / "meta.json", {})
    a = read_json(d / "analysis.json") or {}
    am = a.get("meta") or {}
    author = re.sub(r"[^a-z]", "", ((am.get("authors") or "").split() or [""])[0].lower())
    year = re.sub(r"\D", "", str(am.get("year") or ""))[:4]
    words = re.findall(r"[A-Za-z]+", a.get("title") or meta.get("title") or "")
    kw = next((w.lower() for w in words if w.lower() not in TITLE_STOP and len(w) > 2), "paper")
    return f"{author or 'anon'}{year}{kw}"


def _demote(md: str) -> str:
    """Push headings inside AI answers below the export's own ### level."""
    return re.sub(r"^#{1,6}\s+", "#### ", md.strip(), flags=re.M)


def build_markdown(pid: str, image_embed=None) -> str:
    d = pdir(pid)
    meta = read_json(d / "meta.json", {})
    a = read_json(d / "analysis.json") or {}
    am = a.get("meta") or {}
    title = a.get("title") or meta.get("title") or meta.get("filename")
    fm = {"title": title, "title_zh": a.get("title_zh") or "",
          "aliases": [a["title_zh"]] if a.get("title_zh") else [],
          "authors": am.get("authors") or "", "journal": am.get("journal") or "", "year": str(am.get("year") or ""),
          "doi": am.get("doi") or "", "study_type": am.get("study_type") or "", "category": meta.get("category") or "", "citekey": citekey(pid),
          "source_pdf": meta.get("filename") or "", "tags": ["paper-reading"], "exported": now_iso()}
    L = ["---"] + [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fm.items()] + ["---", "", f"# {title}"]
    if a.get("title_zh"):
        L += ["", f"> {a['title_zh']}"]
    src = " ".join(x for x in (am.get("journal"), str(am.get("year") or "")) if x)
    info = [am.get("authors") and f"- 作者：{am['authors']}", src and f"- 出處：{src}",
            am.get("study_type") and f"- 研究設計：{am['study_type']}",
            am.get("doi") and f"- DOI：[{am['doi']}](https://doi.org/{am['doi']})",
            f"- 原始檔：`{meta.get('filename', '')}`"]
    L += [""] + [x for x in info if x]
    links = skill_note_links(pid)
    if links:
        L += ["", "## 延伸筆記"] + links
    if a.get("tldr"):
        L += ["", "## 三行摘要"] + [f"- {t}" for t in a["tldr"]]
    if a.get("summary"):
        L += ["", "## 摘要", a["summary"].strip()]
    if a.get("keywords"):
        L += ["", "## 關鍵字"] + [f"- **{k.get('term')}**（{k.get('zh')}）：{k.get('definition')}" for k in a["keywords"]]
    notes = (d / "notes.md").read_text(encoding="utf-8").strip() if (d / "notes.md").exists() else ""
    if notes:
        L += ["", "## 我的筆記", notes]
    hls = sorted(read_json(d / "highlights.json", []),
                 key=lambda h: (h.get("page", 0), ((h.get("rects") or [[0, 0]])[0])[1]))
    if hls:
        L += ["", "## 我的高亮"] + [f"- (p.{h['page'] + 1}) {h.get('text', '')}" for h in hls]
    auto = (read_json(d / "autohl.json") or {}).get("items", [])
    if auto:
        L += ["", "## AI 重點句"] + [f"- [{CAT_ZH.get(h['cat'], h['cat'])}] (p.{h['page'] + 1}) {h['text']}"
                                     + (f" —— {h['note']}" if h.get("note") else "") for h in auto]
    exps = list(reversed(read_json(d / "explanations.json", [])))  # stored newest-first
    if exps:
        L += ["", "## AI 解釋"]
        for e in exps:
            L += ["", f"### p.{e.get('page', 0) + 1}・{TYPE_ZH.get(e.get('type'), e.get('type'))}"]
            if e.get("type") == "image":
                emb = image_embed(e["image"]) if image_embed and e.get("image") else None
                if emb:
                    L.append(emb)
            elif e.get("source"):
                L.append("> " + e["source"].replace("\n", "\n> "))
            L += ["", _demote(e.get("answer") or "")]
    return "\n".join(L) + "\n"


_vault_lock = threading.Lock()  # two skill runs finishing together both refresh the same main note


def export_to_vault(pid: str, force: bool = False) -> dict:
    with _vault_lock:
        return _export_to_vault(pid, force)


def _export_to_vault(pid: str, force: bool) -> dict:
    d = pdir(pid)
    vault = Path(settings()["vault_dir"]).expanduser()
    meta_path = d / "meta.json"
    meta = read_json(meta_path, {})
    name = meta.get("vault_file")
    if not name:
        key = citekey(pid)
        name, n = f"{key}.md", 1
        while (vault / name).exists():  # another paper already owns this citekey → key b, c, …
            n += 1
            name = f"{key}{chr(96 + n)}.md"
    target = vault / name
    if target.exists() and not force:
        last = meta.get("vault_mtime")
        if last is None or abs(target.stat().st_mtime - last) > 1:
            raise VaultConflict(f"vault 裡的 {name} 在上次存入後被修改過")
    stem = Path(name).stem
    att = attachment_dir()

    def embed(img: str):
        src = d / "images" / img
        if not src.exists():
            return None
        att.mkdir(parents=True, exist_ok=True)
        dst = att / f"{stem}-{img}"
        if not dst.exists():
            shutil.copy2(src, dst)
        return f"![[{dst.name}]]"

    text = build_markdown(pid, embed)
    vault.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8", newline="\n")
    with _file_lock:
        meta = read_json(meta_path, {})
        meta.update(vault_file=name, vault_mtime=target.stat().st_mtime, vault_saved=now_iso())
        write_json(meta_path, meta)
    return {"path": str(target), "file": name, "saved": meta["vault_saved"],
            "obsidian": "obsidian://open?path=" + quote(str(target))}


# ---------------------------------------------------------------- skill notes (DeepPaperNote / textbook-to-note)

PYTHON = re.sub(r"pythonw(\.exe)?$", r"python\1", sys.executable)
IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
AGENT_SYSTEM = (
    "你在「論文伴讀」本機 app 的背景工作中執行，沒有人可以即時回答問題：skill 要求詢問使用者的地方，"
    "依本次提示給的設定與合理預設繼續，不要停下來等待；真的無法完成時，說明卡在哪一步後結束。"
    "筆記內容一律使用繁體中文（台灣用語），不可出現簡體字；過程中的簡短說明與最後給使用者的回報也用繁體中文。"
    "只寫入提示指定的工作資料夾與 Obsidian 目的地，不要修改論文伴讀 app、skill 本身或其他既有筆記。"
)


class Cancelled(Exception):
    pass


PROCS: dict = {}  # run id -> Popen of its claude session
CANCELLED: set = set()


def vault_dir() -> Path:
    return Path(settings()["vault_dir"]).expanduser()


def vault_root() -> Path:
    """The Obsidian vault holding vault_dir (the nearest folder with .obsidian/)."""
    vd = vault_dir()
    for p in (vd, *vd.parents):
        if (p / ".obsidian").is_dir():
            return p
    return vd


def attachment_dir() -> Path:
    vault = vault_dir()
    att_root = vault.parent / "99Attachment"
    return att_root / "paper-reading" if att_root.is_dir() else vault / "attachments"


def skill_note_dir(skill: str) -> Path:
    return vault_dir() / NOTE_SKILLS[skill]["subdir"]


def _vault_rel(path: Path) -> tuple[Path, str]:
    """(vault, vault-relative posix path) for a folder inside the vault."""
    root = vault_root()
    try:
        return root, path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.parent, path.name


def skill_status() -> list:
    return [{"id": k, "label": v["label"], "skill": v["skill"], "dir": str(skill_note_dir(k)),
             "ok": (v["plugin"] / "skills").is_dir() and (k != "t2n" or (T2N_REPO / "converter").is_dir())}
            for k, v in NOTE_SKILLS.items()]


def _paper_info(pid: str) -> dict:
    d = pdir(pid)
    meta = read_json(d / "meta.json", {})
    a = read_json(d / "analysis.json") or {}
    am = a.get("meta") or {}
    key = Path(meta["vault_file"]).stem if meta.get("vault_file") else citekey(pid)
    return {"title": a.get("title") or meta.get("title") or meta.get("filename", ""), "authors": am.get("authors") or "",
            "year": str(am.get("year") or ""), "journal": am.get("journal") or "", "doi": am.get("doi") or "",
            "study_type": am.get("study_type") or "", "key": key, "pdf": d / "paper.pdf"}


def dpn_target(pid: str) -> Path:
    root, subdir = _vault_rel(skill_note_dir("dpn"))
    key = _paper_info(pid)["key"]
    return root / subdir / key / f"{key}.md"


def _runs_file(pid: str) -> Path:
    return pdir(pid) / "skillnotes.json"


def _update_run(pid: str, rid: str, **kw) -> None:
    with _file_lock:
        runs = read_json(_runs_file(pid), [])
        for r in runs:
            if r.get("id") == rid:
                r.update(kw)
        write_json(_runs_file(pid), runs)


def get_run(pid: str, rid: str) -> dict:
    run = next((r for r in read_json(_runs_file(pid), []) if r.get("id") == rid), None)
    if not run:
        raise ValueError("找不到這筆 Skill 筆記紀錄")
    return run


def list_runs(pid: str) -> list:
    """Newest first. A run left 'running' by a restarted server is marked interrupted."""
    with _file_lock:
        runs = read_json(_runs_file(pid), [])
        jobs = jobs_of(pid)
        stale = [r for r in runs if r.get("status") == "running" and jobs.get(r["skill"], {}).get("status") != "running"]
        for r in stale:
            r.update(status="error", error="伺服器重新啟動，這次產生被中斷了", finished=now_iso())
        if stale:
            write_json(_runs_file(pid), runs)
    return runs


def skill_note_links(pid: str) -> list:
    """Wikilinks to the finished skill notes, for the paper's main vault note."""
    seen, out = set(), []
    for r in read_json(_runs_file(pid), []):
        rel = r.get("rel")
        if r.get("status") != "done" or not rel or rel in seen or not Path(r.get("note_path", "")).is_file():
            continue
        seen.add(rel)
        name = "DeepPaperNote 深度筆記" if r["skill"] == "dpn" else f"textbook-to-note：{r.get('topic') or Path(rel).name}"
        out.append(f"- [[{rel}|{name}]]（{(r.get('finished') or '')[:10]}）")
    return out


class RunLog:
    """Progress lines of one run, flushed into skillnotes.json at most every 2 s."""

    def __init__(self, pid: str, rid: str):
        self.pid, self.rid, self.lines, self.t = pid, rid, [], 0.0

    def add(self, line: str, flush: bool = False) -> None:
        line = re.sub(r"\s+", " ", str(line)).strip()
        if line:
            self.lines.append(f"{time.strftime('%H:%M:%S')} {line[:300]}")
            del self.lines[:-400]
        if flush or time.time() - self.t > 2:
            self.flush()

    def flush(self) -> None:
        self.t = time.time()
        _update_run(self.pid, self.rid, log=self.lines)


def _tool_line(name: str, inp: dict) -> str:
    if name == "Bash":
        what = inp.get("description") or inp.get("command") or ""
    elif name in ("Read", "Write", "Edit"):
        what = Path(str(inp.get("file_path", ""))).name
    elif name in ("Glob", "Grep"):
        what = inp.get("pattern", "")
    elif name == "Skill":
        what = inp.get("skill") or inp.get("command") or ""
    else:
        what = json.dumps(inp, ensure_ascii=False)
    return f"{name}：{what}"


def _kill_tree(p) -> None:
    if sys.platform == "win32":  # the session's bash/python children must go too
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True, creationflags=CREATE_NO_WINDOW)
    else:
        p.kill()


def run_agent(rid: str, prompt: str, *, plugin: Path, model: str, effort: str, cwd: Path, add_dirs: list,
              env_extra: dict, log: RunLog) -> dict:
    """One agentic `claude -p` session with a note skill loaded from `plugin`; returns the result event.

    Unlike run_claude this keeps Claude Code's own system prompt (only appends to it) and grants the
    file/shell tools the skills need. User settings are not loaded, so hooks and other plugins stay out.
    """
    if not CLAUDE:
        raise LLMError("找不到 claude CLI，請確認已安裝並登入 Claude Code。")
    args = [CLAUDE, "-p", "--model", model, "--no-session-persistence", "--setting-sources", "",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--plugin-dir", str(plugin),
            "--append-system-prompt", AGENT_SYSTEM, "--tools", AGENT_TOOLS, "--allowedTools", AGENT_TOOLS,
            "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose"]
    for d in add_dirs:
        args += ["--add-dir", str(d)]
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", **env_extra}
    if effort == "off":
        env["MAX_THINKING_TOKENS"] = "0"
    else:
        args += ["--effort", effort]
    cwd.mkdir(parents=True, exist_ok=True)
    result, noise = None, []
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         cwd=str(cwd), env=env, creationflags=CREATE_NO_WINDOW)
    PROCS[rid] = p
    timer = threading.Timer(AGENT_TIMEOUT, _kill_tree, (p,))
    timer.start()
    try:
        p.stdin.write(prompt.encode("utf-8"))
        p.stdin.close()
        for raw in p.stdout:
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                noise.append(raw.decode("utf-8", "replace").strip())
                continue
            kind = ev.get("type")
            blocks = (ev.get("message") or {}).get("content")
            blocks = blocks if isinstance(blocks, list) else []
            if kind == "assistant":
                for b in blocks:
                    if b.get("type") == "tool_use":
                        log.add(_tool_line(b.get("name", ""), b.get("input") or {}))
                    elif b.get("type") == "text" and b.get("text", "").strip():
                        log.add("💬 " + b["text"])
            elif kind == "user":
                for b in blocks:
                    if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                        c = b.get("content")
                        log.add("⚠ " + (c if isinstance(c, str) else " ".join(
                            x.get("text", "") for x in c or [] if isinstance(x, dict))))
            elif kind == "result":
                result = ev
        p.wait()
    finally:
        timer.cancel()
        PROCS.pop(rid, None)
        log.flush()
    if rid in CANCELLED:
        CANCELLED.discard(rid)
        raise Cancelled("已取消")
    if result is None:
        raise LLMError(f"claude 沒有回傳結果（逾時或中斷）：{' '.join(noise)[-300:]}")
    if result.get("is_error"):
        raise LLMError(str(result.get("result") or result.get("subtype") or "claude 回報錯誤")[:600])
    return result


def _note_result(text: str) -> dict:
    found = re.findall(r"NOTE_RESULT:\s*(\{.*\})", text or "")
    try:
        return json.loads(found[-1]) if found else {}
    except json.JSONDecodeError:
        return {}


def _fresh_note(path, since: float) -> Path | None:
    """`path` if it is a markdown file inside the vault written during this run."""
    if not path:
        return None
    f = Path(str(path)).expanduser()
    try:
        f.resolve().relative_to(vault_root().resolve())
    except ValueError:
        return None
    return f if f.suffix == ".md" and f.is_file() and f.stat().st_mtime >= since - 1 else None


def _no_note(result: dict) -> LLMError:
    said = re.sub(r"\n?NOTE_RESULT:.*", "", result.get("result") or "").strip()
    return LLMError("沒有產生筆記檔。" + (f"Claude 最後的說明：{said[-500:]}" if said else ""))


def _finish_run(pid: str, rid: str, note: Path, result: dict, log: RunLog, **extra) -> None:
    try:
        rel = note.resolve().relative_to(vault_root().resolve()).with_suffix("").as_posix()
    except ValueError:
        rel = note.stem
    summary = re.sub(r"\n?NOTE_RESULT:.*", "", result.get("result") or "").strip()[:4000]
    log.add(f"已存到 Obsidian：{note}", flush=True)
    _update_run(pid, rid, status="done", finished=now_iso(), note_path=str(note), rel=rel,
                obsidian="obsidian://open?path=" + quote(str(note)), cost=result.get("total_cost_usd"),
                turns=result.get("num_turns"), summary=summary, **extra)
    try:  # the paper's main vault note lists every skill note under 延伸筆記
        r = export_to_vault(pid)
        log.add(f"已更新 {r['file']} 的延伸筆記連結", flush=True)
    except VaultConflict:
        log.add("主筆記在 Obsidian 裡改過，沒有自動更新連結（可按「存到 PaperBrain」手動更新）", flush=True)
    except Exception as e:  # noqa: BLE001 — the skill note itself is already saved
        log.add(f"主筆記的延伸筆記連結沒有更新：{e}", flush=True)


def task_dpn(pid: str, rid: str) -> None:
    run, info, log = get_run(pid, rid), _paper_info(pid), RunLog(pid, rid)
    root, subdir = _vault_rel(skill_note_dir("dpn"))
    key = info["key"]
    target = root / subdir / key / f"{key}.md"
    work = pdir(pid) / "dpn"
    DPN_TMP.mkdir(parents=True, exist_ok=True)
    prompt = f"""請先用 Skill 工具載入 `deeppapernote:deeppapernote`，完整依照它規定的全部流程（不可省略 lint、final_quality_review、final_readability_review 與正式存檔）為下面這篇論文產生深度閱讀筆記，並存進 Obsidian vault。

## 論文
- 本機 PDF（最優先來源；使用者已在論文伴讀開啟這份檔案，身分以它為準）：{info['pdf']}
- 標題：{info['title']}
- 作者：{info['authors'] or '（未知）'}；年份：{info['year'] or '（未知）'}；期刊：{info['journal'] or '（未知）'}
- DOI：{info['doi'] or '（論文伴讀沒有抓到，請從 PDF 或 metadata 補）'}
- 研究設計：{info['study_type'] or '（未知）'}

## 這次的設定（論文伴讀已決定，不要再詢問）
- 工作資料夾：{work}（先 cd 進去再跑腳本，中間產物都放這裡）
- 腳本資料夾：{DPN_SCRIPTS}；Python：{PYTHON}
- 輸出語言：zh-TW（繁體中文、台灣用語）；save_mode=obsidian。每個階段的 output_language 與 --language 都必須使用 zh-TW，依繁中 schema 撰寫標題與圖表標籤；使用資料、資訊、程式碼、信賴區間、世代研究等台灣用語。
- 已有本機 PDF：解析身分時用 `--zotero-mode off`
- Obsidian vault：{root}（環境變數 DEEPPAPERNOTE_OBSIDIAN_VAULT、DEEPPAPERNOTE_PAPERS_DIR 已設定）
- 正式存檔：`write_obsidian_note.py --vault "{root}" --subdir "{subdir}" --filename "{key}.md"`（其餘參數照 skill），最後的檔案必須是 {target}，圖片放同資料夾的 images/
- frontmatter 的 tags 另加 `paper-reading`，aliases 另加 `{key}`
- 圖表資產目錄 DEEPPAPERNOTE_OUTPUT_DIR={DPN_TMP}（已設定）

## 這台電腦的已知陷阱
- Windows 路徑上限 260 字元：標題超過約 120 字元時，create_input_record.py 的 --title 先用截短版，筆記內再寫全名
- style gate：含中文的行最多 6 個英文 token（有 of／with／for／in／a 等功能詞時最多 3 個）；臨床用語寫中文（95% 信賴區間、風險比）；長段落只在「。」或「：」之後換行
- `引用` 條目寫成 `Author et al., YYYY.`（et al. 前的姓至少 2 個字元）
- 臨床論文的森林圖常被 plan_figures.py 漏掉而標成 low_priority；assets.json 顯示 usable 的要手動升級成 insert
- 每個圖表項目只允許 1 次 bbox repair

完成後，最後一行單獨輸出：
NOTE_RESULT: {{"note_path": "<寫入的完整路徑>", "figures": <插入的圖數>, "lint": "pass 或 fail"}}"""
    started = time.time()
    log.add(f"啟動 {NOTE_SKILLS['dpn']['skill']}（{run['model']}・{run['effort']}）", flush=True)
    result = run_agent(rid, prompt, plugin=NOTE_SKILLS["dpn"]["plugin"], model=run["model"], effort=run["effort"],
                       cwd=work, add_dirs=[root, DPN_TMP, pdir(pid), NOTE_SKILLS["dpn"]["plugin"]], log=log,
                       env_extra={"DEEPPAPERNOTE_OUTPUT_LANGUAGE": "zh-TW", "DEEPPAPERNOTE_SAVE_MODE": "obsidian",
                                  "DEEPPAPERNOTE_OBSIDIAN_VAULT": str(root), "DEEPPAPERNOTE_PAPERS_DIR": subdir,
                                  "DEEPPAPERNOTE_OUTPUT_DIR": str(DPN_TMP)})
    rep = _note_result(result.get("result", ""))
    note = _fresh_note(target, started) or _fresh_note(rep.get("note_path"), started)
    if not note:
        raise _no_note(result)
    _finish_run(pid, rid, note, result, log, figures=rep.get("figures"), lint=rep.get("lint"))


def task_t2n(pid: str, rid: str) -> None:
    run, info, log = get_run(pid, rid), _paper_info(pid), RunLog(pid, rid)
    book = info["key"]
    md = T2N_CORPUS / book / "full_text.md"
    first = re.split(r",| et al| and ", info["authors"])[0].strip()
    first = first.split()[0] if first else ""
    label = ". ".join(x for x in (f"{first} {info['year']}".strip(), info["title"], info["journal"]) if x)
    if md.is_file() and md.stat().st_mtime >= info["pdf"].stat().st_mtime:
        log.add(f"沿用已轉好的語料：{md}", flush=True)
    else:
        log.add("轉檔：converter/convert.py（本機、0 token）", flush=True)
        r = subprocess.run([PYTHON, str(T2N_REPO / "converter" / "convert.py"), str(info["pdf"]), str(md),
                            "--book-label", label], cwd=str(T2N_REPO), capture_output=True, timeout=1800,
                           env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "T2N_REVIEW_QUEUE": "1"},
                           creationflags=CREATE_NO_WINDOW)
        out = r.stdout.decode("utf-8", "replace")
        for line in out.splitlines()[-5:]:
            log.add(line)
        if r.returncode or not md.is_file():
            raise LLMError("轉檔失敗：" + (r.stderr.decode("utf-8", "replace") or out)[-500:])
    root, note_dir, att = vault_root(), skill_note_dir("t2n"), attachment_dir()
    topic, template = run.get("topic") or "", run.get("template") or "auto"
    prompt = f"""請先用 Skill 工具載入 `textbook-to-note:textbook-to-note`，完整依照它與 `{T2N_REPO / 'workflows' / 'note-writing.md'}` 的流程，把下面這份來源寫成一份模板驅動、逐條引用的繁體中文筆記，並存進 Obsidian。

## 來源
- PDF：{info['pdf']}
- 已轉好的 markdown（有 <!-- page N --> 頁碼標記，不用再轉檔）：{md}
- 語料庫：OUTPUT_DIR={T2N_CORPUS}；這份來源的書名資料夾（figure_remap.py 的 --book）：{book}
- 書目：{info['authors'] or '（未知作者）'}（{info['year'] or '年份未知'}）. {info['title']}. {info['journal']}. {('DOI ' + info['doi']) if info['doi'] else ''}
- 研究設計：{info['study_type'] or '（未知）'}
- 引用格式：({first or 'Author'} {info['year'] or 'n.d.'}, p.N)，頁碼取自頁碼標記

## 這次的設定（論文伴讀已決定，不要再詢問）
- 主題：{topic or '依來源內容挑一個最核心、最值得做成知識筆記的主題（繁體中文，必要時括號附英文）'}
- 模板：{template}（auto＝依 note-writing.md Step 1.1 判斷）
- 筆記資料夾：{note_dir}，檔名「<主題>.md」；已有同名檔時改寫成「<主題> (draft).md」，不可覆蓋
- 圖片附件資料夾：{att}（嵌入寫 `![[檔名|400]]`）
- 沒有外部實證資料庫：Phase 2／3 跳過；Phase 5 連結建議跳過
- frontmatter 的 tags 另加 `paper-reading/textbook-to-note`，source 寫上面的書目

完成後，最後一行單獨輸出 NOTE_RESULT（格式見 skill）。"""
    started = time.time()
    log.add(f"啟動 {NOTE_SKILLS['t2n']['skill']}（{run['model']}・{run['effort']}，模板 {template}）", flush=True)
    result = run_agent(rid, prompt, plugin=NOTE_SKILLS["t2n"]["plugin"], model=run["model"], effort=run["effort"],
                       cwd=pdir(pid) / "t2n", add_dirs=[root, T2N_REPO, T2N_CORPUS, pdir(pid), NOTE_SKILLS["t2n"]["plugin"]],
                       log=log, env_extra={"OUTPUT_DIR": str(T2N_CORPUS), "TEXTBOOK_DIR": str(T2N_CORPUS),
                                           "T2N_REVIEW_QUEUE": "1"})
    rep = _note_result(result.get("result", ""))
    note = _fresh_note(rep.get("note_path"), started)
    if not note and note_dir.is_dir():  # fall back to whatever the session wrote into the folder
        fresh = [f for f in note_dir.glob("*.md") if f.stat().st_mtime >= started - 1]
        note = max(fresh, key=lambda f: f.stat().st_mtime) if fresh else None
    if not note:
        raise _no_note(result)
    _finish_run(pid, rid, note, result, log, topic=rep.get("topic") or topic or note.stem,
                template=rep.get("template") or template, figures=rep.get("figures"), draft=bool(rep.get("draft")))


def _skill_job(fn):
    def job(pid: str, rid: str) -> None:
        try:
            fn(pid, rid)
        except Cancelled:
            _update_run(pid, rid, status="cancelled", finished=now_iso())
            raise
        except Exception as e:
            _update_run(pid, rid, status="error", error=str(e)[:800], finished=now_iso())
            raise
    return job


def start_skill_note(pid: str, body: dict) -> dict:
    skill = str(body.get("skill", ""))
    if skill not in NOTE_SKILLS:
        raise ValueError("不認得的 skill")
    if not next(x for x in skill_status() if x["id"] == skill)["ok"]:
        raise ValueError(f"{NOTE_SKILLS[skill]['label']} 尚未安裝")
    if not read_json(pdir(pid) / "meta.json", {}).get("has_text"):
        raise ValueError("這份 PDF 沒有文字層，無法產生筆記")
    s = settings()
    model = MODEL_ALIAS.get(body.get("model") or "", body.get("model"))
    model = model if model in {m["id"] for m in MODELS} else s["model_note"]
    effort = body.get("effort") if body.get("effort") in EFFORTS else s["effort_note"]
    run = {"id": uuid.uuid4().hex[:10], "skill": skill, "status": "running", "started": now_iso(),
           "model": model, "effort": effort, "log": []}
    if skill == "dpn":
        target = dpn_target(pid)
        if target.exists() and not body.get("force"):
            raise VaultConflict(f"Obsidian 裡已經有這篇的 DeepPaperNote 筆記（{target.name}），重新產生會覆蓋它")
    else:
        tpl = str(body.get("template") or "auto")
        run.update(template=tpl if tpl in T2N_TEMPLATES else "auto", topic=str(body.get("topic") or "").strip()[:120])
    with _file_lock:
        if jobs_of(pid).get(skill, {}).get("status") == "running":
            raise ValueError(f"{NOTE_SKILLS[skill]['label']} 正在產生這篇的筆記，請等它完成")
        runs = read_json(_runs_file(pid), [])
        runs.insert(0, run)
        write_json(_runs_file(pid), runs)
        start_job(pid, skill, _skill_job(task_dpn if skill == "dpn" else task_t2n), run["id"])
    return run


def cancel_run(pid: str, rid: str) -> None:
    get_run(pid, rid)
    p = PROCS.get(rid)
    if not p:
        raise ValueError("這筆沒有在執行")
    CANCELLED.add(rid)
    _kill_tree(p)


def delete_run(pid: str, rid: str) -> None:
    """Forget a run record; the note in the vault stays."""
    with _file_lock:
        runs = [r for r in read_json(_runs_file(pid), []) if r.get("id") != rid or r.get("status") == "running"]
        write_json(_runs_file(pid), runs)


def read_skill_note(pid: str, rid: str) -> dict:
    run = get_run(pid, rid)
    f = Path(run.get("note_path") or "")
    if not f.is_file():
        raise ValueError("Obsidian 裡找不到這份筆記（可能已被移動或刪除）")
    return {"markdown": f.read_text(encoding="utf-8-sig"), "path": str(f), "obsidian": run.get("obsidian")}


def skill_asset(pid: str, rid: str, name: str) -> Path | None:
    """An image embedded in a skill note, resolved the way Obsidian would (note folder, attachments, vault)."""
    note = Path(get_run(pid, rid).get("note_path") or "")
    root = vault_root().resolve()
    name = name.split("|")[0].strip()
    for c in (note.parent / name, attachment_dir() / Path(name).name, root / name):
        c = c.resolve()
        if root in c.parents and c.suffix.lower() in IMG_MIME and c.is_file():
            return c
    return None


# ---------------------------------------------------------------- library categories
# One category per paper, like a folder. meta.json holds category / category_source ("ai" or
# "manual"); library.json keeps the category list (order, description, who made it) so empty
# categories survive. AI never overwrites a manual pick.

LIBRARY_FILE = DATA / "library.json"
LIB = "library"           # JOBS key of library-wide jobs (never a paper id)
CAT_MAX = 24              # characters in a category name
CLASSIFY_CHUNK = 30       # papers per classification call
_classify_lock = threading.Lock()  # one run at a time, so each run sees the categories the last one made


def _cat(s) -> str:
    n = re.sub(r"\s+", " ", str(s or "")).strip()[:CAT_MAX]
    return "" if n == "未分類" else n  # reserved for papers without a category


def _metas() -> dict:
    out = {}
    if PAPERS.exists():
        for d in PAPERS.iterdir():
            m = read_json(d / "meta.json")
            if m:
                out[d.name] = m
    return out


def update_meta(pid: str, **kw) -> dict:
    path = pdir(pid) / "meta.json"
    with _file_lock:
        meta = read_json(path, {})
        meta.update(kw)
        write_json(path, meta)
    return meta


def categories(metas: dict | None = None) -> list:
    """library.json's list plus any category a paper uses that the file lacks."""
    cats, seen = [], set()
    for c in (read_json(LIBRARY_FILE, {}) or {}).get("categories", []):
        n = _cat(c.get("name"))
        if n and n not in seen:
            seen.add(n)
            cats.append({"name": n, "desc": str(c.get("desc") or "")[:200], "by": c.get("by") or "ai"})
    for m in (_metas() if metas is None else metas).values():
        n = _cat(m.get("category"))
        if n and n not in seen:
            seen.add(n)
            cats.append({"name": n, "desc": "", "by": "ai"})
    return cats


def _write_cats(cats: list) -> None:
    write_json(LIBRARY_FILE, {"categories": cats})


def set_category(pid: str, name: str) -> dict:
    """Manual pick; an empty name puts the paper back in 未分類 (so AI may classify it again)."""
    name = _cat(name)
    with _file_lock:
        cats = categories()
        if name and name not in {c["name"] for c in cats}:
            _write_cats(cats + [{"name": name, "desc": "", "by": "manual"}])
        return update_meta(pid, category=name, category_source="manual" if name else "", category_at=now_iso())


def save_category(old: str, name: str, desc=None) -> None:
    """Create (no old name) or rename / re-describe a category; renaming onto an existing name merges."""
    if str(name or "").strip() == "未分類":
        raise ValueError("「未分類」是保留名稱，請換一個")
    old, name = _cat(old), _cat(name)
    if not name:
        raise ValueError("分類名稱不能空白")
    desc = None if desc is None else str(desc).strip()[:200]
    with _file_lock:
        cats = categories()
        names = [c["name"] for c in cats]
        if not old:
            if name in names:
                raise ValueError(f"已經有「{name}」這個分類")
            _write_cats(cats + [{"name": name, "desc": desc or "", "by": "manual"}])
            return
        if old not in names:
            raise ValueError(f"找不到「{old}」這個分類")
        src = cats[names.index(old)]
        if name != old and name in names:
            cats.remove(src)
            src = cats[[c["name"] for c in cats].index(name)]
        src.update(name=name, by="manual")
        if desc is not None:
            src["desc"] = desc
        if name != old:
            for pid, m in _metas().items():
                if m.get("category") == old:
                    update_meta(pid, category=name)
        _write_cats(cats)


def delete_category(name: str) -> None:
    name = _cat(name)
    with _file_lock:
        for pid, m in _metas().items():
            if m.get("category") == name:
                update_meta(pid, category="", category_source="", category_at=now_iso())
        _write_cats([c for c in categories() if c["name"] != name])


def _brief(pid: str, meta: dict, need_authors: bool) -> dict:
    a = read_json(PAPERS / pid / "analysis.json") or {}
    am = a.get("meta") or {}
    b = {"id": pid, "title": a.get("title") or meta.get("title") or meta.get("filename")}
    kws = "; ".join(f"{k.get('term')}（{k.get('zh')}）" if k.get("zh") else str(k.get("term"))
                    for k in a.get("keywords") or [] if isinstance(k, dict) and k.get("term"))
    for k, v in (("title_zh", a.get("title_zh")), ("study_type", am.get("study_type")), ("journal", am.get("journal")),
                 ("keywords", kws), ("tldr", " ".join(a.get("tldr") or []))):
        if v:
            b[k] = v
    if (need_authors or not a) and meta.get("has_text"):
        b["first_page"] = full_text(pid)[:1800]
    return b


def _classify_chunk(chunk: list, mode: str, fresh: set) -> None:
    metas = _metas()
    cats = categories(metas)
    todo = set(chunk)
    manual_used = {m.get("category") for m in metas.values() if m.get("category_source") == "manual"}
    examples: dict = {}
    for pid, m in sorted(metas.items(), key=lambda kv: kv[1].get("category_source") != "manual"):
        if m.get("category") and pid not in todo:
            examples.setdefault(m["category"], []).append(str(m.get("title") or "")[:80])

    def line(c):
        ex = examples.get(c["name"], [])[:3]
        return (f"- {c['name']}" + (f"：{c['desc']}" if c["desc"] else "")
                + (f"（例：{'；'.join(ex)}）" if ex else ""))

    if mode == "all":  # free to redesign everything except what the user made or picked
        keep = [c for c in cats if c["by"] == "manual" or c["name"] in manual_used or c["name"] in fresh]
        old = [c for c in cats if c not in keep]
        cat_block = "必須沿用的分類（名稱：說明）：\n" + ("\n".join(map(line, keep)) or "（無）")
        if old:
            cat_block += "\n\n舊的 AI 分類，僅供參考，可以改名、合併、拆分或捨棄：\n" + "\n".join(map(line, old))
        rule = "這次是重新整理全部分類：請以清楚、互不重疊為目標重新設計分類架構，但「必須沿用」的分類要保留原名。"
    else:
        cat_block = "現有分類（名稱：說明）：\n" + ("\n".join(map(line, cats)) or "（目前還沒有分類）")
        rule = "優先沿用現有分類；只有現有分類都不適合時才新增。"
    need_authors = {p for p in chunk if not metas[p].get("authors_full") and not metas[p].get("authors_checked")}
    papers = [_brief(p, metas[p], p in need_authors) for p in chunk]
    prompt = f"""你要幫一位臨床腎臟科／重症醫師研究者整理論文書庫的分類。分類像資料夾：每篇論文只放進一個分類。

{cat_block}

待分類的論文（JSON）：
{json.dumps(papers, ensure_ascii=False, indent=1)}

分類原則：
1. 依臨床主題、疾病或治療領域分類（例如「急性腎損傷與 CRRT」「血液透析」「腎絲球疾病」），不要依研究設計（統合分析、隨機對照試驗）或文件類型分類；仿單、指引、講義也依主題歸類。
2. {rule}
3. 分類名稱用繁體中文（台灣用語），2–12 個字，可保留通用英文縮寫（如 AKI、CRRT、SGLT2i）；不要加編號或標點裝飾。
4. 粒度適中：一個分類要能容納多篇相關論文，不要太廣（如「醫學」「腎臟」），也不要窄到只適用單一藥物或單篇論文；整個書庫以 5–15 個分類為宜。
5. 附有 first_page 的論文，另外從 first_page 擷取完整作者名單（原文拼寫、依原文順序、以「; 」分隔），找不到就填空字串；沒有 first_page 的論文不用填 authors。

只輸出一個 JSON 物件，前後不要有其他文字：
{{"categories": [{{"name": "分類名稱", "desc": "一句話說明這個分類收哪些論文"}}],
 "assign": [{{"id": "論文 id", "category": "分類名稱", "authors": "完整作者名單"}}]}}
categories 列出這次 assign 用到的每一個分類（沿用的也要列）；assign 必須涵蓋每一篇待分類論文。"""
    out = llm_json(prompt, SYSTEM_BASE, "classify")
    if not isinstance(out, dict):
        raise LLMError("模型沒有回傳分類結果")
    descs = {_cat(c.get("name")): str(c.get("desc") or "").strip()[:200]
             for c in out.get("categories") or [] if isinstance(c, dict)}
    with _file_lock:
        for a in out.get("assign") or []:
            pid = a.get("id") if isinstance(a, dict) else None
            if pid not in todo or not (PAPERS / pid / "meta.json").exists():  # deleted meanwhile
                continue
            upd = {}
            if pid in need_authors:
                au = re.sub(r"\s+", " ", str(a.get("authors") or "")).strip()[:2000]
                upd.update(authors_checked=True, **({"authors_full": au} if au else {}))
            name = _cat(a.get("category"))
            if name and (mode == "force" or read_json(PAPERS / pid / "meta.json", {}).get("category_source") != "manual"):
                upd.update(category=name, category_source="ai", category_at=now_iso())  # a manual pick made meanwhile wins
                fresh.add(name)
            if upd:
                update_meta(pid, **upd)
        cats = categories()
        for c in cats:
            d = descs.get(c["name"])
            if d and (not c["desc"] or c["by"] == "ai"):
                c["desc"] = d
        _write_cats(cats)


def classify(pids: list | None, mode: str = "unsorted", progress=None) -> int:
    """pids=None → the whole library. mode "unsorted": only papers without a category;
    "all": every paper not picked by hand, and AI categories left empty afterwards are dropped."""
    with _classify_lock:
        metas = _metas()
        pool = list(metas) if pids is None else [p for p in pids if p in metas]
        pool.sort(key=lambda p: metas[p].get("added", ""))
        if mode == "all":
            todo = [p for p in pool if metas[p].get("category_source") != "manual"]
        elif mode == "force":
            todo = pool
        else:
            todo = [p for p in pool if not metas[p].get("category")]
        fresh: set = set()
        if progress:
            progress(0, len(todo))
        for i in range(0, len(todo), CLASSIFY_CHUNK):
            _classify_chunk(todo[i:i + CLASSIFY_CHUNK], mode, fresh)
            if progress:
                progress(min(i + CLASSIFY_CHUNK, len(todo)), len(todo))
        if mode == "all" and todo:
            with _file_lock:
                metas = _metas()
                used = {m.get("category") for m in metas.values()}
                _write_cats([c for c in categories(metas) if c["by"] == "manual" or c["name"] in used])
        return len(todo)


def task_classify_paper(pid: str) -> None:
    classify([pid])


def task_classify_library(_key: str, mode: str, pids: list | None = None) -> None:
    classify(pids, mode, progress=lambda done, total: job_set(LIB, "classify", progress=[done, total]))


def library_state() -> dict:
    recheck_library()
    papers = list_papers()
    with _jobs_lock:
        busy = any(j.get("status") == "running" for jobs in JOBS.values() for j in jobs.values())
    trash = sorted(list_papers(trash_dir()), key=lambda m: m.get("trashed_at", ""), reverse=True)
    for t in trash:  # the trash view needs no summaries
        for k in ("summary", "tldr", "keywords"):
            t.pop(k, None)
    return {"papers": papers, "categories": categories({p["id"]: p for p in papers}), "trash": trash,
            "job": jobs_of(LIB).get("classify"), "busy": busy, "location": location_brief()}


# ---------------------------------------------------------------- library location (cloud sync)
# Like EasyRead's 云文献库: no cloud API, no login. The library folder moves into a folder that a
# desktop sync client already syncs and the client does the uploading. Moving copies (the old
# library is never deleted), verifies every paper, then switches DATA live. Each computer that
# has the library open leaves a heartbeat so another computer can warn about concurrent use.

HOST = socket.gethostname() or "this-pc"
HOSTS_DIR = ".paper-reader-hosts"
MIGRATING = ".paper-reader-migrating"   # marker of an unfinished copy at the destination
LIB_DIRNAME = "paper-reader"


def _same(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _inside(child: Path, parent: Path) -> bool:
    c, p = os.path.normcase(os.path.abspath(child)), os.path.normcase(os.path.abspath(parent))
    return c != p and c.startswith(p.rstrip("\\/") + os.sep)


def _lib_info(path: Path) -> dict:
    papers = path / "papers"
    try:
        n = sum(1 for d in papers.iterdir() if (d / "meta.json").exists()) if papers.is_dir() else 0
    except OSError:
        n = 0
    return {"papers": n, "has_library": n > 0 or (path / "library.json").exists(),
            "incomplete": (path / MIGRATING).exists()}


def _onedrive_roots() -> list:
    out = []
    for var, label in (("OneDrive", "OneDrive"), ("OneDriveConsumer", "OneDrive"), ("OneDriveCommercial", "OneDrive（公司／學校）")):
        v = os.environ.get(var)
        if v and Path(v).is_dir() and not any(_same(Path(v), Path(r)) for r, _ in out):
            out.append((v, label))
    return out


def _gdrive_roots() -> list:
    """Google Drive for desktop: streaming mounts a drive (G:\\我的雲端硬碟), mirroring uses ~\\My Drive."""
    drives = os.listdrives() if hasattr(os, "listdrives") else [f"{c}:\\" for c in "DEFGHIJKLMNOPQRSTUVWXYZ"]
    out = []
    for base in [Path(d) for d in drives if not d.upper().startswith("C:")] + [Path.home()]:
        for sub in ("我的雲端硬碟", "My Drive", "Google Drive"):
            if (base / sub).is_dir():
                out.append(str(base / sub))
    return out[:2]


def cloud_candidates() -> list:
    cands = [{"kind": "local", "name": "這台電腦（本機）", "root": str(LOCAL), "target": str(LOCAL)}]
    cands += [{"kind": "onedrive", "name": label, "root": r, "target": str(Path(r) / LIB_DIRNAME)} for r, label in _onedrive_roots()]
    cands += [{"kind": "gdrive", "name": "Google Drive", "root": r, "target": str(Path(r) / LIB_DIRNAME)} for r in _gdrive_roots()]
    for c in cands:
        c.update(_lib_info(Path(c["target"])), current=_same(Path(c["target"]), DATA))
    return cands


def _kind_of(path: Path) -> tuple[str, str]:
    if _same(path, LOCAL):
        return "local", "這台電腦"
    for r, label in _onedrive_roots():
        if _inside(path, Path(r)):
            return "onedrive", label
    for r in _gdrive_roots():
        if _inside(path, Path(r)):
            return "gdrive", "Google Drive"
    return "folder", "自訂資料夾"


def other_hosts() -> list:
    out, now = [], time.time()
    for f in (DATA / HOSTS_DIR).glob("*.json"):
        h = read_json(f, {}) or {}
        if h.get("host") and h["host"] != HOST and now - float(h.get("time") or 0) < 180:
            out.append(h["host"])
    return out


def _heartbeat() -> None:
    if _same(DATA, LOCAL):
        return
    try:
        write_json(DATA / HOSTS_DIR / (re.sub(r"[^\w.-]", "_", HOST) + ".json"),
                   {"host": HOST, "time": time.time(), "pid": os.getpid()})
    except OSError:
        pass


def _heartbeat_loop() -> None:
    while True:
        _heartbeat()
        time.sleep(60)


def location_brief() -> dict:
    kind, label = _kind_of(DATA)
    return {"path": str(DATA), "kind": kind, "label": label, "missing": LIB_MISSING, "others": other_hosts()}


def location_state() -> dict:
    recheck_library()
    return {**location_brief(), "local": str(LOCAL), "candidates": cloud_candidates(), "host": HOST,
            "job": jobs_of(LIB).get("move"), "papers": _lib_info(DATA)["papers"]}


def moving() -> bool:
    return (jobs_of(LIB).get("move") or {}).get("status") == "running"


def _busy_jobs() -> list:
    with _jobs_lock:
        busy = [n for k, jobs in JOBS.items() for n, j in jobs.items()
                if j.get("status") == "running" and not (k == LIB and n == "move")]
    return busy + [f"skill:{r}" for r in PROCS]


def resolve_target(raw: str) -> Path:
    t = os.path.expandvars(str(raw or "").strip().strip('"'))
    if not t:
        raise ValueError("請選擇或輸入資料夾")
    p = Path(t).expanduser()
    if not p.is_absolute() or not p.drive:
        raise ValueError("請輸入完整路徑，例如 C:\\Users\\you\\OneDrive")
    if _same(p, LOCAL):
        return LOCAL
    # a picked parent folder gets its own paper-reader subfolder, unless it already holds a library
    if p.name.lower() != LIB_DIRNAME and not _lib_info(p)["has_library"]:
        p = p / LIB_DIRNAME
    return p


def _tree_size(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _writable(path: Path) -> bool:
    probe = path
    while not probe.exists():
        if probe.parent == probe:
            return False
        probe = probe.parent
    try:
        f = probe / f".paper-reader-probe-{uuid.uuid4().hex[:6]}"
        f.write_bytes(b"")
        f.unlink()
        return True
    except OSError:
        return False


def inspect_target(raw: str) -> dict:
    target = resolve_target(raw)
    info = _lib_info(target)
    current = _same(target, DATA)
    nested = not current and (_inside(target, DATA) or _inside(DATA, target))
    probe = target
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        free = shutil.disk_usage(probe).free
    except OSError:
        free = None
    kind, label = _kind_of(target)
    return {"target": str(target), "kind": kind, "label": label, "current": current, "nested": nested,
            "writable": _writable(target), "free_mb": round(free / 2**20) if free is not None else None,
            "need_mb": round(_tree_size(PAPERS) / 2**20, 1) if PAPERS.exists() else 0,
            "current_papers": _lib_info(DATA)["papers"], **info}


def check_can_move(target: Path) -> None:
    if _same(target, DATA):
        raise ValueError("這就是目前使用中的書庫")
    if _inside(target, DATA) or _inside(DATA, target):
        raise ValueError("新位置不能在目前書庫裡面，也不能包住目前書庫")
    busy = _busy_jobs()
    if busy:
        raise ValueError("還有背景工作在執行（翻譯、摘要、分類或 Skill 筆記），請等它們完成再搬移")
    if not _writable(target):
        raise ValueError(f"無法寫入 {target}")


def _verify_copy(src: Path, dst: Path) -> None:
    for root, _, files in os.walk(src):
        for f in files:
            a = Path(root) / f
            b = dst / a.relative_to(src)
            if not b.is_file() or b.stat().st_size != a.stat().st_size:
                raise OSError(f"複製後檔案不一致：{b}")


def _newest(path: Path) -> float:
    return max((os.path.getmtime(os.path.join(r, f)) for r, _, fs in os.walk(path) for f in fs), default=0.0)


def _merge_categories(src: Path, dst: Path) -> None:
    have = (read_json(dst, {}) or {}).get("categories", [])
    names = {c.get("name") for c in have}
    extra = [c for c in (read_json(src, {}) or {}).get("categories", []) if c.get("name") not in names]
    if extra or not dst.exists():
        write_json(dst, {"categories": have + extra})


def task_move_library(_key: str, target: Path, mode: str) -> None:
    info = _lib_info(target)
    if mode == "copy" and info["has_library"] and not info["incomplete"]:
        raise ValueError("目的地已經有書庫，請改選「合併」或「直接改用」")
    if mode == "use" and not info["has_library"]:
        raise ValueError("目的地沒有書庫可以改用")
    if mode in ("copy", "merge"):
        (target / "papers").mkdir(parents=True, exist_ok=True)
        (target / MIGRATING).write_text(json.dumps({"from": str(DATA), "host": HOST, "at": now_iso()}), encoding="utf-8")
        ids = sorted(d.name for d in PAPERS.iterdir() if (d / "meta.json").exists()) if PAPERS.exists() else []
        job_set(LIB, "move", progress=[0, len(ids)])
        for i, pid in enumerate(ids):
            dst = target / "papers" / pid
            # a paper both libraries have (same PDF → same id) keeps whichever copy was changed last;
            # a copy resumed after a failure redoes every paper
            if mode == "copy" or not (dst / "meta.json").exists() or _newest(PAPERS / pid) > _newest(dst):
                shutil.copytree(PAPERS / pid, dst, dirs_exist_ok=True)
                _verify_copy(PAPERS / pid, dst)
            job_set(LIB, "move", progress=[i + 1, len(ids)])
        _merge_categories(DATA / "library.json", target / "library.json")
        (target / MIGRATING).unlink(missing_ok=True)
    switch_library(target)


def switch_library(target: Path) -> None:
    global DATA, PAPERS, LIBRARY_FILE, LIB_MISSING
    (target / "papers").mkdir(parents=True, exist_ok=True)
    if _same(target, LOCAL):
        LOCATION_FILE.unlink(missing_ok=True)
    else:
        write_json(LOCATION_FILE, {"library_dir": str(target), "since": now_iso()})
    with _jobs_lock:  # finished per-paper job states belong to the old library
        for k in [k for k in JOBS if k != LIB]:
            JOBS.pop(k, None)
    DATA, PAPERS, LIBRARY_FILE, LIB_MISSING = target, target / "papers", target / "library.json", None
    _heartbeat()
    if _kind_of(target)[0] == "onedrive":  # Files On-Demand: keep the library downloaded ("一律保留在此裝置")
        threading.Thread(target=lambda: subprocess.run(
            f'attrib +P -U "{target}" & attrib +P -U "{target}\\*" /S /D', shell=True,
            capture_output=True, creationflags=CREATE_NO_WINDOW), daemon=True).start()


def recheck_library() -> None:
    """The configured sync folder was missing at start-up (drive not mounted yet): switch once it appears."""
    if LIB_MISSING and Path(LIB_MISSING).is_dir() and not _busy_jobs() and not moving():
        switch_library(Path(LIB_MISSING))


def pick_folder() -> str:
    """Native folder dialog on this machine (the server only listens on 127.0.0.1)."""
    ps = ("[Console]::OutputEncoding = [Text.Encoding]::UTF8;"
          "Add-Type -AssemblyName System.Windows.Forms;"
          "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true; ShowInTaskbar = $false};"
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
          "$d.Description = '選擇要放論文伴讀書庫的資料夾（例如 OneDrive 或 Google Drive 裡的資料夾）';"
          "$d.ShowNewFolderButton = $true;"
          "if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }")
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], capture_output=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.decode("utf-8", "replace").strip()


# ---------------------------------------------------------------- reading status, star, trash, batch

STATUSES = ("unread", "reading", "done")


def trash_dir() -> Path:
    return DATA / "trash"


def _trashed(pid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", pid or "") or not (trash_dir() / pid / "meta.json").exists():
        raise KeyError(pid)
    return trash_dir() / pid


def _status_of(meta: dict, d: Path) -> str:
    """Papers from before reading status existed: opened once → reading."""
    s = meta.get("status")
    return s if s in STATUSES else ("reading" if (d / "view.json").exists() else "unread")


def _paper_busy(pid: str) -> bool:
    with _jobs_lock:
        return any(j.get("status") == "running" for j in JOBS.get(pid, {}).values())


def _move_dir(src: Path, dst: Path) -> None:
    try:
        os.replace(src, dst)
    except OSError:  # e.g. a sync client briefly holds a handle on the folder
        shutil.move(str(src), str(dst))


def trash_paper(pid: str) -> None:
    d = pdir(pid)
    if _paper_busy(pid):
        raise ValueError("這篇還有背景工作在執行（翻譯、摘要或 Skill 筆記），等完成後再刪除")
    trash_dir().mkdir(parents=True, exist_ok=True)
    dst = trash_dir() / pid
    if dst.exists():  # an older trashed copy of the same PDF
        shutil.rmtree(dst)
    update_meta(pid, trashed_at=now_iso())
    _move_dir(d, dst)
    with _jobs_lock:
        JOBS.pop(pid, None)


def restore_paper(pid: str) -> dict:
    src = _trashed(pid)
    if (PAPERS / pid).exists():
        raise ValueError("書庫裡已經有同一篇（重新上傳過），回收桶這份可以永久刪除")
    _move_dir(src, PAPERS / pid)
    with _file_lock:
        meta = read_json(PAPERS / pid / "meta.json", {})
        meta.pop("trashed_at", None)
        write_json(PAPERS / pid / "meta.json", meta)
    return meta


def purge_paper(pid: str) -> None:
    shutil.rmtree(_trashed(pid))


def batch(ids: list, op: str, value=None) -> dict:
    ids = [str(i) for i in ids or [] if isinstance(i, str)]
    if op == "classify":
        return {"started": start_job(LIB, "classify", task_classify_library, "force", ids)}
    if op == "status" and value not in STATUSES:
        raise ValueError("不明的閱讀狀態")
    if op not in ("category", "status", "star", "trash", "restore", "purge"):
        raise ValueError("不明的批次操作")
    done, failed = 0, []
    for pid in ids:
        try:
            if op == "category":
                set_category(pid, str(value or ""))
            elif op == "status":
                update_meta(pid, status=value)
            elif op == "star":
                update_meta(pid, starred=bool(value))
            elif op == "trash":
                trash_paper(pid)
            elif op == "restore":
                restore_paper(pid)
            else:
                purge_paper(pid)
            done += 1
        except KeyError:
            failed.append({"id": pid, "error": "找不到這篇論文"})
        except (ValueError, OSError) as e:
            failed.append({"id": pid, "error": str(e)})
    return {"done": done, "failed": failed}


# ---------------------------------------------------------------- bibliographic lookups
# Europe PMC, Crossref, OpenAlex and Semantic Scholar answer without a key. Publisher sites and
# the NCBI/Europe PMC PDF pages sit behind browser challenges, so PMC full texts come from the
# PMC Open Access dataset on AWS (dualstack endpoint: ~2× faster than the default from here).

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
EPMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
PMC_S3 = "https://pmc-oa-opendata.s3.dualstack.us-east-1.amazonaws.com"
MAX_PDF = 150 * 2**20
CHALLENGE_HOSTS = ("pmc.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "europepmc.org")
DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>]+[^\s\"<>.,;)\]])", re.I)


def _http(url: str, accept: str = "*/*", timeout: int = 45, limit: int = MAX_PDF, progress=None) -> tuple[bytes, str, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        total, buf = int(r.headers.get("Content-Length") or 0), bytearray()
        while True:
            chunk = r.read(65536)
            if not chunk:
                break
            buf += chunk
            if len(buf) > limit:
                raise ValueError("檔案太大")
            if progress:
                progress(len(buf), total)
        return bytes(buf), r.headers.get("Content-Type") or "", r.geturl()


def _jget(url: str, timeout: int = 30):
    return json.loads(_http(url, "application/json", timeout, 20 * 2**20)[0])


def _first(v):
    return (v[0] if v else "") if isinstance(v, list) else (v or "")


def _clean(s) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", str(s or "")))).strip()


def epmc_lookup(doi: str = "", pmid: str = "", pmcid: str = "") -> dict | None:
    q = f"EXT_ID:{pmid} AND SRC:MED" if pmid else f"PMCID:{pmcid}" if pmcid else f'DOI:"{doi}"'
    j = _jget(EPMC_SEARCH + "?" + urlencode({"query": q, "format": "json", "resultType": "core", "pageSize": 1}))
    r = ((j.get("resultList") or {}).get("result") or [None])[0]
    return r


def _bib_epmc(r: dict) -> dict:
    ji = r.get("journalInfo") or {}
    jn = ji.get("journal") or {}
    authors = [{"family": a["lastName"], "given": a.get("firstName") or a.get("initials") or ""} if a.get("lastName")
               else {"literal": a.get("collectiveName") or a.get("fullName") or ""}
               for a in (r.get("authorList") or {}).get("author", [])]
    return {"source": "europepmc", "title": _clean(r.get("title")).rstrip("."), "authors": [a for a in authors if any(a.values())],
            "journal": jn.get("title") or "", "journal_abbr": jn.get("isoabbreviation") or jn.get("medlineAbbreviation") or "",
            "year": str(ji.get("yearOfPublication") or r.get("pubYear") or ""), "volume": ji.get("volume") or "",
            "issue": ji.get("issue") or "", "pages": r.get("pageInfo") or "", "doi": r.get("doi") or "",
            "pmid": r.get("pmid") or "", "pmcid": r.get("pmcid") or "", "issn": jn.get("issn") or jn.get("essn") or ""}


def _bib_crossref(m: dict) -> dict:
    date = ((m.get("published-print") or m.get("published-online") or m.get("issued") or {}).get("date-parts") or [[None]])[0]
    authors = [{"family": _clean(a["family"]), "given": _clean(a.get("given"))} if a.get("family") else {"literal": _clean(a.get("name"))}
               for a in m.get("author") or []]
    return {"source": "crossref", "title": _clean(_first(m.get("title"))), "authors": [a for a in authors if any(a.values())],
            "journal": _clean(_first(m.get("container-title"))), "journal_abbr": _clean(_first(m.get("short-container-title"))),
            "year": str(date[0] or "") if date else "", "volume": m.get("volume") or "", "issue": m.get("issue") or "",
            "pages": m.get("page") or m.get("article-number") or "", "doi": m.get("DOI") or "",
            "issn": _first(m.get("ISSN")), "type": m.get("type") or ""}


def crossref_lookup(doi: str) -> dict | None:
    try:
        return _bib_crossref(_jget("https://api.crossref.org/works/" + quote(doi, safe="/"))["message"])
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def _norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def crossref_by_title(title: str, year: str = "") -> dict | None:
    if len(_norm_title(title)) < 20:
        return None
    j = _jget("https://api.crossref.org/works?" + urlencode({"query.bibliographic": title, "rows": 3}))
    for m in (j.get("message") or {}).get("items") or []:
        b = _bib_crossref(m)
        same = difflib.SequenceMatcher(None, _norm_title(b["title"]), _norm_title(title)).ratio() >= 0.93
        if same and (not year or not b["year"] or abs(int(b["year"]) - int(re.sub(r"\D", "", year)[:4] or b["year"])) <= 1):
            return b
    return None


def lookup_biblio(doi: str = "", pmid: str = "", pmcid: str = "", title: str = "", year: str = "") -> dict | None:
    """Crossref when there is a DOI (authoritative), else Europe PMC, else a strict Crossref title match."""
    b = crossref_lookup(doi) if doi else None
    if not b and (pmid or pmcid or doi):
        r = epmc_lookup(doi, pmid, pmcid)
        b = _bib_epmc(r) if r else None
    if not b and title:
        b = crossref_by_title(title, year)
    return b


def _split_name(n: str) -> dict:
    n = re.sub(r"\s+", " ", n).strip().strip(",")
    m = re.fullmatch(r"(.+?)\s+([A-Z]{1,4})", n)  # Vancouver style "Zelniker TA"
    if m:
        return {"family": m.group(1), "given": " ".join(m.group(2))}
    parts = n.split(" ")
    return {"literal": n} if len(parts) == 1 else {"family": parts[-1], "given": " ".join(parts[:-1])}


def _bib_fallback(pid: str, d: Path) -> dict:
    meta = read_json(d / "meta.json", {})
    a = read_json(d / "analysis.json") or {}
    am = a.get("meta") or {}
    full = meta.get("authors_full") or ""
    short = am.get("authors") or ""
    names = full.split(";") if full else re.split(r",\s*", re.sub(r",?\s*et al\.?", "", short))
    if re.search(r"論文未提及|未列", short + full):
        names = []
    return {"source": "ai", "title": a.get("title") or meta.get("title") or meta.get("filename") or "",
            "authors": [_split_name(n) for n in names if n.strip()], "etal": not full and "et al" in short,
            "journal": am.get("journal") or "", "year": re.sub(r"\D", "", str(am.get("year") or ""))[:4],
            "volume": am.get("volume") or "", "issue": "", "pages": am.get("pages") or "",
            "doi": meta.get("doi") or am.get("doi") or "", "pmid": meta.get("pmid") or "", "pmcid": meta.get("pmcid") or ""}


def biblio(pid: str) -> dict:
    """Cached in biblio.json once a lookup succeeds; AI-extracted fields are the fallback."""
    d = PAPERS / pid
    cached = read_json(d / "biblio.json")
    if cached:
        return cached
    fb = _bib_fallback(pid, d)
    try:
        b = lookup_biblio(fb["doi"], fb["pmid"], fb["pmcid"], fb["title"], fb["year"])
    except Exception:  # noqa: BLE001 — offline or rate-limited: use what the AI read off the PDF
        b = None
    if b:
        b.setdefault("pmid", fb["pmid"])
        b.setdefault("pmcid", fb["pmcid"])
        write_json(d / "biblio.json", b)
        return b
    return fb


# ---------------------------------------------------------------- citation formats

def _initials(given: str) -> str:
    out = []
    for part in (given or "").replace(".", " ").split():
        if re.fullmatch(r"[A-Z]{2,4}", part):  # "TA"
            out += [c + "." for c in part]
        else:
            out.append("-".join(s[0].upper() + "." for s in part.split("-") if s))
    return " ".join(out)


def _apa_author(a: dict) -> str:
    if a.get("literal"):
        return a["literal"]
    ini = _initials(a.get("given") or "")
    return f"{a.get('family')}, {ini}" if ini else a.get("family") or ""


def _pages(p: str) -> str:
    return re.sub(r"\s*-+\s*", "–", str(p or "").strip())


def apa(b: dict, as_html: bool = False) -> str:
    e = (lambda s: html.escape(str(s))) if as_html else str
    it = (lambda s: f"<i>{e(s)}</i>") if as_html else str
    names = [_apa_author(a) for a in b.get("authors") or []]
    names = [n for n in names if n]
    if len(names) > 20:
        who = ", ".join(names[:19]) + ", . . . " + names[-1]
    elif len(names) > 1:
        who = ", ".join(names[:-1]) + ", & " + names[-1]
    else:
        who = names[0] if names else ""
    if who and b.get("etal"):
        who += ", et al."
    title = (b.get("title") or "").strip()
    if title and title[-1] not in ".?!":
        title += "."
    year = f"({b['year']})." if b.get("year") else "(n.d.)."
    src = ""
    if b.get("journal"):
        src = it(b["journal"])
        if b.get("volume"):
            src += ", " + it(b["volume"]) + (f"({e(b['issue'])})" if b.get("issue") else "")
        if b.get("pages"):
            src += ", " + e(_pages(b["pages"]))
        src += "."
    doi = f" https://doi.org/{e(b['doi'])}" if b.get("doi") else ""
    if who:
        who_txt = e(who) if who.endswith(".") else e(who) + "."
        return f"{who_txt} {year} {e(title)} {src}".rstrip() + doi
    return f"{e(title)} {year} {src}".rstrip() + doi


def _bib_key(b: dict, used: set) -> str:
    a = (b.get("authors") or [{}])[0]
    fam = unicodedata.normalize("NFKD", a.get("family") or a.get("literal") or "anon").encode("ascii", "ignore").decode()
    words = re.findall(r"[A-Za-z]+", b.get("title") or "")
    kw = next((w.lower() for w in words if w.lower() not in TITLE_STOP and len(w) > 2), "paper")
    key = base = f"{re.sub(r'[^a-z]', '', fam.lower()) or 'anon'}{b.get('year') or ''}{kw}"
    n = 1
    while key in used:
        n += 1
        key = f"{base}{chr(96 + n)}"
    used.add(key)
    return key


def _tex(s) -> str:
    return re.sub(r"([&%$#_])", r"\\\1", str(s or ""))


def bibtex_entry(b: dict, key: str) -> str:
    authors = " and ".join("{" + _tex(a["literal"]) + "}" if a.get("literal") else f"{_tex(a.get('family'))}, {_tex(a.get('given'))}".rstrip(", ")
                           for a in b.get("authors") or [])
    fields = [("author", authors), ("title", "{" + _tex(b.get("title")) + "}"), ("journal", _tex(b.get("journal"))),
              ("year", b.get("year")), ("volume", b.get("volume")), ("number", b.get("issue")),
              ("pages", str(b.get("pages") or "").replace("–", "--").replace("-", "--").replace("----", "--")),
              ("doi", b.get("doi")), ("pmid", b.get("pmid")), ("pmcid", b.get("pmcid")), ("issn", b.get("issn"))]
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields if v)
    return f"@article{{{key},\n{body}\n}}"


def _x(s) -> str:
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(s or ""))
    return html.escape(s, quote=True)


def zotero_rdf(items: list, files: dict | None = None) -> str:
    """Zotero RDF (what Zotero itself exports): one z:Collection per library category; with
    `files` ({index: relative path}) each item links its PDF as a z:Attachment."""
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:z="http://www.zotero.org/namespaces/export#"'
           ' xmlns:dcterms="http://purl.org/dc/terms/" xmlns:bib="http://purl.org/net/biblio#" xmlns:foaf="http://xmlns.com/foaf/0.1/"'
           ' xmlns:link="http://purl.org/rss/1.0/modules/link/" xmlns:dc="http://purl.org/dc/elements/1.1/"'
           ' xmlns:prism="http://prismstandard.org/namespaces/1.2/basic/">']
    collections: dict = {}
    for i, (b, category) in enumerate(items):
        ref = f"#item_{i}"
        if category:
            collections.setdefault(category, []).append(ref)
        out.append(f'  <bib:Article rdf:about="{ref}">')
        out.append("    <z:itemType>journalArticle</z:itemType>")
        if b.get("journal") or b.get("volume"):
            out.append(f'    <dcterms:isPartOf rdf:resource="#journal_{i}"/>')
        if b.get("authors"):
            out.append("    <bib:authors><rdf:Seq>")
            for a in b["authors"]:
                person = (f"<foaf:surname>{_x(a['literal'])}</foaf:surname>" if a.get("literal") else
                          f"<foaf:surname>{_x(a.get('family'))}</foaf:surname><foaf:givenName>{_x(a.get('given'))}</foaf:givenName>")
                out.append(f"      <rdf:li><foaf:Person>{person}</foaf:Person></rdf:li>")
            out.append("    </rdf:Seq></bib:authors>")
        if files and i in files:
            out.append(f'    <link:link rdf:resource="#attachment_{i}"/>')
        out.append(f"    <dc:title>{_x(b.get('title'))}</dc:title>")
        if b.get("year"):
            out.append(f"    <dc:date>{_x(b['year'])}</dc:date>")
        if b.get("pages"):
            out.append(f"    <bib:pages>{_x(str(b['pages']).replace('–', '-'))}</bib:pages>")
        if b.get("doi"):
            out.append(f"    <dc:identifier>DOI {_x(b['doi'])}</dc:identifier>")
            out.append(f"    <dc:identifier><dcterms:URI><rdf:value>https://doi.org/{_x(b['doi'])}</rdf:value></dcterms:URI></dc:identifier>")
        extra = "\n".join(x for x in (f"PMID: {b['pmid']}" if b.get("pmid") else "", f"PMCID: {b['pmcid']}" if b.get("pmcid") else "") if x)
        if extra:
            out.append(f"    <z:extra>{_x(extra)}</z:extra>")
        out.append("  </bib:Article>")
        if b.get("journal") or b.get("volume"):
            out.append(f'  <bib:Journal rdf:about="#journal_{i}">')
            for tag, key in (("dc:title", "journal"), ("dcterms:alternative", "journal_abbr"), ("prism:volume", "volume"), ("prism:number", "issue")):
                if b.get(key):
                    out.append(f"    <{tag}>{_x(b[key])}</{tag}>")
            if b.get("doi"):
                out.append(f"    <dc:identifier>DOI {_x(b['doi'])}</dc:identifier>")
            if b.get("issn"):
                out.append(f"    <dc:identifier>ISSN {_x(b['issn'])}</dc:identifier>")
            out.append("  </bib:Journal>")
        if files and i in files:
            out += [f'  <z:Attachment rdf:about="#attachment_{i}">', "    <z:itemType>attachment</z:itemType>",
                    f'    <rdf:resource rdf:resource="{_x(files[i])}"/>', "    <dc:title>Full Text PDF</dc:title>",
                    "    <link:type>application/pdf</link:type>", "  </z:Attachment>"]
    for j, (name, refs) in enumerate(collections.items()):
        out.append(f'  <z:Collection rdf:about="#collection_{j}">')
        out.append(f"    <dc:title>{_x(name)}</dc:title>")
        out += [f'    <dcterms:hasPart rdf:resource="{r}"/>' for r in refs]
        out.append("  </z:Collection>")
    out.append("</rdf:RDF>")
    return "\n".join(out) + "\n"


def _safe_name(s: str, n: int = 80) -> str:
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", s or "").strip()[:n].strip() or "paper"


def export_citations(ids: list, fmt: str) -> dict:
    ids = [i for i in ids if re.fullmatch(r"[0-9a-f]{12}", str(i)) and (PAPERS / i / "meta.json").exists()]
    if not ids:
        raise ValueError("沒有可匯出的論文")
    with ThreadPoolExecutor(max_workers=6) as ex:  # lookups hit the network once per paper, then biblio.json
        bibs = list(ex.map(biblio, ids))
    stamp = time.strftime("%Y%m%d")
    if fmt == "apa":
        order = sorted(range(len(ids)), key=lambda k: (_apa_author((bibs[k].get("authors") or [{}])[0]) or bibs[k].get("title") or "").lower())
        return {"text": "\n\n".join(apa(bibs[k]) for k in order),
                "html": "".join(f"<p>{apa(bibs[k], True)}</p>" for k in order), "name": f"references-apa-{stamp}.txt",
                "fallback": sum(b.get("source") == "ai" for b in bibs)}
    if fmt == "bibtex":
        used: set = set()
        return {"text": "\n\n".join(bibtex_entry(b, _bib_key(b, used)) for b in bibs) + "\n", "name": f"references-{stamp}.bib",
                "fallback": sum(b.get("source") == "ai" for b in bibs)}
    cats = [read_json(PAPERS / i / "meta.json", {}).get("category") or "" for i in ids]
    if fmt == "rdf":
        return {"text": zotero_rdf(list(zip(bibs, cats))), "name": f"paper-reader-{stamp}.rdf",
                "fallback": sum(b.get("source") == "ai" for b in bibs)}
    if fmt == "rdfzip":
        files = {k: f"files/{k}/{_safe_name(b.get('title'))}.pdf" for k, b in enumerate(bibs)}
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"paper-reader-{stamp}.rdf", zotero_rdf(list(zip(bibs, cats)), files))
            for k, pid in enumerate(ids):
                z.write(PAPERS / pid / "paper.pdf", files[k])
        return {"zip": buf.getvalue(), "name": f"paper-reader-zotero-{stamp}.zip"}
    raise ValueError("不明的匯出格式")


# ---------------------------------------------------------------- import by DOI / PMID / PMCID / URL

def parse_ref(raw: str) -> dict:
    t = unquote(str(raw or "").strip().strip("<>").strip())
    ref = {"raw": t, "doi": "", "pmid": "", "pmcid": "", "url": ""}
    if re.match(r"https?://", t, re.I):
        ref["url"] = t
        path = urlparse(t).path
        m = re.search(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d{1,9})", t) or re.search(r"europepmc\.org/(?:abstract|article)/MED/(\d{1,9})", t, re.I)
        if m:
            ref["pmid"] = m.group(1)
        m = re.search(r"\b(PMC\d{3,9})\b", t, re.I)
        if m and re.search(r"ncbi\.nlm\.nih\.gov|europepmc\.org", t, re.I):
            ref["pmcid"] = m.group(1).upper()
        m = DOI_RE.search(path)
        if m:
            ref["doi"] = re.sub(r"/(full|abstract|pdf|epdf|fulltext|html)$", "", m.group(1), flags=re.I)
        return ref
    m = re.fullmatch(r"(?:pmc(?:id)?:?\s*)?(PMC\d{3,9})", t, re.I)
    if m:
        ref["pmcid"] = m.group(1).upper()
        return ref
    m = re.fullmatch(r"(?:pmid:?\s*)?(\d{1,9})", t, re.I)
    if m:
        ref["pmid"] = m.group(1)
        return ref
    m = DOI_RE.search(t)
    if m:
        ref["doi"] = m.group(1)
        return ref
    raise ValueError("看不出是 DOI、PMID、PMCID 還是網址")


def _pdf_in_page(page: bytes, base: str) -> str | None:
    m = (re.search(rb'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)', page, re.I)
         or re.search(rb'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']citation_pdf_url', page, re.I))
    return urljoin(base, html.unescape(m.group(1).decode("utf-8", "replace"))) if m else None


def _fetch_pdf(url: str, progress=None, timeout: int = 45, depth: int = 0) -> bytes:
    body, ctype, final = _http(url, "application/pdf,text/html;q=0.9,*/*;q=0.8", timeout, progress=progress)
    k = body.find(b"%PDF", 0, 1024)
    if k >= 0:
        return body[k:]
    nxt = _pdf_in_page(body, final) if depth == 0 and "html" in ctype.lower() else None
    if nxt and nxt != url:
        return _fetch_pdf(nxt, progress, timeout, 1)
    if re.search(rb"Just a moment|cf-chl|captcha|Preparing to download", body[:20000], re.I):
        raise ValueError("網站要求在瀏覽器裡驗證")
    raise ValueError("下載到的不是 PDF")


def _pmc_s3_pdf(pmcid: str) -> str | None:
    xml = _http(f"{PMC_S3}/?list-type=2&prefix={pmcid}.&delimiter=/", timeout=30)[0].decode("utf-8", "replace")
    versions = sorted(int(v) for v in re.findall(rf"<Prefix>{pmcid}\.(\d+)/</Prefix>", xml))
    return f"{PMC_S3}/{pmcid}.{versions[-1]}/{pmcid}.{versions[-1]}.pdf" if versions else None


def import_ref(raw: str, say) -> dict:
    """Find an open-access PDF for one reference and add it to the library. say(msg) reports progress."""
    ref = parse_ref(raw)
    info: dict = {}
    if ref["doi"] or ref["pmid"] or ref["pmcid"]:
        say("查詢 Europe PMC…")
        try:
            r = epmc_lookup(ref["doi"], ref["pmid"], ref["pmcid"])
        except Exception:  # noqa: BLE001
            r = None
        if r:
            info = _bib_epmc(r)
            for k in ("doi", "pmid", "pmcid"):
                ref[k] = ref[k] or (info.get(k) or "")
            avail = [f.get("url") for f in (r.get("fullTextUrlList") or {}).get("fullTextUrl", [])
                     if f.get("documentStyle") == "pdf" and f.get("availabilityCode") in ("OA", "F")]
        else:
            avail = []
        if ref["pmid"] and not r:
            raise ValueError("Europe PMC 查不到這個 PMID")
    else:
        avail = []
    cands = [u for u in avail if u]
    if ref["doi"]:
        say("查詢 OpenAlex／Semantic Scholar 的開放取用版本…")
        try:
            w = _jget("https://api.openalex.org/works/https://doi.org/" + quote(ref["doi"], safe="/"))
            locs = [w.get("best_oa_location") or {}] + list(w.get("locations") or [])
            for loc in locs:
                u = loc.get("pdf_url") or ""
                m = re.search(r"(PMC\d{3,9})", u)
                if m and not ref["pmcid"]:
                    ref["pmcid"] = m.group(1)
                cands.append(u)
        except Exception:  # noqa: BLE001
            pass
        try:
            s2 = _jget(f"https://api.semanticscholar.org/graph/v1/paper/DOI:{quote(ref['doi'], safe='/')}?fields=openAccessPdf,externalIds")
            cands.append((s2.get("openAccessPdf") or {}).get("url") or "")
            pmc = (s2.get("externalIds") or {}).get("PubMedCentral")
            if pmc and not ref["pmcid"]:
                ref["pmcid"] = f"PMC{pmc}"
        except Exception:  # noqa: BLE001
            pass
    if ref["url"] and not (ref["doi"] or ref["pmid"] or ref["pmcid"]):
        cands.insert(0, ref["url"])
    seen, tries = set(), []
    for u in cands:
        if u and u not in seen and urlparse(u).hostname not in CHALLENGE_HOSTS:
            seen.add(u)
            tries.append(("出版社開放取用版", u, 45))
    if ref["pmcid"]:
        tries.append(("PMC 開放取用資料集", "pmc-s3", 300))
    if ref["doi"]:
        tries.append(("期刊頁面", f"https://doi.org/{ref['doi']}", 45))
    pdf, errors, source = None, [], ""
    for label, u, timeout in tries:
        host = ""
        try:
            if u == "pmc-s3":
                say("查詢 PMC 開放取用資料集…")
                u = _pmc_s3_pdf(ref["pmcid"])
                if not u:
                    errors.append("PMC：不在開放取用資料集")
                    continue
            host = urlparse(u).hostname or ""
            say(f"下載中：{label}（{host}）…")
            last = [0.0]

            def prog(n, total, label=label):
                if time.time() - last[0] > 1.5:
                    last[0] = time.time()
                    say(f"下載中：{label} {n / 2**20:.1f}" + (f"／{total / 2**20:.1f}" if total else "") + " MB…")

            pdf, source = _fetch_pdf(u, prog, timeout), u
            break
        except Exception as e:  # noqa: BLE001 — try the next source
            errors.append(f"{host or label}：{e if isinstance(e, ValueError) else type(e).__name__}")
    open_url = f"https://doi.org/{ref['doi']}" if ref["doi"] else (
        f"https://pubmed.ncbi.nlm.nih.gov/{ref['pmid']}/" if ref["pmid"] else ref["url"])
    if not pdf:
        why = "；".join(errors[-3:]) or "找不到開放取用的 PDF"
        raise ImportFailed(f"找不到可以直接下載的 PDF（{why}）。可能需要訂閱，請在瀏覽器開啟後用 Chrome 擴充功能或拖曳 PDF 匯入。", open_url)
    say("解析 PDF…")
    name = _safe_name(info.get("title") or ref["doi"] or ref["pmcid"] or ref["pmid"] or "paper") + ".pdf"
    meta = add_paper(name, pdf)
    upd = {k: ref[k] for k in ("doi", "pmid", "pmcid") if ref[k]}
    upd.update(source_url=source, imported_from=ref["raw"])
    pid = meta["id"]
    update_meta(pid, **upd)
    if info and not (PAPERS / pid / "biblio.json").exists():
        try:
            b = (crossref_lookup(ref["doi"]) if ref["doi"] else None) or info
        except Exception:  # noqa: BLE001
            b = info
        b.update({k: b.get(k) or ref[k] for k in ("doi", "pmid", "pmcid")})
        write_json(PAPERS / pid / "biblio.json", b)
    return {"id": pid, "title": info.get("title") or meta.get("title"), "restored": bool(meta.get("restored")),
            "existed": bool(meta.get("existed"))}


class ImportFailed(ValueError):
    def __init__(self, msg: str, open_url: str = ""):
        super().__init__(msg)
        self.open_url = open_url


def import_many(refs: list, emit) -> dict:
    results = []
    for i, raw in enumerate(refs):
        def say(msg, i=i):
            emit(json.dumps({"i": i, "msg": msg}, ensure_ascii=False))
        try:
            results.append({"ref": raw, "ok": True, **import_ref(raw, say)})
        except ImportFailed as e:
            results.append({"ref": raw, "ok": False, "error": str(e), "open_url": e.open_url})
        except Exception as e:  # noqa: BLE001
            if not isinstance(e, (ValueError, urllib.error.URLError)):
                traceback.print_exc()
            results.append({"ref": raw, "ok": False, "error": str(e) or type(e).__name__})
        say("完成" if results[-1]["ok"] else "失敗")
    return {"results": results}


# ---------------------------------------------------------------- papers

def add_paper(filename: str, body: bytes) -> dict:
    if not body.startswith(b"%PDF"):
        raise ValueError("這不是 PDF 檔")
    pid = hashlib.sha1(body).hexdigest()[:12]
    d = PAPERS / pid
    if (d / "meta.json").exists():
        return {**read_json(d / "meta.json"), "existed": True}
    if (trash_dir() / pid / "meta.json").exists():
        return {**restore_paper(pid), "restored": True}
    d.mkdir(parents=True, exist_ok=True)
    (d / "paper.pdf").write_bytes(body)
    layout = build_layout(d / "paper.pdf")
    write_json(d / "layout.json", layout)
    stem = re.sub(r"\.pdf$", "", filename, flags=re.I)
    meta = {"id": pid, "filename": filename, "title": guess_title(d / "paper.pdf", stem),
            "pages": len(layout["pages"]), "added": now_iso(),
            "has_text": any(pg["blocks"] for pg in layout["pages"])}
    write_json(d / "meta.json", meta)
    if meta["has_text"]:
        start_job(pid, "analyze", task_analyze)
    return meta


def list_papers(base: Path | None = None) -> list:
    out = []
    base = PAPERS if base is None else base
    if base.exists():
        for d in base.iterdir():
            meta = read_json(d / "meta.json")
            if not meta:
                continue
            a = read_json(d / "analysis.json") or {}
            am = a.get("meta") or {}
            meta["translated"] = len(list((d / "trans").glob("p*.json"))) if (d / "trans").exists() else 0
            meta["analyzed"] = bool(a)
            meta["opened"] = read_json(d / "view.json", {}).get("opened", meta["added"])
            meta.update(authors=am.get("authors") or "", journal=am.get("journal") or "", year=str(am.get("year") or ""),
                        study_type=am.get("study_type") or "", tldr=a.get("tldr") or [], summary=a.get("summary") or "",
                        keywords=[" ".join(filter(None, (k.get("term"), k.get("zh"))))
                                  for k in a.get("keywords") or [] if isinstance(k, dict)],
                        status=_status_of(meta, d), starred=bool(meta.get("starred")))
            out.append(meta)
    out.sort(key=lambda m: m.get("opened", ""), reverse=True)
    return out


def paper_state(pid: str) -> dict:
    d = pdir(pid)
    trans_dir = d / "trans"
    return {
        "meta": {**read_json(d / "meta.json"), "status": _status_of(read_json(d / "meta.json"), d)},
        "analysis": read_json(d / "analysis.json"),
        "autohl": read_json(d / "autohl.json"),
        "highlights": read_json(d / "highlights.json", []),
        "explanations": read_json(d / "explanations.json", []),
        "chat": read_json(d / "chat.json", []),
        "quiz": read_json(d / "quiz.json"),
        "refs": read_json(d / "refs.json"),
        "notes": (d / "notes.md").read_text(encoding="utf-8") if (d / "notes.md").exists() else "",
        "view": read_json(d / "view.json", {}),
        "translated": sorted(int(p.stem[1:]) for p in trans_dir.glob("p*.json")) if trans_dir.exists() else [],
        # pages still streaming: {page: blocks translated so far} — lets the UI show blocks as they arrive
        "partial": {str(k[1]): len(v) for k, v in list(PARTIAL.items()) if k[0] == pid},
        "jobs": jobs_of(pid),
        "skillnotes": [{**r, "log": (r.get("log") or [])[-80:]} for r in list_runs(pid)],
    }


def translations(pid: str) -> dict:
    d = pdir(pid) / "trans"
    pages, partial = {}, []
    for (p_id, pno), part in list(PARTIAL.items()):
        if p_id == pid:
            pages[str(pno)] = dict(part)
            partial.append(pno)
    if d.exists():
        for p in d.glob("p*.json"):
            pages[str(int(p.stem[1:]))] = (read_json(p) or {}).get("t", {})
    return {"pages": pages, "partial": [p for p in partial if not (d / f"p{p:04d}.json").exists()]}


# ---------------------------------------------------------------- HTTP

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".ico": "image/x-icon", ".json": "application/json; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    server_version = "PaperReader/1.0"

    def log_request(self, code="-", size="-"):  # only log failures
        try:
            if int(code) >= 400:
                sys.stderr.write(f"{self.requestline} -> {int(code)}\n")
        except (TypeError, ValueError):
            pass

    # -- helpers
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _err(self, code: int, msg: str):
        self._json({"error": msg}, code)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _jbody(self) -> dict:
        b = self._body()
        return json.loads(b.decode("utf-8")) if b else {}

    def _stream(self, fn):
        """Server-sent events: {"d": text-delta}… then {"done": true, "item": …} or {"error": …}.

        fn(emit) does the work; if the browser goes away mid-answer the work still finishes
        and is saved, so nothing is lost by closing a panel early.
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        lock, gone = threading.Lock(), [False]

        def send(obj):
            if gone[0]:
                return
            with lock:
                try:
                    self.wfile.write(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except OSError:
                    gone[0] = True

        def emit(t):
            send({"d": t})

        emit.reset = lambda: send({"reset": True})  # a retry is starting: clear the streamed text
        try:
            send({"done": True, "item": fn(emit)})
        except Exception as e:  # noqa: BLE001 — headers are already sent, report in-band
            if not isinstance(e, (LLMError, ValueError, KeyError)):
                traceback.print_exc()
            send({"error": str(e) if not isinstance(e, KeyError) else "找不到這篇論文"})

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _route(self, method: str):
        if not self._host_ok():
            return self._err(403, "forbidden host")
        url = urlparse(self.path)
        path, qs = url.path, parse_qs(url.query)
        if method != "GET" and self.headers.get("X-Paper-Reader") != "1":
            return self._err(403, "missing X-Paper-Reader header")
        if method != "GET" and moving() and not path.startswith("/api/library/location"):
            return self._err(409, "書庫正在搬移，請等搬移完成再操作")
        try:
            if path.startswith("/api/"):
                return self._api(method, path[5:].strip("/").split("/"), qs)
            if method == "GET":
                return self._static(path)
            return self._err(404, "not found")
        except KeyError:
            return self._err(404, "找不到這篇論文")
        except LLMError as e:
            return self._err(502, str(e))
        except VaultConflict as e:
            return self._json({"error": str(e), "conflict": True}, 409)
        except ValueError as e:
            return self._err(400, str(e))
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._err(500, f"{type(e).__name__}: {e}")

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def _static(self, path: str):
        if path in ("/", "/index.html"):
            path = "/index.html"
        f = (STATIC / path.lstrip("/")).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            return self._err(404, "not found")
        self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"))

    def _location(self, method: str, rest: list):
        if rest == [] and method == "GET":
            return self._json(location_state())
        if method != "POST":
            return self._err(404, "not found")
        b = self._jbody()
        if rest == ["inspect"]:
            return self._json(inspect_target(str(b.get("path", ""))))
        if rest == ["move"]:
            mode = str(b.get("mode", ""))
            if mode not in ("copy", "merge", "use"):
                raise ValueError("不明的搬移方式")
            target = resolve_target(str(b.get("path", "")))
            check_can_move(target)
            return self._json({"started": start_job(LIB, "move", task_move_library, target, mode)})
        if rest == ["pick"]:
            return self._json({"path": pick_folder()})
        if rest == ["reveal"]:
            os.startfile(str(DATA))  # noqa: S606 — opens Explorer on this machine only
            return self._json({"ok": True})
        return self._err(404, "not found")

    def _api(self, method: str, parts: list, qs: dict):
        if parts == ["health"] and method == "GET":
            return self._json({"app": "paper-reader", "version": 1})
        if parts == ["papers"] and method == "GET":
            return self._json(list_papers())
        if parts == ["papers"] and method == "POST":
            name = unquote(self.headers.get("X-Filename") or "paper.pdf")
            return self._json(add_paper(name, self._body()))
        if parts == ["settings"]:
            if method == "PUT":
                s = settings()
                s.update({k: v for k, v in self._jbody().items() if k in DEFAULT_SETTINGS})
                write_json(SETTINGS_FILE, s)
                return self._json(settings())
            return self._json({**settings(), "claude": CLAUDE or "", "data_dir": str(DATA), "local_dir": str(LOCAL),
                               "models": MODELS, "efforts": EFFORTS, "tasks": TASKS,
                               "note_skills": skill_status(), "t2n_templates": T2N_TEMPLATES})
        if parts == ["library"] and method == "GET":
            return self._json(library_state())
        if parts[:2] == ["library", "location"]:
            return self._location(method, parts[2:])
        if parts == ["batch"] and method == "POST":
            b = self._jbody()
            return self._json(batch(b.get("ids") or [], str(b.get("op", "")), b.get("value")))
        if parts == ["cite"] and method == "POST":
            b = self._jbody()
            out = export_citations(b.get("ids") or [], str(b.get("format", "")))
            if "zip" in out:
                return self._send(200, out["zip"], "application/zip",
                                  {"Content-Disposition": f"attachment; filename=\"{out['name']}\""})
            return self._json(out)
        if parts == ["import"] and method == "POST":
            refs = [str(r).strip() for r in self._jbody().get("refs") or [] if str(r).strip()][:50]
            return self._stream(lambda emit: import_many(refs, emit))
        if parts == ["library", "classify"] and method == "POST":
            mode = "all" if self._jbody().get("mode") == "all" else "unsorted"
            return self._json({"started": start_job(LIB, "classify", task_classify_library, mode)})
        if parts == ["categories"] and method in ("POST", "PUT", "DELETE"):
            if method == "DELETE":
                delete_category(qs.get("name", [""])[0])
            else:
                b = self._jbody()
                save_category(b.get("old", "") if method == "PUT" else "", b.get("name", ""), b.get("desc"))
            return self._json({"categories": categories()})
        if len(parts) < 2 or parts[0] != "papers":
            return self._err(404, "not found")

        pid, action = parts[1], (parts[2] if len(parts) > 2 else "")
        d = pdir(pid)
        if action == "" and method == "DELETE":
            trash_paper(pid)
            return self._json({"ok": True})
        if action == "pdf":
            return self._send(200, (d / "paper.pdf").read_bytes(), "application/pdf")
        if action == "state":
            return self._json(paper_state(pid))
        if action == "layout":
            layout = read_json(d / "layout.json")
            return self._json({"pages": [{"w": p["w"], "h": p["h"], "blocks": [
                {k: b[k] for k in ("id", "bbox", "lh", "n", "text", "ref")} for b in p["blocks"]]}
                for p in layout["pages"]]})
        if action == "image":
            name = qs.get("name", [""])[0]
            f = (d / "images" / name).resolve()
            if (d / "images").resolve() not in f.parents or not f.is_file():
                return self._err(404, "not found")
            return self._send(200, f.read_bytes(), "image/png")
        if action == "translations":
            return self._json(translations(pid))
        if action == "skillnote" and method == "GET":
            return self._json(read_skill_note(pid, qs.get("id", [""])[0]))
        if action == "skillnote" and method == "DELETE":
            delete_run(pid, qs.get("id", [""])[0])
            return self._json({"ok": True})
        if action == "skillasset":
            f = skill_asset(pid, qs.get("id", [""])[0], qs.get("name", [""])[0])
            if not f:
                return self._err(404, "not found")
            return self._send(200, f.read_bytes(), IMG_MIME[f.suffix.lower()])
        if action == "markdown":
            return self._json({"name": f"{citekey(pid)}.md", "markdown": build_markdown(pid)})
        if action == "view" and method == "PUT":
            v = read_json(d / "view.json", {})
            v.update(self._jbody())
            v["opened"] = now_iso()
            write_json(d / "view.json", v)
            if read_json(d / "meta.json", {}).get("status") in (None, "unread"):
                update_meta(pid, status="reading")
            return self._json(v)

        body = self._jbody() if method in ("POST", "PUT") else {}
        if action == "analyze":
            return self._json({"started": start_job(pid, "analyze", task_analyze)})
        if action == "translate-page":
            p = int(body.get("page", 0))
            return self._json({"started": start_job(pid, f"tp{p}", translate_page, p)})
        if action == "translate-all":
            return self._json({"started": start_job(pid, "translate", task_translate_all, int(body.get("start", 0)))})
        if action == "autohighlight":
            return self._json({"started": start_job(pid, "autohl", task_autohighlight)})
        if action == "references":
            return self._json({"started": start_job(pid, "refs", task_references)})
        if action == "translate-text":
            text = str(body.get("text", ""))[:6000]
            return self._stream(lambda emit: {"text": quick_translate(text, on_text=emit)})
        if action == "explain":
            page, anchor = int(body.get("page", 0)), body.get("bbox")
            if body.get("block"):
                return self._stream(lambda emit: explain_text(pid, page, block=str(body["block"]), on_text=emit))
            text = str(body.get("text", ""))[:8000]
            return self._stream(lambda emit: explain_text(pid, page, text=text, anchor=anchor, on_text=emit))
        if action == "explain-image":
            page, png, anchor = int(body.get("page", 0)), str(body["png"]), body.get("bbox")
            return self._stream(lambda emit: explain_image(pid, png, page, anchor=anchor, on_text=emit))
        if action == "chat" and method == "POST":
            msg = str(body.get("message", ""))[:4000]
            return self._stream(lambda emit: chat(pid, msg, body.get("model"), body.get("effort"), on_text=emit))
        if action == "chat" and method == "DELETE":
            write_json(d / "chat.json", [])
            return self._json({"ok": True})
        if action == "quiz":
            n = max(3, min(15, int(body.get("n", 5))))
            return self._json(make_quiz(pid, n, str(body.get("difficulty", "easy"))))
        if action == "vault" and method == "POST":
            return self._json(export_to_vault(pid, bool(body.get("force"))))
        if action == "skillnote" and method == "POST":
            return self._json({"run": start_skill_note(pid, body)})
        if action == "skillnote-cancel" and method == "POST":
            cancel_run(pid, str(body.get("id", "")))
            return self._json({"ok": True})
        if action == "category" and method == "PUT":
            return self._json(set_category(pid, str(body.get("category") or "")))
        if action == "notes" and method == "PUT":
            (d / "notes.md").write_text(str(body.get("text", "")), encoding="utf-8")
            return self._json({"ok": True})
        if action == "highlights" and method == "PUT":
            write_json(d / "highlights.json", body.get("items", []))
            return self._json({"ok": True})
        if action == "explanations" and method == "DELETE":
            eid = qs.get("id", [""])[0]
            with _file_lock:
                items = [e for e in read_json(d / "explanations.json", []) if e.get("id") != eid]
                write_json(d / "explanations.json", items)
            return self._json({"ok": True})
        return self._err(404, "unknown action")


def already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/settings", timeout=1.5) as r:
            return "data_dir" in json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — anything else on the port is "not us"
        return False


def main():
    LOCAL.mkdir(parents=True, exist_ok=True)
    PAPERS.mkdir(parents=True, exist_ok=True)
    port = PORT
    if already_running(port):  # the desktop shortcut was clicked twice — reuse the running server
        print(f"論文伴讀已在執行：http://127.0.0.1:{port}/")
        if "--no-browser" not in sys.argv:
            webbrowser.open(f"http://127.0.0.1:{port}/")
        return
    for attempt in range(10):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            if "--strict-port" in sys.argv:
                sys.exit(f"無法使用連接埠 {port}，請確認沒有其他程式佔用。")
            port += 1
    else:
        sys.exit("找不到可用的連接埠")
    url = f"http://127.0.0.1:{port}/"
    print(f"論文伴讀已啟動：{url}（只接受本機連線，Ctrl+C 結束）")
    print(f"書庫：{DATA}" + (f"（設定的 {LIB_MISSING} 找不到，暫用本機書庫）" if LIB_MISSING else ""))
    threading.Thread(target=_heartbeat_loop, daemon=True).start()
    if not CLAUDE:
        print("警告：找不到 claude CLI，AI 功能無法使用。")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
