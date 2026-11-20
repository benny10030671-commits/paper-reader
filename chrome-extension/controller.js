import { sourceUrl, hasPdfExtension, pdfResponse, isReaderUrl } from './core.js';

// Self-contained: executeScript runs this in the tab, without fetching the URL
// again. Gmail and other signed attachment URLs often have no .pdf extension.
export function inspectDocument() {
  return { url: location.href, contentType: document.contentType };
}

// A service worker can restart between events. Keep PDF candidates in session
// storage, and serialize each tab's events to avoid stale navigation writes.
export function createController(chrome) {
  const queues = new Map();
  const key = id => `pdf:${id}`;
  const get = async id => (await chrome.storage.session.get(key(id)))[key(id)];
  const queue = (id, action) => {
    const task = (queues.get(id) || Promise.resolve()).catch(() => {}).then(action);
    queues.set(id, task);
    task.finally(() => { if (queues.get(id) === task) queues.delete(id); }).catch(() => {});
    return task;
  };
  const badge = (id, text) => chrome.action.setBadgeText({ tabId: id, text });
  async function clear(id) {
    await chrome.storage.session.remove(key(id));
    await badge(id, '').catch(() => {});
  }
  async function remember(id, candidate) {
    const previous = await get(id);
    const state = previous?.url === candidate.url ? { ...previous, ...candidate } : { ...candidate, prompted: false };
    await chrome.storage.session.set({ [key(id)]: state });
    await chrome.action.setBadgeBackgroundColor({ tabId: id, color: '#6957bd' });
    await badge(id, 'PDF');
  }
  async function discover(id) {
    const tab = await chrome.tabs.get(id), url = sourceUrl(tab.url);
    const item = await get(id);
    if (item?.url === url) return item;
    if (item) await clear(id);
    if (!url || isReaderUrl(url) || tab.discarded || tab.status !== 'complete') return null;
    const blocked = (await chrome.storage.session.get(`nonpdf:${id}`))[`nonpdf:${id}`];
    if (blocked === url) return null;
    if (blocked) await chrome.storage.session.remove(`nonpdf:${id}`);
    let observed;
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: inspectDocument });
      observed = results.find(result => result.frameId === 0)?.result;
    } catch { /* Restricted viewers can still use the known .pdf URL fallback. */ }
    // A navigation can complete while the probe is running. Never remember the
    // previous document under the new tab URL, or overwrite its response state.
    if (sourceUrl((await chrome.tabs.get(id)).url) !== url) return null;
    if (observed && sourceUrl(observed.url) !== url) return null;
    const current = await get(id);
    if (current?.url === url) return current;
    if ((await chrome.storage.session.get(`nonpdf:${id}`))[`nonpdf:${id}`] === url) return null;
    if (observed && !/^application\/(?:x-)?pdf$/i.test(observed.contentType || '')) {
      await chrome.storage.session.set({ [`nonpdf:${id}`]: url });
      return null;
    }
    if (!observed && !hasPdfExtension(url)) return null;
    await remember(id, { url });
    return get(id);
  }
  async function prompt(id) {
    const item = await get(id);
    if (!item || item.prompted) return;
    const { autoPrompt = true } = await chrome.storage.local.get('autoPrompt');
    if (!autoPrompt) return;
    const tab = await chrome.tabs.get(id);
    if (!tab.active || tab.status !== 'complete' || sourceUrl(tab.url) !== item.url) return;
    if (!(await chrome.windows.get(tab.windowId)).focused) return;
    // Inject into the PDF's outer document, not Chrome's internal PDF viewer.
    // The script is idempotent, so repeated events cannot duplicate the banner.
    let shown = false;
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, files: ['banner.js'] });
      shown = results.some(result => result.frameId === 0 && result.result === true);
    } catch { /* Retry on activation; the toolbar stays available. */ }
    const current = await get(id);
    if (current?.url !== item.url || sourceUrl((await chrome.tabs.get(id)).url) !== item.url) return;
    await chrome.storage.session.set({ [key(id)]: {
      ...current, prompted: shown,
      promptError: shown ? null : '左下角提示尚未顯示。可切換分頁再切回來重試，或直接按下方按鈕開啟。',
    } });
  }
  return {
    headers(details) { return queue(details.tabId, async () => {
      if (details.type !== 'main_frame' || details.tabId < 0) return;
      const tab = await chrome.tabs.get(details.tabId);
      const url = sourceUrl(details.url);
      if (!url || ![sourceUrl(tab.url), sourceUrl(tab.pendingUrl)].includes(url)) return;
      const item = pdfResponse(details);
      if (item) await remember(details.tabId, item);
      // An HTML login page with a .pdf URL must not be treated as a PDF.
      else if ((details.statusCode >= 200 && details.statusCode < 300) || details.statusCode >= 400) {
        await clear(details.tabId);
        await chrome.storage.session.set({ [`nonpdf:${details.tabId}`]: url });
      }
      if (item) {
        await chrome.storage.session.remove(`nonpdf:${details.tabId}`);
        await prompt(details.tabId);
      }
    }); },
    updated(id, change) { return queue(id, async () => {
      const tab = await chrome.tabs.get(id), url = sourceUrl(tab.url);
      const item = await get(id);
      if (item && item.url !== url) await clear(id);
      if (change.status !== 'complete') return;
      await discover(id);
      await prompt(id);
    }); },
    activated(id) { return queue(id, async () => { await discover(id); await prompt(id); }); },
    removed(id) { return queue(id, async () => { await clear(id); await chrome.storage.session.remove(`nonpdf:${id}`); }); },
    async restore() {
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.map(tab => this.updated(tab.id, { status: tab.status }).catch(() => {})));
    },
    async candidate(id) {
      // Do not queue this read behind prompt(): banner.js requests its state
      // while executeScript is still awaiting the banner's completion.
      const item = await discover(id), tab = await chrome.tabs.get(id);
      return item && item.url === sourceUrl(tab.url) ? { ...item, title: tab.title } : null;
    },
    async open(id, expectedUrl = null) {
      const item = await this.candidate(id);
      if (!item || isReaderUrl(item.url)) throw new Error('目前分頁不是可匯入的 PDF。');
      if (expectedUrl && item.url !== sourceUrl(expectedUrl)) throw new Error('PDF 分頁已切換，請重新點選開啟。');
      const ticket = crypto.randomUUID();
      await chrome.storage.session.set({ [`import:${ticket}`]: { ...item, tabId: id, created: Date.now() } });
      await chrome.tabs.create({ url: chrome.runtime.getURL(`open.html?ticket=${ticket}`) });
    },
  };
}
