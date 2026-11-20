import { DEFAULT_PORT, readerBase, checkReader } from './core.js';
import { ensureReader } from './launcher.js';
const $ = id => document.getElementById(id);
const config = await chrome.storage.local.get({ port: DEFAULT_PORT, autoPrompt: true });
$('port').value = config.port;
$('auto').checked = config.autoPrompt;
$('extension-id').textContent = chrome.runtime.id;
$('test-launch').onclick = async () => {
  $('test-launch').disabled = true;
  try {
    $('status').textContent = '正在檢查論文伴讀…';
    await ensureReader(chrome, Number($('port').value), {
      verifyLauncher: true,
      onStarting: () => { $('status').textContent = '正在確認自動啟動元件，閱讀器未啟動時會在背景開啟…'; },
    });
    $('status').textContent = '已連上論文伴讀，可以直接從 PDF 提示開啟。';
  } catch (error) { $('status').textContent = error.message; }
  finally { $('test-launch').disabled = false; }
};
$('form').onsubmit = async event => {
  event.preventDefault();
  try {
    const port = Number($('port').value), base = readerBase(port);
    await chrome.storage.local.set({ port, autoPrompt: $('auto').checked });
    $('status').textContent = '設定已儲存，正在檢查連線…';
    await checkReader(base);
    $('status').textContent = '設定已儲存，已連上論文伴讀。';
  } catch (error) { $('status').textContent = error.message; }
};
