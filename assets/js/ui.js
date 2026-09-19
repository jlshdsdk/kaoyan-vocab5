/* ui.js — 共享 UI 工具：toast、主题、图标、词条渲染卡片 */
import { BOOK_NAMES } from './data.js?v=18';

export function toast(msg, ms = 2600) {
  let t = document.getElementById('v5toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'v5toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---- 主题 ---- */
export function initTheme() {
  const apply = () => {
    const pref = localStorage.getItem('v5theme') || 'auto';
    const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  apply();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
}
export function setTheme(pref) { localStorage.setItem('v5theme', pref); initTheme(); }
export function getTheme() { return localStorage.getItem('v5theme') || 'auto'; }

/* ---- 图标（内联 SVG） ---- */
const ICONS = {
  uk: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg>',
  us: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  nav: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2 4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>',
};
export function icon(name) { return ICONS[name] || ''; }

/* ---- 词条渲染 ---- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export { esc };

export function bookBadges(entry) {
  return (entry.books || []).map(b =>
    `<span class="badge" title="${esc(b.tier || '')}">${esc(BOOK_NAMES[b.id] || b.id)}</span>`).join('');
}

/** 正面：词头 + 音标 + 发音按钮 */
export function cardFront(entry, { rank } = {}) {
  const ph = entry.ph || {};
  return `
  <div class="card-front">
    <div class="head-row">
      <h2 class="headword">${esc(entry.w)}</h2>
      ${rank ? `<span class="rank rank${rank}" title="被 ${rank} 本书收录">${'★'.repeat(Math.min(rank, 5))}</span>` : ''}
    </div>
    <div class="phon-row">
      ${ph.uk ? `<span class="phon"><button class="btn-audio" data-acc="uk" data-w="${esc(entry.w)}" aria-label="英音发音">${icon('uk')}</button><span class="ph-text">/${esc(String(ph.uk).replace(/^\/|\/$/g, ''))}/</span></span>` : ''}
      ${ph.us ? `<span class="phon"><button class="btn-audio" data-acc="us" data-w="${esc(entry.w)}" aria-label="美音发音">${icon('us')}</button><span class="ph-text">/${esc(String(ph.us).replace(/^\/|\/$/g, ''))}/</span></span>` : ''}
    </div>
  </div>`;
}

/** 背面：释义、词组、用法、例句全量 */
export function cardBack(entry) {
  const senses = (entry.senses || []).map(s => {
    if (typeof s === 'string') {
      const m = s.match(/^([a-z.&;vtnadju ]{1,8}?)\s+(.+)$/i);
      return `<li>${m ? `<i>${esc(m[1].trim())}</i> ${esc(m[2])}` : esc(s)}</li>`;
    }
    return `<li><i>${esc(s.pos)}</i> ${esc(s.gloss)}${s.tag ? ` <em class="tag">${esc(s.tag)}</em>` : ''}</li>`;
  }).join('');
  const phrases = (entry.phrases || []).map(p =>
    `<li><b>${esc(p.p)}</b> ${esc(p.m)}</li>`).join('');
  const ex = (entry.ex || []).map(e => {
    const label = e.ty === 'real' ? `<em class="ex-real">真题${e.src ? '·' + esc(e.src) : ''}</em>` :
      e.ty === 'mock' ? '<em class="ex-mock">仿写</em>' : '<em class="ex-dict">词典例句</em>';
    return `<li class="ex-item"><p class="ex-en">${esc(e.en)}</p><p class="ex-zh">${esc(e.zh)}</p>${label}</li>`;
  }).join('');
  return `
  <div class="card-back">
    ${senses ? `<ol class="senses">${senses}</ol>` : ''}
    ${phrases ? `<div class="sec"><h3>词组搭配</h3><ul class="phrases">${phrases}</ul></div>` : ''}
    ${entry.usage ? `<div class="sec"><h3>用法·辨析</h3><p>${esc(entry.usage)}</p></div>` : ''}
    ${ex ? `<div class="sec"><h3>例句</h3><ul class="ex">${ex}</ul></div>` : ''}
    <div class="books-row">${bookBadges(entry)}</div>
  </div>`;
}

/** 事件委托：发音按钮 */
export function bindAudioButtons(root = document, pronounce) {
  root.addEventListener('click', e => {
    const btn = e.target.closest('.btn-audio');
    if (!btn) return;
    pronounce(btn.dataset.w, btn.dataset.acc === 'us' ? 'us' : 'uk');
  });
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtInterval(days) {
  if (!days) return '—';
  if (days < 1) return '当天';
  if (days < 30) return `${days} 天`;
  return `${(days / 30).toFixed(1)} 月`;
}
