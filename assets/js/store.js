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
  enforceGraduation(state);
  return state;
}

/** 不变量：一个词不能同时存在于 words 与 graduated。
 *  跨标签页 mergeIncoming / 云端 importJSON 都是并集合并、无墓碑记录，旧快照会把
 *  已毕业的词重新并回 words，导致毕业词反复出现在生词本复习。这里按时间戳裁决：
 *  words 记录的 lastAt 晚于毕业时间 = 毕业后又在别的设备复活在学 → 保留在学；
 *  否则毕业胜出，从 words 移除。每次 load / 合并后执行，旧脏数据自动自愈。 */
function enforceGraduation(s) {
  for (const w of Object.keys(s.words || {})) {
    const g = s.graduated[w];
    if (!g) continue;
    const graduatedAt = (g.graduatedAt != null) ? g.graduatedAt : Infinity;
    if ((s.words[w].lastAt || 0) > graduatedAt) delete s.graduated[w];   // 毕业后复活在学
    else delete s.words[w];                                              // 毕业胜出
  }
}

/* 一次性迁移：旧版「今日笔记」独立键（只在当天显示，跨天即隐形）→ 永久并入 state.notes，
 * 先同步写盘再删旧键（消除他页在防抖窗口内抢先保存的微竞态），随后触发云同步。 */
function migrateOldNoteKey(s) {
  try {
    const old = JSON.parse(localStorage.getItem('v5vocab.notes.today.v1') || 'null');
    if (old && old.date && Array.isArray(old.words)) {
      const arr = s.notes[old.date] || (s.notes[old.date] = []);
      let added = false;
      for (const w of old.words) if (w && !arr.includes(w)) { arr.push(w); added = true; }
      if (added) {
        try {
          localStorage.setItem(KEY, JSON.stringify(s));
          document.dispatchEvent(new CustomEvent('v5:flush'));
        } catch (e) { console.warn('note migration save failed', e); }
      }
    }
  } catch (e) { /* 坏数据直接丢弃 */ }
  localStorage.removeItem('v5vocab.notes.today.v1');
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
    dirty = false;   // 落盘成功后复位，防止 pagehide 用陈旧快照再整写一遍
    // 通知云同步模块（sync.js 监听；未登录/未启用时无人接收，零开销）
    document.dispatchEvent(new CustomEvent('v5:flush'));
  }
  catch (e) { console.error('state save failed (quota?)', e); }
}

// 页面隐藏/卸载前冲刷 pending 写盘（评分后立即导航不丢数据）
addEventListener('pagehide', flush);
// 其他标签页写入：无待写时直接读盘取最新；有待写时把对方记录并入内存（否则自己的
// 整份快照会吞掉对方刚落盘的新增）——按记录级新者胜合并，删除操作不跨标签传播（已知限制）
addEventListener('storage', e => {
  if (e.key !== KEY || !e.newValue) return;
  if (!saveTimer) { state = null; dirty = false; return; }
  try { mergeIncoming(JSON.parse(e.newValue)); } catch (err) {}
});

/** 把另一标签页刚写入的记录按"新者胜/并集"并入本页内存（words 比 lastAt、familiar 取 max、
 *  graduated/notes 并集、daily 取字段 max）。本页删除与对方并发时以对方为准（无 tombstone）。 */
function mergeIncoming(disk) {
  const s = load();
  if (!disk || disk.v !== 1) return;
  for (const [w, rec] of Object.entries(disk.words || {})) {
    if (!s.words[w] || (rec.lastAt || 0) > (s.words[w].lastAt || 0)) s.words[w] = rec;
  }
  for (const [w, t] of Object.entries(disk.familiar || {})) if (!s.familiar[w] || t > s.familiar[w]) s.familiar[w] = t;
  for (const [w, g] of Object.entries(disk.graduated || {})) if (!s.graduated[w]) s.graduated[w] = g;
  for (const [k, arr] of Object.entries(disk.notes || {})) {
    const cur = s.notes[k] || (s.notes[k] = []);
    for (const w of (arr || [])) if (!cur.includes(w)) cur.push(w);
  }
  for (const [k, v] of Object.entries(disk.daily || {})) {
    const c = s.daily[k];
    if (!c) s.daily[k] = v;
    else { c.added = Math.max(c.added || 0, v.added || 0); c.familiar = Math.max(c.familiar || 0, v.familiar || 0); }
  }
  enforceGraduation(s);
}

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

/** 复活毕业词：清零重学，记 reviveCount。lastAt 记为复活时刻，
 *  让"新者胜"合并时压过其他设备上毕业前的旧记录（否则旧记录会复活成新队列）。 */
export function revive(word, now = Date.now()) {
  const s = load();
  if (!s.graduated[word]) return false;
  s.graduated[word].reviveCount = (s.graduated[word].reviveCount || 0) + 1;
  delete s.graduated[word];
  const rec = newRec(now);
  rec.lastAt = now;
  s.words[word] = rec;
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
    for (const [k, arr] of Object.entries(data.notes || {})) {
      const cur = s.notes[k] || (s.notes[k] = []);
      for (const w of (arr || [])) if (!cur.includes(w)) cur.push(w);
    }
    for (const [k, v] of Object.entries(data.daily || {})) {
      const c = s.daily[k];
      if (!c) s.daily[k] = v;
      else { c.added = Math.max(c.added || 0, v.added || 0); c.familiar = Math.max(c.familiar || 0, v.familiar || 0); }
    }
  }
  enforceGraduation(load());
  save();
  return true;
}

export function wipe() {
  dirty = false;
  clearTimeout(saveTimer);
  saveTimer = 0;
  localStorage.removeItem(KEY);
  localStorage.removeItem('v5vocab.notes.today.v1');   // 旧笔记键一并清除，防止迁移"复活"已清空的数据
  state = null;
  document.dispatchEvent(new CustomEvent('v5:wipe'));
}
