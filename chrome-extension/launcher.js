import { readerBase, checkReader } from './core.js';

export const NATIVE_HOST = 'com.paper_reader.launcher';

// Called only by the import page after an explicit open, or the settings test.
// PDF detection never starts the desktop program.
export async function ensureReader(chrome, port, { fetcher = fetch, onStarting = () => {}, timeout = 30000, verifyLauncher = false } = {}) {
  const base = readerBase(port), expectedPort = Number(new URL(base).port);
  try { await checkReader(base, fetcher); if (!verifyLauncher) return base; } catch { /* Start on demand. */ }
  onStarting();
  let timer, reply;
  try {
    reply = await Promise.race([
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'ensure-running', port: expectedPort }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('啟動逾時，請稍後按「重試」。')), timeout); }),
    ]);
  } catch (error) {
    if (/逾時/.test(error.message)) throw error;
    throw new Error('無法連接自動啟動元件。請到「連線設定」查看一次性安裝步驟；已安裝時，請重新載入擴充功能。');
  } finally { clearTimeout(timer); }
  if (!reply?.ok) throw new Error(reply?.error || '論文伴讀未能自動啟動，請稍後重試。');
  if (reply.port !== expectedPort) throw new Error('自動啟動回覆的連接埠不符，請檢查連線設定。');
  await checkReader(base, fetcher);
  return base;
}
