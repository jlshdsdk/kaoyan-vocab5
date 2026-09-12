/* auth.js — 账号系统（Supabase Auth）
 * 未配置 SUPABASE_URL 时优雅降级：cloudEnabled=false，网站与原来完全一样。
 * 加载方式：动态注入 vendor/supabase.js（UMD，本地文件，不依赖外部 CDN）。
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const cloudEnabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let sb = null;            // supabase client
let loadSdkPromise = null;

function loadSdk() {
  if (window.supabase?.createClient) return Promise.resolve();
  if (loadSdkPromise) return loadSdkPromise;
  loadSdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'assets/js/vendor/supabase.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('supabase.js 加载失败'));
    document.head.appendChild(s);
  });
  return loadSdkPromise;
}

if (cloudEnabled) {
  try {
    await loadSdk();
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  } catch (e) { console.error('Supabase 初始化失败', e); }
}

export function client() { return sb; }

/* ---- 会话状态 ---- */

let user = null;
let profile = null;       // profiles 行：{ id, email, nickname, is_admin, banned, created_at }
let readyPromise = null;

export function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (!sb) return;
      try {
        const { data } = await sb.auth.getSession();
        user = data?.session?.user || null;
        if (user) await refreshProfile();
        sb.auth.onAuthStateChange(async (_ev, session) => {
          const prevId = user?.id;
          user = session?.user || null;
          if (user?.id !== prevId) { profile = null; if (user) await refreshProfile(); }
        });
      } catch (e) { console.warn('auth ready failed', e); }
    })();
  }
  return readyPromise;
}

/** 拉取当前用户档案；发现被封禁则自动登出（user 置空，由调用方给出提示） */
async function refreshProfile() {
  if (!sb || !user) return;
  try {
    const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) { console.warn('profile load failed', error); return; }
    profile = data;
    if (profile?.banned) {
      await sb.auth.signOut();
      user = null; profile = null;
    }
  } catch (e) { console.warn(e); }
}

/** 首次登录时数据库里可能还没有档案行（比如先注册后建表），让服务端补建 */
async function ensureProfile() {
  if (!sb || !user || profile) return;
  try {
    const { error } = await sb.rpc('ensure_my_profile');
    if (!error) {
      const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      profile = data || null;
    }
  } catch (e) { console.warn('ensure_profile failed', e); }
}

export async function getUser() { await ready(); return user; }
export async function getProfile() { await ready(); if (user && !profile) await ensureProfile(); return profile; }

export function userLabel() {
  if (!user) return '';
  return (profile?.nickname || '').trim() || (user.email || '').split('@')[0];
}

/* ---- 注册 / 登录 / 登出 ---- */

export async function signUp(email, password, nickname) {
  if (!sb) throw new Error('云同步未配置');
  const { data, error } = await sb.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { nickname: (nickname || '').trim() } },
  });
  if (error) throw error;
  // 项目开启"邮箱确认"时：data.session 为空，需要用户去邮箱点确认链接
  if (!data.session) {
    return { needConfirm: true, message: '注册成功！请先到邮箱查收确认邮件并点击链接，然后再回来登录。' };
  }
  user = data.user;
  await refreshProfile();
  return { needConfirm: false };
}

export async function signIn(email, password) {
  if (!sb) throw new Error('云同步未配置');
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    if (/not confirmed/i.test(error.message || '')) throw new Error('邮箱还没确认：请先到邮箱点击确认邮件里的链接');
    if (/Invalid login/i.test(error.message || '')) throw new Error('账号或密码不对');
    throw error;
  }
  user = data.user;
  profile = null;
  await refreshProfile();     // 被禁用的账号会在内部被登出（user 变回 null）
  if (!user) throw new Error('该账号已被管理员禁用');
  return user;
}

export async function signOut() {
  if (!sb) return;
  try { await sb.auth.signOut(); } catch (e) { console.warn(e); }
  user = null; profile = null;
}
