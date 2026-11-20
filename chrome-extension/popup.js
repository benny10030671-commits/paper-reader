import { pdfFilename } from './core.js';
const $ = id => document.getElementById(id);
let tabId, candidateUrl;
async function init() {
  const { autoPrompt = true } = await chrome.storage.local.get('autoPrompt');
  $('auto').checked = autoPrompt;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const reply = await chrome.runtime.sendMessage({ type: 'candidate', tabId });
  if (!reply?.ok) throw new Error(reply?.error || '無法讀取目前分頁，請重新開啟提示。');
  if (!reply.value) {
    $('heading').textContent = '請先在 Chrome 開啟 PDF';
    $('description').textContent = '偵測到 PDF 後，就能從這裡匯入論文伴讀。';
    return;
  }
  $('heading').textContent = '用論文伴讀開啟這篇 PDF？';
  $('filename').textContent = pdfFilename(reply.value.url, reply.value.disposition);
  candidateUrl = reply.value.url;
  if (reply.value.promptError) $('description').textContent = reply.value.promptError;
  $('open').disabled = false;
}
function showError(error) { $('error').textContent = error.message; $('error').hidden = false; }
$('open').onclick = async () => {
  $('open').disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'open', tabId, sourceUrl: candidateUrl });
    if (!reply?.ok) throw new Error(reply?.error || '無法開啟匯入頁面。');
    window.close();
  } catch (error) { showError(error); $('open').disabled = false; }
};
$('dismiss').onclick = () => window.close();
$('auto').onchange = () => chrome.storage.local.set({ autoPrompt: $('auto').checked }).catch(showError);
$('settings').onclick = () => chrome.runtime.openOptionsPage();
init().catch(showError);
