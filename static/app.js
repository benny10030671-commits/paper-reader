import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
import { normalizeRotation, rotatedSize, pageToView, viewToPage, viewRectToPage, rotationTransform } from './rotation.js';
import { planTranslationOverlays, textFitter } from './translation-overlay.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

// ------------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const sig = x => JSON.stringify(x ?? null);
const store = {
  get(k, d) { try { const v = localStorage.getItem('pr:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pr:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const ICONS = {
  library: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  settings: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'rotate-left': '<path d="M3 10a9 9 0 1 1 2.6 8"/><path d="M3 4v6h6"/>',
  'rotate-right': '<path d="M21 10a9 9 0 1 0-2.6 8"/><path d="M21 4v6h-6"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="10" cy="10" r="2"/><path d="m20 15-3-3-6 6"/>',
  languages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  notes: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  quiz: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  quote: '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  send: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  'note-add': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  vault: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  star: '<path d="M11.5 2.8a.6.6 0 0 1 1 0l2.6 5.3 5.8.8a.6.6 0 0 1 .3 1l-4.2 4.1 1 5.8a.6.6 0 0 1-.8.6L12 17.7l-5.2 2.7a.6.6 0 0 1-.8-.6l1-5.8L2.8 9.9a.6.6 0 0 1 .3-1l5.8-.8Z"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  pencil: '<path d="M21.2 6.8a2.8 2.8 0 0 0-4-4L4 16v4h4Z"/><path d="m14.5 5.5 4 4"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
};
const icon = n => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ''}</svg>`;
function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach(el => { if (!el.querySelector(':scope > svg.ic')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)); });
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opt = { method, headers: { ...headers } };
  if (method !== 'GET') opt.headers['X-Paper-Reader'] = '1';
  if (body !== undefined) {
    if (body instanceof Blob) { opt.body = body; opt.headers['Content-Type'] = 'application/pdf'; }
    else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch('/api/' + path, opt);
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, data: j });
  return j;
}

// POST that answers with server-sent events: text deltas go to onDelta, resolves with the final item
async function streamApi(path, body, onDelta) {
  const r = await fetch('/api/' + path, {
    method: 'POST', headers: { 'X-Paper-Reader': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(j.error || r.statusText);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', item = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let k;
    while ((k = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, k).split('\n').find(l => l.startsWith('data: '));
      buf = buf.slice(k + 2);
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.d) onDelta?.(ev.d);
      else if (ev.reset) onDelta?.reset?.();
      else if (ev.error) throw new Error(ev.error);
      else if (ev.done) item = ev.item;
    }
  }
  if (!item) throw new Error('連線中斷，請再試一次');
  return item;
}

// throttle re-rendering of streamed text to one paint per frame
function liveRenderer(render) {
  let text = '', queued = false;
  const push = delta => {
    text += delta;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(text); });
  };
  push.reset = () => { text = ''; };
  return push;
}

// strip the "標題：…/類型：…" header lines the explain prompt asks for
const stripHead = t => t.replace(/^(\s*(標題|類型)[:：][^\n]*\n?)+/, '').replace(/^\s*(標題|類型)[:：][^\n]*$/, '');

function toast(msg, kind = '', link = null) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  if (link?.onClick) {
    const b = document.createElement('button');
    b.className = 'toast-act';
    b.textContent = link.label;
    b.onclick = () => { link.onClick(); t.remove(); };
    t.append(' ', b);
  } else if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    t.append(' ', a);
  }
  $('#toasts').appendChild(t);
  const life = kind === 'err' ? 6500 : link ? 9000 : 3200;
  setTimeout(() => t.classList.add('out'), life);
  setTimeout(() => t.remove(), life + 500);
}

function confirmBox(msg) {
  const dlg = $('#dlg-confirm');
  $('#confirm-msg').textContent = msg;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已複製'); } catch { toast('複製失敗', 'err'); }
}

function download(name, data, type = 'text/markdown;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const fmtTime = iso => { try { return new Date(iso).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' }); } catch { return iso; } };

// markdown → sanitized HTML, then page links + KaTeX once it is in the DOM
const md = text => DOMPurify.sanitize(marked.parse(String(text || ''), { breaks: true, gfm: true }));
function postMd(root) {
  if (!root) return;
  $$('.md', root).concat(root.classList?.contains('md') ? [root] : []).forEach(el => {
    if (el.dataset.post) return;
    el.dataset.post = '1';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement.closest('a,code,pre,.katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const re = /\bp\.\s?(\d{1,3})/g;
    for (const n of nodes) {
      re.lastIndex = 0;
      if (!re.test(n.data)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = re.exec(n.data))) {
        frag.append(n.data.slice(last, m.index));
        const a = document.createElement('a');
        a.className = 'pg-link'; a.dataset.p = m[1]; a.textContent = m[0];
        frag.append(a);
        last = m.index + m[0].length;
      }
      frag.append(n.data.slice(last));
      n.replaceWith(frag);
    }
    if (window.renderMathInElement) {
      try {
        renderMathInElement(el, {
          delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }],
          throwOnError: false,
        });
      } catch { /* leave raw TeX */ }
    }
  });
}

// ------------------------------------------------------------------ state
const S = {
  papers: [], pid: null, pdf: null, layout: null, st: null, trans: {}, transPartial: new Set(), cfg: null,
  scale: 1, zoom: 'auto', cur: 0, rotations: {}, pageEls: [], twinEls: [], io: null,
  showTrans: false, sbs: false, showAuto: true, figMode: false, showExChips: store.get('exChips', true),
  tab: store.get('tab', 'ai'), panelOpen: store.get('panelOpen', true),
  hlFilter: { novelty: true, method: true, result: true, mine: true },
  exFilter: 'all', onlyZh: store.get('onlyZh', false), notesMode: 'edit',
  notesView: store.get('notesView', 'mine'), skillSel: store.get('skillSel', 'dpn'),
  skillForm: { template: 'auto', topic: '' }, skillOpen: new Set(), skillLogOpen: new Set(), skillSumOpen: new Set(), skillPreview: {},
  quizCfg: { n: 5, d: 'easy' }, quizAnswers: {},
  pending: { explain: [], chat: null, quiz: false },
  pollT: null, sel: null, search: { q: '', hits: [], i: -1 },
  // library: '' = 全部, NONE = 未分類, otherwise a category name
  lib: { cats: [], trash: [], job: null, busy: false, sig: '', cat: store.get('libCat', ''), q: '',
    scope: store.get('libScope', 'all'), sort: store.get('libSort', 'opened'), status: store.get('libStatus', ''),
    sel: new Set(), anchor: null, shownIds: [] },
  importing: false, cite: {},
  libT: null,
  cloud: { st: null, sel: null, info: null, custom: '', t: null },
};
const jobOf = n => S.st?.jobs?.[n];
const running = n => jobOf(n)?.status === 'running';
const anyRunning = () => Object.values(S.st?.jobs || {}).some(j => j.status === 'running');

const TABS = [
  ['ai', 'sparkles', 'AI 伴讀'],
  ['trans', 'languages', '對照翻譯'],
  ['explain', 'lightbulb', '解釋'],
  ['hl', 'highlighter', '高亮'],
  ['notes', 'notes', '筆記'],
  ['quiz', 'quiz', '測驗'],
  ['refs', 'quote', '引用卡片'],
];
const TYPE_LABEL = { text: '文本', image: '圖片', table: '表格', formula: '數學公式' };
const CAT_LABEL = { novelty: '新穎性', method: '方法', result: '結果' };
const COLOR_LABEL = { yellow: '黃', green: '綠', blue: '藍', pink: '粉紅', purple: '紫' };
const JOB_LABEL = { analyze: '摘要與關鍵字', translate: '版面翻譯', autohl: '自動高亮', refs: '參考文獻擷取',
  dpn: 'DeepPaperNote 筆記', t2n: 'textbook-to-note 筆記', classify: 'AI 分類' };

// ------------------------------------------------------------------ theme
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  store.set('theme', next);
}

// ------------------------------------------------------------------ routing
function route() {
  const m = location.hash.match(/^#\/paper\/([0-9a-f]{12})/);
  if (m) openPaper(m[1]); else showLibrary();
}

async function showLibrary() {
  closeReader();
  document.title = '論文伴讀';
  $('#reader').hidden = true;
  $('#library').hidden = false;
  $('#lib-q').value = S.lib.q;
  $('#lib-scope').value = S.lib.scope;
  $('#lib-sort').value = S.lib.sort;
  await loadLibrary(true);
}

async function loadLibrary(force = false) {
  clearTimeout(S.libT);
  if ($('#library').hidden) return;
  let r;
  try { r = await api('library'); } catch (e) {
    if (force) { toast(e.message, 'err'); S.papers = []; renderLibrary(); }
    S.libT = setTimeout(loadLibrary, 5000);
    return;
  }
  if ($('#library').hidden) return;
  const prev = S.lib.job;
  if (prev?.status === 'running' && r.job && r.job.status !== 'running') {
    const n = r.job.progress?.[1] ?? 0;
    if (r.job.status === 'error') toast(`AI 分類失敗：${r.job.error}`, 'err');
    else toast(n ? `AI 分類完成：整理了 ${n} 篇論文` : '沒有需要分類的論文');
  }
  S.papers = r.papers;
  Object.assign(S.lib, { cats: r.categories, trash: r.trash || [], job: r.job, busy: r.busy });
  renderLibLocation(r.location);
  const key = sig([r.papers, r.categories, r.trash, r.job]);
  // an open category dropdown would close under a re-render: wait for it
  const picking = document.activeElement?.matches?.('#lib-list select');
  if (force || (key !== S.lib.sig && !picking)) { S.lib.sig = key; renderLibrary(); }
  if (S.lib.job?.status === 'running' || S.lib.busy || picking) S.libT = setTimeout(loadLibrary, 2500);
}

// ---- search
const NONE = '__none';
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase();
const plainMd = s => String(s || '').replace(/[#*_`>|~]/g, '').replace(/\s+/g, ' ').trim();
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const qTerms = q => norm(q).split(/\s+/).filter(Boolean);

function libFields(p) {
  return p._f ??= {
    title: [p.title, p.title_zh, p.filename].join('\n'),
    author: [p.authors, p.authors_full].join('\n'),
    category: p.category || '未分類',
    summary: [...(p.tldr || []), plainMd(p.summary), (p.keywords || []).join('；')].join('\n'),
    other: [p.journal, p.year, p.study_type].join('\n'),
  };
}

function libMatch(p, terms, scope) {
  if (!terms.length) return true;
  const f = libFields(p);
  const hay = norm(scope === 'all' ? Object.values(f).join('\n') : f[scope]);
  return terms.every(t => hay.includes(t));
}

// escape, then wrap every search term in <mark>
function markTerms(text, terms) {
  const t = String(text ?? '');
  if (!terms.length) return esc(t);
  const re = new RegExp(`(${terms.map(escRe).join('|')})`, 'gi');
  return t.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

// a line of context for terms that matched somewhere the card does not show
function libSnippet(p, terms, scope, shown) {
  if (!terms.length || scope === 'title' || scope === 'category') return '';
  const seen = norm(shown);
  const missing = terms.filter(t => !seen.includes(t));
  if (!missing.length) return '';
  const f = libFields(p);
  const fields = scope === 'author' ? [['作者', p.authors_full]]
    : scope === 'summary' ? [['摘要', f.summary]]
    : [['作者', p.authors_full], ['摘要', f.summary], ['', f.other]];
  for (const [label, raw] of fields) {
    const text = String(raw || '');
    const n = norm(text);
    const at = Math.min(...missing.map(t => n.indexOf(t)).filter(i => i >= 0));
    if (!Number.isFinite(at)) continue;
    const a = Math.max(0, at - 50), b = Math.min(text.length, at + 90);
    const body = (a ? '…' : '') + text.slice(a, b).replace(/\n/g, ' ') + (b < text.length ? '…' : '');
    return `${label ? `<b>${label}：</b>` : ''}${markTerms(body, terms)}`;
  }
  return '';
}

const LIB_SORT = {
  opened: (a, b) => (b.opened || '').localeCompare(a.opened || ''),
  added: (a, b) => (b.added || '').localeCompare(a.added || ''),
  year: (a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0) || LIB_SORT.opened(a, b),
  title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'en', { sensitivity: 'base' }),
};
const sortedCats = () => [...S.lib.cats].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant-TW'));

const STATUS_LABEL = { unread: '未讀', reading: '閱讀中', done: '已讀' };
const STATUS_FILTERS = [['', '全部'], ['starred', '星號'], ['unread', '未讀'], ['reading', '閱讀中'], ['done', '已讀']];
const TRASH = '__trash';
const inStatus = p => !S.lib.status || (S.lib.status === 'starred' ? p.starred : p.status === S.lib.status);
const inCat = p => !S.lib.cat || (p.category || NONE) === S.lib.cat;

function renderLibrary() {
  const list = $('#lib-list');
  const L = S.lib;
  if (L.cat && L.cat !== NONE && L.cat !== TRASH && !L.cats.some(c => c.name === L.cat)) L.cat = '';
  const terms = qTerms(L.q);
  const hits = S.papers.filter(p => libMatch(p, terms, L.scope));
  const counts = {};
  hits.filter(inStatus).forEach(p => { const k = p.category || NONE; counts[k] = (counts[k] || 0) + 1; });
  renderLibSide(counts, hits.filter(inStatus).length);
  if (L.cat === TRASH) return renderTrash(terms);
  const sCounts = Object.fromEntries(STATUS_FILTERS.map(([k]) => [k, 0]));
  hits.filter(inCat).forEach(p => {
    sCounts[''] += 1;
    sCounts[p.status] = (sCounts[p.status] || 0) + 1;
    if (p.starred) sCounts.starred += 1;
  });
  $('#lib-filters').innerHTML = STATUS_FILTERS.map(([k, label]) =>
    `<button class="chip ${L.status === k ? 'on' : ''}" data-status-filter="${k}">${k === 'starred' ? icon('star') : ''}${label}<span class="chip-n">${sCounts[k] || 0}</span></button>`).join('');
  const shown = hits.filter(p => inStatus(p) && inCat(p)).sort(LIB_SORT[L.sort] || LIB_SORT.opened);
  L.shownIds = shown.map(p => p.id);
  L.sel = new Set([...L.sel].filter(id => L.shownIds.includes(id)));
  const where = [L.cat === NONE ? '未分類' : L.cat, L.status && STATUS_FILTERS.find(([k]) => k === L.status)[1]].filter(Boolean).join('・');
  $('#lib-count').textContent = !S.papers.length ? '' : terms.length ? `${where ? where + '：' : ''}找到 ${shown.length} 篇` : `${where || '全部'} ${shown.length} 篇`;
  if (!S.papers.length) {
    list.innerHTML = '<div class="empty">書庫還是空的。把 PDF 拖進來，或用 DOI／PMID 匯入，就可以開始閱讀、翻譯與提問。</div>';
    return renderBatchBar();
  }
  if (!shown.length) {
    list.innerHTML = `<div class="empty">${terms.length ? '沒有符合的論文。換個關鍵字，或把搜尋範圍改成「全部欄位」。'
      : L.status ? '沒有這個狀態的論文。' : '這個分類還沒有論文。可以把論文卡片拖到左邊的分類。'}</div>`;
    return renderBatchBar();
  }
  const opts = sortedCats().map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  list.innerHTML = shown.map(p => {
    const sub = [p.authors || p.authors_full, [p.journal, p.year].filter(Boolean).join(' '),
      p.authors || p.journal ? '' : p.filename, `${p.pages} 頁`, `加入於 ${(p.added || '').slice(0, 10)}`].filter(Boolean).join(' · ');
    const snip = libSnippet(p, terms, L.scope, [p.title, p.title_zh, p.filename, sub, p.category].join('\n'));
    const ai = p.category_source === 'ai';
    const sel = L.sel.has(p.id);
    return `
    <article class="lib-card ${sel ? 'sel' : ''}" data-id="${p.id}" draggable="true">
      <label class="sel-box" title="選取（按住 Shift 可連續選取）"><input type="checkbox" data-sel="${p.id}" ${sel ? 'checked' : ''} aria-label="選取"></label>
      <div class="lib-main">
        <h3 title="${esc(p.filename)}">${markTerms(p.title, terms)}</h3>
        ${p.title_zh ? `<p class="zh">${markTerms(p.title_zh, terms)}</p>` : ''}
        <p class="sub">${markTerms(sub, terms)}</p>
        ${snip ? `<p class="snip">${snip}</p>` : ''}
        <p class="lib-proc">
          <span class="tag ${p.analyzed ? 'ok' : ''}">${p.analyzed ? '摘要完成' : (p.has_text ? '尚無摘要' : '無文字層')}</span>
          <span class="tag ${p.translated === p.pages ? 'ok' : ''}">翻譯 ${p.translated}/${p.pages} 頁</span>
        </p>
      </div>
      <div class="lib-tags">
        <div class="lib-tag-row">
          <button class="star-btn ${p.starred ? 'on' : ''}" data-star="${p.id}" title="${p.starred ? '取消星號' : '加星號'}" aria-pressed="${p.starred}">${icon('star')}</button>
          <label class="cat-pick ${p.category ? '' : 'none'}" title="${ai ? 'AI 自動分類；改選後會變成手動分類，AI 不會再更動' : p.category ? '手動分類' : '尚未分類'}">
            ${ai ? '<span class="ai-mark">AI</span>' : icon('folder')}
            <select data-cat-of="${p.id}" aria-label="分類">
              <option value="">未分類</option>${opts}<option value="__new">＋ 新增分類…</option>
            </select>
            ${icon('chevron')}
          </label>
        </div>
        <label class="st-pick st-${p.status}" title="閱讀狀態">
          <span class="st-dot"></span>
          <select data-status-of="${p.id}" aria-label="閱讀狀態">
            ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          ${icon('chevron')}
        </label>
      </div>
      <button class="icon-btn danger" data-del="${p.id}" data-icon="trash" title="移到回收桶"></button>
    </article>`;
  }).join('');
  shown.forEach(p => { list.querySelector(`[data-cat-of="${p.id}"]`).value = p.category || ''; });
  hydrateIcons(list);
  renderBatchBar();
}

function renderTrash(terms) {
  const L = S.lib, list = $('#lib-list');
  const shown = L.trash.filter(p => libMatch(p, terms, L.scope));
  L.shownIds = shown.map(p => p.id);
  L.sel = new Set([...L.sel].filter(id => L.shownIds.includes(id)));
  $('#lib-filters').innerHTML = L.trash.length
    ? `<button class="chip danger-chip" id="trash-empty" data-icon="trash">清空回收桶</button>` : '';
  $('#lib-count').textContent = `回收桶 ${shown.length} 篇`;
  list.innerHTML = !shown.length
    ? `<div class="empty">${L.trash.length ? '沒有符合的論文。' : '回收桶是空的。刪除的論文會先放在這裡，可以還原。'}</div>`
    : shown.map(p => `
    <article class="lib-card trashed ${L.sel.has(p.id) ? 'sel' : ''}" data-id="${p.id}">
      <label class="sel-box" title="選取"><input type="checkbox" data-sel="${p.id}" ${L.sel.has(p.id) ? 'checked' : ''} aria-label="選取"></label>
      <div class="lib-main">
        <h3>${markTerms(p.title, terms)}</h3>
        ${p.title_zh ? `<p class="zh">${markTerms(p.title_zh, terms)}</p>` : ''}
        <p class="sub">${esc([p.authors || p.authors_full, p.category && `分類：${p.category}`, `刪除於 ${fmtTime(p.trashed_at)}`].filter(Boolean).join(' · '))}</p>
      </div>
      <div class="trash-acts">
        <button class="ghost" data-restore="${p.id}" data-icon="restore">還原</button>
        <button class="ghost danger-ghost" data-purge="${p.id}">永久刪除</button>
      </div>
    </article>`).join('');
  hydrateIcons($('#lib-filters'));
  hydrateIcons(list);
  renderBatchBar();
}

function renderBatchBar() {
  const L = S.lib, bar = $('#batch-bar'), n = L.sel.size;
  $('#lib-list').classList.toggle('selecting', n > 0);
  bar.hidden = !n;
  if (!n) return;
  const all = L.shownIds.length;
  const head = `<button class="icon-btn" data-bsel="none" data-icon="x" title="取消選取（Esc）"></button><b>已選 ${n} 篇</b>${n < all ? `<button class="link-btn" data-bsel="all">全選 ${all} 篇</button>` : ''}`;
  const tail = '';
  if (L.cat === TRASH) {
    bar.innerHTML = `${head}<span class="bb-sep"></span>
      <button class="chip" data-bop="restore" data-icon="restore">還原</button>
      <button class="chip danger-chip" data-bop="purge" data-icon="trash">永久刪除</button>${tail}`;
  } else {
    const cats = sortedCats().map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    bar.innerHTML = `${head}<span class="bb-sep"></span>
      <label class="bb-select">${icon('folder')}<select data-bop="category" aria-label="移到分類">
        <option value="" selected disabled hidden>移到分類</option><option value="__unsorted">未分類</option>${cats}<option value="__new">＋ 新增分類…</option></select></label>
      <label class="bb-select"><span class="st-dot"></span><select data-bop="status" aria-label="標為">
        <option value="" selected disabled hidden>標為</option>${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <button class="chip" data-bop="star" data-icon="star">加星號</button>
      <button class="chip" data-bop="unstar">取消星號</button>
      <span class="menu-wrap"><button class="chip" data-menu="export" data-icon="quote">匯出引用</button>
        <div class="menu" id="export-menu" hidden>
          <button data-export="apa-copy">複製 APA（貼到 Word 保留斜體）</button>
          <button data-export="apa">下載 APA（.txt）</button>
          <button data-export="bibtex">下載 BibTeX（.bib）</button>
          <button data-export="rdf">下載 Zotero RDF（.rdf）</button>
          <button data-export="rdfzip">Zotero RDF＋PDF（.zip）</button>
        </div></span>
      <button class="chip" data-bop="classify" data-icon="sparkles">AI 重新分類</button>
      <button class="chip danger-chip" data-bop="trash" data-icon="trash">刪除</button>${tail}`;
  }
  hydrateIcons(bar);
}

// selection changes without re-rendering the cards (keeps dropdowns and scroll in place)
function toggleSel(id, on, range = false) {
  const L = S.lib;
  if (range && L.anchor && L.shownIds.includes(L.anchor)) {
    const [a, b] = [L.shownIds.indexOf(L.anchor), L.shownIds.indexOf(id)].sort((x, y) => x - y);
    L.shownIds.slice(a, b + 1).forEach(x => (on ? L.sel.add(x) : L.sel.delete(x)));
  } else if (on) L.sel.add(id); else L.sel.delete(id);
  L.anchor = id;
  syncSel();
}

function setSel(ids) {
  S.lib.sel = new Set(ids);
  syncSel();
}

function syncSel() {
  $$('#lib-list .lib-card').forEach(c => {
    const on = S.lib.sel.has(c.dataset.id);
    c.classList.toggle('sel', on);
    const cb = c.querySelector('input[data-sel]');
    if (cb) cb.checked = on;
  });
  renderBatchBar();
}

function renderLibSide(counts, total) {
  const L = S.lib;
  const item = (key, label, n, tools = '', title = '', drop = true) => `
    <div class="cat-item ${L.cat === key ? 'on' : ''} ${key === TRASH ? 'trash-item' : ''}" data-catsel="${esc(key)}" ${key && drop ? `data-drop="${esc(key)}"` : ''}
      role="button" tabindex="0" ${title ? `title="${esc(title)}"` : ''}>
      ${key === TRASH ? icon('trash') : ''}<span class="cat-name">${esc(label)}</span><span class="cat-n">${n || 0}</span>${tools}
    </div>`;
  const tools = name => `<span class="cat-tools">
      <button class="icon-btn" data-cat-edit="${esc(name)}" data-icon="pencil" title="改名／編輯說明"></button>
      <button class="icon-btn danger" data-cat-del="${esc(name)}" data-icon="trash" title="刪除分類"></button></span>`;
  const job = L.job?.status === 'running' ? L.job : null;
  const unsorted = S.papers.filter(p => !p.category).length;
  const prog = job?.progress?.[1] ? `${job.progress[0]}/${job.progress[1]} 篇` : '準備中';
  $('#lib-side').innerHTML = `
    <div class="side-head"><span>分類</span><button class="icon-btn" id="cat-add" data-icon="plus" title="新增分類"></button></div>
    ${item('', '全部', total)}
    ${sortedCats().map(c => item(c.name, c.name, counts[c.name], tools(c.name), c.desc)).join('')}
    ${item(NONE, '未分類', counts[NONE])}
    <div class="cat-sep"></div>
    ${item(TRASH, '回收桶', L.trash.length, '', '刪除的論文會先放在這裡；把卡片拖到這裡也可以刪除')}
    <div class="side-ai">
      ${job ? `<div class="status-line"><span class="spinner"></span>AI 分類中（${prog}）…</div>`
        : `<button class="primary wide" id="lib-ai" data-icon="sparkles" ${unsorted ? '' : 'disabled'}>AI 分類未分類（${unsorted}）</button>
           <button class="link-btn" id="lib-ai-all" ${S.papers.length ? '' : 'disabled'}>重新整理全部分類…</button>`}
      <p class="faint small">把卡片拖到分類上即可手動歸類（選取多篇可一起拖）。手動指定的分類 AI 不會改動。</p>
    </div>`;
  hydrateIcons($('#lib-side'));
}

function setLibCat(key) {
  if (key !== S.lib.cat) S.lib.sel.clear();
  S.lib.cat = key;
  store.set('libCat', key === TRASH ? '' : key);
  renderLibrary();
}

async function runBatch(op, value = null, ids = [...S.lib.sel]) {
  if (!ids.length) return null;
  if (op === 'star' || op === 'unstar') [op, value] = ['star', op === 'star'];
  let r = null;
  try {
    r = await api('batch', { method: 'POST', body: { ids, op, value } });
    if (r.failed?.length) toast(`${r.failed.length} 篇沒有完成：${r.failed[0].error}`, 'err');
  } catch (e) { toast(e.message, 'err'); }
  await loadLibrary(true);
  return r;
}

async function setCategory(pid, name) {
  await runBatch('category', name, Array.isArray(pid) ? pid : [pid]);
}

async function trashPapers(ids) {
  const r = await runBatch('trash', null, ids);
  if (!r?.done) return;
  ids.forEach(id => S.lib.sel.delete(id));
  renderBatchBar();
  toast(`已移到回收桶（${r.done} 篇）`, '', { label: '復原', onClick: () => runBatch('restore', null, ids) });
}

async function purgePapers(ids) {
  if (!(await confirmBox(`永久刪除 ${ids.length} 篇？PDF、翻譯、筆記、高亮都會刪除，無法復原（已存到 PaperBrain 的筆記不受影響）。`))) return;
  const r = await runBatch('purge', null, ids);
  if (r?.done) toast(`已永久刪除 ${r.done} 篇`);
}

async function restorePapers(ids) {
  const r = await runBatch('restore', null, ids);
  if (r?.done) toast(`已還原 ${r.done} 篇`);
}

async function reclassify(ids) {
  if (!(await confirmBox(`讓 AI 重新分類選取的 ${ids.length} 篇？包含你手動指定過的，分完會標成 AI 分類。`))) return;
  const r = await runBatch('classify', null, ids);
  if (r && !r.started) toast('AI 分類已經在進行中');
}

// citations: APA / BibTeX / Zotero RDF (+PDF zip); metadata comes from Crossref / Europe PMC when found
async function exportCite(kind, ids) {
  if (!ids.length) return;
  const fmt = kind === 'apa-copy' ? 'apa' : kind;
  const slow = setTimeout(() => toast('查詢書目資料中…（第一次會向 Crossref／Europe PMC 查詢）'), 900);
  try {
    if (fmt === 'rdfzip') {
      const r = await fetch('/api/cite', { method: 'POST', headers: { 'X-Paper-Reader': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, format: fmt }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const name = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '')?.[1] || 'paper-reader-zotero.zip';
      download(name, await r.blob());
      toast('已下載。解壓縮後在 Zotero 用「檔案 → 匯入…」選裡面的 .rdf，PDF 會一起匯入。');
      return;
    }
    const r = await api('cite', { method: 'POST', body: { ids, format: fmt } });
    if (kind === 'apa-copy') await copyRich(r.html, r.text);
    else download(r.name, r.text, fmt === 'rdf' ? 'application/rdf+xml' : 'text/plain;charset=utf-8');
    if (r.fallback) toast(`${r.fallback} 篇在書目資料庫查不到，用 AI 從 PDF 擷取的資料，請核對`, 'err');
  } catch (e) { toast(e.message, 'err'); } finally { clearTimeout(slow); }
}

async function copyRich(htmlText, text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([htmlText], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    toast('已複製（貼到 Word 會保留斜體）');
  } catch { await copyText(text); }
}

// ---- import by DOI / PMID / PMCID / URL
function openImport() {
  const dlg = $('#dlg-import');
  if (!S.importing) $('#import-log').innerHTML = '';
  dlg.showModal();
  $('#import-refs').focus();
}

async function runImport() {
  const refs = $('#import-refs').value.split(/[\n;,]+/).map(s => s.trim()).filter(Boolean);
  if (!refs.length || S.importing) return;
  const log = $('#import-log'), go = $('#import-go');
  log.innerHTML = refs.map((r, i) => `<div class="imp-row" data-i="${i}"><span class="imp-ref">${esc(r)}</span><span class="imp-msg">等待中</span></div>`).join('');
  S.importing = true;
  go.disabled = true;
  const row = i => log.querySelector(`.imp-row[data-i="${i}"] .imp-msg`);
  try {
    const res = await streamApi('import', { refs }, d => {
      try { const m = JSON.parse(d); const el = row(m.i); if (el) { el.innerHTML = `<span class="spinner"></span>${esc(m.msg)}`; } } catch { /* not a progress line */ }
    });
    let ok = 0;
    res.results.forEach((r, i) => {
      const el = row(i);
      if (!el) return;
      el.parentElement.classList.add(r.ok ? 'ok' : 'fail');
      if (r.ok) {
        ok += 1;
        const note = r.existed ? '（原本就在書庫）' : r.restored ? '（從回收桶還原）' : '';
        el.innerHTML = `✓ ${esc(r.title || '')}${note} <a href="#/paper/${r.id}" data-close-import>開啟</a>`;
      } else {
        el.innerHTML = `✗ ${esc(r.error)}${r.open_url ? ` <a href="${esc(r.open_url)}" target="_blank" rel="noopener">在瀏覽器開啟</a>` : ''}`;
      }
    });
    $('#import-refs').value = res.results.filter(r => !r.ok).map(r => r.ref).join('\n');
    if (ok) toast(`已匯入 ${ok} 篇，正在背景產生摘要`);
  } catch (e) { toast(e.message, 'err'); } finally {
    S.importing = false;
    go.disabled = false;
    if (!$('#library').hidden) loadLibrary(true);
  }
}

function catDialog(title, name = '', desc = '') {
  const dlg = $('#dlg-cat');
  $('#cat-dlg-title').textContent = title;
  dlg.querySelector('[name="name"]').value = name;
  dlg.querySelector('[name="desc"]').value = desc;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok' ? {
    name: dlg.querySelector('[name="name"]').value.trim(), desc: dlg.querySelector('[name="desc"]').value.trim(),
  } : null), { once: true }));
}

async function createCategory(assignTo = null) {
  const r = await catDialog(assignTo ? '新增分類並放入這篇' : '新增分類');
  if (!r?.name) return renderLibrary(); // resets a card dropdown left on「新增分類…」
  try {
    if (!S.lib.cats.some(c => c.name === r.name)) await api('categories', { method: 'POST', body: r });
    if (assignTo) return setCategory(assignTo, r.name);
  } catch (e) { toast(e.message, 'err'); }
  await loadLibrary(true);
}

async function editCategory(name) {
  const c = S.lib.cats.find(x => x.name === name);
  const r = await catDialog('編輯分類', name, c?.desc || '');
  if (!r?.name) return;
  if (r.name !== name && S.lib.cats.some(x => x.name === r.name)
    && !(await confirmBox(`已經有「${r.name}」分類，要把「${name}」的論文合併進去嗎？`))) return;
  try {
    await api('categories', { method: 'PUT', body: { old: name, name: r.name, desc: r.desc } });
    if (S.lib.cat === name) { S.lib.cat = r.name; store.set('libCat', r.name); }
  } catch (e) { toast(e.message, 'err'); }
  await loadLibrary(true);
}

async function deleteCategory(name) {
  const n = S.papers.filter(p => p.category === name).length;
  if (!(await confirmBox(`刪除分類「${name}」？${n ? `裡面的 ${n} 篇論文會移到「未分類」（論文本身不會刪除）。` : ''}`))) return;
  try { await api(`categories?name=${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (e) { toast(e.message, 'err'); }
  await loadLibrary(true);
}

async function classifyLibrary(mode) {
  if (mode === 'all' && !(await confirmBox('讓 AI 重新整理全部分類？AI 可能合併、拆分或改名分類；你手動指定過的論文與手動建立的分類都會保留。'))) return;
  try {
    const r = await api('library/classify', { method: 'POST', body: { mode } });
    if (!r.started) toast('AI 分類已經在進行中');
    S.lib.job = { status: 'running', progress: null };
    renderLibrary();
    S.libT = setTimeout(loadLibrary, 1500);
  } catch (e) { toast(e.message, 'err'); }
}

function renderLibLocation(loc) {
  if (!loc) return;
  $('#lib-sub').textContent = loc.kind === 'local'
    ? '上傳 PDF 後會自動產生摘要與關鍵字。所有資料只存在這台電腦。'
    : `上傳 PDF 後會自動產生摘要與關鍵字。書庫放在 ${loc.label}（${loc.path}），由它負責同步。`;
  const warn = locWarnings(loc);
  $('#lib-alert').hidden = !warn.length;
  $('#lib-alert').innerHTML = warn.map(w => `<div class="warn-box">${w}</div>`).join('');
}

async function uploadFiles(files) {
  const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) return toast('請選擇 PDF 檔', 'err');
  let last = null;
  for (const f of pdfs) {
    toast(`上傳並解析中：${f.name}`);
    try { last = await api('papers', { method: 'POST', body: f, headers: { 'X-Filename': encodeURIComponent(f.name) } }); }
    catch (e) { toast(`${f.name}：${e.message}`, 'err'); }
  }
  if (pdfs.length === 1 && last) location.hash = '#/paper/' + last.id;
  else if (!S.pid) showLibrary();
}

// ------------------------------------------------------------------ reader
function closeReader() {
  clearTimeout(S.pollT);
  clearTimeout(S._viewT);
  S.io?.disconnect();
  S.io = null;
  S.pdf?.destroy();
  Object.assign(S, {
    pdf: null, pid: null, layout: null, st: null, trans: {}, transPartial: new Set(), pageEls: [], twinEls: [],
    cur: 0, rotations: {}, sel: null, search: { q: '', hits: [], i: -1 }, quizAnswers: {},
    pending: { explain: [], chat: null, quiz: false }, showTrans: false, sbs: false, outline: null,
    skillForm: { template: 'auto', topic: '' }, skillOpen: new Set(), skillLogOpen: new Set(), skillSumOpen: new Set(), skillPreview: {},
  });
  hideSelPop();
  setFigMode(false);
  $('#pages').innerHTML = '';
  $('#pages').classList.remove('show-trans', 'sbs');
  $('#search-input').value = '';
  $('#search-count').textContent = '';
  $('#outline-pop').hidden = true;
}

async function openPaper(pid) {
  if (S.pid === pid && S.pdf) return;
  closeReader();
  S.pid = pid;
  $('#library').hidden = true;
  $('#reader').hidden = false;
  $('#pages').innerHTML = '<div class="loading-big">載入中…</div>';
  try {
    const [st, layout, trans] = await Promise.all([
      api(`papers/${pid}/state`), api(`papers/${pid}/layout`), api(`papers/${pid}/translations`)]);
    if (S.pid !== pid) return;
    S.st = st; S.layout = layout; S.trans = trans.pages; S.transPartial = new Set(trans.partial);
    S.rotations = Object.fromEntries(layout.pages.map((_, i) => [i, normalizeRotation(st.view?.rotations?.[i])]));
    const pdf = await pdfjsLib.getDocument({ url: `/api/papers/${pid}/pdf` }).promise;
    if (S.pid !== pid) { pdf.destroy(); return; }
    S.pdf = pdf;
  } catch (e) {
    toast('無法開啟：' + e.message, 'err');
    location.hash = '#/';
    return;
  }
  const m = S.st.meta;
  if (m.status === 'unread') {
    m.status = 'reading';
    api('batch', { method: 'POST', body: { ids: [pid], op: 'status', value: 'reading' } }).catch(() => {});
  }
  $('#doc-title').textContent = m.title_zh ? `${m.title_zh}` : m.title;
  $('#doc-title').title = m.title;
  document.title = `${m.title} · 論文伴讀`;
  applyPanel();
  buildPages();
  selectTab(S.tab);
  updateToolbar();
  const start = S.st.view?.page || 0;
  requestAnimationFrame(() => gotoPage(start, false));
  saveView(start);
  if (!m.has_text) toast('這份 PDF 沒有文字層（可能是掃描檔），翻譯與 AI 功能無法使用', 'err');
  schedulePoll();
}

const pageRotation = i => normalizeRotation(S.rotations[i]);
let viewSave = Promise.resolve();
function saveView(page = S.cur) {
  const pid = S.pid, body = { page, rotations: { ...S.rotations } };
  if (!pid) return;
  // Serialize snapshots so rapid rotation clicks cannot restore an older angle.
  viewSave = viewSave.then(() => api(`papers/${pid}/view`, { method: 'PUT', body }))
    .catch(e => { if (S.pid === pid) toast('閱讀位置儲存失敗：' + e.message, 'err'); });
  return viewSave;
}

function updateRotationUI() {
  const angle = pageRotation(S.cur), button = $('#rotation-value');
  button.textContent = `${angle}°`;
  button.disabled = angle === 0;
  button.title = `第 ${S.cur + 1} 頁已旋轉 ${angle}°；點擊還原方向`;
}

function rotatePage(delta) {
  if (!S.pdf || !S.layout) return;
  const i = S.cur;
  S.rotations[i] = delta === 0 ? 0 : normalizeRotation(pageRotation(i) + delta);
  hideSelPop();
  hideBlkBtn();
  setLink(0, null);
  window.getSelection()?.removeAllRanges();
  setZoom(S.zoom);
  gotoPage(i, false);
  saveView(i);
}

function computeScale() {
  if (S.zoom === 'auto') {
    const vw = $('#viewer').clientWidth - 64; // page padding + room for the vertical scrollbar
    const maxW = Math.max(...S.layout.pages.map((p, i) => rotatedSize(p.w, p.h, pageRotation(i))[0]));
    // side-by-side fits two pages (original + translation) and the 16px gap between them
    return Math.max(0.3, Math.min(2.4, S.sbs ? (vw - 16) / (2 * maxW) : vw / maxW));
  }
  return +S.zoom;
}

function buildPages() {
  const wrap = $('#pages');
  wrap.innerHTML = '';
  S.scale = computeScale();
  S.twinEls = [];
  S.pageEls = S.layout.pages.map((p, i) => {
    const row = document.createElement('div');
    row.className = 'pg-row';
    const el = document.createElement('div');
    el.className = 'pg';
    el.dataset.i = i;
    el.innerHTML = `<div class="pg-surface"><canvas class="pg-canvas"></canvas><div class="hl-layer"></div><div class="textLayer"></div><div class="tr-layer"></div><div class="ex-layer"></div></div><div class="pg-num">${i + 1}</div>`;
    const tw = document.createElement('div');
    tw.className = 'pg-twin';
    tw.dataset.i = i;
    tw.innerHTML = `<div class="pg-surface"><canvas class="pg-canvas"></canvas><div class="tr-layer"></div></div><div class="pg-num">${i + 1}・譯文</div>`;
    row.append(el, tw);
    wrap.appendChild(row);
    S.twinEls[i] = tw;
    return el;
  });
  sizePages();
  S.io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) renderPage(+e.target.dataset.i);
  }, { root: $('#viewer'), rootMargin: '700px 0px' });
  S.pageEls.forEach(el => S.io.observe(el));
  S.pageEls.forEach((_, i) => { renderHL(i); renderEx(i); });
  $('#page-total').textContent = S.layout.pages.length;
  updateZoomUI();
}

function sizePages() {
  S.pageEls.forEach((el, i) => {
    const p = S.layout.pages[i];
    const angle = pageRotation(i), [w, h] = rotatedSize(p.w, p.h, angle);
    for (const e of [el, S.twinEls[i]]) {
      e.style.width = `${w * S.scale}px`;
      e.style.height = `${h * S.scale}px`;
      e.style.setProperty('--scale-factor', S.scale);
      const surface = e.querySelector('.pg-surface');
      surface.style.width = `${p.w * S.scale}px`;
      surface.style.height = `${p.h * S.scale}px`;
      surface.style.transform = rotationTransform(p.w * S.scale, p.h * S.scale, angle);
    }
  });
}

function nearViewport(el) {
  const v = $('#viewer').getBoundingClientRect(), r = el.getBoundingClientRect();
  return r.bottom > v.top - 700 && r.top < v.bottom + 700;
}

function setZoom(z) {
  const v = $('#viewer');
  const anchor = S.pageEls[S.cur];
  const rel = anchor ? (v.scrollTop - anchor.offsetTop) / anchor.offsetHeight : 0;
  S.zoom = z;
  S.scale = computeScale();
  sizePages();
  if (anchor) v.scrollTop = anchor.offsetTop + rel * anchor.offsetHeight;
  S.pageEls.forEach((el, i) => { if (nearViewport(el)) renderPage(i); });
  updateZoomUI();
}

function updateZoomUI() {
  const sel = $('#zoom-select');
  const custom = sel.querySelector('option[value="custom"]');
  if ([...sel.options].some(o => o.value === String(S.zoom) && o.value !== 'custom')) {
    sel.value = String(S.zoom);
    custom.hidden = true;
  } else {
    custom.hidden = false;
    custom.textContent = `${Math.round(S.scale * 100)}%`;
    sel.value = 'custom';
  }
}

async function renderPage(i) {
  const el = S.pageEls[i];
  if (!el || !S.pdf) return;
  const key = String(S.scale);
  if (el.dataset.rs === key) return;
  el.dataset.rs = key;
  const pdf = S.pdf;
  try {
    const page = await pdf.getPage(i + 1);
    if (pdf !== S.pdf || el.dataset.rs !== key) return;
    const vp = page.getViewport({ scale: S.scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.className = 'pg-canvas';
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
    if (pdf !== S.pdf || el.dataset.rs !== key) return;
    el.querySelector('.pg-canvas').replaceWith(canvas);
    el.dataset.painted = '1';
    if (S.sbs) renderTwin(i);
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    el.querySelector('.textLayer').replaceWith(tl);
    await new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render();
  } catch (e) {
    if (!/cancel|destroy|Transport/i.test(e?.message || '')) console.error(e);
    el.dataset.rs = '';
    return;
  }
  if (S.showTrans) renderTr(i);
}

// the right-hand page in side-by-side view: a copy of the rendered page with the translation laid over it
function renderTwin(i) {
  const tw = S.twinEls[i], src = S.pageEls[i]?.querySelector('.pg-canvas');
  if (!tw || !src || !S.pageEls[i].dataset.painted) return;
  const c = document.createElement('canvas');
  c.className = 'pg-canvas';
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  tw.querySelector('.pg-canvas').replaceWith(c);
  tw.dataset.painted = '1';
  renderTrInto(tw.querySelector('.tr-layer'), i);
}

function setSbs(on) {
  if (on && S.showTrans) setShowTrans(false);
  S.sbs = on;
  $('#pages').classList.toggle('sbs', on);
  setZoom(S.zoom); // auto-zoom halves the page width in side-by-side
  if (on) {
    S.pageEls.forEach((el, i) => { if (el.dataset.painted) renderTwin(i); });
    maybeStartTranslation();
  }
  updateToolbar();
}

function maybeStartTranslation() {
  if (S.st.translated.length < S.layout.pages.length && !running('translate')) {
    startJob('translate-all', 'translate', { start: S.cur });
  }
}

function onScroll() {
  if (S._raf) return;
  S._raf = requestAnimationFrame(() => {
    S._raf = 0;
    if (!S.pageEls.length) return;
    const v = $('#viewer');
    const y = v.scrollTop + v.clientHeight * 0.35;
    let lo = 0, hi = S.pageEls.length - 1, ans = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (S.pageEls[m].offsetTop <= y) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    if (ans !== S.cur) { S.cur = ans; onPageChange(); }
  });
}

function onPageChange() {
  $('#page-input').value = S.cur + 1;
  updateRotationUI();
  if (S.tab === 'trans') renderTransPane();
  clearTimeout(S._viewT);
  const pid = S.pid;
  S._viewT = setTimeout(() => pid && S.pid === pid && saveView(), 1500);
}

function gotoPage(i, smooth = true, yPt = null, xPt = null) {
  i = Math.max(0, Math.min(S.pageEls.length - 1, i));
  const el = S.pageEls[i];
  if (!el) return;
  const p = S.layout.pages[i];
  const point = yPt == null ? null : pageToView(xPt ?? p.w / 2, yPt, p.w, p.h, pageRotation(i));
  const viewer = $('#viewer');
  const top = point == null ? el.offsetTop - 12 : el.offsetTop + point[1] * S.scale - 110;
  const left = point == null ? viewer.scrollLeft : Math.max(0, el.offsetLeft + point[0] * S.scale - viewer.clientWidth / 2);
  viewer.scrollTo({ top, left, behavior: smooth ? 'smooth' : 'auto' });
  S.cur = i;
  onPageChange();
}

function place(d, b, p) {
  d.style.left = `${(b[0] / p.w) * 100}%`;
  d.style.top = `${(b[1] / p.h) * 100}%`;
  d.style.width = `${((b[2] - b[0]) / p.w) * 100}%`;
  d.style.height = `${((b[3] - b[1]) / p.h) * 100}%`;
}

function flashRect(i, b) {
  const el = S.pageEls[i];
  if (!el || !b) return;
  const d = document.createElement('div');
  d.className = 'flash';
  place(d, [b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2], S.layout.pages[i]);
  el.querySelector('.hl-layer').appendChild(d);
  setTimeout(() => d.remove(), 2000);
}

function jumpTo(i, b) {
  gotoPage(i, true, b ? b[1] : null, b ? b[0] : null);
  if (b) setTimeout(() => flashRect(i, b), 350);
}

// ------------------------------------------------------------------ highlights layer
function renderHL(i) {
  const el = S.pageEls[i];
  if (!el || !S.st) return;
  const layer = el.querySelector('.hl-layer');
  const p = S.layout.pages[i];
  layer.querySelectorAll('.hl').forEach(n => n.remove());
  const frag = document.createDocumentFragment();
  if (S.showAuto && S.st.autohl) {
    for (const a of S.st.autohl.items) {
      if (a.page !== i || !S.hlFilter[a.cat]) continue;
      for (const r of a.rects) {
        const d = document.createElement('div');
        d.className = `hl auto cat-${a.cat}`;
        place(d, r, p);
        frag.appendChild(d);
      }
    }
  }
  if (S.hlFilter.mine) {
    for (const u of S.st.highlights) {
      if (u.page !== i) continue;
      for (const r of u.rects) {
        const d = document.createElement('div');
        d.className = 'hl mine';
        d.style.setProperty('--c', `var(--hl-${u.color})`);
        place(d, r, p);
        frag.appendChild(d);
      }
    }
  }
  layer.prepend(frag);
}
const renderAllHL = () => S.pageEls.forEach((_, i) => renderHL(i));

// ------------------------------------------------------------------ layout translation overlay
// signature of what a page's translation overlay currently shows, so polling only redraws changed pages
function trSig(i) {
  const t = S.trans[String(i)];
  const busy = running('translate') || running(`tp${i}`) || S.transPartial.has(i);
  return `${t ? Object.keys(t).length : -1}|${busy ? 1 : 0}`;
}

function renderTr(i) {
  if (S.showTrans && S.pageEls[i]) renderTrInto(S.pageEls[i].querySelector('.tr-layer'), i);
  if (S.sbs && S.twinEls[i]?.dataset.painted) renderTrInto(S.twinEls[i].querySelector('.tr-layer'), i);
}

function renderTrInto(layer, i) {
  const p = S.layout.pages[i];
  const t = S.trans[String(i)];
  const partial = S.transPartial.has(i);
  layer.innerHTML = '';
  layer.dataset.sig = trSig(i);
  if (!p.blocks.length) return;
  if (!t || partial) {
    const busy = partial || running('translate') || running(`tp${i}`);
    layer.insertAdjacentHTML('beforeend', `<div class="tr-pending">${busy ? '翻譯中…' : '此頁尚未翻譯'}</div>`);
  }
  if (!t) return;
  const { overlays } = planTranslationOverlays(p.blocks, t);
  const placed = [];
  for (const b of overlays) {
    const zh = t[b.id];
    if (!zh) continue;
    const d = document.createElement('div');
    d.className = 'tr';
    d.dataset.b = b.id;
    d.title = '點一下看原文';
    d.style.lineHeight = b.n === 1 ? '1.15' : '1.4';
    const pt = Math.max(5, b.lh * 0.9); // about the size of the original text
    d.style.fontSize = `calc(var(--scale-factor) * ${pt.toFixed(2)}px)`;
    place(d, b.bbox, p);
    d.textContent = zh;
    layer.appendChild(d);
    placed.push({ d, w: d.style.width, h: d.style.height, fit: textFitter(1, 3 / pt, TR_MAX_GROW) });
  }
  fitTexts(placed);
}

// Scale each translated text to fill its original block: larger while there is room (Chinese
// needs less room than the English it replaces), smaller when it does not fit.
// The text keeps its font size; it is laid out in a box 1/k the size of the block and the box
// is scaled by k. Trying another k then only re-wraps the lines, where a new font size has the
// browser shape every glyph again (measured ~65 ms per page per size against ~1 ms per re-wrap),
// and all blocks of the page step together so a step costs one layout. Font size and box are
// relative to the page, so zooming keeps the fit.
const TR_MAX_GROW = 2; // a nearly empty box must not blow a few words up to poster size
function fitTexts(placed) {
  const box = (x, k) => { x.d.style.width = `calc(${x.w} / ${k})`; x.d.style.height = `calc(${x.h} / ${k})`; };
  for (let live = placed; live.length; live = live.filter(x => !x.fit.done)) {
    for (const x of live) box(x, x.fit.size);
    const seen = live.map(({ d }) => d.clientHeight // 0: not laid out (hidden) — leave it unscaled
      ? [d.scrollHeight <= d.clientHeight + 1, d.scrollWidth <= d.clientWidth + 1] : [true, false]);
    live.forEach((x, n) => x.fit.next(...seen[n]));
  }
  for (const x of placed) {
    box(x, x.fit.size);
    if (x.fit.size !== 1) x.d.style.transform = `scale(${x.fit.size})`;
  }
}

function setShowTrans(on) {
  if (on && S.sbs) setSbs(false);
  S.showTrans = on;
  $('#pages').classList.toggle('show-trans', on);
  if (on) {
    S.pageEls.forEach((el, i) => { if (el.dataset.painted) renderTr(i); });
    maybeStartTranslation();
  }
  updateToolbar();
}

function refreshTrOverlays() {
  if (!S.showTrans && !S.sbs) return;
  S.pageEls.forEach((el, i) => {
    if (!el.dataset.painted) return;
    const layer = S.showTrans ? el.querySelector('.tr-layer') : S.twinEls[i].querySelector('.tr-layer');
    if (layer.dataset.sig !== trSig(i)) renderTr(i);
  });
}

// ------------------------------------------------------------------ figure explain mode
function setFigMode(on) {
  S.figMode = on;
  $('#pages')?.classList.toggle('figmode', on);
  $('#btn-fig')?.classList.toggle('on', on);
  if (on) { hideSelPop(); window.getSelection()?.removeAllRanges(); toast('在頁面上拖曳框選圖、表或公式（Esc 取消）'); }
}

function onPagesMouseDown(e) {
  if (!S.figMode || e.button !== 0) return;
  const pg = e.target.closest('.pg');
  if (!pg) return;
  e.preventDefault();
  const b = pg.getBoundingClientRect();
  const x0 = e.clientX - b.left, y0 = e.clientY - b.top;
  const box = document.createElement('div');
  box.className = 'fig-rect';
  pg.appendChild(box);
  const move = ev => {
    const x = Math.max(0, Math.min(b.width, ev.clientX - b.left));
    const y = Math.max(0, Math.min(b.height, ev.clientY - b.top));
    Object.assign(box.style, { left: `${Math.min(x0, x)}px`, top: `${Math.min(y0, y)}px`, width: `${Math.abs(x - x0)}px`, height: `${Math.abs(y - y0)}px` });
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    const r = { x: box.offsetLeft, y: box.offsetTop, w: box.offsetWidth, h: box.offsetHeight };
    box.remove();
    if (r.w < 12 || r.h < 12) return;
    setFigMode(false);
    explainRegion(+pg.dataset.i, r);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

async function cropRegion(i, r, scale, rotation) {
  const page = await S.pdf.getPage(i + 1);
  let hs = 2.5;
  const k0 = hs / scale;
  const maxSide = Math.max(r.w, r.h) * k0;
  if (maxSide > 2400) hs *= 2400 / maxSide;
  const k = hs / scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(r.w * k);
  canvas.height = Math.round(r.h * k);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: hs, rotation: (page.rotate + rotation) % 360 }), transform: [1, 0, 0, 1, -r.x * k, -r.y * k] }).promise;
  return canvas.toDataURL('image/png');
}

async function explainRegion(i, r) {
  const pid = S.pid, p = S.layout.pages[i], scale = S.scale, rotation = pageRotation(i);
  const bbox = viewRectToPage([r.x, r.y, r.x + r.w, r.y + r.h].map(v => v / scale), p.w, p.h, rotation).map(v => +v.toFixed(2));
  let png;
  try { png = await cropRegion(i, r, scale, rotation); } catch (e) { return toast('擷取圖片失敗：' + e.message, 'err'); }
  if (S.pid !== pid) return;
  runExplain('explain-image', { png, page: i, bbox }, { tmp: uid(), type: 'image', page: i, image: png });
}

// every explanation (selected text, paragraph button, figure crop) streams into a pending card in 解釋
async function runExplain(endpoint, body, tmp) {
  const pid = S.pid;
  openTab('explain');
  S.pending.explain.unshift(tmp);
  renderExplainPane();
  const onDelta = liveRenderer(t => {
    tmp.live = stripHead(t);
    const el = document.querySelector(`[data-tmp="${tmp.tmp}"] .live`);
    if (el && tmp.live.trim()) el.innerHTML = md(tmp.live);
  });
  try {
    const item = await streamApi(`papers/${pid}/${endpoint}`, body, onDelta);
    if (S.pid === pid) { S.st.explanations.unshift(item); renderEx(item.page); }
  } catch (e) { toast('解釋失敗：' + e.message, 'err'); }
  if (S.pid !== pid) return;
  S.pending.explain = S.pending.explain.filter(x => x !== tmp);
  renderExplainPane();
}

const explainBlock = (i, b) =>
  runExplain('explain', { page: i, block: b.id }, { tmp: uid(), type: 'text', page: i, source: b.text });

// ------------------------------------------------------------------ paragraph button, explanation labels, twin link
const blkBtn = Object.assign(document.createElement('button'), { className: 'blk-btn', title: '解釋這一段', hidden: true });
blkBtn.innerHTML = icon('sparkles');

function blockAt(i, x, y) {
  const bs = S.layout.pages[i].blocks.filter(b => !b.ref && b.text.length >= 8);
  const inside = (b, left) => x >= b.bbox[0] - left && x <= b.bbox[2] + 4 && y >= b.bbox[1] - 3 && y <= b.bbox[3] + 3;
  return bs.find(b => inside(b, 0)) || bs.find(b => inside(b, 34)); // 34pt of left margin reaches the button
}

function hideBlkBtn() {
  blkBtn.hidden = true;
  S.hover = null;
}

function setLink(i, bid) {
  $$('.link-rect').forEach(n => n.remove());
  $$('.pg-twin .tr.linked').forEach(n => n.classList.remove('linked'));
  if (!S.sbs || bid == null) return;
  const b = S.layout.pages[i].blocks.find(x => x.id === bid);
  if (!b) return;
  const d = document.createElement('div');
  d.className = 'link-rect';
  place(d, b.bbox, S.layout.pages[i]);
  S.pageEls[i].querySelector('.hl-layer').appendChild(d);
  S.twinEls[i].querySelector(`.tr[data-b="${bid}"]`)?.classList.add('linked');
}

function onPagesMove(e) {
  if (S._hoverRaf) return;
  const { clientX, clientY, target, buttons } = e;
  S._hoverRaf = requestAnimationFrame(() => {
    S._hoverRaf = 0;
    if (!S.layout || S.figMode || buttons) return hideBlkBtn();
    if (target.closest?.('.blk-btn')) return;
    const twinTr = target.closest?.('.pg-twin .tr');
    if (twinTr) { hideBlkBtn(); return setLink(+twinTr.closest('.pg-twin').dataset.i, twinTr.dataset.b); }
    const pg = target.closest?.('.pg');
    if (!pg) { setLink(0, null); return hideBlkBtn(); }
    const i = +pg.dataset.i, r = pg.getBoundingClientRect();
    const p = S.layout.pages[i];
    const [x, y] = viewToPage((clientX - r.left) / S.scale, (clientY - r.top) / S.scale, p.w, p.h, pageRotation(i));
    const b = blockAt(i, x, y);
    if (!b) { setLink(0, null); return hideBlkBtn(); }
    if (S.hover?.b === b) return;
    S.hover = { i, b };
    setLink(i, b.id);
    pg.querySelector('.pg-surface').appendChild(blkBtn);
    blkBtn.style.left = `${Math.max(2, b.bbox[0] * S.scale - 30)}px`;
    blkBtn.style.top = `${b.bbox[1] * S.scale - 2}px`;
    blkBtn.hidden = false;
  });
}

// labels on the page for explanations anchored to a spot (paragraph, selection or figure)
function renderEx(i) {
  const el = S.pageEls[i];
  if (!el || !S.st) return;
  const layer = el.querySelector('.ex-layer');
  layer.innerHTML = '';
  if (!S.showExChips) return;
  const p = S.layout.pages[i];
  for (const x of S.st.explanations) {
    if (x.page !== i || !x.bbox) continue;
    const c = document.createElement('button');
    c.className = 'ex-chip';
    c.dataset.ex = x.id;
    c.title = '看這則解釋';
    c.innerHTML = `${icon('lightbulb')}<span>${esc(x.title || TYPE_LABEL[x.type] || '解釋')}</span>`;
    c.style.left = `${(x.bbox[0] / p.w) * 100}%`;
    c.style.top = `calc(${(x.bbox[1] / p.h) * 100}% - 22px)`;
    layer.appendChild(c);
  }
}

function showExplanation(id) {
  S.exFilter = 'all';
  openTab('explain');
  const card = document.querySelector(`[data-ex-card="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  card.classList.remove('flash-card');
  void card.offsetWidth;
  card.classList.add('flash-card');
}

// ------------------------------------------------------------------ selection popup
function selRects(range) {
  const raw = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1);
  if (!raw.length) return {};
  const out = {};
  for (const r of raw) {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const i = S.pageEls.findIndex(el => {
      const b = el.getBoundingClientRect();
      return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
    });
    if (i < 0) continue;
    const b = S.pageEls[i].getBoundingClientRect();
    const p = S.layout.pages[i];
    (out[i] ??= []).push(viewRectToPage([(r.left - b.left) / S.scale, (r.top - b.top) / S.scale, (r.right - b.left) / S.scale, (r.bottom - b.top) / S.scale], p.w, p.h, pageRotation(i)));
  }
  for (const k of Object.keys(out)) {
    const heights = out[k].map(r => r[3] - r[1]).sort((a, b) => a - b);
    const median = heights[heights.length >> 1];
    out[k] = mergeRects(out[k].filter(r => r[3] - r[1] <= median * 2.5));
  }
  return out;
}

function mergeRects(rs) {
  rs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines = [];
  for (const r of rs) {
    const cy = (r[1] + r[3]) / 2;
    const L = lines.find(l => Math.abs((l[1] + l[3]) / 2 - cy) < Math.min(l[3] - l[1], r[3] - r[1]) * 0.6 && r[0] <= l[2] + 8 && r[2] >= l[0] - 8);
    if (L) { L[0] = Math.min(L[0], r[0]); L[1] = Math.min(L[1], r[1]); L[2] = Math.max(L[2], r[2]); L[3] = Math.max(L[3], r[3]); }
    else lines.push([...r]);
  }
  return lines.map(l => l.map(v => +v.toFixed(2)));
}

const CITE_RE = /^[\[(]?\s*\d{1,3}(?:\s*[–\-,]\s*\d{1,3})*\s*[\])]?$/;
function citeNumbers(text) {
  const out = new Set();
  for (const part of text.replace(/[\[\]()]/g, '').split(',')) {
    const m = part.trim().match(/^(\d{1,3})(?:\s*[–\-]\s*(\d{1,3}))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let n = a; n <= Math.min(b, a + 40); n++) out.add(n);
  }
  return [...out];
}

function onMouseUp(e) {
  if (S.figMode || !S.pid) return;
  if ($('#sel-pop').contains(e.target)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().replace(/\s+/g, ' ').trim();
    if (!text || !sel.rangeCount) return hideSelPop();
    const range = sel.getRangeAt(0);
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const pg = node?.closest('.pg, .pg-twin');
    const inTrans = node?.closest('#trans-list');
    if (!pg && !inTrans) return hideSelPop();
    S.sel = { text, page: pg ? +pg.dataset.i : S.cur, rects: pg ? selRects(range) : {} };
    showSelPop(range.getBoundingClientRect());
  }, 0);
}

function showSelPop(rect) {
  const pop = $('#sel-pop');
  const isCite = CITE_RE.test(S.sel.text);
  $('[data-act="cite"]', pop).hidden = !isCite;
  $('.dots', pop).style.display = Object.keys(S.sel.rects).length ? '' : 'none';
  const body = $('.pop-body', pop);
  body.hidden = true;
  body.innerHTML = '';
  pop.hidden = false;
  positionPop(rect);
  if (isCite && S.st.refs?.refs?.length) showCite();
}

function positionPop(rect) {
  const pop = $('#sel-pop');
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let top = rect.top - h - 8;
  if (top < 8) top = rect.bottom + 8;
  top = Math.min(top, window.innerHeight - h - 8);
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
  S.popRect = rect;
}

function hideSelPop() {
  const pop = $('#sel-pop');
  if (pop) pop.hidden = true;
}

function popBody(html) {
  const body = $('#sel-pop .pop-body');
  body.hidden = false;
  body.innerHTML = html;
  hydrateIcons(body);
  postMd(body);
  if (S.popRect) positionPop(S.popRect);
}

function showCite() {
  const refs = S.st.refs?.refs || [];
  if (!refs.length) {
    popBody(`<div class="faint">還沒有擷取參考文獻。</div><div class="pop-actions"><button class="ghost" data-pop="extract-refs">擷取參考文獻</button></div>`);
    return;
  }
  const nums = citeNumbers(S.sel.text);
  const hits = nums.map(n => refs.find(r => +r.n === n)).filter(Boolean);
  popBody(hits.length ? `<ul class="ref-list">${hits.map(refItem).join('')}</ul>` : '<div class="faint">找不到對應編號的參考文獻。</div>');
}

async function onPopAction(e) {
  const btn = e.target.closest('button');
  if (!btn || !S.sel) return;
  const { text, page, rects } = S.sel;
  const pid = S.pid;
  if (btn.dataset.color) {
    const group = uid();
    for (const [pg, rs] of Object.entries(rects)) {
      S.st.highlights.push({ id: uid(), group, page: +pg, rects: rs, color: btn.dataset.color, text, created: new Date().toISOString() });
      renderHL(+pg);
    }
    saveHighlights();
    window.getSelection()?.removeAllRanges();
    hideSelPop();
    if (S.tab === 'hl') renderHLPane();
    return;
  }
  const act = btn.dataset.act || btn.dataset.pop;
  if (act === 'copy') { copyText(text); hideSelPop(); }
  else if (act === 'note') { appendNote(quoteMd(text, page)); hideSelPop(); }
  else if (act === 'ask') {
    hideSelPop();
    openTab('ai');
    const ta = $('#chat-input');
    ta.value = `關於這段：「${text}」\n`;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  } else if (act === 'explain') {
    hideSelPop();
    explainSelection(text, page, rects);
  } else if (act === 'translate') {
    popBody('<div class="status-line"><span class="spinner"></span>翻譯中…</div><div class="pop-live"></div>');
    const live = liveRenderer(t => {
      const el = $('#sel-pop .pop-live');
      if (!el) return;
      $('#sel-pop .status-line')?.remove();
      el.textContent = t;
    });
    try {
      const r = await streamApi(`papers/${pid}/translate-text`, { text }, live);
      if (S.pid !== pid || $('#sel-pop').hidden) return;
      S.popTrans = r.text;
      popBody(`<div>${esc(r.text)}</div><div class="pop-actions"><button class="ghost" data-pop="copy-trans" data-icon="copy">複製譯文</button><button class="ghost" data-pop="note-trans" data-icon="note-add">加入筆記</button></div>`);
    } catch (err) { popBody(`<div class="err-box">翻譯失敗：${esc(err.message)}</div>`); }
  } else if (act === 'copy-trans') copyText(S.popTrans || '');
  else if (act === 'note-trans') { appendNote(`${quoteMd(text, page)}\n\n${S.popTrans}`); hideSelPop(); }
  else if (act === 'cite') showCite();
  else if (act === 'extract-refs') { hideSelPop(); openTab('refs'); startJob('references', 'refs'); }
}

function explainSelection(text, page, rects) {
  const rs = rects?.[page];
  const bbox = rs?.length
    ? [Math.min(...rs.map(r => r[0])), Math.min(...rs.map(r => r[1])), Math.max(...rs.map(r => r[2])), Math.max(...rs.map(r => r[3]))]
    : undefined;
  runExplain('explain', { text, page, bbox }, { tmp: uid(), type: 'text', page, source: text });
}

const quoteMd = (text, page) => `> ${text.replace(/\n/g, '\n> ')}\n> — p.${page + 1}`;

function saveHighlights() {
  api(`papers/${S.pid}/highlights`, { method: 'PUT', body: { items: S.st.highlights } }).catch(e => toast('高亮儲存失敗：' + e.message, 'err'));
}

function appendNote(block) {
  S.st.notes = (S.st.notes.trimEnd() + '\n\n' + block).trimStart() + '\n';
  saveNotes(true);
  if (S.tab === 'notes') renderNotesPane();
  toast('已加入筆記');
}

function saveNotes(now = false) {
  clearTimeout(S._notesT);
  const pid = S.pid, text = S.st.notes;
  const run = () => api(`papers/${pid}/notes`, { method: 'PUT', body: { text } })
    .then(() => { const s = $('#notes-status'); if (s) s.textContent = '已儲存'; })
    .catch(e => toast('筆記儲存失敗：' + e.message, 'err'));
  if (now) return run();
  S._notesT = setTimeout(run, 700);
  return Promise.resolve();
}

async function saveToVault() {
  const pid = S.pid;
  const btn = $('#notes-vault');
  if (btn) btn.disabled = true;
  try {
    await saveNotes(true);
    let r;
    try {
      r = await api(`papers/${pid}/vault`, { method: 'POST', body: {} });
    } catch (e) {
      if (!e.data?.conflict) throw e;
      if (!(await confirmBox(`${e.message}（可能是在 Obsidian 裡編輯過）。要用論文伴讀的版本覆蓋嗎？`))) return;
      r = await api(`papers/${pid}/vault`, { method: 'POST', body: { force: true } });
    }
    if (S.pid !== pid) return;
    S.st.meta.vault_file = r.file;
    S.st.meta.vault_saved = r.saved;
    toast(`已存到 PaperBrain：${r.file}`, '', { href: r.obsidian, label: '在 Obsidian 開啟' });
    if (S.tab === 'notes') $('#vault-status').textContent = vaultStatus();
  } catch (e) {
    toast('存入 PaperBrain 失敗：' + e.message, 'err');
  } finally {
    if ($('#notes-vault')) $('#notes-vault').disabled = false;
  }
}

const vaultStatus = () => S.st.meta.vault_saved ? `上次存入 PaperBrain：${fmtTime(S.st.meta.vault_saved)}` : '';

// ------------------------------------------------------------------ jobs / polling
async function startJob(action, name, body = {}) {
  try {
    await api(`papers/${S.pid}/${action}`, { method: 'POST', body });
    S.st.jobs[name] = { status: 'running' };
    updateToolbar();
    renderPane();
    schedulePoll(1500);
  } catch (e) { toast(e.message, 'err'); }
}

function schedulePoll(delay) {
  clearTimeout(S.pollT);
  if (!S.pid || !anyRunning()) return;
  // translations stream in block by block — poll faster while they are on screen
  const watching = running('translate') && (S.showTrans || S.sbs || S.tab === 'trans');
  S.pollT = setTimeout(refreshState, delay ?? (watching ? 1200 : 2500));
}

async function refreshState() {
  const pid = S.pid;
  if (!pid) return;
  let st;
  try { st = await api(`papers/${pid}/state`); } catch { S.pollT = setTimeout(refreshState, 5000); return; }
  if (pid !== S.pid) return;
  const old = S.st;
  // keep optimistic client-side lists; the server copies of these only change through this client
  st.highlights = old.highlights;
  st.notes = old.notes;
  st.explanations = old.explanations;
  st.chat = old.chat;
  S.st = st;
  for (const [k, j] of Object.entries(st.jobs)) {
    const o = old.jobs?.[k];
    if (o?.status === 'running' && j.status === 'error' && j.error !== '已取消') toast(`${JOB_LABEL[k] || '翻譯'}失敗：${j.error}`, 'err');
    if (o?.status === 'running' && j.status === 'done' && k === 'classify') {
      if (st.meta.category) toast(`AI 已把這篇歸入書庫分類「${st.meta.category}」`);
    } else if (o?.status === 'running' && j.status === 'done' && JOB_LABEL[k]) {
      const run = SKILL_INFO[k] && (st.skillnotes || []).find(r => r.skill === k && r.status === 'done');
      toast(`${JOB_LABEL[k]}完成`, '', run ? { href: run.obsidian, label: '在 Obsidian 開啟' } : null);
    }
  }
  const transChanged = sig(old.translated) !== sig(st.translated) || sig(old.partial) !== sig(st.partial);
  if (transChanged) {
    const r = await api(`papers/${pid}/translations`).catch(() => null);
    if (!r || S.pid !== pid) return schedulePoll();
    S.trans = r.pages;
    S.transPartial = new Set(r.partial);
  }
  refreshTrOverlays();
  if (sig(old.autohl) !== sig(st.autohl)) renderAllHL();
  if (sig(old.analysis) !== sig(st.analysis) && st.analysis) {
    $('#doc-title').textContent = st.meta.title_zh || st.meta.title;
  }
  updateToolbar();
  const changed = {
    ai: sig(old.analysis) !== sig(st.analysis) || sig(old.jobs.analyze) !== sig(st.jobs.analyze),
    trans: transChanged || sig(old.jobs) !== sig(st.jobs),
    hl: sig(old.autohl) !== sig(st.autohl) || sig(old.jobs.autohl) !== sig(st.jobs.autohl),
    refs: sig(old.refs) !== sig(st.refs) || sig(old.jobs.refs) !== sig(st.jobs.refs),
  };
  if (changed[S.tab]) renderPane();
  if (S.tab === 'notes' && sig(old.skillnotes) !== sig(st.skillnotes)) renderSkillRuns();
  schedulePoll();
}

function updateToolbar() {
  if (!S.st) return;
  const n = S.layout.pages.length, done = S.st.translated.length;
  const ba = $('#btn-auto');
  ba.classList.toggle('on', S.showAuto && !!S.st.autohl);
  ba.classList.toggle('busy', running('autohl'));
  const bt = $('#btn-trans');
  bt.classList.toggle('on', S.showTrans);
  bt.classList.toggle('busy', running('translate') && S.showTrans);
  const bs = $('#btn-sbs');
  bs.classList.toggle('on', S.sbs);
  bs.classList.toggle('busy', running('translate') && S.sbs);
  const badge = $('#trans-badge');
  badge.hidden = !(running('translate') && done < n);
  badge.textContent = `${done}/${n}`;
  $('#btn-fig').classList.toggle('on', S.figMode);
  const m = S.st.meta, star = $('#btn-star');
  star.classList.toggle('on', !!m.starred);
  star.title = m.starred ? '取消星號' : '加星號';
  star.setAttribute('aria-pressed', !!m.starred);
  $('#status-select').value = m.status || 'reading';
  $('#status-select').className = `st-${m.status || 'reading'}`;
}

async function setPaperFlag(op, value) {
  const pid = S.pid;
  if (op === 'star') S.st.meta.starred = value; else S.st.meta.status = value;
  updateToolbar();
  try { await api('batch', { method: 'POST', body: { ids: [pid], op, value } }); } catch (e) { toast(e.message, 'err'); }
}

// ------------------------------------------------------------------ panel
function applyPanel() {
  $('#workspace').classList.toggle('panel-closed', !S.panelOpen);
  const w = store.get('panelW', 430);
  $('#panel').style.setProperty('--panel-w', `${w}px`);
  const rail = $('#panel-rail');
  rail.innerHTML = `<button class="rail-btn" id="btn-panel" data-icon="panel" data-tip="${S.panelOpen ? '收合面板' : '展開面板'}"></button><span class="rail-sep"></span>` +
    TABS.map(([k, ic, label]) => `<button class="rail-btn ${k === S.tab && S.panelOpen ? 'active' : ''}" data-tab="${k}" data-icon="${ic}" data-tip="${label}"></button>`).join('');
  hydrateIcons(rail);
}

function openTab(t) {
  if (!S.panelOpen) { S.panelOpen = true; store.set('panelOpen', true); applyPanel(); if (S.zoom === 'auto') setZoom('auto'); }
  selectTab(t);
}

function selectTab(t) {
  S.tab = t;
  store.set('tab', t);
  $$('#panel-rail [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === t && S.panelOpen));
  renderPane(true);
}

function renderPane(fresh = false) {
  if (!S.st) return;
  const t = S.tab;
  if (t === 'ai') return fresh ? mountAIPane() : renderAISections();
  if (t === 'trans') return fresh ? mountTransPane() : renderTransPane();
  if (t === 'explain') return renderExplainPane();
  if (t === 'hl') return renderHLPane();
  if (t === 'notes') return fresh ? renderNotesPane() : null;
  if (t === 'quiz') return renderQuizPane();
  if (t === 'refs') return renderRefsPane();
}

// ---- model / effort pickers
const EFFORT_LABEL = { off: '不思考（最快）', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const modelOptions = () => (S.cfg?.models || []).map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
const effortOptions = () => (S.cfg?.efforts || Object.keys(EFFORT_LABEL)).map(e => `<option value="${e}">${EFFORT_LABEL[e] || e}</option>`).join('');

async function loadConfig() {
  try { S.cfg = await api('settings'); } catch { S.cfg = null; }
}

// ---- AI pane
const STATIC_Q = ['這篇論文的核心是什麼？', '與現有研究有什麼不同？', '有什麼局限性？'];

function mountAIPane() {
  $('#panel-body').innerHTML = `
    <div class="pane">
      <div class="pane-scroll" id="ai-scroll">
        <div id="ai-sections"></div>
        <div id="chat-log"></div>
      </div>
      <div class="ai-bottom">
        <div class="suggest" id="suggest"></div>
        <div class="chat-box">
          <textarea id="chat-input" rows="2" placeholder="有什麼儘管問我。（Enter 送出，Shift+Enter 換行）"></textarea>
          <div class="chat-row">
            <button class="icon-btn" id="chat-clear" data-icon="trash" title="清除對話"></button>
            <span class="grow"></span>
            <select id="chat-model" title="模型">${modelOptions()}</select>
            <select id="chat-effort" title="effort（思考強度）：越高想得越久、越慢">${effortOptions()}</select>
            <button class="send-btn" id="chat-send" data-icon="send" title="送出"></button>
          </div>
        </div>
      </div>
    </div>`;
  hydrateIcons($('#panel-body'));
  const ids = (S.cfg?.models || []).map(m => m.id);
  const m = store.get('chatModel', null), ef = store.get('chatEffort', null);
  $('#chat-model').value = ids.includes(m) ? m : (S.cfg?.model_chat || ids[0] || '');
  $('#chat-effort').value = (S.cfg?.efforts || []).includes(ef) ? ef : (S.cfg?.effort_chat || 'medium');
  renderAISections();
  renderChat();
  $('#ai-scroll').scrollTop = 0;
}

const secHead = (key, title, tools = '') =>
  `<div class="sec-head"><button class="sec-title" data-sec-toggle="${key}">${icon('chevron')}${title}</button><span class="grow"></span>${tools}</div>`;

function renderAISections() {
  const box = $('#ai-sections');
  if (!box) return;
  const a = S.st.analysis, j = jobOf('analyze');
  if (!S.st.meta.has_text) { box.innerHTML = '<div class="err-box">這份 PDF 沒有文字層，無法產生摘要。</div>'; return; }
  if (!a) {
    if (j?.status === 'running') {
      box.innerHTML = `<div class="sec"><div class="status-line"><span class="spinner"></span>AI 正在閱讀全文，產生摘要與關鍵字（約 1–2 分鐘）…</div><div class="skeleton"><i></i><i></i><i></i></div></div>`;
    } else {
      box.innerHTML = `<div class="sec">${j?.status === 'error' ? `<div class="err-box">摘要產生失敗：${esc(j.error)}</div><br>` : ''}
        <button class="primary" data-ai="analyze" data-icon="sparkles">產生摘要與關鍵字</button></div>`;
    }
    hydrateIcons(box);
    renderSuggest();
    return;
  }
  const tools = key => `<button class="icon-btn" data-copy-sec="${key}" data-icon="copy" title="複製"></button><button class="icon-btn" data-ai="analyze" data-icon="refresh" title="重新產生"></button>`;
  const regenBusy = j?.status === 'running' ? '<div class="status-line"><span class="spinner"></span>重新產生中…</div>' : '';
  const kws = a.keywords || [];
  const m = a.meta || {};
  box.innerHTML = `
    ${regenBusy}
    <section class="sec ${store.get('sec:kw', false) ? 'collapsed' : ''}" data-sec="kw">
      ${secHead('kw', '關鍵字詞典', tools('kw'))}
      <div class="sec-body">
        <div class="kw-chips clampable clamped" style="--clamp:112px" id="kw-chips">${kws.map((k, i) => `<button class="kw" data-kw="${i}">${esc(k.term)}</button>`).join('')}</div>
        <div class="more-wrap"><button class="more-btn" data-more="kw-chips">查看全部</button></div>
        <div class="kw-detail" id="kw-detail" hidden></div>
      </div>
    </section>
    <section class="sec ${store.get('sec:tldr', false) ? 'collapsed' : ''}" data-sec="tldr">
      ${secHead('tldr', '三行摘要', tools('tldr'))}
      <div class="sec-body"><ol class="tldr">${(a.tldr || []).map(t => `<li>${esc(t)}</li>`).join('')}</ol></div>
    </section>
    <section class="sec ${store.get('sec:sum', false) ? 'collapsed' : ''}" data-sec="sum">
      ${secHead('sum', '摘要', tools('sum'))}
      <div class="sec-body">
        <div class="md clampable clamped" style="--clamp:240px" id="sum-md">${md(a.summary)}</div>
        <div class="more-wrap"><button class="more-btn" data-more="sum-md">查看全部</button></div>
        <div class="meta-line">${[m.study_type, m.authors, [m.journal, m.year].filter(Boolean).join(' '), m.doi ? `DOI ${m.doi}` : ''].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
    </section>`;
  hydrateIcons(box);
  postMd(box);
  renderSuggest();
}

function renderSuggest() {
  const box = $('#suggest');
  if (!box) return;
  const qs = [...STATIC_Q, ...(S.st.analysis?.questions || [])];
  box.innerHTML = S.st.chat.length > 2 ? '' : qs.slice(0, 6).map(q => `<button class="chip" data-q="${esc(q)}" title="${esc(q)}"><span>${esc(q)}</span></button>`).join('');
}

function renderChat() {
  const log = $('#chat-log');
  if (!log) return;
  const msgs = S.st.chat.map((m, i) => m.role === 'user'
    ? `<div class="msg user">${esc(m.content)}</div>`
    : `<div class="msg bot"><div class="md">${md(m.content)}</div>
        <div class="msg-tools"><button class="icon-btn" data-chat-copy="${i}" data-icon="copy" title="複製"></button>
        <button class="icon-btn" data-chat-note="${i}" data-icon="note-add" title="加入筆記"></button><span>${esc(m.model || '')}</span></div></div>`);
  if (S.pending.chat) {
    msgs.push(`<div class="msg user">${esc(S.pending.chat)}</div>`,
      `<div class="msg bot" id="chat-live"><div class="md live"></div><div class="typing"><span></span><span></span><span></span></div></div>`);
  }
  log.innerHTML = msgs.join('');
  hydrateIcons(log);
  postMd(log);
  const send = $('#chat-send');
  if (send) send.disabled = !!S.pending.chat;
  renderSuggest();
}

async function sendChat(q) {
  q = (q || '').trim();
  if (!q || S.pending.chat) return;
  const pid = S.pid;
  S.pending.chat = q;
  const ta = $('#chat-input');
  if (ta) ta.value = '';
  renderChat();
  scrollChat();
  const model = $('#chat-model')?.value || S.cfg?.model_chat;
  const effort = $('#chat-effort')?.value || S.cfg?.effort_chat;
  store.set('chatModel', model);
  store.set('chatEffort', effort);
  const live = liveRenderer(t => {
    const el = $('#chat-live .live');
    if (!el) return;
    const nearBottom = (() => { const s = $('#ai-scroll'); return s && s.scrollHeight - s.scrollTop - s.clientHeight < 80; })();
    el.innerHTML = md(t);
    if (nearBottom) scrollChat();
  });
  try {
    const reply = await streamApi(`papers/${pid}/chat`, { message: q, model, effort }, live);
    if (S.pid !== pid) return;
    S.st.chat.push({ role: 'user', content: q }, reply);
  } catch (e) {
    toast('提問失敗：' + e.message, 'err');
    if ($('#chat-input')) $('#chat-input').value = q;
  }
  if (S.pid !== pid) return;
  S.pending.chat = null;
  renderChat();
  scrollChat();
}
const scrollChat = () => { const s = $('#ai-scroll'); if (s) s.scrollTop = s.scrollHeight; };

// ---- translation pane
function mountTransPane() {
  $('#panel-body').innerHTML = `
    <div class="pane">
      <div class="pane-head" id="trans-head"></div>
      <div class="pane-scroll ${S.onlyZh ? 'only-zh' : ''}" id="trans-list"></div>
    </div>`;
  renderTransPane();
}

function renderTransPane() {
  const head = $('#trans-head'), list = $('#trans-list');
  if (!head || !list) return;
  const n = S.layout.pages.length, done = S.st.translated.length, i = S.cur;
  const p = S.layout.pages[i], t = S.trans[String(i)];
  const allBusy = running('translate'), pageBusy = running(`tp${i}`) || (allBusy && !t);
  const jt = jobOf('translate');
  const { preserved } = planTranslationOverlays(p.blocks, t);
  head.innerHTML = `
    <h2>第 ${i + 1} 頁</h2><span class="faint small">全文 ${done}/${n} 頁已翻譯</span><span class="grow"></span>
    <label class="toggle"><input type="checkbox" id="only-zh" ${S.onlyZh ? 'checked' : ''}>只看譯文</label>
    ${done < n && !allBusy ? `<button class="chip" data-tr="all" data-icon="languages">翻譯全文</button>` : ''}
    ${allBusy ? `<div class="progress"><i style="width:${(100 * done) / n}%"></i></div>` : ''}
    ${jt?.status === 'error' ? `<div class="err-box" style="width:100%">${esc(jt.error)}</div>` : ''}
    ${preserved.length ? '<div class="faint small" style="width:100%">含重疊內容的段落在版面翻譯中保留原文，避免蓋住公式；下方仍提供譯文。</div>' : ''}`;
  hydrateIcons(head);
  const blocks = p.blocks.filter(b => !b.ref && /[A-Za-z]{2}/.test(b.text));
  if (!blocks.length) { list.innerHTML = '<div class="pane-empty">這一頁沒有可翻譯的文字。</div>'; return; }
  const partial = S.transPartial.has(i);
  const intro = t && !partial ? '' : `<div class="sec">${pageBusy || partial
    ? '<div class="status-line"><span class="spinner"></span>這一頁翻譯中…（譯好的段落會陸續出現）</div>'
    : `<button class="primary" data-tr="page" data-icon="languages">翻譯這一頁</button>`}</div>`;
  list.innerHTML = intro + blocks.map(b => {
    const zh = t ? (t[b.id] || '') : '';
    const empty = partial ? '<span class="faint small">翻譯中…</span>' : '<span class="faint small">（不翻譯）</span>';
    return `<div class="bi" data-b="${b.id}"><div class="bi-en">${esc(b.text)}</div>${t ? `<div class="bi-zh">${zh ? esc(zh) : empty}</div>` : ''}</div>`;
  }).join('');
  hydrateIcons(list);
}

// ---- explanations pane
function renderExplainPane() {
  if (S.tab !== 'explain') return;
  const f = S.exFilter;
  const items = S.st.explanations.filter(e => f === 'all' || e.type === f);
  const pend = S.pending.explain.filter(e => f === 'all' || e.type === f);
  const card = (e, pending) => `
    <article class="ex-card" ${pending ? `data-tmp="${e.tmp}"` : `data-ex-card="${e.id}"`}>
      <header><span class="badge t-${e.type}">${TYPE_LABEL[e.type] || e.type}</span>
        <a class="pg-link" data-p="${e.page + 1}">p.${e.page + 1}</a>
        ${pending ? '' : `<time>${fmtTime(e.created)}</time>`}<span class="grow"></span>
        ${pending ? '' : `<button class="icon-btn" data-ex-note="${e.id}" data-icon="note-add" title="加入筆記"></button><button class="icon-btn danger" data-ex-del="${e.id}" data-icon="trash" title="刪除"></button>`}
      </header>
      ${e.title ? `<div class="ex-title">${esc(e.title)}</div>` : ''}
      ${e.type === 'image' ? `<img src="${pending ? e.image : `/api/papers/${S.pid}/image?name=${encodeURIComponent(e.image)}`}" alt="">` : `<blockquote>${esc(e.source)}</blockquote>`}
      ${pending
        ? `<div class="md live">${e.live?.trim() ? md(e.live) : '<div class="status-line"><span class="spinner"></span>AI 解釋中…</div>'}</div>`
        : `<div class="md">${md(e.answer)}</div>`}
    </article>`;
  $('#panel-body').innerHTML = `
    <div class="pane">
      <div class="pane-head"><h2>解釋</h2><span class="grow"></span>
        ${['all', 'text', 'image', 'table', 'formula'].map(k => `<button class="chip ${f === k ? 'on' : ''}" data-exf="${k}">${k === 'all' ? '全部' : TYPE_LABEL[k]}</button>`).join('')}
        <label class="toggle" style="width:100%"><input type="checkbox" id="ex-chips" ${S.showExChips ? 'checked' : ''}>在頁面顯示解釋標籤</label>
      </div>
      <div class="pane-scroll">
        ${pend.map(e => card(e, true)).join('')}
        ${items.map(e => card(e, false)).join('')}
        ${!items.length && !pend.length ? '<div class="pane-empty">滑鼠移到段落旁，點左邊的 ✦ 就能解釋那一段（點標題會解釋整節）；<br>也可以選取文字按「解釋」，或用上方「圖片說明」框選圖、表、公式。</div>' : ''}
      </div>
    </div>`;
  hydrateIcons($('#panel-body'));
  postMd($('#panel-body'));
}

// ---- highlights pane
function hlColor(h) { return h.cat ? `var(--cat-${h.cat})` : `var(--hl-${h.color})`; }

function renderHLPane() {
  if (S.tab !== 'hl') return;
  const auto = S.st.autohl?.items || [];
  const j = jobOf('autohl');
  const items = [
    ...auto.filter(a => S.hlFilter[a.cat]).map(a => ({ ...a, kind: 'auto' })),
    ...(S.hlFilter.mine ? S.st.highlights.map(h => ({ ...h, kind: 'mine' })) : []),
  ].sort((a, b) => a.page - b.page || (a.rects[0]?.[1] ?? 0) - (b.rects[0]?.[1] ?? 0));
  $('#panel-body').innerHTML = `
    <div class="pane">
      <div class="pane-head"><h2>高亮</h2><span class="grow"></span>
        ${j?.status === 'running' ? '<span class="status-line"><span class="spinner"></span>AI 找重點句中…</span>'
          : `<button class="chip" data-hl="gen" data-icon="${auto.length ? 'refresh' : 'sparkles'}">${auto.length ? '重新產生自動高亮' : '產生自動高亮'}</button>`}
        <div style="width:100%;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <label class="toggle"><input type="checkbox" id="show-auto" ${S.showAuto ? 'checked' : ''}>頁面顯示自動高亮</label>
          <span class="grow"></span>
          ${Object.entries(CAT_LABEL).map(([k, v]) => `<button class="chip cat-chip ${k} ${S.hlFilter[k] ? 'on' : ''}" data-hlf="${k}">${v}</button>`).join('')}
          <button class="chip ${S.hlFilter.mine ? 'on' : ''}" data-hlf="mine">我的高亮</button>
        </div>
        ${j?.status === 'error' ? `<div class="err-box" style="width:100%">${esc(j.error)}</div>` : ''}
      </div>
      <div class="pane-scroll">
        ${items.map(h => `
          <div class="hl-item" data-hl-go="${h.kind}:${h.id}">
            <span class="hl-bar" style="background:${hlColor(h)}"></span>
            <div style="flex:1;min-width:0">
              <div class="hl-text">${esc(h.text)}</div>
              ${h.note ? `<div class="hl-note">${esc(h.note)}</div>` : ''}
              <div class="hl-meta"><span>p.${h.page + 1}</span><span>${h.kind === 'auto' ? CAT_LABEL[h.cat] : '我的高亮・' + (COLOR_LABEL[h.color] || '')}</span></div>
            </div>
            ${h.kind === 'mine' ? `<button class="icon-btn danger" data-hl-del="${h.id}" data-icon="trash" title="刪除"></button>` : ''}
          </div>`).join('')}
        ${!items.length ? '<div class="pane-empty">選取文字後點色點即可高亮。<br>「自動高亮」會請 AI 標出新穎性、方法、結果的關鍵句。</div>' : ''}
      </div>
    </div>`;
  hydrateIcons($('#panel-body'));
}

// ---- notes pane
function renderNotesPane() {
  const skill = S.notesView === 'skill';
  const busy = (S.st.skillnotes || []).some(r => r.status === 'running');
  $('#panel-body').innerHTML = `
    <div class="pane">
      <div class="pane-head"><h2>筆記</h2>
        <div class="seg"><button data-nv="mine" class="${skill ? '' : 'on'}">我的筆記</button><button data-nv="skill" class="${skill ? 'on' : ''}">Skill 筆記<span class="nv-dot" id="nv-dot" ${busy ? '' : 'hidden'}></span></button></div>
        ${skill ? '' : `<div class="row-break"></div>
        <div class="seg"><button data-nm="edit" class="${S.notesMode === 'edit' ? 'on' : ''}">編輯</button><button data-nm="preview" class="${S.notesMode === 'preview' ? 'on' : ''}">預覽</button></div>
        <span class="grow"></span>
        <button class="chip" id="notes-export" data-icon="download" title="下載 .md 檔">匯出</button>
        <button class="chip on" id="notes-vault" data-icon="vault" title="連同摘要、關鍵字、高亮、AI 解釋存進 PaperBrain vault">存到 PaperBrain</button>
        <div class="faint small" style="width:100%"><span id="notes-status"></span>　<span id="vault-status"></span></div>`}
      </div>
      ${skill ? '<div class="pane-scroll" id="skill-pane"></div>' : `
      <div class="notes-area">
        <textarea id="notes-ta" placeholder="在此自由記錄……支援 Markdown 與 $LaTeX$ 公式。&#10;選取論文文字、解釋、對話回答都可以「加入筆記」。" ${S.notesMode === 'edit' ? '' : 'hidden'}></textarea>
        <div id="notes-preview" class="md" ${S.notesMode === 'preview' ? '' : 'hidden'}></div>
      </div>`}
    </div>`;
  hydrateIcons($('#panel-body'));
  if (skill) return renderSkillPane();
  $('#vault-status').textContent = vaultStatus();
  $('#notes-ta').value = S.st.notes;
  if (S.notesMode === 'preview') { $('#notes-preview').innerHTML = md(S.st.notes || '*（還沒有筆記）*'); postMd($('#notes-preview')); }
}

// ---- skill notes: DeepPaperNote / textbook-to-note run as full Claude Code sessions, saved into Obsidian
const SKILL_INFO = {
  dpn: { name: 'DeepPaperNote', desc: '論文深度精讀：重建研究問題、方法主線、關鍵結果與侷限，附圖表決策與 lint 品管。適合單篇原著論文。', eta: '約 5–20 分鐘' },
  t2n: { name: 'textbook-to-note', desc: '模板筆記：依疾病／藥物／檢查／技術／評估工具模板逐條引用，圖片經 QC 閘門抽取。適合教科書章節、綜論。', eta: '約 2–10 分鐘' },
};
const RUN_STATUS = { running: '產生中', done: '已存到 Obsidian', error: '失敗', cancelled: '已取消' };
const skillCfg = id => (S.cfg?.note_skills || []).find(x => x.id === id);
const elapsed = (from, to) => {
  const s = Math.max(0, Math.round(((to ? new Date(to) : new Date()) - new Date(from)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function renderSkillPane() {
  const box = $('#skill-pane');
  if (!box) return;
  const sel = S.skillSel, f = S.skillForm;
  const opt = id => {
    const c = skillCfg(id), ok = !!c?.ok;
    return `<label class="skill-opt ${sel === id ? 'on' : ''} ${ok ? '' : 'off'}">
      <input type="radio" name="skill-pick" value="${id}" ${sel === id ? 'checked' : ''} ${ok ? '' : 'disabled'}>
      <span><b>${SKILL_INFO[id].name}</b><span class="faint small">　${SKILL_INFO[id].eta}</span><br>
      <span class="skill-desc">${ok ? SKILL_INFO[id].desc : '尚未安裝這個 skill。'}</span></span></label>`;
  };
  const tpls = S.cfg?.t2n_templates || ['auto'];
  const dir = skillCfg(sel)?.dir || '';
  box.innerHTML = `
    <section class="sec skill-form">
      <div class="skill-opts">${opt('dpn')}${opt('t2n')}</div>
      <div class="skill-fields" ${sel === 't2n' ? '' : 'hidden'}>
        <label>模板<select id="t2n-template">${tpls.map(t => `<option value="${esc(t)}" ${f.template === t ? 'selected' : ''}>${t === 'auto' ? '自動判斷' : esc(t)}</option>`).join('')}</select></label>
        <label>主題<input id="t2n-topic" value="${esc(f.topic)}" placeholder="留空＝由 AI 依內容決定" autocomplete="off"></label>
      </div>
      <div class="chat-row">
        <select id="skill-model" title="模型">${modelOptions()}</select>
        <select id="skill-effort" title="effort（思考強度）：越高越慢">${effortOptions()}</select>
        <span class="grow"></span>
        <button class="primary" id="skill-run" data-icon="sparkles" ${skillCfg(sel)?.ok ? '' : 'disabled'}>產生並存到 Obsidian</button>
      </div>
      <div class="faint small skill-dest" title="${esc(dir)}">存到：${esc(dir)}</div>
    </section>
    <div id="skill-runs"></div>`;
  hydrateIcons(box);
  const ids = (S.cfg?.models || []).map(m => m.id);
  const m = store.get('skillModel', null), ef = store.get('skillEffort', null);
  $('#skill-model').value = ids.includes(m) ? m : (S.cfg?.model_note || ids[0] || '');
  $('#skill-effort').value = (S.cfg?.efforts || []).includes(ef) ? ef : (S.cfg?.effort_note || 'medium');
  renderSkillRuns();
}

function renderSkillRuns() {
  const box = $('#skill-runs');
  const runs = S.st.skillnotes || [];
  const dot = $('#nv-dot');
  if (dot) dot.hidden = !runs.some(r => r.status === 'running');
  if (!box) return;
  if (!runs.length) {
    box.innerHTML = '<div class="pane-empty">選一個 skill 按「產生並存到 Obsidian」。<br>產生時會在背景執行完整的 Claude Code 流程，可以繼續閱讀；<br>完成的筆記會出現在這裡，也會連到這篇的 PaperBrain 主筆記。</div>';
    return;
  }
  box.innerHTML = runs.map(r => {
    const live = r.status === 'running';
    const logOpen = live || S.skillLogOpen.has(r.id);
    const lines = (r.log || []).slice(live ? -8 : -80);
    const sub = r.skill === 't2n' ? [r.topic, r.template && r.template !== 'auto' ? `模板：${r.template}` : r.template === 'auto' ? '模板：自動' : ''].filter(Boolean).join('・') : '';
    const model = (S.cfg?.models || []).find(x => x.id === r.model)?.label || r.model;
    return `
    <article class="skill-run s-${r.status}" data-run="${r.id}">
      <header>
        <span class="badge sk-${r.skill}">${SKILL_INFO[r.skill]?.name || r.skill}</span>
        <span class="run-status">${live ? '<span class="spinner"></span>' : ''}${RUN_STATUS[r.status] || r.status}</span>
        <span class="grow"></span>
        <span class="faint small" ${live ? `data-t0="${esc(r.started)}"` : ''}>${live ? elapsed(r.started) : esc(fmtTime(r.started))}</span>
      </header>
      ${sub ? `<div class="run-sub">${esc(sub)}</div>` : ''}
      <div class="run-meta faint small">${esc(model)}・${esc(r.effort)}${r.status !== 'running' && r.finished ? `・用時 ${elapsed(r.started, r.finished)}` : ''}${r.cost ? `・約 US$${(+r.cost).toFixed(2)}` : ''}${r.figures != null && r.figures !== '' ? `・${esc(r.figures)} 張圖` : ''}</div>
      ${r.status === 'done' ? `<div class="run-path" title="${esc(r.note_path)}">${esc(r.rel || r.note_path)}.md${r.draft ? '（同名筆記已存在，存成 draft）' : ''}</div>` : ''}
      ${r.status === 'error' ? `<div class="err-box">${esc(r.error)}</div>` : ''}
      ${r.status === 'done' && r.summary ? `<details class="run-summary" data-sum="${r.id}" ${S.skillSumOpen.has(r.id) ? 'open' : ''}><summary>Claude 的回報</summary><div class="md">${md(r.summary)}</div></details>` : ''}
      ${logOpen && lines.length ? `<pre class="run-log">${lines.map(esc).join('\n')}</pre>` : ''}
      <div class="run-tools">
        ${live ? `<button class="chip" data-run-cancel="${r.id}" data-icon="x">取消</button>` : ''}
        ${r.status === 'done' ? `<a class="chip on" href="${esc(r.obsidian)}" data-icon="vault">在 Obsidian 開啟</a>
          <button class="chip" data-run-preview="${r.id}" data-icon="notes">${S.skillOpen.has(r.id) ? '收起預覽' : '預覽'}</button>
          <button class="chip" data-run-link="${r.id}" data-icon="note-add" title="把這份筆記的 [[連結]] 加到「我的筆記」">連結到我的筆記</button>` : ''}
        ${!live && r.log?.length ? `<button class="chip" data-run-log="${r.id}" data-icon="list">${logOpen ? '收起紀錄' : '執行紀錄'}</button>` : ''}
        ${r.status === 'error' || r.status === 'cancelled' ? `<button class="chip" data-run-retry="${r.id}" data-icon="refresh">重試</button>` : ''}
        ${!live ? `<span class="grow"></span><button class="icon-btn danger" data-run-del="${r.id}" data-icon="trash" title="刪除這筆紀錄（Obsidian 裡的筆記不會刪）"></button>` : ''}
      </div>
      ${S.skillOpen.has(r.id) ? `<div class="md run-preview">${S.skillPreview[r.id] ?? '<div class="status-line"><span class="spinner"></span>讀取中…</div>'}</div>` : ''}
    </article>`;
  }).join('');
  hydrateIcons(box);
  postMd(box);
  $$('.run-log', box).forEach(el => { el.scrollTop = el.scrollHeight; });
}

// keep the running cards' clocks moving between polls
setInterval(() => $$('[data-t0]').forEach(el => { el.textContent = elapsed(el.dataset.t0); }), 1000);

async function startSkillNote(skill = S.skillSel, opts = {}, force = false) {
  const pid = S.pid;
  const model = $('#skill-model')?.value || S.cfg?.model_note;
  const effort = $('#skill-effort')?.value || S.cfg?.effort_note;
  store.set('skillModel', model);
  store.set('skillEffort', effort);
  const body = { skill, model, effort, force, ...opts };
  if (skill === 't2n' && !('template' in opts)) Object.assign(body, S.skillForm);
  let r;
  try {
    r = await api(`papers/${pid}/skillnote`, { method: 'POST', body });
  } catch (e) {
    if (e.data?.conflict && await confirmBox(`${e.message}。確定要重新產生嗎？`)) return startSkillNote(skill, opts, true);
    if (!e.data?.conflict) toast(e.message, 'err');
    return;
  }
  if (S.pid !== pid) return;
  S.st.skillnotes = [r.run, ...(S.st.skillnotes || [])];
  S.st.jobs[skill] = { status: 'running' };
  toast(`${SKILL_INFO[skill].name} 已在背景開始（${SKILL_INFO[skill].eta}）`);
  renderSkillRuns();
  schedulePoll(1500);
}

// Obsidian syntax the in-app preview cannot render: frontmatter, ![[embeds]], [[links]], callout markers
function obsidianToMd(text, rid) {
  const asset = name => `/api/papers/${S.pid}/skillasset?id=${rid}&name=${encodeURIComponent(name)}`;
  return String(text || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, n) => `![](<${asset(n.trim())}>)`)
    .replace(/!\[([^\]]*)\]\((?!https?:|\/)([^)\s]+)\)/g, (_, alt, n) => `![${alt}](<${asset(decodeURIComponent(n))}>)`)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^(>\s*)\[!(\w+)\][+-]?\s*(.*)$/gm, (_, q, type, title) => `${q}**${title || type}**`);
}

async function toggleSkillPreview(rid) {
  if (S.skillOpen.has(rid)) { S.skillOpen.delete(rid); return renderSkillRuns(); }
  S.skillOpen.add(rid);
  renderSkillRuns();
  try {
    const r = await api(`papers/${S.pid}/skillnote?id=${rid}`);
    S.skillPreview[rid] = md(obsidianToMd(r.markdown, rid));
  } catch (e) {
    S.skillPreview[rid] = `<div class="err-box">${esc(e.message)}</div>`;
  }
  renderSkillRuns();
}

// same content as the vault note (built server-side), minus the copied figure images
async function exportMarkdown() {
  try {
    await saveNotes(true);
    const r = await api(`papers/${S.pid}/markdown`);
    download(r.name, r.markdown);
  } catch (e) { toast('匯出失敗：' + e.message, 'err'); }
}

// ---- quiz pane
function renderQuizPane() {
  if (S.tab !== 'quiz') return;
  const q = S.st.quiz, c = S.quizCfg;
  let body = '';
  if (S.pending.quiz) body = '<div class="status-line"><span class="spinner"></span>出題中（約 30–60 秒）…</div>';
  else if (q?.questions?.length) {
    const answered = Object.keys(S.quizAnswers).length;
    const right = q.questions.filter((x, i) => S.quizAnswers[i] === x.answer).length;
    body = `<div class="score">${answered === q.questions.length ? `完成！答對 ${right} / ${q.questions.length} 題` : `已作答 ${answered} / ${q.questions.length}　答對 ${right}`}</div>` +
      q.questions.map((x, qi) => {
        const ans = S.quizAnswers[qi];
        const done = ans !== undefined;
        return `<div class="qz"><p class="qz-q">${qi + 1}. ${esc(x.q)}</p>
          ${(x.options || []).map((o, oi) => `<button class="qz-opt ${done && oi === x.answer ? 'right' : ''} ${done && oi === ans && ans !== x.answer ? 'wrong' : ''}" data-qz="${qi}:${oi}" ${done ? 'disabled' : ''}>${'ABCD'[oi]}. ${esc(o)}</button>`).join('')}
          ${done ? `<div class="qz-exp"><b>${ans === x.answer ? '答對了！' : `正確答案：${'ABCD'[x.answer]}`}</b> <span class="md">${md(x.explanation)}</span>${x.page ? ` <a class="pg-link" data-p="${x.page}">p.${x.page}</a>` : ''}</div>` : ''}
        </div>`;
      }).join('');
  }
  $('#panel-body').innerHTML = `
    <div class="pane">
      <div class="pane-head"><h2>測驗</h2></div>
      <div class="pane-scroll">
        <div class="quiz-setup">
          <h4>題目數量</h4><div class="seg">${[5, 10, 15].map(n => `<button data-qn="${n}" class="${c.n === n ? 'on' : ''}">${n}</button>`).join('')}</div>
          <h4>難度</h4><div class="seg"><button data-qd="easy" class="${c.d === 'easy' ? 'on' : ''}">簡單</button><button data-qd="hard" class="${c.d === 'hard' ? 'on' : ''}">困難</button></div>
          <button class="primary wide" id="quiz-go" ${S.pending.quiz ? 'disabled' : ''}>${q ? '重新產生測驗' : '產生測驗'}</button>
        </div>
        <div id="quiz-body" style="margin-top:14px">${body}</div>
      </div>
    </div>`;
  postMd($('#panel-body'));
}

async function makeQuiz() {
  const pid = S.pid;
  S.pending.quiz = true;
  S.quizAnswers = {};
  renderQuizPane();
  try {
    const quiz = await api(`papers/${pid}/quiz`, { method: 'POST', body: { n: S.quizCfg.n, difficulty: S.quizCfg.d } });
    if (S.pid === pid) S.st.quiz = quiz;
  } catch (e) { toast('出題失敗：' + e.message, 'err'); }
  if (S.pid !== pid) return;
  S.pending.quiz = false;
  renderQuizPane();
}

// ---- references pane
function refItem(r) {
  const title = r.title || '';
  const q = encodeURIComponent(title || `${r.authors} ${r.year}`);
  return `<li data-ref="${esc(r.n)}"><span class="rn">${esc(r.n)}</span><div style="min-width:0">
    <div class="rt">${esc(title || '（無標題）')}</div>
    <div class="ra">${esc([r.authors, [r.journal, r.year].filter(Boolean).join(' ')].filter(Boolean).join(' · '))}</div>
    <div class="rl"><a href="https://pubmed.ncbi.nlm.nih.gov/?term=${q}" target="_blank" rel="noopener">PubMed</a>
    <a href="https://scholar.google.com/scholar?q=${q}" target="_blank" rel="noopener">Google Scholar</a>
    ${r.doi ? `<a href="https://doi.org/${encodeURIComponent(r.doi)}" target="_blank" rel="noopener">DOI</a>` : ''}</div></div></li>`;
}

async function loadCite(pid) {
  if (S.cite[pid]) return;
  S.cite[pid] = { loading: true };
  try {
    const [a, b] = await Promise.all([api('cite', { method: 'POST', body: { ids: [pid], format: 'apa' } }),
      api('cite', { method: 'POST', body: { ids: [pid], format: 'bibtex' } })]);
    S.cite[pid] = { apa: a.text, apaHtml: a.html, bib: b.text.trim(), fallback: !!a.fallback };
  } catch (e) { S.cite[pid] = { error: e.message }; }
  if (S.pid === pid && S.tab === 'refs') renderRefsPane();
}

function renderRefsPane() {
  if (S.tab !== 'refs') return;
  const refs = S.st.refs?.refs || [];
  const j = jobOf('refs');
  const c = S.cite[S.pid];
  if (!c) loadCite(S.pid);
  $('#panel-body').innerHTML = `
    <div class="pane">
      <div class="pane-head"><h2>引用卡片</h2></div>
      <div class="pane-scroll">
        <section class="sec">
          <div class="sec-head"><b>本文引用</b><span class="grow"></span>
            <button class="chip" data-cite-copy="apa" ${c?.apa ? '' : 'disabled'}>複製 APA</button>
            <button class="chip" data-cite-copy="bib" ${c?.bib ? '' : 'disabled'}>複製 BibTeX</button></div>
          ${!c || c.loading ? '<div class="status-line"><span class="spinner"></span>查詢書目資料（Crossref／Europe PMC）…</div>'
            : c.error ? `<div class="err-box">${esc(c.error)}</div>`
            : `<p class="cite-apa">${c.apaHtml.replace(/^<p>|<\/p>$/g, '')}</p><textarea class="bib" readonly>${esc(c.bib)}</textarea>
               <div class="faint small">${c.fallback ? '書目資料庫查不到這篇，以上由 AI 從全文擷取，引用前請核對。' : '書目資料來自 Crossref／Europe PMC。'}</div>`}
        </section>
        <section class="sec">
          <div class="sec-head"><b>參考文獻${refs.length ? `（${refs.length}）` : ''}</b><span class="grow"></span>
            ${j?.status === 'running' ? '<span class="status-line"><span class="spinner"></span>擷取中…</span>'
              : `<button class="chip" data-refs="extract" data-icon="${refs.length ? 'refresh' : 'sparkles'}">${refs.length ? '重新擷取' : '擷取參考文獻'}</button>`}
          </div>
          ${j?.status === 'error' ? `<div class="err-box">${esc(j.error)}</div>` : ''}
          ${refs.length ? `<ul class="ref-list">${refs.map(refItem).join('')}</ul>` : '<div class="faint small">擷取後，選取內文的引用編號（如 [6,7] 或上標 1–3）即可直接看到文獻。</div>'}
        </section>
      </div>
    </div>`;
  hydrateIcons($('#panel-body'));
}

// ------------------------------------------------------------------ outline & search
async function toggleOutline() {
  const pop = $('#outline-pop');
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.hidden = false;
  if (S.outline === undefined || S.outline === null) {
    pop.innerHTML = '<div class="faint small" style="padding:8px">載入中…</div>';
    try { S.outline = (await S.pdf.getOutline()) || []; } catch { S.outline = []; }
  }
  const flat = [];
  const walk = (items, depth) => items.forEach(it => { flat.push({ ...it, depth }); if (it.items?.length && depth < 2) walk(it.items, depth + 1); });
  walk(S.outline, 0);
  pop.innerHTML = flat.length
    ? flat.map((it, k) => `<button class="ol-item" data-ol="${k}" style="padding-left:${10 + it.depth * 14}px">${esc(it.title)}</button>`).join('')
    : '<div class="faint small" style="padding:8px">這份 PDF 沒有內建目錄。</div>';
  S.outlineFlat = flat;
}

async function gotoOutline(k) {
  const it = S.outlineFlat?.[k];
  $('#outline-pop').hidden = true;
  if (!it?.dest) return;
  try {
    const dest = typeof it.dest === 'string' ? await S.pdf.getDestination(it.dest) : it.dest;
    const idx = await S.pdf.getPageIndex(dest[0]);
    gotoPage(idx);
  } catch { toast('無法跳到這個章節', 'err'); }
}

function runSearch(q) {
  q = q.trim().toLowerCase();
  S.search = { q, hits: [], i: -1 };
  if (q.length >= 2) {
    S.layout.pages.forEach((p, pi) => p.blocks.forEach(b => { if (b.text.toLowerCase().includes(q)) S.search.hits.push({ page: pi, bbox: b.bbox }); }));
  }
  $('#search-count').textContent = q.length >= 2 ? `0/${S.search.hits.length}` : '';
}

function searchStep(dir) {
  const s = S.search;
  if (!s.hits.length) return;
  if (s.i === -1 && dir > 0) {
    const k = s.hits.findIndex(h => h.page >= S.cur);
    s.i = k === -1 ? 0 : k;
  } else s.i = (s.i + dir + s.hits.length) % s.hits.length;
  const h = s.hits[s.i];
  $('#search-count').textContent = `${s.i + 1}/${s.hits.length}`;
  jumpTo(h.page, h.bbox);
}

// ------------------------------------------------------------------ library location (cloud sync)
const LOC_ICON = { local: 'laptop', onedrive: 'cloud', gdrive: 'cloud', folder: 'folder' };

async function openCloud() {
  const dlg = $('#dlg-cloud');
  Object.assign(S.cloud, { sel: null, info: null });
  if (!dlg.open) {
    dlg.showModal();
    dlg.addEventListener('close', () => clearTimeout(S.cloud.t), { once: true });
  }
  await refreshCloud();
}

async function refreshCloud() {
  clearTimeout(S.cloud.t);
  const prev = S.cloud.st?.job;
  let st;
  try { st = await api('library/location'); } catch (e) { S.cloud.t = setTimeout(refreshCloud, 3000); return toast(e.message, 'err'); }
  S.cloud.st = st;
  if (prev?.status === 'running' && st.job?.status !== 'running') {
    if (st.job?.status === 'done') {
      toast(`書庫已改用：${st.path}`);
      S.cloud.info = null;
      S.cloud.sel = null;
      if (location.hash.startsWith('#/paper/')) location.hash = '#/'; else if (!$('#library').hidden) showLibrary();
    } else if (st.job?.status === 'error') toast(`搬移失敗：${st.job.error}`, 'err');
  }
  if ($('#dlg-cloud').open) renderCloud();
  if (st.job?.status === 'running') S.cloud.t = setTimeout(refreshCloud, 1000);
}

function locWarnings(st) {
  return [
    st.missing ? `找不到設定的書庫資料夾 <code>${esc(st.missing)}</code>（雲端硬碟沒開或還沒同步？），目前暫用本機書庫；資料夾出現後會自動切回。` : '',
    st.others?.length ? `另一台電腦（${esc(st.others.join('、'))}）最近 3 分鐘內開著這個書庫。兩台同時使用可能互相覆蓋，請一次只在一台電腦開。` : '',
  ].filter(Boolean);
}

function renderCloud() {
  const st = S.cloud.st, C = S.cloud;
  const run = st.job?.status === 'running';
  const card = c => `
    <button type="button" class="loc-card ${C.sel === c.target ? 'on' : ''}" data-loc="${esc(c.target)}" ${run ? 'disabled' : ''}>
      ${icon(LOC_ICON[c.kind])}
      <span class="loc-txt"><b>${esc(c.name)}</b><span class="loc-path">${esc(c.target)}</span></span>
      <span class="tag ${c.current ? 'ok' : ''}">${c.current ? '使用中' : c.has_library ? `已有書庫 ${c.papers} 篇` : '尚無書庫'}</span>
    </button>`;
  const custom = C.sel && !st.candidates.some(c => c.target === C.sel);
  $('#cloud-body').innerHTML = `
    <div class="loc-now">
      <div class="loc-txt"><span class="faint small">目前書庫・${esc(st.label)}・${st.papers} 篇</span><code>${esc(st.path)}</code></div>
      <button type="button" class="ghost" id="loc-reveal" data-icon="folder">開啟資料夾</button>
    </div>
    ${locWarnings(st).map(w => `<div class="warn-box">${w}</div>`).join('')}
    ${run ? `<div class="status-line"><span class="spinner"></span>搬移中${st.job.progress ? `（${st.job.progress[0]}/${st.job.progress[1]} 篇）` : ''}…這段時間請不要編輯論文。</div>` : ''}
    ${st.job?.status === 'error' ? `<div class="err-box">上次搬移失敗：${esc(st.job.error)}（目前書庫沒有變動）</div>` : ''}
    <h3 class="loc-h">選擇位置</h3>
    <div class="loc-cards">
      ${st.candidates.map(card).join('')}
      ${st.candidates.some(c => c.kind === 'gdrive') ? '' : `
      <div class="loc-card off">${icon('cloud')}<span class="loc-txt"><b>Google Drive</b>
        <span class="loc-path">這台電腦沒有安裝 Google Drive 電腦版。<a href="https://www.google.com/drive/download/" target="_blank" rel="noopener">下載安裝</a>並登入後，重新開啟這個視窗就會出現在這裡。</span></span></div>`}
      <div class="loc-card custom ${custom ? 'on' : ''}">${icon('folder')}
        <span class="loc-txt"><b>其他資料夾</b><span class="faint small">Dropbox、iCloud 或其他會同步的資料夾都可以；選上層資料夾會自動建一個 paper-reader 子資料夾。</span>
          <span class="loc-custom">
            <input id="loc-input" placeholder="例如 G:\\我的雲端硬碟" value="${esc(C.custom)}" spellcheck="false" ${run ? 'disabled' : ''}>
            <button type="button" class="chip" id="loc-pick" ${run ? 'disabled' : ''}>選擇…</button>
            <button type="button" class="chip" id="loc-check" ${run ? 'disabled' : ''}>確認</button>
          </span></span>
      </div>
    </div>
    <div id="loc-plan">${locPlan()}</div>
    <ul class="loc-notes faint small">
      <li>搬移是「複製」：原本的書庫會原封不動保留，確認新位置沒問題後可以自己刪掉。</li>
      <li>放進 OneDrive 時，論文伴讀會把書庫設成「一律保留在此裝置」，離線也能開。Google Drive 建議用「鏡像檔案」模式，或把這個資料夾設成可離線使用。</li>
      <li>不要兩台電腦同時開同一個書庫：換電腦前先關掉另一台的論文伴讀，並等雲端同步完成。</li>
      <li>模型、effort、PaperBrain 路徑等設定不會同步，每台電腦各自設定。</li>
    </ul>`;
  hydrateIcons($('#cloud-body'));
}

function locPlan() {
  const i = S.cloud.info;
  if (!i) return '';
  if (i.loading) return '<div class="status-line"><span class="spinner"></span>檢查中…</div>';
  if (i.error) return `<div class="err-box">${esc(i.error)}</div>`;
  const head = `<p>書庫會放在：<code>${esc(i.target)}</code></p>`;
  if (i.current) return `<div class="loc-plan">${head}<p class="faint">這就是目前使用中的書庫。</p></div>`;
  if (i.nested) return `<div class="loc-plan">${head}<div class="err-box">新位置不能在目前書庫裡面，也不能包住目前書庫。</div></div>`;
  if (!i.writable) return `<div class="loc-plan">${head}<div class="err-box">這個位置無法寫入，請換一個資料夾。</div></div>`;
  const off = S.cloud.st.job?.status === 'running' ? 'disabled' : '';
  if (!i.has_library || i.incomplete) {
    const short = i.free_mb != null && i.free_mb < i.need_mb * 1.1;
    return `<div class="loc-plan">${head}
      <p>目前書庫的 ${i.current_papers} 篇論文（約 ${i.need_mb} MB）會複製過去，完成並逐檔核對後改用新位置。${i.incomplete ? '上次複製沒有完成，這次會重新複製。' : ''}</p>
      ${short ? `<div class="err-box">空間不足：需要約 ${i.need_mb} MB，只剩 ${i.free_mb} MB。</div>` : ''}
      <div class="loc-actions"><button type="button" class="primary" data-move="copy" ${off || (short ? 'disabled' : '')}>複製過去並改用</button></div></div>`;
  }
  return `<div class="loc-plan">${head}
    <p>那裡已經有書庫（${i.papers} 篇）。</p>
    <div class="loc-actions">
      <button type="button" class="primary" data-move="merge" ${off}>合併後改用</button>
      <button type="button" class="ghost" data-move="use" ${off}>直接改用那裡的書庫</button>
    </div>
    <p class="faint small">合併：把目前書庫的論文複製過去，兩邊都有的論文保留較晚修改的那份。直接改用：不複製任何東西，目前書庫留在原處。</p></div>`;
}

async function inspectLoc(path) {
  S.cloud.info = { loading: true };
  $('#loc-plan').innerHTML = locPlan();
  try {
    S.cloud.info = await api('library/location/inspect', { method: 'POST', body: { path } });
    S.cloud.sel = S.cloud.info.target;
  } catch (e) { S.cloud.info = { error: e.message }; }
  renderCloud();
}

async function onCloudClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.loc) return inspectLoc(t.dataset.loc);
  if (t.id === 'loc-check') return inspectLoc($('#loc-input').value);
  if (t.id === 'loc-reveal') return api('library/location/reveal', { method: 'POST', body: {} }).catch(err => toast(err.message, 'err'));
  if (t.id === 'loc-pick') {
    t.disabled = true;
    t.textContent = '請在跳出的視窗選擇…';
    try {
      const r = await api('library/location/pick', { method: 'POST', body: {} });
      if (r.path) { S.cloud.custom = r.path; return inspectLoc(r.path); }
    } catch (err) { toast(err.message, 'err'); }
    return renderCloud();
  }
  if (t.dataset.move) {
    try {
      const r = await api('library/location/move', { method: 'POST', body: { path: S.cloud.info.target, mode: t.dataset.move } });
      if (!r.started) toast('已經在搬移中');
      S.cloud.st.job = { status: 'running', progress: null };
      renderCloud();
      S.cloud.t = setTimeout(refreshCloud, 600);
    } catch (err) { toast(err.message, 'err'); }
  }
}

// ------------------------------------------------------------------ settings
const TASK_LABEL = {
  analysis: '摘要、關鍵字、自動高亮', translate: '版面翻譯／並排檢視', quick: '選取翻譯、參考文獻擷取',
  explain: '段落／選取／圖片解釋', chat: '對話（預設）', quiz: '測驗出題',
  note: 'Skill 筆記（預設）', classify: '書庫 AI 分類',
};

async function openSettings() {
  let s;
  try { s = S.cfg = await api('settings'); } catch (e) { return toast(e.message, 'err'); }
  const dlg = $('#dlg-settings');
  $('#set-tasks').innerHTML =
    `<div class="set-row set-all"><span>一次套用到全部</span><select data-all="model"><option value="">模型…</option>${modelOptions()}</select><select data-all="effort"><option value="">effort…</option>${effortOptions()}</select></div>` +
    s.tasks.map(t => `<div class="set-row"><span>${TASK_LABEL[t] || t}</span><select name="model_${t}">${modelOptions()}</select><select name="effort_${t}">${effortOptions()}</select></div>`).join('');
  s.tasks.forEach(t => {
    dlg.querySelector(`[name="model_${t}"]`).value = s[`model_${t}`];
    dlg.querySelector(`[name="effort_${t}"]`).value = s[`effort_${t}`];
  });
  $$('[data-all]', dlg).forEach(sel => {
    sel.onchange = () => { if (sel.value) $$(`#set-tasks select[name^="${sel.dataset.all}_"]`, dlg).forEach(x => { x.value = sel.value; }); };
  });
  dlg.querySelector('[name="concurrency"]').value = s.concurrency;
  dlg.querySelector('[name="auto_translate"]').checked = !!s.auto_translate;
  dlg.querySelector('[name="auto_classify"]').checked = !!s.auto_classify;
  dlg.querySelector('[name="vault_dir"]').value = s.vault_dir;
  $('#set-loc').textContent = s.data_dir;
  $('#set-info').textContent = `claude CLI：${s.claude || '找不到'}　資料夾：${s.data_dir}`;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    const body = {};
    $$('#set-tasks select[name]', dlg).forEach(sel => { body[sel.name] = sel.value; });
    body.concurrency = Math.max(1, Math.min(8, +dlg.querySelector('[name="concurrency"]').value || 4));
    body.auto_translate = dlg.querySelector('[name="auto_translate"]').checked;
    body.auto_classify = dlg.querySelector('[name="auto_classify"]').checked;
    const vd = dlg.querySelector('[name="vault_dir"]').value.trim();
    if (vd) body.vault_dir = vd;
    try {
      await api('settings', { method: 'PUT', body });
      await loadConfig();
      toast('設定已儲存');
    } catch (e) { toast(e.message, 'err'); }
  }, { once: true });
}

// ------------------------------------------------------------------ events
function bindEvents() {
  window.addEventListener('hashchange', route);
  $('#btn-theme').onclick = toggleTheme;
  $('#btn-settings').onclick = openSettings;
  $('#btn-cloud').onclick = openCloud;
  $('#btn-star').onclick = () => setPaperFlag('star', !S.st?.meta?.starred);
  $('#status-select').onchange = e => setPaperFlag('status', e.target.value);
  $('#cloud-body').addEventListener('click', onCloudClick);
  $('#cloud-body').addEventListener('input', e => { if (e.target.id === 'loc-input') S.cloud.custom = e.target.value; });
  $('#cloud-body').addEventListener('keydown', e => {
    if (e.target.id === 'loc-input' && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); inspectLoc(e.target.value); }
  });
  const pick = () => $('#file-input').click();
  $('#btn-upload').onclick = pick;
  $('#btn-upload-2').onclick = pick;
  $('#dropzone').onclick = pick;
  $('#file-input').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };

  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#drop-overlay').hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true; if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files); });

  const list = $('#lib-list');
  list.addEventListener('click', async e => {
    const cb = e.target.closest('input[data-sel]');
    if (cb) return toggleSel(cb.dataset.sel, cb.checked, e.shiftKey);
    if (e.target.closest('.sel-box, .cat-pick, .st-pick')) return;
    const star = e.target.closest('[data-star]');
    if (star) {
      const p = S.papers.find(x => x.id === star.dataset.star);
      return runBatch(p?.starred ? 'unstar' : 'star', null, [star.dataset.star]);
    }
    const del = e.target.closest('[data-del]');
    if (del) return trashPapers([del.dataset.del]);
    const rs = e.target.closest('[data-restore]');
    if (rs) return restorePapers([rs.dataset.restore]);
    const pg = e.target.closest('[data-purge]');
    if (pg) return purgePapers([pg.dataset.purge]);
    const card = e.target.closest('.lib-card');
    if (!card) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || card.classList.contains('trashed')) {
      return toggleSel(card.dataset.id, !S.lib.sel.has(card.dataset.id), e.shiftKey);
    }
    location.hash = '#/paper/' + card.dataset.id;
  });
  list.addEventListener('change', e => {
    const { catOf, statusOf } = e.target.dataset;
    if (catOf) return e.target.value === '__new' ? createCategory(catOf) : setCategory(catOf, e.target.value);
    if (statusOf) runBatch('status', e.target.value, [statusOf]);
  });
  // drag cards (all selected ones when the dragged card is selected) onto a category or the trash
  list.addEventListener('dragstart', e => {
    const card = e.target.closest?.('.lib-card');
    if (!card) return;
    const ids = S.lib.sel.has(card.dataset.id) ? [...S.lib.sel] : [card.dataset.id];
    e.dataTransfer.setData('application/x-paper-id', ids.join(','));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  list.addEventListener('dragend', e => e.target.closest?.('.lib-card')?.classList.remove('dragging'));
  const side = $('#lib-side');
  const dropOf = e => (e.dataTransfer?.types?.includes('application/x-paper-id') ? e.target.closest('[data-drop]') : null);
  side.addEventListener('dragover', e => {
    const t = dropOf(e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.drop-on', side).forEach(x => x !== t && x.classList.remove('drop-on'));
    t.classList.add('drop-on');
  });
  side.addEventListener('dragleave', e => { if (!side.contains(e.relatedTarget)) $$('.drop-on', side).forEach(x => x.classList.remove('drop-on')); });
  side.addEventListener('drop', e => {
    const t = dropOf(e);
    $$('.drop-on', side).forEach(x => x.classList.remove('drop-on'));
    if (!t) return;
    e.preventDefault();
    const key = t.dataset.drop;
    const ids = e.dataTransfer.getData('application/x-paper-id').split(',').filter(id => S.papers.some(p => p.id === id));
    if (!ids.length) return;
    if (key === TRASH) return trashPapers(ids);
    const move = ids.filter(id => (S.papers.find(p => p.id === id).category || NONE) !== key);
    if (move.length) setCategory(move, key === NONE ? '' : key);
  });
  side.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b?.id === 'cat-add') return createCategory();
    if (b?.id === 'lib-ai') return classifyLibrary('unsorted');
    if (b?.id === 'lib-ai-all') return classifyLibrary('all');
    if (b?.dataset.catEdit) return editCategory(b.dataset.catEdit);
    if (b?.dataset.catDel) return deleteCategory(b.dataset.catDel);
    const it = e.target.closest('[data-catsel]');
    if (it) setLibCat(it.dataset.catsel);
  });
  side.addEventListener('keydown', e => {
    const it = e.target.closest('[data-catsel]');
    if (it && e.target === it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setLibCat(it.dataset.catsel); }
  });
  $('#lib-filters').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'trash-empty') return purgePapers(S.lib.trash.map(p => p.id));
    if (b.dataset.statusFilter !== undefined) {
      S.lib.status = b.dataset.statusFilter;
      store.set('libStatus', S.lib.status);
      renderLibrary();
    }
  });
  const bar = $('#batch-bar');
  bar.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const ids = [...S.lib.sel];
    if (b.dataset.bsel === 'all') return setSel(S.lib.shownIds);
    if (b.dataset.bsel === 'none') return setSel([]);
    if (b.dataset.menu === 'export') { $('#export-menu').hidden = !$('#export-menu').hidden; return; }
    if (b.dataset.export) { $('#export-menu').hidden = true; return exportCite(b.dataset.export, ids); }
    const op = b.dataset.bop;
    if (op === 'star' || op === 'unstar') return runBatch(op, null, ids);
    if (op === 'trash') return trashPapers(ids);
    if (op === 'restore') return restorePapers(ids);
    if (op === 'purge') return purgePapers(ids);
    if (op === 'classify') return reclassify(ids);
  });
  bar.addEventListener('change', async e => {
    const op = e.target.dataset.bop, v = e.target.value, ids = [...S.lib.sel];
    if (op === 'status') return runBatch('status', v, ids);
    if (op !== 'category') return;
    if (v !== '__new') return setCategory(ids, v === '__unsorted' ? '' : v);
    const r = await catDialog(`新增分類並放入選取的 ${ids.length} 篇`);
    if (!r?.name) return renderBatchBar();
    try { if (!S.lib.cats.some(c => c.name === r.name)) await api('categories', { method: 'POST', body: r }); } catch (err) { return toast(err.message, 'err'); }
    setCategory(ids, r.name);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.menu-wrap')) $$('.menu').forEach(m => { m.hidden = true; });
  });
  $('#lib-q').addEventListener('input', e => { S.lib.q = e.target.value; renderLibrary(); });
  $('#lib-scope').onchange = e => { S.lib.scope = e.target.value; store.set('libScope', S.lib.scope); renderLibrary(); };
  $('#lib-sort').onchange = e => { S.lib.sort = e.target.value; store.set('libSort', S.lib.sort); renderLibrary(); };
  document.addEventListener('keydown', e => {
    if ($('#library').hidden || document.querySelector('dialog[open]')) return;
    const typing = e.target.closest('input, textarea, select');
    if (e.key === 'Escape' && S.lib.sel.size) { setSel([]); return; }
    if (typing || e.altKey) return;
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('#lib-q').focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && S.lib.shownIds?.length) { e.preventDefault(); setSel(S.lib.shownIds); }
  });
  $('#btn-import').onclick = openImport;
  $('#import-go').onclick = runImport;
  $('#import-refs').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runImport(); } });
  $('#import-log').addEventListener('click', e => { if (e.target.closest('[data-close-import]')) $('#dlg-import').close(); });


  // toolbar
  $('#viewer').addEventListener('scroll', () => { onScroll(); if (!$('#sel-pop').hidden) hideSelPop(); }, { passive: true });
  $('#zoom-select').onchange = e => { if (e.target.value !== 'custom') setZoom(e.target.value); };
  $('#zoom-in').onclick = () => setZoom(String(+(Math.min(4, S.scale * 1.15)).toFixed(3)));
  $('#zoom-out').onclick = () => setZoom(String(+(Math.max(0.3, S.scale / 1.15)).toFixed(3)));
  $('#rotate-left').onclick = () => rotatePage(-90);
  $('#rotate-right').onclick = () => rotatePage(90);
  $('#rotation-value').onclick = () => rotatePage(0);
  $('#page-input').onchange = e => gotoPage((+e.target.value || 1) - 1);
  $('#btn-outline').onclick = toggleOutline;
  $('#outline-pop').onclick = e => { const b = e.target.closest('[data-ol]'); if (b) gotoOutline(+b.dataset.ol); };
  $('#btn-auto').onclick = () => {
    if (!S.st?.meta.has_text) return;
    if (!S.st.autohl) { if (!running('autohl')) { startJob('autohighlight', 'autohl'); toast('AI 正在挑選重點句（約 1 分鐘）…'); } S.showAuto = true; }
    else { S.showAuto = !S.showAuto; renderAllHL(); if (S.tab === 'hl') renderHLPane(); }
    updateToolbar();
  };
  $('#btn-fig').onclick = () => setFigMode(!S.figMode);
  $('#btn-trans').onclick = () => { if (S.st?.meta.has_text) setShowTrans(!S.showTrans); };
  $('#btn-sbs').onclick = () => { if (S.st?.meta.has_text) setSbs(!S.sbs); };
  $('#search-input').addEventListener('input', e => runSearch(e.target.value));
  $('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); } });

  // pages
  $('#pages').addEventListener('mousedown', onPagesMouseDown);
  $('#pages').addEventListener('mousemove', onPagesMove);
  $('#viewer').addEventListener('mouseleave', () => { hideBlkBtn(); setLink(0, null); });
  blkBtn.addEventListener('mousedown', e => e.preventDefault());
  blkBtn.addEventListener('click', e => {
    e.stopPropagation();
    const h = S.hover;
    hideBlkBtn();
    if (h) explainBlock(h.i, h.b);
  });
  $('#pages').addEventListener('click', e => {
    const chip = e.target.closest('.ex-chip');
    if (chip) return showExplanation(chip.dataset.ex);
    const tr = e.target.closest('.pg .tr');
    if (tr && !window.getSelection()?.toString()) tr.classList.toggle('peek');
  });
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('mousedown', e => {
    if (!$('#sel-pop').hidden && !$('#sel-pop').contains(e.target)) hideSelPop();
    if (!$('#outline-pop').hidden && !e.target.closest('.tb-pop-wrap')) $('#outline-pop').hidden = true;
  });
  $('#sel-pop').addEventListener('mousedown', e => { if (!e.target.closest('a')) e.preventDefault(); });
  $('#sel-pop').addEventListener('click', onPopAction);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideSelPop(); setFigMode(false); $('#outline-pop').hidden = true; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.pid) { e.preventDefault(); $('#search-input').focus(); $('#search-input').select(); }
  });

  // resizer
  $('#resizer').addEventListener('mousedown', e => {
    e.preventDefault();
    const rs = $('#resizer');
    rs.classList.add('drag');
    const right = $('#workspace').getBoundingClientRect().right - $('#panel-rail').offsetWidth;
    const move = ev => {
      const w = Math.max(300, Math.min(window.innerWidth * 0.65, right - ev.clientX));
      $('#panel').style.setProperty('--panel-w', `${w}px`);
      store.set('panelW', Math.round(w));
    };
    const up = () => {
      rs.classList.remove('drag');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (S.zoom === 'auto') setZoom('auto');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.pid && S.zoom === 'auto') setZoom('auto'); }, 200); });

  // panel rail
  $('#panel-rail').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'btn-panel') {
      S.panelOpen = !S.panelOpen;
      store.set('panelOpen', S.panelOpen);
      applyPanel();
      if (S.panelOpen) renderPane(true);
      if (S.zoom === 'auto') setZoom('auto');
      return;
    }
    if (b.dataset.tab) openTab(b.dataset.tab);
  });

  // panel body (delegated)
  const pb = $('#panel-body');
  pb.addEventListener('click', async e => {
    const t = e.target.closest('button, .bi, .hl-item, [data-sec-toggle]');
    if (!t) return;
    const d = t.dataset;
    if (d.ai === 'analyze') return startJob('analyze', 'analyze');
    if (d.secToggle) {
      const sec = t.closest('.sec');
      sec.classList.toggle('collapsed');
      store.set('sec:' + d.secToggle, sec.classList.contains('collapsed'));
      return;
    }
    if (d.copySec) {
      const a = S.st.analysis;
      const txt = d.copySec === 'kw' ? a.keywords.map(k => `${k.term}（${k.zh}）：${k.definition}`).join('\n')
        : d.copySec === 'tldr' ? a.tldr.join('\n') : a.summary;
      return copyText(txt);
    }
    if (d.more) {
      const el = $('#' + d.more);
      const clamped = el.classList.toggle('clamped');
      t.textContent = clamped ? '查看全部' : '收合';
      return;
    }
    if (d.kw !== undefined) {
      const k = S.st.analysis.keywords[+d.kw];
      const box = $('#kw-detail');
      const same = t.classList.contains('on');
      $$('.kw', pb).forEach(x => x.classList.remove('on'));
      if (same) { box.hidden = true; return; }
      t.classList.add('on');
      box.hidden = false;
      box.innerHTML = `<b>${esc(k.term)}</b>　${esc(k.zh)}<div>${esc(k.definition)}</div>`;
      return;
    }
    if (d.q) return sendChat(d.q);
    if (t.id === 'chat-send') return sendChat($('#chat-input').value);
    if (t.id === 'chat-clear') {
      if (!S.st.chat.length || !(await confirmBox('清除這篇論文的所有對話紀錄？'))) return;
      await api(`papers/${S.pid}/chat`, { method: 'DELETE' }).catch(err => toast(err.message, 'err'));
      S.st.chat = [];
      return renderChat();
    }
    if (d.chatCopy) return copyText(S.st.chat[+d.chatCopy].content);
    if (d.chatNote) return appendNote(`**AI 回答**\n\n${S.st.chat[+d.chatNote].content}`);
    if (d.tr === 'all') return startJob('translate-all', 'translate', { start: S.cur });
    if (d.tr === 'page') return startJob('translate-page', `tp${S.cur}`, { page: S.cur });
    if (t.classList.contains('bi')) {
      if (window.getSelection()?.toString()) return;
      const b = S.layout.pages[S.cur].blocks.find(x => x.id === d.b);
      return jumpTo(S.cur, b?.bbox);
    }
    if (d.exf) { S.exFilter = d.exf; return renderExplainPane(); }
    if (d.exDel) {
      await api(`papers/${S.pid}/explanations?id=${d.exDel}`, { method: 'DELETE' }).catch(err => toast(err.message, 'err'));
      const gone = S.st.explanations.find(x => x.id === d.exDel);
      S.st.explanations = S.st.explanations.filter(x => x.id !== d.exDel);
      if (gone) renderEx(gone.page);
      return renderExplainPane();
    }
    if (d.exNote) {
      const x = S.st.explanations.find(y => y.id === d.exNote);
      const head = x.type === 'image' ? `**圖片說明（p.${x.page + 1}）**` : quoteMd(x.source, x.page);
      return appendNote(`${head}\n\n${x.answer}`);
    }
    if (d.hl === 'gen') return startJob('autohighlight', 'autohl');
    if (d.hlf) { S.hlFilter[d.hlf] = !S.hlFilter[d.hlf]; renderAllHL(); return renderHLPane(); }
    if (d.hlDel) {
      e.stopPropagation();
      S.st.highlights = S.st.highlights.filter(h => h.id !== d.hlDel);
      saveHighlights();
      renderAllHL();
      return renderHLPane();
    }
    if (d.hlGo) {
      const [kind, id] = d.hlGo.split(':');
      const h = kind === 'auto' ? S.st.autohl.items.find(x => x.id === id) : S.st.highlights.find(x => x.id === id);
      if (h) jumpTo(h.page, h.rects[0]);
      return;
    }
    if (d.nm) { S.notesMode = d.nm; return renderNotesPane(); }
    if (d.nv) { S.notesView = d.nv; store.set('notesView', d.nv); return renderNotesPane(); }
    if (t.id === 'skill-run') return startSkillNote();
    if (d.runCancel) {
      if (!(await confirmBox('取消這次產生？已經寫進 Obsidian 的部分不會自動清掉。'))) return;
      return api(`papers/${S.pid}/skillnote-cancel`, { method: 'POST', body: { id: d.runCancel } }).catch(err => toast(err.message, 'err'));
    }
    if (d.runPreview) return toggleSkillPreview(d.runPreview);
    if (d.runLog) { S.skillLogOpen.has(d.runLog) ? S.skillLogOpen.delete(d.runLog) : S.skillLogOpen.add(d.runLog); return renderSkillRuns(); }
    if (d.runLink) {
      const r = S.st.skillnotes.find(x => x.id === d.runLink);
      return appendNote(`[[${r.rel}|${SKILL_INFO[r.skill].name}${r.topic ? '：' + r.topic : ''}]]`);
    }
    if (d.runRetry) {
      const r = S.st.skillnotes.find(x => x.id === d.runRetry);
      return startSkillNote(r.skill, r.skill === 't2n' ? { template: r.template, topic: r.topic || '' } : {});
    }
    if (d.runDel) {
      await api(`papers/${S.pid}/skillnote?id=${d.runDel}`, { method: 'DELETE' }).catch(err => toast(err.message, 'err'));
      S.st.skillnotes = S.st.skillnotes.filter(x => x.id !== d.runDel);
      return renderSkillRuns();
    }
    if (t.id === 'notes-export') return exportMarkdown();
    if (t.id === 'notes-vault') return saveToVault();
    if (d.qn) { S.quizCfg.n = +d.qn; return renderQuizPane(); }
    if (d.qd) { S.quizCfg.d = d.qd; return renderQuizPane(); }
    if (t.id === 'quiz-go') return makeQuiz();
    if (d.qz) { const [qi, oi] = d.qz.split(':').map(Number); S.quizAnswers[qi] = oi; return renderQuizPane(); }
    if (d.refs === 'extract') return startJob('references', 'refs');
    if (d.citeCopy === 'apa') return copyRich(`<p>${S.cite[S.pid].apaHtml.replace(/^<p>|<\/p>$/g, '')}</p>`, S.cite[S.pid].apa);
    if (d.citeCopy === 'bib') return copyText(S.cite[S.pid].bib);
  });
  pb.addEventListener('change', e => {
    if (e.target.id === 'only-zh') { S.onlyZh = e.target.checked; store.set('onlyZh', S.onlyZh); $('#trans-list').classList.toggle('only-zh', S.onlyZh); }
    if (e.target.id === 'show-auto') { S.showAuto = e.target.checked; renderAllHL(); updateToolbar(); }
    if (e.target.name === 'skill-pick') { S.skillSel = e.target.value; store.set('skillSel', S.skillSel); return renderSkillPane(); }
    if (e.target.id === 't2n-template') S.skillForm.template = e.target.value;
    if (e.target.id === 'ex-chips') {
      S.showExChips = e.target.checked;
      store.set('exChips', S.showExChips);
      S.pageEls.forEach((_, i) => renderEx(i));
    }
  });
  pb.addEventListener('input', e => {
    if (e.target.id === 'notes-ta') { S.st.notes = e.target.value; const s = $('#notes-status'); if (s) s.textContent = '編輯中…'; saveNotes(); }
    if (e.target.id === 't2n-topic') S.skillForm.topic = e.target.value;
    if (e.target.id === 'chat-input') { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`; }
  });
  // <details> toggle does not bubble; catch it on the way down so a re-render keeps it open
  pb.addEventListener('toggle', e => {
    const id = e.target.dataset?.sum;
    if (id) e.target.open ? S.skillSumOpen.add(id) : S.skillSumOpen.delete(id);
  }, true);
  pb.addEventListener('keydown', e => {
    if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(e.target.value); }
  });

  // page links anywhere
  document.addEventListener('click', e => {
    const a = e.target.closest('.pg-link');
    if (a && S.pid) { e.preventDefault(); gotoPage(+a.dataset.p - 1); }
  });
}

// ------------------------------------------------------------------ init
applyTheme(store.get('theme', null));
hydrateIcons();
bindEvents();
loadConfig().then(route); // model/effort lists feed the chat pickers
