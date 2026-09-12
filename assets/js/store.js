/* store.js — 学习状态持久化（localStorage v5vocab.state.v1）+ 每日任务记账 + 导入导出
 * 登录后自动云同步（Supabase user_data 表）：启动时拉云端做词级合并，
 * 本机每次保存 3 秒后增量推回云端。未登录/未配置云 = 纯本机模式。
 */
import { newRec } from './srs.js';
import { cloudEnabled, client, getUser } from './auth.js?v=9';

const KEY = 'v5vocab.state.v1';
const DEFAULTS = {
  v: 1,
  words: {},        // word -> rec
  graduated: {},    // word -> {graduatedAt, reviveCount}
  familiar: {},     // word -> timestamp
  daily: {},        // 'YYYY-MM-DD' -> {added, familiar}
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
  return state;
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

/** 防抖保存（200ms），避免高频评分时同步写盘卡顿 */
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try { localStorage.setItem(KEY, JSON.stringify(load())); }
  catch (e) { console.error('state save failed (quota?)', e); }
  scheduleCloudPush();
}

/* ---- 云同步 ---- */

let cloudPushTimer = 0;

function scheduleCloudPush() {
  if (!cloudEnabled || !client()) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => { cloudPushTimer = 0; pushCloud(); }, 3000);
}

/** 把当前进度整份写入云端自己名下（user_data 一人一行，词级冲突由合并策略兜底） */
export async function pushCloud(userId) {
  if (!cloudEnabled) return;
  const sb = client();
  if (!sb) return;
  try {
    const uid = userId || (await getUser())?.id;
    if (!uid) return;
    const { error } = await sb.from('user_data')
      .upsert({ user_id: uid, data: JSON.parse(JSON.stringify(load())) }, { onConflict: 'user_id' });
    if (error) console.warn('cloud push failed', error.message);
  } catch (e) { console.warn('cloud push failed', e); }
}

/** 页面启动时调用：已登录则拉云端进度与本地合并（记录较新者优先），合并后推回云端。
 * 云端还没有记录时（新账号/第一次在云上），把本机现有进度作为初始进度上传。 */
export async function syncOnStart(timeoutMs = 8000) {
  if (!cloudEnabled) return;
  const sb = client();
  if (!sb) return;
  try {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const u = await Promise.race([getUser(), sleep(timeoutMs).then(() => null)]);
    if (!u) return;                                   // 未登录或网络太慢，先走本机
    const { data, error } = await sb.from('user_data').select('data').eq('user_id', u.id).maybeSingle();
    if (error) { console.warn('cloud pull failed', error.message); return; }
    if (!data) { pushCloud(u.id); return; }
    const before = JSON.stringify(load());
    try { importJSON(JSON.stringify(data.data), { whole: false }); } catch (e) { console.warn('cloud merge failed', e); return; }
    if (JSON.stringify(load()) !== before) save();    // 云端带来了新东西才落盘
    pushCloud(u.id);                                  // 合并结果推回云端
  } catch (e) { console.warn('syncOnStart failed', e); }
}

// 页面卸载前冲刷 pending 写盘（评分后立即导航不丢数据）+ 尽力推一次云端
addEventListener('pagehide', () => {
  flush();
  if (cloudPushTimer) { clearTimeout(cloudPushTimer); cloudPushTimer = 0; pushCloud(); }
});
// 其他标签页写入时丢弃内存快照，下次读盘取最新（避免后写者吞掉先写者）
addEventListener('storage', e => { if (e.key === KEY && !saveTimer) state = null; });

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
    for (const [k, v] of Object.entries(data.daily || {})) {
      const cur = s.daily[k];
      if (!cur) s.daily[k] = v;
      else {  // 两台设备同一天都学过：按各字段较大值合并，避免翻倍也避免丢数
        cur.added = Math.max(cur.added || 0, v.added || 0);
        cur.familiar = Math.max(cur.familiar || 0, v.familiar || 0);
      }
    }
  }
  save();
  return true;
}

export function wipe() {
  localStorage.removeItem(KEY);
  state = null;
  // 已登录时同步清空云端，防止下次启动被云端旧数据"复活"
  if (cloudEnabled) {
    (async () => {
      const sb = client();
      const u = await getUser();
      if (!sb || !u) return;
      const { error } = await sb.from('user_data').delete().eq('user_id', u.id);
      if (error) console.warn('cloud wipe failed', error.message);
    })();
  }
}
