/* sync.js — 云端进度同步（Supabase user_data 表，每用户一行整份 JSON）
 *
 * 页面加载时若已登录：
 *   · 云端为空、本机有进度 → 直接上传本机（首次登录即"以本设备为准"）
 *   · 本机为空、云端有进度 → 整份从云端恢复
 *   · 两边都有 → 词级合并（每条记录较新者优先；同新以本机为准），合并结果回推
 * 之后本机每次写盘 3 秒防抖自动回推；页面隐藏/关闭前尽力补推（keepalive）。
 * 「清空全部学习数据」会调用 wipeCloud() 同时删除云端记录。
 *
 * 注意：本文件 import 的模块 URL 必须与各 HTML 页面引用的完全一致（含 ?v=），
 * 否则浏览器会把同一模块加载成两份实例，本机状态分裂。
 */
import { cloudEnabled, getUser, client } from './auth.js?v=18';
import { toast } from './ui.js?v=18';
import * as store from './store.js?v=19';

const PUSH_DEBOUNCE = 3000;   // 本机改动后延迟回推（README 约定 3 秒）
const RETRY_MS = 30000;       // 网络失败后的重试间隔

let started = false;
let online = false;           // 已登录且完成首次同步（失败重试中为 false）
let pushTimer = 0;
let retryTimer = 0;
let pushing = false;
let lastPushAt = 0;           // 上次成功回推的时间戳（账号中心展示用）

export function isOnline() { return online; }
export function lastSyncTime() { return lastPushAt; }

export async function startSync() {
  if (!cloudEnabled || started) return;
  started = true;

  document.addEventListener('v5:flush', schedulePush);
  addEventListener('pagehide', () => { if (pushTimer) pushNow(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pushTimer) pushNow(true);
  });

  const u = await getUser();
  if (!u) return;
  await initialSync();
}

/** 首次同步：拉云端，按三档情况处理。拉取失败则稍后重试，期间不回推，
 *  防止用本机快照盲目覆盖云端（可能吞掉其他设备的新记录）。 */
async function initialSync() {
  const sb = client(); const u = await getUser();
  if (!sb || !u) return;
  let row;
  try {
    const { data, error } = await sb.from('user_data')
      .select('data, updated_at').eq('user_id', u.id).maybeSingle();
    if (error) throw error;
    row = data;
  } catch (e) {
    console.warn('云端进度拉取失败，30 秒后重试', e);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(initialSync, RETRY_MS);
    return;
  }
  clearTimeout(retryTimer);

  const cloud = row?.data || null;
  const localCount = countAll(store.getState());
  online = true;

  if (!cloud) {
    if (localCount > 0) {
      if (await pushNow()) toast('☁️ 本机进度已上传云端，其他设备登录即同步');
    }
    return;
  }

  if (localCount === 0) {
    try {
      // 只记过笔记、没加过生词的设备：云端整份恢复前，把本机 notes 按日期并集并入云端数据，
      // 否则整份替换会吞掉本机笔记（countAll 已计入 notes 日期数，此处为双保险）
      const localNotes = store.getState().notes || {};
      const merged = { ...cloud, notes: { ...((cloud && cloud.notes) || {}) } };
      for (const [k, arr] of Object.entries(localNotes)) {
        const cur = merged.notes[k] ? [...merged.notes[k]] : [];
        for (const w of (arr || [])) if (!cur.includes(w)) cur.push(w);
        merged.notes[k] = cur;
      }
      store.importJSON(JSON.stringify(merged), { whole: true });  // 内部 save 会安排一次回推，幂等无害
      toast('☁️ 已从云端恢复学习进度');
    } catch (e) { console.warn('云端进度恢复失败', e); }
    return;
  }

  // 两边都有 → 词级合并，较新者胜（同时间戳保留本机），合并结果回推
  try {
    const before = countAll(store.getState());
    store.importJSON(JSON.stringify(cloud), { whole: false });
    const gained = countAll(store.getState()) - before;
    await pushNow();
    toast(gained > 0 ? `☁️ 已合并云端与本机进度（新并入 ${gained} 条）` : '☁️ 已同步云端进度');
  } catch (e) {
    console.warn('云端进度合并失败，30 秒后重试（不回推，保住云端待重试的记录）', e);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(initialSync, RETRY_MS);
  }
}

function countAll(s) {
  return Object.keys(s.words || {}).length
       + Object.keys(s.graduated || {}).length
       + Object.keys(s.familiar || {}).length
       + Object.keys(s.notes || {}).length;   // 笔记也是用户数据：只有笔记的设备不能被判为"空"
}

/* ---- 回推 ---- */

function schedulePush() {
  if (!online) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = 0; pushNow(); }, PUSH_DEBOUNCE);
}

/** 把本机当前进度整份 upsert 到云端。keepalive=true 用于页面卸载前尽力送达。 */
async function pushNow(keepalive = false) {
  clearTimeout(pushTimer); pushTimer = 0;
  const sb = client(); const u = await getUser();
  if (!sb || !u || !cloudEnabled) return false;
  if (pushing) return false;      // 上一发还在路上，交给重试链
  pushing = true;
  try {
    const data = JSON.parse(store.exportJSON());
    if (keepalive) {
      // supabase-js 内部是普通 fetch，卸载即断；这里手写 keepalive 请求
      const { data: sess } = await sb.auth.getSession();
      if (!sess?.access_token) return false;
      const body = JSON.stringify({ user_id: u.id, data });
      const res = await fetch(`${sb.supabaseUrl}/rest/v1/user_data?on_conflict=user_id`, {
        method: 'POST',
        headers: {
          'apikey': sb.supabaseKey,
          'Authorization': `Bearer ${sess.access_token}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body,
        keepalive: true,          // >64KB 时浏览器会拒发，靠下次加载合并自愈
      });
      if (!res.ok) throw new Error(`keepalive push HTTP ${res.status}`);
    } else {
      const { error } = await sb.from('user_data')
        .upsert({ user_id: u.id, data }, { onConflict: 'user_id' });
      if (error) throw error;
    }
    lastPushAt = Date.now();
    return true;
  } catch (e) {
    console.warn('云端回推失败，稍后自动重试', e);
    if (online && !keepalive) {
      pushTimer = setTimeout(() => { pushTimer = 0; pushNow(); }, RETRY_MS);
    }
    return false;
  } finally {
    pushing = false;
  }
}

/* ---- 账号中心（login.html）用的显式操作与状态 ---- */

/** 云端进度概况；无记录返回 null */
export async function cloudInfo() {
  const sb = client(); const u = await getUser();
  if (!sb || !u) return null;
  const { data, error } = await sb.from('user_data')
    .select('data, updated_at').eq('user_id', u.id).maybeSingle();
  if (error || !data) return null;
  return { updatedAt: data.updated_at, count: countAll(data.data || {}) };
}

/** 显式：以本机进度整份覆盖云端 */
export async function pushLocalOverwrite() {
  const ok = await pushNow();
  if (!ok) throw new Error('上传失败，请检查网络后重试');
  return true;
}

/** 显式：以云端进度整份覆盖本机 */
export async function pullCloudOverwrite() {
  const sb = client(); const u = await getUser();
  if (!sb || !u) throw new Error('未登录');
  const { data: row, error } = await sb.from('user_data')
    .select('data').eq('user_id', u.id).maybeSingle();
  if (error) throw error;
  if (!row?.data) throw new Error('云端还没有进度记录');
  store.importJSON(JSON.stringify(row.data), { whole: true });
  return true;
}

/** 「清空全部学习数据」时同步删除云端记录；返回是否删除成功（失败时调用方不应 reload，
 *  否则页面重载后会从云端"恢复"回刚被清空的数据） */
export async function wipeCloud() {
  if (!cloudEnabled) return true;
  const sb = client(); const u = await getUser();
  if (!sb || !u) return false;
  online = false;
  clearTimeout(pushTimer); clearTimeout(retryTimer);
  pushTimer = 0; retryTimer = 0;
  try {
    const { error } = await sb.from('user_data').delete().eq('user_id', u.id);
    if (error) throw error;
    return true;
  } catch (e) { console.warn('云端进度删除失败', e); return false; }
}
