import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureReader, NATIVE_HOST } from '../chrome-extension/launcher.js';

const health = () => Response.json({ app: 'paper-reader' });
const offline = async () => { throw new Error('Connection refused'); };

test('a running reader is reused without invoking the native host', async () => {
  const chrome = { runtime: { sendNativeMessage() { assert.fail('Must not launch again'); } } };
  assert.equal(await ensureReader(chrome, undefined, { fetcher: health }), 'http://127.0.0.1:8791');
});

test('a stopped reader is started and health checked before import continues', async () => {
  const events = [];
  let running = false;
  const chrome = { runtime: { async sendNativeMessage(host, message) {
    events.push('launch');
    assert.equal(host, NATIVE_HOST);
    assert.deepEqual(message, { action: 'ensure-running', port: 9123 });
    running = true;
    return { ok: true, port: 9123 };
  } } };
  const base = await ensureReader(chrome, 9123, {
    fetcher: async () => { events.push('health'); return running ? health() : offline(); },
    onStarting: () => events.push('starting'),
  });
  assert.equal(base, 'http://127.0.0.1:9123');
  assert.deepEqual(events, ['health', 'starting', 'launch', 'health']);
});

test('the settings test verifies the native host even when the reader is already running', async () => {
  let called = false;
  const chrome = { runtime: { async sendNativeMessage() { called = true; return { ok: true, port: 8791, started: false }; } } };
  await ensureReader(chrome, 8791, { fetcher: health, verifyLauncher: true });
  assert.equal(called, true);
  chrome.runtime.sendNativeMessage = async () => { throw new Error('Host not found'); };
  await assert.rejects(ensureReader(chrome, 8791, { fetcher: health, verifyLauncher: true }), /一次性安裝/);
});

test('missing helper, startup failure and timeout produce recoverable errors', async () => {
  const options = { fetcher: offline, timeout: 10 };
  const chrome = { runtime: { sendNativeMessage: async () => { throw new Error('Specified native messaging host not found.'); } } };
  await assert.rejects(ensureReader(chrome, 8791, options), /一次性安裝/);
  chrome.runtime.sendNativeMessage = async () => ({ ok: false, error: '連接埠已被其他程式佔用' });
  await assert.rejects(ensureReader(chrome, 8791, options), /佔用/);
  chrome.runtime.sendNativeMessage = () => new Promise(() => {});
  await assert.rejects(ensureReader(chrome, 8791, options), /逾時/);
});

test('native replies cannot redirect imports or skip the reader identity check', async () => {
  const chrome = { runtime: { sendNativeMessage: async () => ({ ok: true, port: 9999, url: 'https://example.com' }) } };
  await assert.rejects(ensureReader(chrome, 8791, { fetcher: offline }), /不符/);
  chrome.runtime.sendNativeMessage = async () => ({ ok: true, port: 8791 });
  await assert.rejects(ensureReader(chrome, 8791, { fetcher: async () => Response.json({ app: 'other' }) }), /尚未連上/);
  await assert.rejects(ensureReader(chrome, 'https://example.com', { fetcher: offline }), /連接埠/);
});
