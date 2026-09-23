/* store.js — 学习状态持久化（localStorage v5vocab.state.v1）+ 每日任务记账 + 导入导出 */
import { newRec } from './srs.js?v=18';

const KEY = 'v5vocab.state.v1';
const DEFAULTS = {
  v: 1,
  words: {},        // word -> rec
  graduated: {},    // word -> {graduatedAt, reviveCount}
  familiar: {},     // word -> timestamp
  daily: {},        // 'YYYY-MM-DD' -> {added, familiar}
  notes: {},        // 'YYYY-MM-DD' -> [word]（复习页「记入今日笔记」按钮，随账号云同步）
  settings: { dailyGoal: 50, realAudio: true, theme: 'auto', voice: 'auto' },
};

export function todayKey(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let state = null;
let saveTimer = 0;

function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) { console.warn('state load failed', e); }
  state = deepMerge(cloneDefaults(), state || {});
  migrateOldNoteKey(state);
  return state;
}

/* 一次性迁移：旧版「今日笔记」独立键（只在当天显示，跨天即隐形）→ 永久并入 state.notes，
 * 随即 save() 触发云同步，其他设备也能看到。 */
function migrateOldNoteKey(s) {
  try {
    const old = JSON.parse(localStorage.getItem('v5vocab.notes.today.v1') || 'null');
    if (old && old.date && Array.isArray(old.words)) {
      const arr = s.notes[old.date] || (s.notes[old.date] = []);
      let added = false;
      for (const w of old.words) if (w && !arr.includes(w)) { arr.push(w); added = true; }
      localStorage.removeItem('v5vocab.notes.today.v1');
      if (added) save();
    }
  } catch (e) { /* 坏数据直接丢弃旧键内容 */ localStorage.removeItem('v5vocab.notes.today.v1'); }
}

function deepMerge(base, over) {
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], over[k]);
    } else base[k] = over[k];
  }
  return base;
}

function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULTS)); }

/** 防抖保存（200ms），避免高频评分时同步写盘卡顿。
 * dirty 门闸：只有本页真正改过状态才允许写盘——防止后台旧标签页在
 * pagehide 时用内存里的旧快照/空默认覆盖其他标签页已保存的数据 */
let dirty = false;

export function save() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!dirty) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
    // 通知云同步模块（sync.js 监听；未登录/未启用时无人接收，零开销）
    document.dispatchEvent(new CustomEvent('v5:flush'));
  }
  catch (e) { console.error('state save failed (quota?)', e); }
}

// 页面隐藏/卸载前冲刷 pending 写盘（评分后立即导航不丢数据）
addEventListener('pagehide', flush);
// 其他标签页写入时丢弃内存快照，下次读盘取最新（避免后写者吞掉先写者）
addEventListener('storage', e => { if (e.key === KEY && !saveTimer) { state = null; dirty = false; } });

export function getState() { return load(); }

/* ---- 生词本操作 ---- */

export function markFamiliar(word, now = Date.now()) {
  const s = load();
  s.familiar[word] = now;
  bumpDaily('familiar', now);
  save();
}

export function addWord(word, now = Date.now()) {
  const s = load();
  if (s.words[word]) return false;             // 已在本中，不重复计今日新增
  if (s.graduated[word]) {                     // 毕业词复活路径由 revive() 处理；直接 add 视为复活
    return revive(word, now);
  }
  s.words[word] = newRec(now);
  bumpDaily('added', now);
  save();
  return true;
}

export function removeWord(word) {
  const s = load();
  delete s.words[word];
  save();
}

/** 毕业：从 words 移入 graduated */
export function graduate(word, now = Date.now()) {
  const s = load();
  if (!s.words[word]) return;
  s.graduated[word] = s.graduated[word] || { graduatedAt: now, reviveCount: 0 };
  delete s.words[word];
  save();
}

/** 复活毕业词：清零重学，记 reviveCount */
export function revive(word, now = Date.now()) {
  const s = load();
  if (!s.graduated[word]) return false;
  s.graduated[word].reviveCount = (s.graduated[word].reviveCount || 0) + 1;
  delete s.graduated[word];
  s.words[word] = newRec(now);
  save();
  return true;
}

export function applyReview(word, newRecFields) {
  const s = load();
  if (!s.words[word]) return;
  s.words[word] = newRecFields;
  if (newRecFields.graduated) {
    delete newRecFields.graduated;
    graduate(word);
  }
  save();
}

/* ---- 生词笔记（复习页按钮） ---- */

/** 把词记入今天的生词笔记；已存在返回 false */
export function addNoteWord(word, now = Date.now()) {
  const s = load();
  const k = todayKey(new Date(now));
  s.notes[k] = s.notes[k] || [];
  if (s.notes[k].includes(word)) return false;
  s.notes[k].push(word);
  save();
  return true;
}

/* ---- 每日任务 ---- */

function bumpDaily(field, now = Date.now()) {
  const s = load();
  const k = todayKey(new Date(now));
  s.daily[k] = s.daily[k] || { added: 0, familiar: 0 };
  s.daily[k][field] = (s.daily[k][field] || 0) + 1;
}

export function todayAdded() {
  const s = load();
  return (s.daily[todayKey()] || {}).added || 0;
}

export function todayGoal() {
  return load().settings.dailyGoal || 50;
}

/** 是否该跳过：已入本 / 已毕业 / 已标熟悉 */
export function shouldSkip(word) {
  const s = load();
  return !!(s.words[word] || s.graduated[word] || s.familiar[word]);
}

/* ---- 连续打卡 ---- */

export function streakDays() {
  const s = load();
  let n = 0;
  const d = new Date();
  // 今天没有任何活动不打断昨天的连续，但连续数从今天算起为 0 起点
  if (!s.daily[todayKey(d)] || !((s.daily[todayKey(d)].added) || (s.daily[todayKey(d)].familiar))) d.setDate(d.getDate() - 1);
  for (;;) {
    const k = todayKey(d);
    const e = s.daily[k];
    if (e && (e.added || e.familiar)) { n++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return n;
}

/* ---- 导入导出 ---- */

export function exportJSON() {
  return JSON.stringify(load(), null, 1);
}

/** 导入：whole=true 覆盖式替换；否则合并（远端记录字段较新者优先） */
export function importJSON(text, { whole = true } = {}) {
  const data = JSON.parse(text);
  if (!data || data.v !== 1 || typeof data.words !== 'object') throw new Error('格式不符：需要 v5vocab 导出的 v1 JSON');
  if (whole) {
    state = deepMerge(cloneDefaults(), data);
  } else {
    const s = load();
    for (const [w, rec] of Object.entries(data.words || {})) {
      if (!s.words[w] || (rec.lastAt || 0) > (s.words[w].lastAt || 0)) s.words[w] = rec;
    }
    for (const [w, t] of Object.entries(data.familiar || {})) if (!s.familiar[w] || t > s.familiar[w]) s.familiar[w] = t;
    for (const [w, g] of Object.entries(data.graduated || {})) if (!s.graduated[w]) s.graduated[w] = g;
    for (const [k, v] of Object.entries(data.daily || {})) if (!s.daily[k]) s.daily[k] = v;
    for (const [k, arr] of Object.entries(data.notes || {})) {
      const cur = s.notes[k] || (s.notes[k] = []);
      for (const w of (arr || [])) if (!cur.includes(w)) cur.push(w);
    }
  }
  save();
  return true;
}

export function wipe() {
  dirty = false;
  clearTimeout(saveTimer);
  saveTimer = 0;
  localStorage.removeItem(KEY);
  state = null;
  document.dispatchEvent(new CustomEvent('v5:wipe'));
}
