export const DEFAULT_PORT = 8791;
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

export function sourceUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function isReaderUrl(value) {
  const url = new URL(value);
  return ['127.0.0.1', 'localhost'].includes(url.hostname) && /^\/api\/papers\/[0-9a-f]{12}\/pdf\/?$/.test(url.pathname);
}

export function hasPdfExtension(value) {
  const url = sourceUrl(value);
  return !!url && /\.pdf$/i.test(new URL(url).pathname) && !isReaderUrl(url);
}

export function pdfResponse(details) {
  const url = sourceUrl(details.url);
  if (details.type !== 'main_frame' || details.tabId < 0 || !url || isReaderUrl(url)) return null;
  if (details.statusCode < 200 || details.statusCode >= 300) return null;
  const headers = details.responseHeaders || [];
  const type = headers.find(h => h.name.toLowerCase() === 'content-type')?.value?.split(';')[0].trim().toLowerCase();
  const disposition = headers.find(h => h.name.toLowerCase() === 'content-disposition')?.value || '';
  if (/^attachment\b/i.test(disposition)) return null;
  if (type === 'application/pdf' || type === 'application/x-pdf') return { url, disposition };
  return null;
}

export function readerBase(port = DEFAULT_PORT) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('連接埠必須介於 1024 與 65535。');
  return `http://127.0.0.1:${n}`;
}

export function pdfFilename(url, disposition = '') {
  let name = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1]
    || disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    || disposition.match(/filename\s*=\s*([^;]+)/i)?.[1]
    || new URL(url).pathname.split('/').pop() || 'paper.pdf';
  try { name = decodeURIComponent(name); } catch { /* Keep malformed server names as text. */ }
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 180) || 'paper.pdf';
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

export async function readPdf(response) {
  if (!response.ok) throw new Error(`無法下載 PDF（HTTP ${response.status}）。請先在原網站完成登入，再重試。`);
  if (Number(response.headers.get('content-length')) > MAX_PDF_BYTES) throw new Error('PDF 超過 100 MB，請下載後在論文伴讀上傳。');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PDF_BYTES) throw new Error('PDF 超過 100 MB，請下載後在論文伴讀上傳。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const blob = new Blob(chunks, { type: 'application/pdf' });
  if (!(await blob.slice(0, 5).text()).startsWith('%PDF-')) {
    throw new Error('網站回傳的不是 PDF，可能需要登入或完成網站驗證。請回原頁下載 PDF，再用下方「選擇 PDF」匯入。');
  }
  return blob;
}

// Injected into the original PDF tab with scripting.executeScript, so it must
// stay self-contained. The tab already downloaded this PDF with the site's own
// session; asking the cache first avoids a second download, which publishers
// with short-lived signed links (e.g. ScienceDirect) answer with an HTML page.
export async function sendTabPdf(channel, limit) {
  const port = chrome.runtime.connect({ name: channel });
  try {
    const response = await fetch(location.href, { cache: 'force-cache', credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new Error('PDF 超過 100 MB，請下載後在論文伴讀上傳。'); }
      chunks.push(value);
    }
    const blob = new Blob(chunks);
    const step = 4 * 1024 * 1024;
    for (let start = 0; start < size; start += step) {
      const bytes = new Uint8Array(await blob.slice(start, start + step).arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      port.postMessage({ chunk: btoa(text) });
    }
    port.postMessage({ done: size });
    return true;
  } catch (error) {
    port.postMessage({ error: error.message || '無法讀取 PDF 分頁。' });
    return false;
  }
}

export function readTabPdf(chrome, { tabId, url, channel }, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const parts = [];
    const idle = Math.min(timeout, 15000);
    let port, timer, size = 0, settled = false;
    const finish = (error, blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.runtime.onConnect.removeListener(onConnect);
      try { port?.disconnect(); } catch { /* Already closed by the tab. */ }
      if (error) reject(error); else resolve(blob);
    };
    const arm = ms => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('PDF 分頁沒有回應。')), ms); };
    function onConnect(candidate) {
      // Only the script injected below, in the original tab's top frame, may answer.
      const sender = candidate.sender || {};
      if (port || candidate.name !== channel || sender.tab?.id !== tabId || sender.frameId !== 0 || sourceUrl(sender.url) !== url) return;
      port = candidate;
      port.onMessage.addListener(message => {
        arm(idle);
        if (message.error) return finish(new Error(message.error));
        if (typeof message.chunk === 'string') {
          const bytes = Uint8Array.from(atob(message.chunk), c => c.charCodeAt(0));
          size += bytes.byteLength;
          if (size > MAX_PDF_BYTES) return finish(new Error('PDF 超過 100 MB，請下載後在論文伴讀上傳。'));
          return parts.push(bytes);
        }
        if (message.done === size) finish(null, readPdf(new Response(new Blob(parts, { type: 'application/pdf' }))));
        else if ('done' in message) finish(new Error('PDF 傳輸不完整。'));
      });
      port.onDisconnect.addListener(() => finish(new Error('PDF 分頁已關閉或重新整理。')));
    }
    chrome.runtime.onConnect.addListener(onConnect);
    arm(timeout);
    chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: sendTabPdf, args: [channel, MAX_PDF_BYTES] })
      .then(() => { if (!settled) arm(idle); }, () => finish(new Error('無法讀取 PDF 分頁。')));
  });
}

export async function checkReader(base, fetcher = fetch) {
  try {
    const response = await fetcher(`${base}/api/health`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    // Existing running readers already support PDF uploads. Do not require a
    // restart while an AI job is still processing a paper.
    if (response.status === 404) {
      const legacy = await fetcher(`${base}/api/settings`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
      const settings = await legacy.json();
      if (legacy.ok && typeof settings.data_dir === 'string' && Array.isArray(settings.models) && Array.isArray(settings.tasks)) return;
      throw new Error();
    }
    const info = await response.json();
    if (!response.ok || info.app !== 'paper-reader') throw new Error();
  } catch { throw new Error('尚未連上論文伴讀。請確認連接埠，或按「重試」重新連線。'); }
}

export async function uploadPdf(base, blob, filename, fetcher = fetch) {
  const response = await fetcher(`${base}/api/papers`, {
    method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Paper-Reader': '1', 'X-Filename': encodeURIComponent(filename) },
    body: blob, signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok || !/^[0-9a-f]{12}$/.test(result.id || '')) throw new Error(result.error || '匯入失敗，請重試。');
  return `${base}/#/paper/${result.id}`;
}
