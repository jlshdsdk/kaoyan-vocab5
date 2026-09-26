/* audio.js — 按键/点击即出声
 * 百度英音(lan=uk)、美音(lan=en)开头几乎没有静音，比有道少约 300ms 空等。
 * 卡片出现时预载；缓冲好了直接 play()。
 * 预载还没到就按键时：短等在途音频（约 300ms 内基本都能到，实测单个约 150-300ms），
 * 到了立刻播真音频；超时才回落系统语音。百度响应带 max-age=3600，一小时内重复访问走磁盘缓存。 */
const clips = new Map();
let voicesUK = null, voicesUS = null;
let warnedNoUK = false;
let playing = null;

function scoreVoice(v) {
  let s = 0;
  const n = (v.name || '').toLowerCase();
  if (v.localService) s += 12;
  if (n.includes('online')) s -= 10;
  if (n.includes('espeak')) s -= 8;
  if (n.includes('natural') || n.includes('neural')) s += v.localService ? 3 : -4;
  return s;
}

function pickVoices() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return;
  const rank = list => list.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a));
  const uk = rank(vs.filter(v => (v.lang || '').toLowerCase().startsWith('en-gb')));
  const us = rank(vs.filter(v => (v.lang || '').toLowerCase().startsWith('en-us')));
  voicesUK = uk[0] || null;
  voicesUS = us[0] || uk[0] || null;
  if (!voicesUK && voicesUS && !warnedNoUK) {
    warnedNoUK = true;
    import('./ui.js?v=18').then(ui => ui.toast('未找到英音声音，英音将用美音代替')).catch(() => {});
  }
}

/* 预热到百度 TTS 的连接：DNS+TCP+TLS 提前建好，首次取音省 100-300ms。
 * 音频请求是无 CORS 的媒体请求，preconnect 不带 crossorigin 才能匹配上。 */
function preconnectTTS() {
  if (document.querySelector('link[rel="preconnect"][href="https://fanyi.baidu.com"]')) return;
  for (const rel of ['preconnect', 'dns-prefetch']) {
    const l = document.createElement('link');
    l.rel = rel;
    l.href = 'https://fanyi.baidu.com';
    document.head.appendChild(l);
  }
}

export function initAudio() {
  if (!document.querySelector('meta[name="referrer"]')) {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
  }
  preconnectTTS();
  if (!('speechSynthesis' in window)) return;
  pickVoices();
  speechSynthesis.onvoiceschanged = pickVoices;
  try { speechSynthesis.resume(); } catch (e) {}
  setInterval(() => {
    if (!speechSynthesis.speaking && !speechSynthesis.pending) {
      try { speechSynthesis.resume(); } catch (e) {}
    }
  }, 8000);
}

export function accentAvailable() {
  return { uk: !!voicesUK, us: !!voicesUS, tts: 'speechSynthesis' in window };
}

function clipKey(word, accent) {
  return String(word).toLowerCase() + '|' + accent;
}

function clipUrl(word, accent) {
  const lan = accent === 'uk' ? 'uk' : 'en';
  return 'https://fanyi.baidu.com/gettts?lan=' + lan + '&text=' + encodeURIComponent(word) + '&spd=3&source=web';
}

function ensureClip(word, accent) {
  const key = clipKey(word, accent);
  let a = clips.get(key);
  if (a) return a;
  a = new Audio();
  a.preload = 'auto';
  a.referrerPolicy = 'no-referrer';
  a.src = clipUrl(word, accent);
  clips.set(key, a);
  if (clips.size > 80) {
    const oldest = clips.keys().next().value;
    const old = clips.get(oldest);
    try { old.pause(); old.removeAttribute('src'); old.load(); } catch (e) {}
    clips.delete(oldest);
  }
  return a;
}

function stopClip() {
  if (!playing) return;
  try { playing.pause(); } catch (e) {}
  playing = null;
}

function playReadyClip(word, accent) {
  const a = clips.get(clipKey(word, accent));
  if (!a || a.readyState < 2 || a.error) return false;
  stopClip();
  playing = a;
  if (a.currentTime > 0.05) {
    try { a.currentTime = 0; } catch (e) {}
  }
  const p = a.play();
  if (p && p.catch) p.catch(() => {});
  if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) {
    speechSynthesis.cancel();
  }
  return true;
}

export function speak(word, accent = 'uk') {
  if (!('speechSynthesis' in window)) return;
  if (!voicesUK && !voicesUS) pickVoices();
  const acc = accent === 'us' ? 'us' : 'uk';
  const u = new SpeechSynthesisUtterance(word);
  u.rate = 0.95;
  u.lang = acc === 'uk' ? 'en-GB' : 'en-US';
  const v = acc === 'uk' ? (voicesUK || voicesUS) : (voicesUS || voicesUK);
  if (v) u.voice = v;
  const synth = speechSynthesis;
  synth.resume();
  if (synth.speaking || synth.pending) {
    synth.cancel();
    setTimeout(() => { synth.resume(); synth.speak(u); }, 0);
  } else {
    synth.speak(u);
  }
}

function realAudioEnabled() {
  try {
    const s = JSON.parse(localStorage.getItem('v5vocab.state.v1') || 'null');
    return !s || !s.settings || s.settings.realAudio !== false;
  } catch (e) { return true; }
}

export function prefetchRealAudio(word) {
  if (!word || !realAudioEnabled() || !window.navigator.onLine) return;
  ensureClip(word, 'uk');
  ensureClip(word, 'us');
}

/* 按键即播：就绪立刻播；在途则等它（通常 150-300ms，用户感知仍接近即时）；
 * WAIT_MS 内没到或出错才回落系统语音，回落后音频继续缓存，下次按键秒响。 */
const WAIT_MS = 300;

function pressPlay(word, acc) {
  const a = ensureClip(word, acc);
  if (a.error) return false;
  if (a.readyState >= 2) return playReadyClip(word, acc);
  let settled = false;
  const fallback = () => {
    if (settled) return;
    settled = true;
    cleanup();
    stopClip();
    speak(word, acc);
  };
  const onReady = () => {
    if (settled) return;
    if (a.error) { fallback(); return; }
    if (a.readyState >= 2) {
      settled = true;
      cleanup();
      playReadyClip(word, acc);
    }
  };
  const timer = setTimeout(fallback, WAIT_MS);
  function cleanup() {
    clearTimeout(timer);
    a.removeEventListener('loadeddata', onReady);
    a.removeEventListener('canplay', onReady);
    a.removeEventListener('error', fallback);
  }
  a.addEventListener('loadeddata', onReady);
  a.addEventListener('canplay', onReady);
  a.addEventListener('error', fallback);
  return true;
}

export function pronounce(word, accent = 'uk', preferReal = realAudioEnabled()) {
  if (!word) return;
  const acc = accent === 'us' ? 'us' : 'uk';
  if (preferReal && pressPlay(word, acc)) return;
  stopClip();
  speak(word, acc);
}
