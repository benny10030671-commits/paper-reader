import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceUrl, hasPdfExtension, pdfResponse, readerBase, pdfFilename, readPdf, checkReader, uploadPdf, sendTabPdf, readTabPdf, MAX_PDF_BYTES } from '../chrome-extension/core.js';
import { createController, inspectDocument } from '../chrome-extension/controller.js';

const pmc = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9760043/pdf/ijgm-15-8577.pdf';
const response = (url = pmc, type = 'application/pdf') => ({ tabId: 1, type: 'main_frame', statusCode: 200, url, responseHeaders: [{ name: 'Content-Type', value: type }] });

function mockChrome(url = pmc) {
  const session = {}, local = {}, calls = { banners: [], probes: [], badges: [], created: [] };
  const documents = new Map();
  const tabs = new Map([[1, { id: 1, url, active: true, status: 'complete', windowId: 2, title: 'Example paper' }]]);
  const storage = data => ({
    async get(key) { return typeof key === 'string' ? { [key]: data[key] } : { ...key, ...data }; },
    async set(value) { Object.assign(data, value); },
    async remove(key) { delete data[key]; },
  });
  const chrome = {
    storage: { session: storage(session), local: storage(local) },
    tabs: { async get(id) { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id); }, async create(value) { calls.created.push(value); }, async query() { return [...tabs.values()]; } },
    windows: { async get() { return { focused: true }; } },
    action: { async setBadgeText(value) { calls.badges.push(value); }, async setBadgeBackgroundColor() {} },
    scripting: { async executeScript(value) {
      if (value.func === inspectDocument) {
        calls.probes.push(value);
        const tab = tabs.get(value.target.tabId);
        return [{ frameId: 0, result: documents.get(tab.id) || { url: tab.url, contentType: hasPdfExtension(tab.url) ? 'application/pdf' : 'text/html' } }];
      }
      calls.banners.push(value);
      return [{ frameId: 0, result: true }];
    } },
    runtime: { getURL(path) { return `chrome-extension://test/${path}`; } },
  };
  return { chrome, session, local, calls, tabs, documents, controller: createController(chrome) };
}

test('PMC links, extensionless PDF responses, local files and unsafe URLs', () => {
  assert.equal(hasPdfExtension(pmc + '?download=1#page=3'), true);
  assert.equal(hasPdfExtension('file:///C:/papers/example.PDF'), true);
  assert.equal(pdfResponse(response('https://journal.example/download?id=3')).url, 'https://journal.example/download?id=3');
  for (const type of ['text/html', 'application/json']) assert.equal(pdfResponse(response(pmc, type)), null);
  for (const value of ['javascript:alert(1)', 'data:application/pdf,test', 'https://user:password@example.com/test.pdf']) assert.equal(sourceUrl(value), null);
  assert.equal(pdfResponse({ ...response(), type: 'sub_frame' }), null);
  assert.equal(pdfResponse({ ...response(), statusCode: 302 }), null);
  assert.equal(hasPdfExtension('http://127.0.0.1:8791/api/papers/abcdefabcdef/pdf'), false);
  assert.equal(pdfResponse(response('http://localhost:8791/api/papers/abcdefabcdef/pdf')), null);
});

test('auto prompt appears once, only for the active PDF, and can be disabled', async () => {
  const m = mockChrome();
  await m.controller.headers(response());
  await m.controller.updated(1, { status: 'complete' });
  await m.controller.activated(1);
  assert.equal(m.calls.banners.length, 1);
  assert.deepEqual(m.calls.banners[0], { target: { tabId: 1, frameIds: [0] }, files: ['banner.js'] });
  assert.equal(m.calls.created.length, 0, 'Detection must never import automatically');
  const background = mockChrome();
  background.tabs.get(1).active = false;
  await background.controller.headers(response());
  assert.equal(background.calls.banners.length, 0);
  background.tabs.get(1).active = true;
  await background.controller.activated(1);
  assert.equal(background.calls.banners.length, 1);
  const disabled = mockChrome();
  disabled.local.autoPrompt = false;
  await disabled.controller.headers(response());
  assert.equal(disabled.calls.banners.length, 0);
  assert.ok(await disabled.controller.candidate(1), 'Manual opening remains available');
});

test('HTML login responses suppress .pdf URL fallback and later PDF responses recover', async () => {
  const m = mockChrome();
  await m.controller.headers(response(pmc, 'text/html'));
  await m.controller.updated(1, { status: 'complete' });
  assert.equal(await m.controller.candidate(1), null);
  assert.equal(m.calls.banners.length, 0);
  await m.controller.headers(response());
  assert.equal(m.calls.banners.length, 1);
  const denied = mockChrome();
  await denied.controller.headers({ ...response(pmc, 'text/html'), statusCode: 403 });
  await denied.controller.updated(1, { status: 'complete' });
  assert.equal(await denied.controller.candidate(1), null);
  assert.equal(denied.calls.banners.length, 0);
});

test('navigation clears candidates; stale network events cannot open the wrong document', async () => {
  const m = mockChrome();
  await m.controller.headers(response());
  m.tabs.get(1).url = 'https://example.com/';
  await m.controller.updated(1, { url: 'https://example.com/' });
  await m.controller.headers(response());
  assert.equal(await m.controller.candidate(1), null);
  await assert.rejects(m.controller.open(1), /不是/);
  assert.equal(m.calls.created.length, 0);
  assert.equal(m.calls.badges.at(-1).text, '');
  m.tabs.get(1).url = 'https://example.com/another.pdf';
  await assert.rejects(m.controller.open(1, pmc), /已切換/);
});

test('service-worker restart keeps a PDF candidate and explicit opening creates one import ticket', async () => {
  const url = 'https://journal.example/download?id=6';
  const m = mockChrome(url);
  await m.controller.headers(response(url));
  const restarted = createController(m.chrome);
  assert.equal((await restarted.candidate(1)).url, url);
  await restarted.open(1);
  assert.equal(m.calls.created.length, 1);
  const ticket = new URL(m.calls.created[0].url).searchParams.get('ticket');
  assert.equal(m.session[`import:${ticket}`].url, url);
  assert.equal(m.session[`import:${ticket}`].tabId, 1, 'The import page reads the PDF back from this tab');
  await restarted.removed(1);
  assert.equal(m.session['pdf:1'], undefined);
});

test('after an extension reload, open .pdf tabs get a fresh banner without reloading the page', async () => {
  const signedPdf = 'https://pdf.sciencedirectassets.com/1/main.pdf?X-Amz-Expires=300';
  const m = mockChrome(signedPdf);
  m.tabs.set(2, { id: 2, url: 'https://example.com/article', active: false, status: 'complete', windowId: 2 });
  await m.controller.restore();
  assert.equal((await m.controller.candidate(1)).url, signedPdf);
  assert.equal(m.calls.banners.length, 1, 'The active PDF tab is prompted again');
  assert.equal(await m.controller.candidate(2), null);
});

test('Gmail-style extensionless PDF tabs are rediscovered after reload, activation, completion or manual opening', async () => {
  // Synthetic URL only: never put real attachment tokens in a fixture.
  const url = 'https://mail-attachment.googleusercontent.com/attachment/u/0/?view=att&disp=inline&token=test';
  for (const trigger of ['restore', 'activated', 'updated', 'candidate']) {
    const m = mockChrome(url);
    m.documents.set(1, { url, contentType: 'application/pdf' });
    if (trigger === 'restore') await m.controller.restore();
    else if (trigger === 'updated') await m.controller.updated(1, { status: 'complete' });
    else await m.controller[trigger](1);
    assert.equal((await m.controller.candidate(1)).url, url, trigger);
    assert.equal(m.calls.probes.length, 1, 'An identified document is not repeatedly probed');
    assert.equal(m.calls.banners.length, trigger === 'candidate' ? 0 : 1);
    assert.equal(m.calls.created.length, 0, 'Detection never starts an import');
  }
});

test('the injected document probe reads MIME and URL without downloading or reading PDF contents', () => {
  const saved = { document: globalThis.document, location: globalThis.location };
  Object.assign(globalThis, { document: { contentType: 'application/pdf' }, location: { href: 'https://example.com/attachment' } });
  try { assert.deepEqual(inspectDocument(), { url: 'https://example.com/attachment', contentType: 'application/pdf' }); }
  finally { Object.assign(globalThis, saved); }
});

test('restore does not mistake a .pdf login page for a PDF and skips protected or discarded tabs', async () => {
  const m = mockChrome();
  m.documents.set(1, { url: pmc, contentType: 'text/html' });
  for (const [id, url] of [[2, 'chrome://settings/'], [3, 'http://127.0.0.1:8791/api/papers/abcdefabcdef/pdf']]) {
    m.tabs.set(id, { id, url, active: false, status: 'complete' });
  }
  m.tabs.set(4, { id: 4, url: pmc, active: false, status: 'complete', discarded: true });
  await m.controller.restore();
  await m.controller.activated(1);
  assert.equal(await m.controller.candidate(1), null);
  assert.equal(m.calls.banners.length, 0);
  assert.equal(m.calls.probes.length, 1, 'Known HTML and inaccessible tabs are skipped');
});

test('failed or incomplete banner injection is retried on activation, but a successful prompt is not repeated', async () => {
  for (const failure of ['throw', false, undefined]) {
    const m = mockChrome();
    const execute = m.chrome.scripting.executeScript;
    let attempts = 0;
    m.chrome.scripting.executeScript = async value => {
      if (value.files && ++attempts === 1) {
        if (failure === 'throw') throw new Error('Frame not ready');
        return [{ frameId: 0, result: failure }];
      }
      return execute(value);
    };
    await m.controller.headers(response());
    assert.equal(m.session['pdf:1'].prompted, false);
    assert.ok((await m.controller.candidate(1)).promptError);
    await m.controller.activated(1);
    assert.equal(m.session['pdf:1'].prompted, true);
    assert.equal(m.session['pdf:1'].promptError, null);
    await m.controller.activated(1);
    assert.equal(attempts, 2, 'Successful or subsequently dismissed banners are not injected again');
  }
});

test('navigation during MIME detection or banner injection cannot mark the new page as prompted', async () => {
  const url = 'https://example.com/attachment';
  const probe = mockChrome(url);
  probe.chrome.scripting.executeScript = async () => {
    probe.tabs.get(1).url = 'https://example.com/login';
    return [{ frameId: 0, result: { url, contentType: 'application/pdf' } }];
  };
  await probe.controller.activated(1);
  assert.equal(probe.session['pdf:1'], undefined);
  assert.equal(probe.calls.banners.length, 0);
  const banner = mockChrome();
  banner.chrome.scripting.executeScript = async () => {
    banner.tabs.get(1).url = 'https://example.com/login';
    return [{ frameId: 0, result: true }];
  };
  await banner.controller.headers(response());
  assert.equal(banner.session['pdf:1'].prompted, false);
  assert.equal(await banner.controller.candidate(1), null);
});

test('banner state requests do not wait on their own injection and unavailable probes keep the URL fallback', async () => {
  const m = mockChrome();
  m.chrome.scripting.executeScript = async value => {
    if (value.func) throw new Error('Cannot inspect this viewer');
    assert.equal((await m.controller.candidate(1)).url, pmc);
    return [{ frameId: 0, result: true }];
  };
  await m.controller.restore();
  assert.equal(m.session['pdf:1'].prompted, true);
});

test('PDF transfer rejects HTML and oversized files, handles encoded names and validates reader destinations', async () => {
  await assert.rejects(readPdf(new Response('<html>Login required</html>')), /不是 PDF/);
  await assert.rejects(readPdf(new Response('%PDF-1.7', { headers: { 'content-length': String(MAX_PDF_BYTES + 1) } })), /100 MB/);
  await assert.rejects(readPdf(new Response('', { status: 403 })), /HTTP 403/);
  assert.equal((await readPdf(new Response('%PDF-1.7\nexample'))).type, 'application/pdf');
  assert.equal(pdfFilename(pmc, "inline; filename*=UTF-8''%E8%AB%96%E6%96%87.pdf"), '論文.pdf');
  assert.equal(pdfFilename(pmc, 'inline; filename="../../bad.pdf"').includes('/'), false);
  assert.equal(readerBase(), 'http://127.0.0.1:8791');
  for (const port of ['https://evil.example', 0, 65536, 1234.5]) assert.throws(() => readerBase(port));
});

test('import protocol verifies local reader, preserves the CSRF header and never navigates to an arbitrary server reply', async () => {
  await assert.rejects(checkReader(readerBase(), async () => new Response('{}')), /尚未連上/);
  await checkReader(readerBase(), async () => Response.json({ app: 'paper-reader' }));
  await checkReader(readerBase(), async url => url.endsWith('/health')
    ? new Response('{}', { status: 404 })
    : Response.json({ data_dir: 'local', models: [], tasks: [] }));
  await assert.rejects(checkReader(readerBase(), async () => new Response('{}', { status: 404 })), /尚未連上/);
  let sent;
  const destination = await uploadPdf(readerBase(), new Blob(['%PDF-1.7']), '論文.pdf', async (url, options) => {
    sent = { url, ...options };
    return Response.json({ id: '123456abcdef' });
  });
  assert.equal(sent.headers['X-Paper-Reader'], '1');
  assert.equal(decodeURIComponent(sent.headers['X-Filename']), '論文.pdf');
  assert.equal(destination, 'http://127.0.0.1:8791/#/paper/123456abcdef');
  await assert.rejects(uploadPdf(readerBase(), new Blob(), 'paper.pdf', async () => Response.json({ id: 'https://evil.example' })), /匯入失敗/);
});

const signed = 'https://pdf.publisher.example/main.pdf?X-Amz-Expires=300&sig=abc';

function mockPort(name, sender) {
  const listeners = { message: [], disconnect: [] };
  return {
    name, sender, posted: [], disconnected: false,
    onMessage: { addListener: f => listeners.message.push(f) },
    onDisconnect: { addListener: f => listeners.disconnect.push(f) },
    postMessage(message) { this.posted.push(message); },
    disconnect() { this.disconnected = true; },
    emit(message) { for (const f of listeners.message) f(message); },
  };
}

// executeScript stands in for the injected script: `inject` receives a
// connect() that delivers a port to every onConnect listener.
function tabChrome(inject) {
  const listeners = new Set(), calls = [];
  const chrome = {
    runtime: { onConnect: { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f) } },
    scripting: { async executeScript(value) { calls.push(value); return inject(port => [...listeners].forEach(f => f(port))); } },
  };
  return { chrome, calls, listeners };
}

async function withPage(href, fetcher, fn) {
  const saved = { chrome: globalThis.chrome, location: globalThis.location, fetch: globalThis.fetch };
  const port = mockPort();
  Object.assign(globalThis, { chrome: { runtime: { connect: ({ name }) => Object.assign(port, { name }) } }, location: { href }, fetch: fetcher });
  try { return await fn(port); } finally { Object.assign(globalThis, saved); }
}

test('signed publisher links: the PDF is read back from the original tab, not downloaded again', async () => {
  const pdf = new Uint8Array(5 * 1024 * 1024 + 7).fill(65);
  pdf.set(new TextEncoder().encode('%PDF-1.7'));
  let request;
  const posted = await withPage(signed, async (url, options) => { request = { url, ...options }; return new Response(pdf); }, async port => {
    assert.equal(await sendTabPdf('pdf:t1', MAX_PDF_BYTES), true);
    return port.posted;
  });
  assert.equal(request.url, signed);
  assert.equal(request.cache, 'force-cache', 'Reuse the copy the tab already downloaded');
  assert.equal(posted.length, 3, '5 MB travels as two base64 chunks plus done');
  const m = tabChrome(connect => {
    const port = mockPort('pdf:t1', { tab: { id: 1 }, frameId: 0, url: signed });
    connect(port);
    posted.forEach(message => port.emit(message));
    return [{ result: true }];
  });
  const blob = await readTabPdf(m.chrome, { tabId: 1, url: signed, channel: 'pdf:t1' });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), pdf);
  assert.deepEqual(m.calls[0].target, { tabId: 1, frameIds: [0] });
  assert.equal(m.calls[0].func, sendTabPdf);
  assert.equal(m.listeners.size, 0, 'The listener is removed once the transfer ends');
});

test('tab transfer only accepts the original top frame and reports failures for the download fallback', async () => {
  const pdf = btoa('%PDF-1.7\nok');
  const answer = (port, ...messages) => tabChrome(connect => { connect(port); messages.forEach(message => port.emit(message)); return [{ result: true }]; });
  for (const sender of [{ tab: { id: 9 }, frameId: 0, url: signed }, { tab: { id: 1 }, frameId: 3, url: signed }, { tab: { id: 1 }, frameId: 0, url: 'https://evil.example/x.pdf' }]) {
    const m = answer(mockPort('pdf:t1', sender), { chunk: pdf }, { done: 11 });
    await assert.rejects(readTabPdf(m.chrome, { tabId: 1, url: signed, channel: 'pdf:t1' }, 50), /沒有回應/);
  }
  const reply = (...messages) => answer(mockPort('pdf:t1', { tab: { id: 1 }, frameId: 0, url: signed }), ...messages).chrome;
  await assert.rejects(readTabPdf(reply({ error: 'HTTP 403' }), { tabId: 1, url: signed, channel: 'pdf:t1' }), /HTTP 403/);
  await assert.rejects(readTabPdf(reply({ chunk: pdf }, { done: 999 }), { tabId: 1, url: signed, channel: 'pdf:t1' }), /不完整/);
  await assert.rejects(readTabPdf(reply({ chunk: btoa('<html>login</html>') }, { done: 18 }), { tabId: 1, url: signed, channel: 'pdf:t1' }), /不是 PDF/);
  const refused = tabChrome(() => { throw new Error('Cannot access contents of the page'); });
  await assert.rejects(readTabPdf(refused.chrome, { tabId: 1, url: signed, channel: 'pdf:t1' }), /無法讀取/);
  const failed = await withPage(signed, async () => new Response('', { status: 403 }), async port => (await sendTabPdf('pdf:t1', MAX_PDF_BYTES), port.posted));
  assert.deepEqual(failed, [{ error: 'HTTP 403' }]);
});
