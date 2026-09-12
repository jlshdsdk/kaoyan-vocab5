-- ================================================================
--  考研五书词汇 · 账号系统一键初始化脚本
--
--  使用方法：
--   1. 在本文件里找到「admin_email」那一行（约第 14 行），
--      把引号里的邮箱改成【你自己注册账号要用的邮箱】。
--   2. 全选复制本文件全部内容。
--   3. 打开 Supabase 控制台 → 左侧「SQL Editor」→ New query →
--      粘贴 → 点「Run」。显示 Success 即完成。
--
--  用这个邮箱注册的账号会自动成为管理员（全站只有这一个）。
--  本脚本可以重复运行，不会破坏已有数据。
-- ================================================================

-- 账号注册时用到的一些站点配置
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);

insert into public.app_config (key, value) values
  ('admin_email', 'admin@example.com')          -- ★★★ 把这个邮箱换成你自己的！★★★
on conflict (key) do update set value = excluded.value;

-- 账号档案表：每个注册用户一行
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  nickname   text,
  is_admin   boolean not null default false,
  banned     boolean not null default false,
  created_at timestamptz not null default now()
);

-- 学习进度表：每个用户一行，data 存整个进度 JSON
create table if not exists public.user_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- 行级安全（RLS）：这是"别人碰不到别人数据、只有你是管理员"的根本保障，
-- 全部在数据库端强制执行，网页代码改不动它。
alter table public.profiles enable row level security;
alter table public.user_data enable row level security;
alter table public.app_config enable row level security;

-- 当前登录者是不是管理员：档案里有标记，或邮箱 = 上面登记的管理员邮箱
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = auth.uid()),
    exists (select 1 from public.app_config c
            where c.key = 'admin_email'
              and lower(c.value) = lower(coalesce(auth.email(), '')))
  );
$$;

-- 普通用户永远不能给自己提权：改 is_admin / banned 必须本来就是管理员
create or replace function public.protect_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.is_admin is distinct from old.is_admin) and not public.is_admin() then
    raise exception '只有管理员能修改管理员标记';
  end if;
  if (new.banned is distinct from old.banned) and not public.is_admin() then
    raise exception '只有管理员能修改禁用标记';
  end if;
  return new;
end $$;

drop trigger if exists trg_protect_profile on public.profiles;
create trigger trg_protect_profile before update on public.profiles
  for each row execute function public.protect_profile();

-- 注册成功时自动建立档案；邮箱 = 登记的管理员邮箱 → 自动成为管理员
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare admin_mail text;
begin
  select value into admin_mail from public.app_config where key = 'admin_email';
  insert into public.profiles (id, email, nickname, is_admin)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'nickname', ''),
             split_part(coalesce(new.email, 'user'), '@', 1)),
    lower(coalesce(admin_mail, '')) = lower(coalesce(new.email, ''))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 保险：万一有人在建表之前就注册了（没有档案行），登录后由前端调用补建
create or replace function public.ensure_my_profile()
returns void language plpgsql security definer set search_path = public as $$
declare admin_mail text;
begin
  if auth.uid() is null then raise exception '未登录'; end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then return; end if;
  select value into admin_mail from public.app_config where key = 'admin_email';
  insert into public.profiles (id, email, nickname, is_admin)
  values (auth.uid(), auth.email(),
          split_part(coalesce(auth.email(), 'user'), '@', 1),
          lower(coalesce(admin_mail, '')) = lower(coalesce(auth.email(), '')));
end $$;

grant execute on function public.ensure_my_profile() to authenticated;

-- ---------------- 行级权限规则 ----------------

-- 档案：本人只能读自己；管理员可以读/改/删所有人
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete
  using (public.is_admin());

-- 学习进度：本人对自己的记录可读可写；管理员可以读所有人（看进度）、
-- 可以删除（重置某人进度）。普通用户之间完全隔离。
drop policy if exists ud_all on public.user_data;
create policy ud_all on public.user_data for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists ud_read_admin on public.user_data;
create policy ud_read_admin on public.user_data for select
  using (public.is_admin());

drop policy if exists ud_delete_admin on public.user_data;
create policy ud_delete_admin on public.user_data for delete
  using (public.is_admin());

-- updated_at 自动维护
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_ud_touch on public.user_data;
create trigger trg_ud_touch before update on public.user_data
  for each row execute function public.touch_updated_at();
