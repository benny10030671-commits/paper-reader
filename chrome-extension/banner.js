// Runs in the isolated world of the PDF's top-level document. Chrome's own
// viewer frame and the PDF contents are left untouched.
(async () => {
  const id = 'paper-reader-pdf-prompt';
  // A banner left by an earlier extension instance (before a reload or update)
  // can no longer reach the extension. Keep a live banner; replace a stale one.
  const existing = document.getElementById(id);
  if (existing) {
    delete existing.dataset.alive;
    existing.dispatchEvent(new Event('paper-reader-ping'));
    if (existing.dataset.alive) return true;
    existing.remove();
  }
  const reply = await chrome.runtime.sendMessage({ type: 'banner-state' });
  if (!reply?.ok || !reply.value?.autoPrompt) return false;
  const url = new URL(location.href);
  url.hash = '';
  if (url.href !== reply.value.url || !document.documentElement) return false;

  const host = document.createElement('div');
  host.id = id;
  // Explicit inline properties keep the host above the native full-page embed.
  host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;display:block;color-scheme:light;';
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all:initial; color-scheme:light; }
    * { box-sizing:border-box; }
    .wrap { position:relative; font:13px/1.5 system-ui,"Microsoft JhengHei",sans-serif; color:#292536; }
    .bar { display:flex; align-items:center; height:42px; background:#fff; border:1px solid #e4dfee; border-radius:11px; box-shadow:0 3px 18px #0003; overflow:hidden; }
    button { border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; }
    button:hover { background:#f2eef9; }
    button:focus-visible,input:focus-visible { outline:2px solid #8b75cf; outline-offset:-3px; }
    button:disabled { opacity:.55; cursor:default; }
    #open { display:flex; align-items:center; gap:8px; height:100%; padding:0 12px; font-weight:600; white-space:nowrap; }
    .mark { display:grid; place-items:center; width:22px; height:22px; border-radius:7px; background:#6957bd; color:#fff; font-size:12px; }
    #menu,#close { width:32px; height:100%; color:#7c7588; font-size:19px; }
    #close { border-left:1px solid #eeeaf4; }
    .panel { position:absolute; bottom:52px; left:0; width:min(310px,calc(100vw - 32px)); padding:19px; background:white; border:1px solid #e4dfee; border-radius:13px; box-shadow:0 6px 24px #0003; }
    .panel h2 { margin:0 0 12px; font-size:14px; font-weight:650; }
    .setting { display:flex; align-items:center; justify-content:space-between; gap:12px; cursor:pointer; }
    input { accent-color:#6957bd; width:17px; height:17px; }
    p { margin:10px 0; color:#857d8e; font-size:12px; line-height:1.65; }
    .link { padding:4px 0; color:#6957bd; font-size:12px; }
    .error { margin:0 0 10px; padding:12px; max-width:310px; background:#fff; border-radius:10px; color:#a13449; box-shadow:0 3px 18px #0003; }
    [hidden] { display:none !important; }
  `);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `
    <div class="wrap">
      <div id="error" class="error" role="alert" hidden></div>
      <section id="panel" class="panel" aria-label="論文伴讀提示設定" hidden>
        <h2>論文伴讀</h2>
        <label class="setting">開啟 PDF 時顯示提示<input id="auto" type="checkbox" checked></label>
        <p>關閉後，仍可從 Chrome 工具列的論文伴讀圖示開啟 PDF。</p>
        <p>點選開啟後才會匯入你的本機書庫。</p>
        <button id="settings" class="link">連線設定</button>
      </section>
      <div class="bar" role="group" aria-label="用論文伴讀開啟 PDF">
        <button id="open"><span class="mark" aria-hidden="true">伴</span>用論文伴讀開啟</button>
        <button id="menu" aria-label="提示設定" aria-expanded="false" aria-controls="panel">⋯</button>
        <button id="close" aria-label="關閉論文伴讀提示">×</button>
      </div>
    </div>`;
  const $ = selector => root.querySelector(selector);
  let busy = false;
  function error(message) { $('#error').textContent = message; $('#error').hidden = false; }
  async function message(type) {
    if (!chrome.runtime?.id) throw new Error('論文伴讀擴充功能剛更新過，這個提示已失效。請切換到其他分頁再切回來，或重新整理這個 PDF 分頁。');
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error || '連線中斷，請重新整理 PDF 分頁。');
  }
  $('#open').onclick = async event => {
    if (!event.isTrusted || busy) return;
    busy = true;
    $('#open').disabled = true;
    try { await message('banner-open'); }
    catch (e) { error(e.message); }
    finally { busy = false; $('#open').disabled = false; }
  };
  $('#menu').onclick = () => {
    $('#panel').hidden = !$('#panel').hidden;
    $('#menu').setAttribute('aria-expanded', String(!$('#panel').hidden));
  };
  $('#settings').onclick = event => { if (event.isTrusted) message('banner-options').catch(e => error(e.message)); };
  const changed = (changes, area) => {
    if (area === 'local' && changes.autoPrompt?.newValue === false) remove();
  };
  function remove() {
    try { chrome.storage.onChanged.removeListener(changed); } catch { /* Extension reloaded; nothing to detach. */ }
    host.remove();
  }
  $('#close').onclick = remove;
  $('#auto').onchange = async event => {
    if (!event.isTrusted) return;
    try { await chrome.storage.local.set({ autoPrompt: event.target.checked }); if (!event.target.checked) remove(); }
    catch (e) { error(e.message); }
  };
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('#panel').hidden = true; $('#menu').setAttribute('aria-expanded', 'false'); $('#menu').focus(); }
  });
  chrome.storage.onChanged.addListener(changed);
  host.addEventListener('paper-reader-ping', () => { if (chrome.runtime?.id) host.dataset.alive = '1'; });
  document.documentElement.appendChild(host);
  return true;
})();
