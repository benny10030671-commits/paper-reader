import { createController } from './controller.js';
import { sourceUrl } from './core.js';

const controller = createController(chrome);
const safely = promise => promise.catch(() => {}); // Closing a tab can cancel its queued work.
chrome.webRequest.onHeadersReceived.addListener(
  details => safely(controller.headers(details)),
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }, ['responseHeaders'],
);
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url || change.status) safely(controller.updated(id, change));
});
chrome.tabs.onActivated.addListener(({ tabId }) => safely(controller.activated(tabId)));
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId >= 0) safely(chrome.tabs.query({ active: true, windowId }).then(tabs => {
    if (tabs[0]) return controller.activated(tabs[0].id);
  }));
});
chrome.tabs.onRemoved.addListener(id => safely(controller.removed(id)));
// A reload or update drops session state, and banners already on open PDF tabs
// belong to the old instance. Re-detect open PDF tabs so the next activation
// shows a working banner without reloading the page (signed links may expire).
chrome.runtime.onInstalled.addListener(() => safely(controller.restore()));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoPrompt?.newValue === true) safely(controller.restore());
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  let task;
  if (extensionPage && message.type === 'candidate' && Number.isInteger(message.tabId)) task = controller.candidate(message.tabId);
  if (extensionPage && message.type === 'open' && Number.isInteger(message.tabId)) task = controller.open(message.tabId, message.sourceUrl);
  // Content scripts use only their own sender tab and top-level PDF URL.
  // Never accept a tab ID or download URL supplied by website content.
  if (!extensionPage && sender.tab && sender.frameId === 0 && ['banner-state', 'banner-open', 'banner-options'].includes(message.type)) {
    task = (async () => {
      const item = await controller.candidate(sender.tab.id);
      if (!item || item.url !== sourceUrl(sender.url)) throw new Error('PDF 分頁已切換，請重新整理。');
      if (message.type === 'banner-open') return controller.open(sender.tab.id, sender.url);
      if (message.type === 'banner-options') return chrome.runtime.openOptionsPage();
      const { autoPrompt = true } = await chrome.storage.local.get('autoPrompt');
      return { ...item, autoPrompt };
    })();
  }
  if (!task) return;
  task.then(value => reply({ ok: true, value })).catch(error => reply({ ok: false, error: error.message }));
  return true;
});
