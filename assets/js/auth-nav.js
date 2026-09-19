/* auth-nav.js — 各页顶栏右侧的账号入口（登录/用户名/管理面板） */
import { esc } from './ui.js?v=18';
import { cloudEnabled, getUser, getProfile, userLabel } from './auth.js?v=18';

export async function initAuthNav() {
  const slot = document.getElementById('authSlot');
  if (!slot) return;
  if (!cloudEnabled) {
    slot.innerHTML = '<a class="tab" href="login.html" title="账号与云同步">登录</a>';
    return;
  }
  slot.innerHTML = '<a class="tab" href="login.html">…</a>';
  try {
    const u = await getUser();
    if (!u) { slot.innerHTML = '<a class="tab" href="login.html">登录 / 注册</a>'; return; }
    const p = await getProfile();
    const admin = p?.is_admin
      ? '<a class="tab" href="admin.html" title="账号管理（管理员）">👑</a>' : '';
    slot.innerHTML = `${admin}<a class="tab" href="login.html" title="账号中心">👤 ${esc(userLabel())}</a>`;
  } catch (e) {
    slot.innerHTML = '<a class="tab" href="login.html">登录</a>';
  }
}
