/* config.js — 云同步配置（唯一需要手动填的文件）
 * 两个值来自 Supabase 控制台 → Project Settings → API：
 *   SUPABASE_URL      = Project URL，形如 https://xxxxxxxx.supabase.co
 *   SUPABASE_ANON_KEY = anon public（公开密钥，可放前端，不泄密）
 * 两个值都填好后云同步自动启用；留空则网站保持原来的纯本机模式。
 */
export const SUPABASE_URL = 'https://qvemohfojzawpnleyjsb.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_VFalDAdNoIgd19oxlZ8wlw_AM-rv7Uq';
