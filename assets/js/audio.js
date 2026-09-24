/* audio.js — 按键/点击即出声
 * 百度英音(lan=uk)、美音(lan=en)开头几乎没有静音，比有道少约 300ms 空等。
 * 卡片出现时预载；缓冲好了直接 play()。还没好才回落系统语音。 */
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

export function initAudio() {
  if (!document.querySelector('meta[name="referrer"]')) {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
  }
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

export function pronounce(word, accent = 'uk', preferReal = realAudioEnabled()) {
  if (!word) return;
  const acc = accent === 'us' ? 'us' : 'uk';
  if (preferReal) {
    ensureClip(word, acc);
    if (playReadyClip(word, acc)) {
      if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) {
        speechSynthesis.cancel();
      }
      return;
    }
  }
  stopClip();
  speak(word, acc);
}
