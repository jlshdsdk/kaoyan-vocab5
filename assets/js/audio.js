/* audio.js — 发音模块：SpeechSynthesis 即时主路径 + 真人音频按需缓存增强
 * 设计目标：点击 <100ms 响应。utterance 预建缓存；真人音频（dictionaryapi.dev）就绪后自动升级，
 * 取不到就永远 TTS，不阻塞点击。 */
const IDX_DB = 'v5audio';
const STORE = 'clips';

let voicesUK = null, voicesUS = null;
const uttrCache = new Map();     // word|accent -> SpeechSynthesisUtterance
let dbPromise = null;
let unlocked = false;
let warnedNoUK = false;

function pickVoices() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return;
  const score = v => {
    let s = 0;
    const n = v.name.toLowerCase();
    if (n.includes('espeak')) s -= 10;              // 机械合成声降权
    if (n.includes('google')) s += 3;
    if (n.includes('natural') || n.includes('neural')) s += 4;
    if (n.includes('siri')) s += 3;
    if (v.localService) s += 1;
    return s;
  };
  const uk = vs.filter(v => v.lang === 'en-GB' || v.lang.toLowerCase().startsWith('en-gb')).sort((a, b) => score(b) - score(a));
  const us = vs.filter(v => v.lang === 'en-US' || v.lang.toLowerCase().startsWith('en-us')).sort((a, b) => score(b) - score(a));
  voicesUK = uk[0] || null;
  voicesUS = us[0] || uk[0] || null;
  if (!voicesUK && voicesUS && !warnedNoUK) {
    warnedNoUK = true;
    import('./ui.js?v=18').then(ui => ui.toast('未找到英音声音，英音将用美音代替')).catch(() => {});
  }
}

export function initAudio() {
  if (!('speechSynthesis' in window)) return;
  pickVoices();
  speechSynthesis.onvoiceschanged = pickVoices;
  // 首次用户交互后解锁（移动端自动播放策略）
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    try { const u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } catch (e) {}
  };
  addEventListener('pointerdown', unlock, { once: true, passive: true });
  addEventListener('keydown', unlock, { once: true });
}

export function accentAvailable() {
  return { uk: !!voicesUK, us: !!voicesUS, tts: 'speechSynthesis' in window };
}

/** 即时发音（TTS 主路径，永远 <100ms） */
export function speak(word, accent = 'uk') {
  if (!('speechSynthesis' in window)) return;
  const key = word + '|' + accent;
  let u = uttrCache.get(key);
  if (!u) {
    u = new SpeechSynthesisUtterance(word);
    u.rate = 0.95;
    u.lang = accent === 'uk' ? 'en-GB' : 'en-US';
    const v = accent === 'uk' ? (voicesUK || voicesUS) : (voicesUS || voicesUK);
    if (v) u.voice = v;
    uttrCache.set(key, u);
    if (uttrCache.size > 500) uttrCache.delete(uttrCache.keys().next().value);
  }
  speechSynthesis.cancel();   // 连点时掐掉上一个
  speechSynthesis.speak(u);
}

/* ---- 真人音频增强（IndexedDB 缓存 + dictionaryapi.dev） ---- */

function realAudioEnabled() {
  try {
    const s = JSON.parse(localStorage.getItem('v5vocab.state.v1') || 'null');
    return !s || !s.settings || s.settings.realAudio !== false;
  } catch (e) { return true; }
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const rq = indexedDB.open(IDX_DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbPromise;
}

async function idbGet(word) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(word);
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { return null; }
}

async function idbPut(word, buf) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(buf, word);
  } catch (e) {}
}

/** 后台预取真人音频（卡片进入视口时调用）；失败静默 */
export function prefetchRealAudio(word) {
  if (!realAudioEnabled() || !window.navigator.onLine) return;
  idbGet(word).then(hit => {
    if (hit) return;
    fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        let url = '', urlAny = '';
        for (const ent of data || []) {
          for (const ph of ent.phonetics || []) {
            if (!ph.audio) continue;
            if (ph.audio.includes('-uk')) { url = ph.audio; break; }
            if (!url && ph.audio.includes('-us')) url = ph.audio;
            if (!urlAny && !ph.audio.includes('-us') && !ph.audio.includes('-uk')) urlAny = ph.audio;
          }
          if (url) break;
        }
        url = url || urlAny;
        if (!url) throw 0;
        return fetch(url).then(r => r.ok ? r.arrayBuffer() : Promise.reject());
      })
      .then(buf => buf && idbPut(word, buf))
      .catch(() => {});
  });
}

/** 若真人音频缓存就绪则播放之，返回 true；否则 false（调用方回落 TTS） */
export async function speakRealIfReady(word) {
  const hit = await idbGet(word);
  if (!hit) return false;
  try {
    const ctx = getCtx();
    const src = ctx.createBufferSource();
    src.buffer = await ctx.decodeAudioData(hit.slice(0));
    src.connect(ctx.destination);
    src.start();
    return true;
  } catch (e) { return false; }
}

let _ctx = null;
function getCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
}

/** 统一入口：真人音频优先（可在设置中关），回落 TTS；两者都是即时路径 */
export function pronounce(word, accent = 'uk', preferReal = realAudioEnabled()) {
  if (preferReal) {
    speakRealIfReady(word).then(ok => { if (!ok) speak(word, accent); });
  } else {
    speak(word, accent);
  }
}
