import { sourceUrl, pdfFilename, readPdf, readTabPdf, uploadPdf } from './core.js';
import { ensureReader } from './launcher.js';
const $ = id => document.getElementById(id);
const ticket = new URL(location.href).searchParams.get('ticket');
const key = `import:${ticket}`;
let item, busy = false;
async function run(file) {
  if (busy) return;
  busy = true;
  $('recovery').hidden = true;
  $('status').className = '';
  try {
    const { port } = await chrome.storage.local.get('port');
    $('status').textContent = '正在連接論文伴讀…';
    const base = await ensureReader(chrome, port, {
      onStarting: () => { $('status').textContent = '正在背景啟動論文伴讀，啟動後會繼續匯入…'; },
    });
    let blob, name;
    if (file) {
      blob = await readPdf(new Response(file));
      name = pdfFilename('https://local.invalid/' + encodeURIComponent(file.name));
    } else {
      if (new URL(item.url).protocol === 'file:' && !await chrome.extension.isAllowedFileSchemeAccess()) {
        throw new Error('本機 PDF 需要在 Chrome 的擴充功能詳細資料中開啟「允許存取檔案網址」，或直接在下方選擇 PDF。');
      }
      name = pdfFilename(item.url, item.disposition);
      if (Number.isInteger(item.tabId) && new URL(item.url).protocol !== 'file:') {
        $('status').textContent = '正在從 PDF 分頁取得檔案…';
        blob = await fromTab().catch(error => { console.warn('PDF 分頁讀取失敗，改由擴充功能重新下載：', error); return null; });
      }
      if (!blob) {
        $('status').textContent = '正在下載 PDF…';
        let response;
        try { response = await fetch(item.url, { credentials: 'include', signal: AbortSignal.timeout(60000) }); }
        catch { throw new Error('無法從原網站取得 PDF。請確認網路與登入狀態，或下載 PDF 後在下方選擇檔案。'); }
        name = pdfFilename(item.url, response.headers.get('content-disposition') || item.disposition);
        blob = await readPdf(response);
      }
    }
    $('status').textContent = '正在匯入書庫…';
    const destination = await uploadPdf(base, blob, name);
    await chrome.storage.session.remove(key);
    location.replace(destination);
  } catch (error) {
    $('status').textContent = error.message || '匯入失敗，請重試。';
    $('status').className = 'error';
    $('recovery').hidden = false;
  } finally { busy = false; }
}
// The original tab still holds the PDF it downloaded with the site's session.
// A fresh extension request is only the fallback: signed publisher links
// often refuse it once the tab has used them.
async function fromTab() {
  const tab = await chrome.tabs.get(item.tabId);
  if (sourceUrl(tab.url) !== item.url) throw new Error('PDF 分頁已切換。');
  return readTabPdf(chrome, { tabId: item.tabId, url: item.url, channel: `pdf:${ticket}` });
}
$('retry').onclick = () => run();
$('file').onchange = event => { const file = event.target.files[0]; if (file) run(file); event.target.value = ''; };
$('settings').onclick = () => chrome.runtime.openOptionsPage();
async function init() {
  item = (await chrome.storage.session.get(key))[key];
  if (!item || !sourceUrl(item.url)) {
    $('status').textContent = '這個匯入頁面已過期。請回到 PDF 分頁，重新點選「用論文伴讀開啟」。';
    return;
  }
  $('filename').textContent = pdfFilename(item.url, item.disposition);
  await run();
}
init().catch(error => { $('status').textContent = error.message; });
