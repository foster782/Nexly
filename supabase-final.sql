
-- ============================================================
-- NEXLY MASTER DATABASE SCRIPT
-- Purpose:
--   Repair and synchronize an existing Nexly Supabase project.
--
-- IMPORTANT:
--   * Does NOT DROP user/profile/message/conversation tables.
--   * Does NOT delete existing rows.
--   * Drops/recreates only Nexly RPC functions and RLS policies
--     so old parameter names / return types cannot conflict.
--   * No Deno / Edge Function is required by this database script.
--
-- Works with the frontend patterns used by the current Nexly build:
--   profiles
--   friend_requests
--   friendships
--   conversations
--   conversation_members
--   messages
--   blocked_users
--   game_invites
--   game_matches
--   notifications
--   call_sessions
--   call_participants
--   call_events
--   contact_aliases
--   message_reactions
--   Storage bucket nexly-media
--
-- Run ONCE in Supabase:
--   SQL Editor -> New query -> paste entire file -> Run
-- ============================================================

begin;

create extension if not exists pgcrypto;

-- ============================================================
-- 0. LEGACY FRIEND REQUEST OBJECT CLEANUP
-- ============================================================
-- The old object may be a UNIQUE CONSTRAINT backed by an index.
-- PostgreSQL requires dropping the constraint, not its index.
-- The statements below are safe if the old objects do not exist.

ALTER TABLE public.friend_requests
  DROP CONSTRAINT IF EXISTS friend_requests_one_direction_unique;

DROP INDEX IF EXISTS public.friend_requests_unique_pair;
DROP INDEX IF EXISTS public.friend_requests_direction_unique;
DROP INDEX IF EXISTS public.friend_requests_sender_receiver_unique;

-- ============================================================
-- 1. PROFILES
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null default '',
  avatar_url text,
  phone text,
  bio text not null default '',
  status text not null default 'offline',
  status_mode text not null default 'auto',
  last_seen timestamptz,
  phone_verified boolean not null default false,
  email_verified_at timestamptz,
  notify_messages boolean not null default true,
  notify_calls boolean not null default true,
  notify_friend_requests boolean not null default true,
  notify_games boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists display_name text not null default '';
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists bio text not null default '';
alter table public.profiles add column if not exists status text not null default 'offline';
alter table public.profiles add column if not exists status_mode text not null default 'auto';
alter table public.profiles add column if not exists last_seen timestamptz;
alter table public.profiles add column if not exists phone_verified boolean not null default false;
alter table public.profiles add column if not exists email_verified_at timestamptz;
alter table public.profiles add column if not exists notify_messages boolean not null default true;
alter table public.profiles add column if not exists notify_calls boolean not null default true;
alter table public.profiles add column if not exists notify_friend_requests boolean not null default true;
alter table public.profiles add column if not exists notify_games boolean not null default true;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

update public.profiles
set status_mode = 'auto'
where status_mode is null
   or status_mode not in ('auto','online','away','dnd','offline');

update public.profiles
set status = 'offline'
where status is null
   or status not in ('online','away','dnd','offline');

update public.profiles
set phone_verified = false
where phone_verified is null;

update public.profiles
set notify_messages = true
where notify_messages is null;

update public.profiles
set notify_calls = true
where notify_calls is null;

update public.profiles
set notify_friend_requests = true
where notify_friend_requests is null;

update public.profiles
set notify_games = true
where notify_games is null;

create index if not exists profiles_username_idx
on public.profiles(lower(username));

create index if not exists profiles_status_idx
on public.profiles(status);

create index if not exists profiles_last_seen_idx
on public.profiles(last_seen desc);

-- ============================================================
-- 2. FRIEND REQUESTS
-- ============================================================

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(sender_id <> receiver_id)
);

alter table public.friend_requests
  add column if not exists status text not null default 'pending';

alter table public.friend_requests
  add column if not exists created_at timestamptz not null default now();

alter table public.friend_requests
  add column if not exists updated_at timestamptz not null default now();

update public.friend_requests
set status = 'pending'
where status is null
   or status not in ('pending','accepted','rejected');

-- Remove duplicate pending requests without touching the oldest request.
with ranked as (
  select
    id,
    row_number() over (
      partition by sender_id, receiver_id
      order by created_at asc, id asc
    ) as rn
  from public.friend_requests
  where status = 'pending'
)
delete from public.friend_requests fr
using ranked r
where fr.id = r.id
  and r.rn > 1;

create unique index if not exists friend_requests_pending_unique
on public.friend_requests(sender_id, receiver_id)
where status = 'pending';

create index if not exists friend_requests_receiver_status_idx
on public.friend_requests(receiver_id, status, created_at desc);

create index if not exists friend_requests_sender_status_idx
on public.friend_requests(sender_id, status, created_at desc);

-- ============================================================
-- 3. FRIENDSHIPS
-- ============================================================

create table if not exists public.friendships (
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id, friend_id),
  check(user_id <> friend_id)
);

create index if not exists friendships_friend_idx
on public.friendships(friend_id, user_id);

-- ============================================================
-- 4. CONTACT ALIASES
-- ============================================================

create table if not exists public.contact_aliases (
  user_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid not null references public.profiles(id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(user_id, contact_id),
  check(user_id <> contact_id)
);

-- ============================================================
-- 5. BLOCKED USERS
-- ============================================================

create table if not exists public.blocked_users (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(blocker_id, blocked_id),
  check(blocker_id <> blocked_id)
);

create index if not exists blocked_users_blocked_idx
on public.blocked_users(blocked_id);

-- ============================================================
-- 6. CONVERSATIONS
-- ============================================================

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'direct',
  title text,
  description text,
  avatar_url text,
  owner_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(type in ('direct','group'))
);

alter table public.conversations add column if not exists type text not null default 'direct';
alter table public.conversations add column if not exists title text;
alter table public.conversations add column if not exists description text;
alter table public.conversations add column if not exists avatar_url text;
alter table public.conversations add column if not exists owner_id uuid references public.profiles(id) on delete set null;
alter table public.conversations add column if not exists created_at timestamptz not null default now();
alter table public.conversations add column if not exists updated_at timestamptz not null default now();

update public.conversations
set type = case
  when lower(coalesce(type,'')) = 'group' then 'group'
  else 'direct'
end
where type is null
   or type not in ('direct','group');

create index if not exists conversations_owner_idx
on public.conversations(owner_id);

create index if not exists conversations_type_idx
on public.conversations(type);

-- ============================================================
-- 7. CONVERSATION MEMBERS
-- ============================================================

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member',
  banned boolean not null default false,
  can_send boolean not null default true,
  unread_count integer not null default 0,
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key(conversation_id, user_id)
);

alter table public.conversation_members add column if not exists role text not null default 'member';
alter table public.conversation_members add column if not exists banned boolean not null default false;
alter table public.conversation_members add column if not exists can_send boolean not null default true;
alter table public.conversation_members add column if not exists unread_count integer not null default 0;
alter table public.conversation_members add column if not exists last_read_at timestamptz;
alter table public.conversation_members add column if not exists joined_at timestamptz not null default now();

update public.conversation_members
set role = 'member'
where role is null
   or role not in ('admin','member');

update public.conversation_members
set banned = false
where banned is null;

update public.conversation_members
set can_send = true
where can_send is null;

update public.conversation_members
set unread_count = 0
where unread_count is null
   or unread_count < 0;

create index if not exists conversation_members_user_idx
on public.conversation_members(user_id, conversation_id);

create index if not exists conversation_members_conversation_idx
on public.conversation_members(conversation_id, user_id);

-- ============================================================
-- 8. MESSAGES
-- ============================================================

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null default '',
  attachments jsonb,
  reply_to uuid references public.messages(id) on delete set null,
  forwarded_from uuid references public.messages(id) on delete set null,
  edited boolean not null default false,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.messages add column if not exists attachments jsonb;
alter table public.messages add column if not exists reply_to uuid references public.messages(id) on delete set null;
alter table public.messages add column if not exists forwarded_from uuid references public.messages(id) on delete set null;
alter table public.messages add column if not exists edited boolean not null default false;
alter table public.messages add column if not exists pinned boolean not null default false;
alter table public.messages add column if not exists updated_at timestamptz not null default now();

create index if not exists messages_conversation_created_idx
on public.messages(conversation_id, created_at);

create index if not exists messages_reply_idx
on public.messages(reply_to);

create index if not exists messages_forwarded_idx
on public.messages(forwarded_from);

create index if not exists messages_pinned_idx
on public.messages(conversation_id, pinned)
where pinned = true;

-- ============================================================
-- 9. MESSAGE REACTIONS
-- ============================================================

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reaction text not null,
  created_at timestamptz not null default now(),
  primary key(message_id, user_id, reaction)
);

-- ============================================================
-- 10. NOTIFICATIONS
-- ============================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  payload jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
on public.notifications(user_id, created_at desc);

create index if not exists notifications_unread_idx
on public.notifications(user_id, read, created_at desc);

-- ============================================================
-- 11. GAMES
-- ============================================================

create table if not exists public.game_invites (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  game text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(sender_id <> receiver_id),
  check(game in ('racing','rps','tictactoe')),
  check(status in ('pending','accepted','rejected','expired'))
);

alter table public.game_invites add column if not exists conversation_id uuid references public.conversations(id) on delete set null;
alter table public.game_invites add column if not exists game text;
alter table public.game_invites add column if not exists status text not null default 'pending';
alter table public.game_invites add column if not exists created_at timestamptz not null default now();
alter table public.game_invites add column if not exists updated_at timestamptz not null default now();

create index if not exists game_invites_receiver_idx
on public.game_invites(receiver_id, status, created_at desc);

create index if not exists game_invites_sender_idx
on public.game_invites(sender_id, created_at desc);

create table if not exists public.game_matches (
  id uuid primary key default gen_random_uuid(),
  match_key text,
  game text not null,
  player1_id uuid not null references public.profiles(id) on delete cascade,
  player2_id uuid not null references public.profiles(id) on delete cascade,
  winner_id uuid references public.profiles(id) on delete set null,
  score1 integer not null default 0,
  score2 integer not null default 0,
  metadata jsonb,
  created_at timestamptz not null default now(),
  check(player1_id <> player2_id),
  check(game in ('racing','rps','tictactoe'))
);

alter table public.game_matches add column if not exists match_key text;
alter table public.game_matches add column if not exists metadata jsonb;
alter table public.game_matches add column if not exists score1 integer not null default 0;
alter table public.game_matches add column if not exists score2 integer not null default 0;

-- IMPORTANT:
-- match_key is deliberately NOT unique because both game clients can
-- finish the same match almost simultaneously. A non-unique index avoids
-- the 409 duplicate-key error that the old schema produced.
drop index if exists public.game_matches_match_key_uidx;

create index if not exists game_matches_match_key_idx
on public.game_matches(match_key)
where match_key is not null;

create index if not exists game_matches_player1_idx
on public.game_matches(player1_id, created_at desc);

create index if not exists game_matches_player2_idx
on public.game_matches(player2_id, created_at desc);

-- ============================================================
-- 12. PERSISTENT CALLS
-- ============================================================

create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  caller_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'audio',
  status text not null default 'ringing',
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz not null default (now() + interval '15 seconds'),
  check(kind in ('audio','video')),
  check(status in ('ringing','active','ended','rejected','missed'))
);

alter table public.call_sessions add column if not exists conversation_id uuid references public.conversations(id) on delete cascade;
alter table public.call_sessions add column if not exists caller_id uuid references public.profiles(id) on delete cascade;
alter table public.call_sessions add column if not exists kind text not null default 'audio';
alter table public.call_sessions add column if not exists status text not null default 'ringing';
alter table public.call_sessions add column if not exists created_at timestamptz not null default now();
alter table public.call_sessions add column if not exists answered_at timestamptz;
alter table public.call_sessions add column if not exists ended_at timestamptz;
alter table public.call_sessions add column if not exists expires_at timestamptz not null default (now() + interval '15 seconds');

create index if not exists call_sessions_conversation_idx
on public.call_sessions(conversation_id, created_at desc);

create index if not exists call_sessions_status_expiry_idx
on public.call_sessions(status, expires_at);

create table if not exists public.call_participants (
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'invited',
  joined_at timestamptz,
  left_at timestamptz,
  primary key(call_id, user_id)
);

alter table public.call_participants add column if not exists status text not null default 'invited';
alter table public.call_participants add column if not exists joined_at timestamptz;
alter table public.call_participants add column if not exists left_at timestamptz;

create index if not exists call_participants_user_idx
on public.call_participants(user_id, status);

create table if not exists public.call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists call_events_call_created_idx
on public.call_events(call_id, created_at);

-- ============================================================
-- 13. USERNAME PROFILE REPAIR
-- ============================================================
-- Existing auth users are repaired only if they are missing profiles.
-- Duplicate usernames are avoided by suffixing _2, _3, etc.
-- No existing profile username is overwritten.

do $$
declare
  u record;
  base_name text;
  candidate text;
  suffix_no integer;
begin
  for u in
    select
      au.id,
      au.email,
      au.raw_user_meta_data
    from auth.users au
    left join public.profiles p
      on p.id = au.id
    where p.id is null
  loop
    base_name := lower(
      regexp_replace(
        coalesce(
          nullif(u.raw_user_meta_data->>'username',''),
          split_part(coalesce(u.email,''),'@',1),
          'user'
        ),
        '[^a-zA-Z0-9_.-]',
        '',
        'g'
      )
    );

    if length(base_name) < 3 then
      base_name := 'user_' || left(u.id::text,8);
    end if;

    base_name := left(base_name, 20);
    candidate := base_name;
    suffix_no := 1;

    while exists(
      select 1 from public.profiles p2
      where lower(p2.username)=lower(candidate)
    )
    loop
      suffix_no := suffix_no + 1;
      candidate := left(base_name, 24 - length('_' || suffix_no::text))
                   || '_' || suffix_no::text;
    end loop;

    insert into public.profiles(
      id,
      username,
      display_name,
      phone,
      bio,
      email_verified_at
    )
    values(
      u.id,
      candidate,
      coalesce(
        nullif(u.raw_user_meta_data->>'display_name',''),
        candidate
      ),
      nullif(u.raw_user_meta_data->>'phone',''),
      coalesce(
        nullif(u.raw_user_meta_data->>'bio',''),
        ''
      ),
      null
    )
    on conflict (id) do nothing;
  end loop;
end;
$$;

-- ============================================================
-- 14. DROP ALL NEXLY RPC FUNCTIONS FIRST
-- ============================================================
-- This prevents:
--   42P13 cannot change name of input parameter
--   42P13 cannot change return type
-- Existing table data is untouched.

drop function if exists public.is_conversation_member(uuid) cascade;
drop function if exists public.is_member(uuid) cascade;
drop function if exists public.is_admin(uuid) cascade;
drop function if exists public.is_blocked_by_me(uuid) cascade;
drop function if exists public.is_blocked_between(uuid) cascade;
drop function if exists public.block_user(uuid) cascade;
drop function if exists public.unblock_user(uuid) cascade;
drop function if exists public.create_direct_conversation(uuid) cascade;
drop function if exists public.create_group(text,text,uuid[]) cascade;
drop function if exists public.add_group_members(uuid,uuid[]) cascade;
drop function if exists public.remove_group_member(uuid,uuid) cascade;
drop function if exists public.set_group_member_role(uuid,uuid,text) cascade;
drop function if exists public.set_group_member_ban(uuid,uuid,boolean) cascade;
drop function if exists public.set_group_member_can_send(uuid,uuid,boolean) cascade;
drop function if exists public.set_group_member_permissions(boolean,boolean,uuid,text,uuid) cascade;
drop function if exists public.leave_group(uuid) cascade;
drop function if exists public.delete_group(uuid) cascade;
drop function if exists public.send_friend_request(uuid) cascade;
drop function if exists public.accept_friend_request(uuid) cascade;
drop function if exists public.reject_friend_request(uuid) cascade;
drop function if exists public.mark_conversation_read(uuid) cascade;
drop function if exists public.increment_unread_counts(uuid,uuid) cascade;
drop function if exists public.pin_message(uuid,boolean) cascade;
drop function if exists public.forward_message(uuid,uuid) cascade;
drop function if exists public.create_user_notification(uuid,text,text,text,jsonb) cascade;
drop function if exists public.set_presence_mode(text) cascade;
drop function if exists public.heartbeat_presence() cascade;
drop function if exists public.set_notification_preferences(boolean,boolean,boolean,boolean) cascade;
drop function if exists public.start_game_invite(uuid,text) cascade;
drop function if exists public.respond_game_invite(uuid,text) cascade;
drop function if exists public.record_game_match(text,text,uuid,uuid,uuid,integer,integer,jsonb) cascade;
drop function if exists public.is_call_participant(uuid) cascade;
drop function if exists public.start_call(uuid,text) cascade;
drop function if exists public.answer_call(uuid) cascade;
drop function if exists public.reject_call(uuid) cascade;
drop function if exists public.end_call(uuid) cascade;
drop function if exists public.expire_calls(timestamptz) cascade;
drop function if exists public.send_call_event(uuid,text,jsonb) cascade;
drop function if exists public.set_contact_alias(uuid,text) cascade;
drop function if exists public.remove_contact_alias(uuid) cascade;

-- ============================================================
-- 15. MEMBERSHIP FUNCTIONS
-- ============================================================

create function public.is_conversation_member(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from public.conversation_members cm
    where cm.conversation_id = cid
      and cm.user_id = auth.uid()
      and cm.banned = false
  );
$$;

create function public.is_member(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from public.conversation_members cm
    where cm.conversation_id = cid
      and cm.user_id = auth.uid()
      and cm.banned = false
  );
$$;

create function public.is_admin(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from public.conversation_members cm
    where cm.conversation_id = cid
      and cm.user_id = auth.uid()
      and cm.role = 'admin'
      and cm.banned = false
  );
$$;

-- ============================================================
-- 16. BLOCK FUNCTIONS
-- ============================================================
-- NOTE: Parameter name is deliberately target_user_id because
-- Supabase RPC uses the parameter name when the frontend sends
-- { target_user_id: ... }.

create function public.is_blocked_by_me(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from public.blocked_users b
    where b.blocker_id = auth.uid()
      and b.blocked_id = target_user_id
  );
$$;

create function public.is_blocked_between(other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from public.blocked_users b
    where (b.blocker_id = auth.uid() and b.blocked_id = other_user_id)
       or (b.blocker_id = other_user_id and b.blocked_id = auth.uid())
  );
$$;

create function public.block_user(target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if target_user_id is null or target_user_id = auth.uid() then
    raise exception 'Invalid target user';
  end if;

  if not exists(
    select 1
    from public.profiles p
    where p.id = target_user_id
  ) then
    raise exception 'User not found';
  end if;

  insert into public.blocked_users(blocker_id,blocked_id)
  values(auth.uid(),target_user_id)
  on conflict do nothing;

  delete from public.friend_requests
  where (sender_id = auth.uid() and receiver_id = target_user_id)
     or (sender_id = target_user_id and receiver_id = auth.uid());

  delete from public.friendships
  where (user_id = auth.uid() and friend_id = target_user_id)
     or (user_id = target_user_id and friend_id = auth.uid());

  return true;
end;
$$;

create function public.unblock_user(target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.blocked_users
  where blocker_id = auth.uid()
    and blocked_id = target_user_id;

  return found;
end;
$$;

-- ============================================================
-- 17. DIRECT CHAT
-- ============================================================

create function public.create_direct_conversation(target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if target_user_id is null or target_user_id = auth.uid() then
    raise exception 'Invalid target user';
  end if;

  if public.is_blocked_between(target_user_id) then
    raise exception 'User interaction is blocked';
  end if;

  select cm1.conversation_id
  into v_conversation_id
  from public.conversation_members cm1
  join public.conversation_members cm2
    on cm2.conversation_id = cm1.conversation_id
  join public.conversations c
    on c.id = cm1.conversation_id
  where cm1.user_id = auth.uid()
    and cm2.user_id = target_user_id
    and cm1.banned = false
    and cm2.banned = false
    and c.type = 'direct'
  limit 1;

  if v_conversation_id is null then
    insert into public.conversations(
      type,
      owner_id
    )
    values(
      'direct',
      auth.uid()
    )
    returning id into v_conversation_id;

    insert into public.conversation_members(
      conversation_id,
      user_id,
      role,
      banned,
      can_send,
      unread_count
    )
    values
      (v_conversation_id,auth.uid(),'member',false,true,0),
      (v_conversation_id,target_user_id,'member',false,true,0);
  end if;

  return v_conversation_id;
end;
$$;

-- ============================================================
-- 18. GROUP FUNCTIONS
-- ============================================================

create function public.create_group(
  p_title text,
  p_description text default null,
  p_member_ids uuid[] default '{}'::uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_user_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if length(trim(coalesce(p_title,''))) = 0 then
    raise exception 'Group title is required';
  end if;

  insert into public.conversations(
    type,
    title,
    description,
    owner_id
  )
  values(
    'group',
    trim(p_title),
    nullif(trim(p_description),''),
    auth.uid()
  )
  returning id into v_conversation_id;

  insert into public.conversation_members(
    conversation_id,
    user_id,
    role,
    banned,
    can_send,
    unread_count
  )
  values(
    v_conversation_id,
    auth.uid(),
    'admin',
    false,
    true,
    0
  );

  foreach v_user_id in array coalesce(p_member_ids,'{}'::uuid[]) loop
    if v_user_id <> auth.uid()
       and exists(
         select 1 from public.profiles p where p.id = v_user_id
       )
    then
      insert into public.conversation_members(
        conversation_id,
        user_id,
        role,
        banned,
        can_send,
        unread_count
      )
      values(
        v_conversation_id,
        v_user_id,
        'member',
        false,
        true,
        0
      )
      on conflict do nothing;
    end if;
  end loop;

  return v_conversation_id;
end;
$$;

create function public.add_group_members(
  p_conversation_id uuid,
  p_member_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_added integer := 0;
begin
  if not public.is_admin(p_conversation_id) then
    raise exception 'Only administrators can add members';
  end if;

  foreach v_user_id in array coalesce(p_member_ids,'{}'::uuid[]) loop
    if v_user_id <> auth.uid()
       and exists(select 1 from public.profiles p where p.id=v_user_id)
    then
      insert into public.conversation_members(
        conversation_id,user_id,role,banned,can_send,unread_count
      )
      values(
        p_conversation_id,v_user_id,'member',false,true,0
      )
      on conflict do nothing;

      if found then
        v_added := v_added + 1;
      end if;
    end if;
  end loop;

  return v_added;
end;
$$;

create function public.remove_group_member(
  p_conversation_id uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select owner_id
  into v_owner
  from public.conversations
  where id=p_conversation_id
    and type='group';

  if not public.is_admin(p_conversation_id) then
    raise exception 'Only administrators can remove members';
  end if;

  if p_user_id=v_owner then
    raise exception 'The group owner cannot be removed';
  end if;

  delete from public.conversation_members
  where conversation_id=p_conversation_id
    and user_id=p_user_id;

  return found;
end;
$$;

create function public.set_group_member_role(
  p_conversation_id uuid,
  p_user_id uuid,
  p_role text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select owner_id
  into v_owner
  from public.conversations
  where id=p_conversation_id
    and type='group';

  if not public.is_admin(p_conversation_id) then
    raise exception 'Only administrators can change roles';
  end if;

  if p_role not in ('admin','member') then
    raise exception 'Invalid role';
  end if;

  if p_user_id=v_owner and p_role='member' then
    raise exception 'The group owner cannot lose ownership';
  end if;

  update public.conversation_members
  set role=p_role
  where conversation_id=p_conversation_id
    and user_id=p_user_id;

  return found;
end;
$$;

create function public.set_group_member_ban(
  p_conversation_id uuid,
  p_user_id uuid,
  p_banned boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select owner_id
  into v_owner
  from public.conversations
  where id=p_conversation_id
    and type='group';

  if not public.is_admin(p_conversation_id) then
    raise exception 'Only administrators can ban members';
  end if;

  if p_user_id=v_owner and p_banned then
    raise exception 'The group owner cannot be banned';
  end if;

  update public.conversation_members
  set banned=p_banned
  where conversation_id=p_conversation_id
    and user_id=p_user_id;

  return found;
end;
$$;

create function public.set_group_member_can_send(
  p_conversation_id uuid,
  p_user_id uuid,
  p_can_send boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_conversation_id) then
    raise exception 'Only administrators can change send permissions';
  end if;

  update public.conversation_members
  set can_send=p_can_send
  where conversation_id=p_conversation_id
    and user_id=p_user_id;

  return found;
end;
$$;

-- EXACT RPC SHAPE REQUESTED BY THE FRONTEND:
-- set_group_member_permissions({
--   p_banned,
--   p_can_send,
--   p_conversation_id,
--   p_role,
--   p_user_id
-- })

create function public.set_group_member_permissions(
  p_banned boolean,
  p_can_send boolean,
  p_conversation_id uuid,
  p_role text,
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select owner_id
  into v_owner
  from public.conversations
  where id=p_conversation_id
    and type='group';

  if not public.is_admin(p_conversation_id) then
    raise exception 'Only administrators can edit group members';
  end if;

  if p_role not in ('admin','member') then
    raise exception 'Invalid role';
  end if;

  if p_user_id=v_owner and p_banned then
    raise exception 'The group owner cannot be banned';
  end if;

  if p_user_id=v_owner and p_role='member' then
    raise exception 'The group owner cannot lose admin role';
  end if;

  update public.conversation_members
  set role=p_role,
      banned=coalesce(p_banned,false),
      can_send=coalesce(p_can_send,true)
  where conversation_id=p_conversation_id
    and user_id=p_user_id;

  return found;
end;
$$;

create function public.leave_group(
  p_conversation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select owner_id
  into v_owner
  from public.conversations
  where id=p_conversation_id
    and type='group';

  if v_owner=auth.uid() then
    raise exception 'The group owner cannot leave. Delete the group instead.';
  end if;

  delete from public.conversation_members
  where conversation_id=p_conversation_id
    and user_id=auth.uid();

  return found;
end;
$$;

create function public.delete_group(
  p_conversation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select owner_id
  into v_owner
  from public.conversations
  where id=p_conversation_id
    and type='group';

  if v_owner is null or v_owner<>auth.uid() then
    raise exception 'Only the group owner can delete the group';
  end if;

  delete from public.conversations
  where id=p_conversation_id
    and type='group';

  return found;
end;
$$;

-- ============================================================
-- 19. FRIEND REQUEST FUNCTIONS
-- ============================================================

create function public.send_friend_request(
  p_receiver_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid()=p_receiver_id then
    raise exception 'Cannot add yourself';
  end if;

  if not exists(
    select 1 from public.profiles where id=p_receiver_id
  ) then
    raise exception 'User not found';
  end if;

  if public.is_blocked_between(p_receiver_id) then
    raise exception 'User interaction is blocked';
  end if;

  if exists(
    select 1
    from public.friendships f
    where f.user_id=auth.uid()
      and f.friend_id=p_receiver_id
  ) then
    raise exception 'Already friends';
  end if;

  insert into public.friend_requests(
    sender_id,
    receiver_id,
    status
  )
  values(
    auth.uid(),
    p_receiver_id,
    'pending'
  )
  on conflict(sender_id,receiver_id)
  where status='pending'
  do update set updated_at=now()
  returning id into v_id;

  return v_id;
end;
$$;

create function public.accept_friend_request(
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender uuid;
  v_conversation_id uuid;
begin
  select sender_id
  into v_sender
  from public.friend_requests
  where id=p_request_id
    and receiver_id=auth.uid()
    and status='pending';

  if v_sender is null then
    raise exception 'Friend request not found';
  end if;

  if public.is_blocked_between(v_sender) then
    raise exception 'User interaction is blocked';
  end if;

  update public.friend_requests
  set status='accepted',
      updated_at=now()
  where id=p_request_id;

  insert into public.friendships(user_id,friend_id)
  values
    (auth.uid(),v_sender),
    (v_sender,auth.uid())
  on conflict do nothing;

  v_conversation_id:=public.create_direct_conversation(v_sender);

  return v_conversation_id;
end;
$$;

create function public.reject_friend_request(
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.friend_requests
  set status='rejected',
      updated_at=now()
  where id=p_request_id
    and receiver_id=auth.uid()
    and status='pending';

  return found;
end;
$$;

-- ============================================================
-- 20. UNREAD COUNT FUNCTIONS
-- ============================================================

create function public.mark_conversation_read(
  p_conversation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversation_members
  set unread_count=0,
      last_read_at=now()
  where conversation_id=p_conversation_id
    and user_id=auth.uid();

  return found;
end;
$$;

create function public.increment_unread_counts(
  p_conversation_id uuid,
  p_sender_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  update public.conversation_members
  set unread_count=coalesce(unread_count,0)+1
  where conversation_id=p_conversation_id
    and user_id<>p_sender_id
    and banned=false;

  get diagnostics v_count=row_count;

  return v_count;
end;
$$;

-- ============================================================
-- 21. MESSAGE HELPERS
-- ============================================================

create function public.pin_message(
  p_message_id uuid,
  p_pinned boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
begin
  select conversation_id
  into v_conversation_id
  from public.messages
  where id=p_message_id;

  if v_conversation_id is null then
    raise exception 'Message not found';
  end if;

  if not public.is_member(v_conversation_id) then
    raise exception 'Not a conversation member';
  end if;

  update public.messages
  set pinned=coalesce(p_pinned,true),
      updated_at=now()
  where id=p_message_id;

  return found;
end;
$$;

create function public.forward_message(
  p_message_id uuid,
  p_target_conversation_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.messages%rowtype;
  v_new_id uuid;
  v_attachment jsonb;
begin
  select *
  into v_source
  from public.messages
  where id=p_message_id;

  if v_source.id is null then
    raise exception 'Message not found';
  end if;

  if not public.is_member(v_source.conversation_id) then
    raise exception 'Source conversation access denied';
  end if;

  if not public.is_member(p_target_conversation_id) then
    raise exception 'Target conversation access denied';
  end if;

  if p_target_conversation_id=v_source.conversation_id then
    -- Self-forward inside same conversation is allowed.
    null;
  end if;

  insert into public.messages(
    conversation_id,
    sender_id,
    content,
    attachments,
    forwarded_from
  )
  values(
    p_target_conversation_id,
    auth.uid(),
    coalesce(v_source.content,''),
    v_source.attachments,
    v_source.id
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ============================================================
-- 22. NOTIFICATION FUNCTION
-- ============================================================

create function public.create_user_notification(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_body text default null,
  p_payload jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notifications(
    user_id,type,title,body,payload
  )
  values(
    p_user_id,p_type,p_title,p_body,p_payload
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================
-- 23. PRESENCE
-- ============================================================

create function public.set_presence_mode(
  p_status_mode text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_status_mode not in ('auto','online','away','dnd','offline') then
    raise exception 'Invalid status mode';
  end if;

  v_status:=case
    when p_status_mode='auto' then 'online'
    when p_status_mode='online' then 'online'
    when p_status_mode='away' then 'away'
    when p_status_mode='dnd' then 'dnd'
    when p_status_mode='offline' then 'offline'
  end;

  update public.profiles
  set status_mode=p_status_mode,
      status=v_status,
      last_seen=now(),
      updated_at=now()
  where id=auth.uid();

  return found;
end;
$$;

create function public.heartbeat_presence()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set status=case
      when status_mode='auto' then 'online'
      else status_mode
    end,
    last_seen=now(),
    updated_at=now()
  where id=auth.uid();

  return found;
end;
$$;

create function public.set_notification_preferences(
  p_messages boolean default true,
  p_calls boolean default true,
  p_friend_requests boolean default true,
  p_games boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set notify_messages=coalesce(p_messages,true),
      notify_calls=coalesce(p_calls,true),
      notify_friend_requests=coalesce(p_friend_requests,true),
      notify_games=coalesce(p_games,true),
      updated_at=now()
  where id=auth.uid();

  return found;
end;
$$;

-- ============================================================
-- 24. CONTACT ALIASES
-- ============================================================

create function public.set_contact_alias(
  p_contact_id uuid,
  p_alias text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_contact_id=auth.uid() then
    raise exception 'Cannot rename yourself';
  end if;

  if not exists(
    select 1 from public.profiles where id=p_contact_id
  ) then
    raise exception 'Contact not found';
  end if;

  if length(trim(coalesce(p_alias,'')))=0 then
    delete from public.contact_aliases
    where user_id=auth.uid()
      and contact_id=p_contact_id;
    return true;
  end if;

  insert into public.contact_aliases(
    user_id,
    contact_id,
    alias,
    updated_at
  )
  values(
    auth.uid(),
    p_contact_id,
    trim(p_alias),
    now()
  )
  on conflict(user_id,contact_id)
  do update set
    alias=excluded.alias,
    updated_at=now();

  return true;
end;
$$;

create function public.remove_contact_alias(
  p_contact_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.contact_aliases
  where user_id=auth.uid()
    and contact_id=p_contact_id;

  return found;
end;
$$;

-- ============================================================
-- 25. GAMES
-- ============================================================

create function public.start_game_invite(
  p_receiver_id uuid,
  p_game text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_id uuid;
begin
  if p_receiver_id=auth.uid() then
    raise exception 'Cannot play with yourself';
  end if;

  if p_game not in ('racing','rps','tictactoe') then
    raise exception 'Invalid game';
  end if;

  if public.is_blocked_between(p_receiver_id) then
    raise exception 'Game unavailable: user is blocked';
  end if;

  select cm1.conversation_id
  into v_conversation_id
  from public.conversation_members cm1
  join public.conversation_members cm2
    on cm2.conversation_id=cm1.conversation_id
  join public.conversations c
    on c.id=cm1.conversation_id
  where cm1.user_id=auth.uid()
    and cm2.user_id=p_receiver_id
    and cm1.banned=false
    and cm2.banned=false
    and c.type='direct'
  limit 1;

  if v_conversation_id is null then
    raise exception 'A direct chat with this user is required';
  end if;

  insert into public.game_invites(
    sender_id,
    receiver_id,
    conversation_id,
    game,
    status
  )
  values(
    auth.uid(),
    p_receiver_id,
    v_conversation_id,
    p_game,
    'pending'
  )
  returning id into v_id;

  return v_id;
end;
$$;

create function public.respond_game_invite(
  p_invite_id uuid,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('accepted','rejected','expired') then
    raise exception 'Invalid game invite status';
  end if;

  update public.game_invites
  set status=p_status,
      updated_at=now()
  where id=p_invite_id
    and receiver_id=auth.uid()
    and status='pending';

  return found;
end;
$$;

create function public.record_game_match(
  p_match_key text,
  p_game text,
  p_player1_id uuid,
  p_player2_id uuid,
  p_winner_id uuid default null,
  p_score1 integer default 0,
  p_score2 integer default 0,
  p_metadata jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid()<>p_player1_id
     and auth.uid()<>p_player2_id then
    raise exception 'You are not a participant';
  end if;

  if p_game not in ('racing','rps','tictactoe') then
    raise exception 'Invalid game';
  end if;

  select id
  into v_id
  from public.game_matches
  where match_key=p_match_key
  order by created_at desc
  limit 1;

  if v_id is not null then
    update public.game_matches
    set winner_id=p_winner_id,
        score1=coalesce(p_score1,0),
        score2=coalesce(p_score2,0),
        metadata=p_metadata
    where id=v_id;

    return v_id;
  end if;

  insert into public.game_matches(
    match_key,
    game,
    player1_id,
    player2_id,
    winner_id,
    score1,
    score2,
    metadata
  )
  values(
    p_match_key,
    p_game,
    p_player1_id,
    p_player2_id,
    p_winner_id,
    coalesce(p_score1,0),
    coalesce(p_score2,0),
    p_metadata
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================
-- 26. CALLS
-- ============================================================

create function public.is_call_participant(
  p_call_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from public.call_participants cp
    where cp.call_id=p_call_id
      and cp.user_id=auth.uid()
  );
$$;

create function public.start_call(
  p_conversation_id uuid,
  p_kind text default 'audio'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call_id uuid;
  v_type text;
  v_count integer;
  v_member record;
begin
  if p_kind not in ('audio','video') then
    raise exception 'Invalid call kind';
  end if;

  if not public.is_member(p_conversation_id) then
    raise exception 'Not a conversation member';
  end if;

  select type
  into v_type
  from public.conversations
  where id=p_conversation_id;

  if v_type is null then
    raise exception 'Conversation not found';
  end if;

  select count(*)
  into v_count
  from public.conversation_members
  where conversation_id=p_conversation_id
    and banned=false;

  if v_count>6 then
    raise exception 'Maximum 6 call participants';
  end if;

  if v_type='direct' then
    for v_member in
      select cm.user_id,p.status
      from public.conversation_members cm
      join public.profiles p on p.id=cm.user_id
      where cm.conversation_id=p_conversation_id
        and cm.user_id<>auth.uid()
        and cm.banned=false
    loop
      if public.is_blocked_between(v_member.user_id) then
        raise exception 'Calls are blocked with this user';
      end if;

      if v_member.status='dnd' then
        raise exception 'The other user is in Do Not Disturb mode';
      end if;
    end loop;
  end if;

  insert into public.call_sessions(
    conversation_id,
    caller_id,
    kind,
    status,
    expires_at
  )
  values(
    p_conversation_id,
    auth.uid(),
    p_kind,
    'ringing',
    now()+interval '15 seconds'
  )
  returning id into v_call_id;

  insert into public.call_participants(
    call_id,
    user_id,
    status,
    joined_at
  )
  values(
    v_call_id,
    auth.uid(),
    'connected',
    now()
  );

  for v_member in
    select cm.user_id,p.status
    from public.conversation_members cm
    join public.profiles p on p.id=cm.user_id
    where cm.conversation_id=p_conversation_id
      and cm.user_id<>auth.uid()
      and cm.banned=false
  loop
    if v_member.status<>'dnd'
       and not public.is_blocked_between(v_member.user_id)
    then
      insert into public.call_participants(
        call_id,
        user_id,
        status
      )
      values(
        v_call_id,
        v_member.user_id,
        'invited'
      )
      on conflict(call_id,user_id) do nothing;
    end if;
  end loop;

  if not exists(
    select 1
    from public.call_participants
    where call_id=v_call_id
      and user_id<>auth.uid()
      and status='invited'
  ) then
    update public.call_sessions
    set status='ended',
        ended_at=now()
    where id=v_call_id;

    raise exception 'No available participants';
  end if;

  return v_call_id;
end;
$$;

create function public.answer_call(
  p_call_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if not public.is_call_participant(p_call_id) then
    raise exception 'Not a call participant';
  end if;

  select status
  into v_status
  from public.call_sessions
  where id=p_call_id;

  if v_status not in ('ringing','active') then
    return false;
  end if;

  if now() >
     (select expires_at from public.call_sessions where id=p_call_id)
  then
    update public.call_sessions
    set status='missed',
        ended_at=now()
    where id=p_call_id
      and status='ringing';

    update public.call_participants
    set status='missed',
        left_at=now()
    where call_id=p_call_id
      and status='invited';

    return false;
  end if;

  update public.call_participants
  set status='connected',
      joined_at=coalesce(joined_at,now())
  where call_id=p_call_id
    and user_id=auth.uid();

  update public.call_sessions
  set status='active',
      answered_at=coalesce(answered_at,now())
  where id=p_call_id;

  return true;
end;
$$;

create function public.reject_call(
  p_call_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remaining integer;
begin
  if not public.is_call_participant(p_call_id) then
    raise exception 'Not a call participant';
  end if;

  update public.call_participants
  set status='rejected',
      left_at=now()
  where call_id=p_call_id
    and user_id=auth.uid();

  select count(*)
  into v_remaining
  from public.call_participants
  where call_id=p_call_id
    and status in ('invited','connected');

  if v_remaining<=1 then
    update public.call_sessions
    set status='ended',
        ended_at=now()
    where id=p_call_id
      and status in ('ringing','active');
  end if;

  return true;
end;
$$;

create function public.end_call(
  p_call_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_call_participant(p_call_id) then
    raise exception 'Not a call participant';
  end if;

  update public.call_participants
  set status='left',
      left_at=now()
  where call_id=p_call_id
    and user_id=auth.uid()
    and status not in ('left','rejected','missed');

  if exists(
    select 1
    from public.call_sessions
    where id=p_call_id
      and caller_id=auth.uid()
  ) then
    update public.call_sessions
    set status='ended',
        ended_at=now()
    where id=p_call_id;
  else
    update public.call_sessions
    set status='ended',
        ended_at=now()
    where id=p_call_id
      and not exists(
        select 1
        from public.call_participants cp
        where cp.call_id=p_call_id
          and cp.status in ('invited','connected')
      );
  end if;

  return true;
end;
$$;

create function public.expire_calls(
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.call_participants cp
  set status='missed',
      left_at=p_now
  from public.call_sessions cs
  where cp.call_id=cs.id
    and cs.status='ringing'
    and cs.expires_at<=p_now
    and cp.status='invited';

  update public.call_sessions
  set status='missed',
      ended_at=p_now
  where status='ringing'
    and expires_at<=p_now;

  get diagnostics v_count=row_count;

  return v_count;
end;
$$;

create function public.send_call_event(
  p_call_id uuid,
  p_event_type text,
  p_payload jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_call_participant(p_call_id) then
    raise exception 'Not a call participant';
  end if;

  insert into public.call_events(
    call_id,
    sender_id,
    event_type,
    payload
  )
  values(
    p_call_id,
    auth.uid(),
    p_event_type,
    p_payload
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================
-- 27. AUTH PROFILE TRIGGER
-- ============================================================

drop function if exists public.handle_new_user() cascade;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_name text;
  candidate text;
  suffix_no integer := 1;
begin
  base_name := lower(
    regexp_replace(
      coalesce(
        nullif(new.raw_user_meta_data->>'username',''),
        split_part(coalesce(new.email,''),'@',1),
        'user'
      ),
      '[^a-zA-Z0-9_.-]',
      '',
      'g'
    )
  );

  if length(base_name)<3 then
    base_name:='user_' || left(new.id::text,8);
  end if;

  base_name:=left(base_name,20);
  candidate:=base_name;

  while exists(
    select 1
    from public.profiles p
    where lower(p.username)=lower(candidate)
      and p.id<>new.id
  )
  loop
    suffix_no:=suffix_no+1;
    candidate:=left(
      base_name,
      24-length('_'||suffix_no::text)
    ) || '_' || suffix_no::text;
  end loop;

  insert into public.profiles(
    id,
    username,
    display_name,
    phone,
    bio,
    email_verified_at
  )
  values(
    new.id,
    candidate,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name',''),
      candidate
    ),
    nullif(new.raw_user_meta_data->>'phone',''),
    coalesce(
      nullif(new.raw_user_meta_data->>'bio',''),
      ''
    ),
    null
  )
  on conflict(id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

-- ============================================================
-- 28. UNREAD MESSAGE TRIGGER
-- ============================================================
-- Entering a conversation can call mark_conversation_read().
-- New messages increase unread_count for other members automatically.

create or replace function public.nexly_increment_unread_after_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversation_members
  set unread_count=coalesce(unread_count,0)+1
  where conversation_id=new.conversation_id
    and user_id<>new.sender_id
    and banned=false;

  update public.conversations
  set updated_at=now()
  where id=new.conversation_id;

  return new;
end;
$$;

drop trigger if exists trigger_nexly_increment_unread_after_message
on public.messages;

create trigger trigger_nexly_increment_unread_after_message
after insert on public.messages
for each row
execute function public.nexly_increment_unread_after_message();

-- ============================================================
-- FRIEND REQUEST DIRECT-REST DUPLICATE GUARD
-- ============================================================
-- Frontends can retry a direct INSERT into friend_requests.
-- Ignore an already-pending request in either direction so a stale
-- legacy client does not surface PostgreSQL 23505 / HTTP 409.

create or replace function public.nexly_ignore_duplicate_friend_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_key bigint;
begin
  v_lock_key := hashtextextended(
    least(new.sender_id::text, new.receiver_id::text) || ':' ||
    greatest(new.sender_id::text, new.receiver_id::text),
    0
  );

  perform pg_advisory_xact_lock(v_lock_key);

  if exists (
    select 1
    from public.friend_requests fr
    where fr.status = 'pending'
      and (
        (fr.sender_id = new.sender_id and fr.receiver_id = new.receiver_id)
        or
        (fr.sender_id = new.receiver_id and fr.receiver_id = new.sender_id)
      )
  ) then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists trigger_nexly_ignore_duplicate_friend_request
on public.friend_requests;

create trigger trigger_nexly_ignore_duplicate_friend_request
before insert on public.friend_requests
for each row
execute function public.nexly_ignore_duplicate_friend_request();

-- ============================================================
-- 29. GAME / FRIEND / MESSAGE NOTIFICATION TRIGGERS
-- ============================================================

create or replace function public.nexly_notify_friend_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender_name text;
  v_enabled boolean;
begin
  select
    coalesce(nullif(display_name,''),username)
  into v_sender_name
  from public.profiles
  where id=new.sender_id;

  select notify_friend_requests
  into v_enabled
  from public.profiles
  where id=new.receiver_id;

  if coalesce(v_enabled,false) then
    perform public.create_user_notification(
      new.receiver_id,
      'friend_request',
      'Новая заявка в друзья',
      coalesce(v_sender_name,'Пользователь') || ' отправил заявку в друзья',
      jsonb_build_object(
        'request_id',new.id,
        'sender_id',new.sender_id
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trigger_nexly_notify_friend_request
on public.friend_requests;

create trigger trigger_nexly_notify_friend_request
after insert on public.friend_requests
for each row
execute function public.nexly_notify_friend_request();

create or replace function public.nexly_notify_game_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender_name text;
  v_enabled boolean;
begin
  select
    coalesce(nullif(display_name,''),username)
  into v_sender_name
  from public.profiles
  where id=new.sender_id;

  select notify_games
  into v_enabled
  from public.profiles
  where id=new.receiver_id;

  if coalesce(v_enabled,false) then
    perform public.create_user_notification(
      new.receiver_id,
      'game_invite',
      'Приглашение в игру',
      coalesce(v_sender_name,'Пользователь') ||
        ' приглашает вас сыграть в ' || new.game,
      jsonb_build_object(
        'invite_id',new.id,
        'sender_id',new.sender_id,
        'game',new.game,
        'conversation_id',new.conversation_id
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trigger_nexly_notify_game_invite
on public.game_invites;

create trigger trigger_nexly_notify_game_invite
after insert on public.game_invites
for each row
execute function public.nexly_notify_game_invite();

create or replace function public.nexly_notify_call_participant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_caller_name text;
  v_notify boolean;
  v_kind text;
begin
  select caller_id,kind
  into v_caller,v_kind
  from public.call_sessions
  where id=new.call_id;

  if v_caller is null or v_caller=new.user_id then
    return new;
  end if;

  select
    coalesce(nullif(display_name,''),username)
  into v_caller_name
  from public.profiles
  where id=v_caller;

  select notify_calls
  into v_notify
  from public.profiles
  where id=new.user_id;

  if coalesce(v_notify,false) and new.status='invited' then
    perform public.create_user_notification(
      new.user_id,
      'incoming_call',
      case
        when v_kind='video' then 'Входящий видеозвонок'
        else 'Входящий звонок'
      end,
      coalesce(v_caller_name,'Пользователь') || ' звонит вам',
      jsonb_build_object(
        'call_id',new.call_id,
        'caller_id',v_caller,
        'kind',v_kind
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trigger_nexly_notify_call_participant
on public.call_participants;

create trigger trigger_nexly_notify_call_participant
after insert on public.call_participants
for each row
execute function public.nexly_notify_call_participant();

-- ============================================================
-- 30. RLS ENABLE
-- ============================================================

alter table public.profiles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.contact_aliases enable row level security;
alter table public.blocked_users enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.notifications enable row level security;
alter table public.game_invites enable row level security;
alter table public.game_matches enable row level security;
alter table public.call_sessions enable row level security;
alter table public.call_participants enable row level security;
alter table public.call_events enable row level security;

-- ============================================================
-- 31. DROP OLD POLICIES
-- ============================================================

do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname='public'
      and tablename in (
        'profiles',
        'friend_requests',
        'friendships',
        'contact_aliases',
        'blocked_users',
        'conversations',
        'conversation_members',
        'messages',
        'message_reactions',
        'notifications',
        'game_invites',
        'game_matches',
        'call_sessions',
        'call_participants',
        'call_events'
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      p.policyname,
      p.schemaname,
      p.tablename
    );
  end loop;
end;
$$;

-- ============================================================
-- 32. PROFILES RLS
-- ============================================================

create policy profiles_select_all_authenticated
on public.profiles
for select
to authenticated
using (true);

create policy profiles_insert_self
on public.profiles
for insert
to authenticated
with check (id=auth.uid());

create policy profiles_update_self
on public.profiles
for update
to authenticated
using (id=auth.uid())
with check (id=auth.uid());

-- ============================================================
-- 33. FRIEND REQUEST RLS
-- ============================================================

create policy friend_requests_select_participants
on public.friend_requests
for select
to authenticated
using (
  sender_id=auth.uid()
  or receiver_id=auth.uid()
);

create policy friend_requests_insert_self
on public.friend_requests
for insert
to authenticated
with check (
  sender_id=auth.uid()
);

create policy friend_requests_update_receiver_or_sender
on public.friend_requests
for update
to authenticated
using (
  sender_id=auth.uid()
  or receiver_id=auth.uid()
)
with check (
  sender_id=auth.uid()
  or receiver_id=auth.uid()
);

create policy friend_requests_delete_participants
on public.friend_requests
for delete
to authenticated
using (
  sender_id=auth.uid()
  or receiver_id=auth.uid()
);

-- ============================================================
-- 34. FRIENDSHIP RLS
-- ============================================================

create policy friendships_select_participants
on public.friendships
for select
to authenticated
using (
  user_id=auth.uid()
  or friend_id=auth.uid()
);

create policy friendships_insert_participants
on public.friendships
for insert
to authenticated
with check (
  user_id=auth.uid()
  or friend_id=auth.uid()
);

create policy friendships_delete_participants
on public.friendships
for delete
to authenticated
using (
  user_id=auth.uid()
  or friend_id=auth.uid()
);

-- ============================================================
-- 35. CONTACT ALIAS RLS
-- ============================================================

create policy contact_aliases_select_self
on public.contact_aliases
for select
to authenticated
using (user_id=auth.uid());

create policy contact_aliases_insert_self
on public.contact_aliases
for insert
to authenticated
with check (user_id=auth.uid());

create policy contact_aliases_update_self
on public.contact_aliases
for update
to authenticated
using (user_id=auth.uid())
with check (user_id=auth.uid());

create policy contact_aliases_delete_self
on public.contact_aliases
for delete
to authenticated
using (user_id=auth.uid());

-- ============================================================
-- 36. BLOCK RLS
-- ============================================================

create policy blocked_users_select_self
on public.blocked_users
for select
to authenticated
using (blocker_id=auth.uid());

create policy blocked_users_insert_self
on public.blocked_users
for insert
to authenticated
with check (blocker_id=auth.uid());

create policy blocked_users_delete_self
on public.blocked_users
for delete
to authenticated
using (blocker_id=auth.uid());

-- ============================================================
-- 37. CONVERSATION RLS
-- ============================================================

create policy conversations_select_member
on public.conversations
for select
to authenticated
using (public.is_member(id));

-- Direct inserts are allowed only to the owner; group creation from the
-- frontend should prefer create_group(...) RPC.
create policy conversations_insert_owner
on public.conversations
for insert
to authenticated
with check (
  owner_id=auth.uid()
);

create policy conversations_update_admin_or_owner
on public.conversations
for update
to authenticated
using (
  owner_id=auth.uid()
  or public.is_admin(id)
)
with check (
  owner_id=auth.uid()
  or public.is_admin(id)
);

create policy conversations_delete_owner
on public.conversations
for delete
to authenticated
using (
  owner_id=auth.uid()
);

-- ============================================================
-- 38. MEMBER RLS
-- ============================================================

create policy conversation_members_select_member
on public.conversation_members
for select
to authenticated
using (public.is_member(conversation_id));

create policy conversation_members_insert_member_or_admin
on public.conversation_members
for insert
to authenticated
with check (
  (
    user_id=auth.uid()
    and public.is_member(conversation_id)
  )
  or public.is_admin(conversation_id)
);

create policy conversation_members_update_self_or_admin
on public.conversation_members
for update
to authenticated
using (
  user_id=auth.uid()
  or public.is_admin(conversation_id)
)
with check (
  user_id=auth.uid()
  or public.is_admin(conversation_id)
);

create policy conversation_members_delete_self_or_admin
on public.conversation_members
for delete
to authenticated
using (
  user_id=auth.uid()
  or public.is_admin(conversation_id)
);

-- ============================================================
-- 39. MESSAGE RLS
-- ============================================================

create policy messages_select_member
on public.messages
for select
to authenticated
using (public.is_member(conversation_id));

create policy messages_insert_member
on public.messages
for insert
to authenticated
with check (
  sender_id=auth.uid()
  and public.is_member(conversation_id)
  and exists(
    select 1
    from public.conversation_members cm
    where cm.conversation_id=messages.conversation_id
      and cm.user_id=auth.uid()
      and cm.banned=false
      and cm.can_send=true
  )
  and not exists(
    select 1
    from public.conversation_members cm_sender
    join public.conversation_members cm_other
      on cm_other.conversation_id=cm_sender.conversation_id
    where cm_sender.conversation_id=messages.conversation_id
      and cm_sender.user_id=auth.uid()
      and cm_other.user_id<>auth.uid()
      and cm_other.banned=false
      and exists(
        select 1
        from public.blocked_users b
        where (b.blocker_id=auth.uid() and b.blocked_id=cm_other.user_id)
           or (b.blocker_id=cm_other.user_id and b.blocked_id=auth.uid())
      )
  )
);

create policy messages_update_sender_or_admin
on public.messages
for update
to authenticated
using (
  sender_id=auth.uid()
  or public.is_admin(conversation_id)
)
with check (
  sender_id=auth.uid()
  or public.is_admin(conversation_id)
);

create policy messages_delete_sender_or_admin
on public.messages
for delete
to authenticated
using (
  sender_id=auth.uid()
  or public.is_admin(conversation_id)
);

-- ============================================================
-- 40. REACTION RLS
-- ============================================================

create policy message_reactions_select_member
on public.message_reactions
for select
to authenticated
using (
  exists(
    select 1
    from public.messages m
    where m.id=message_id
      and public.is_member(m.conversation_id)
  )
);

create policy message_reactions_insert_self
on public.message_reactions
for insert
to authenticated
with check (
  user_id=auth.uid()
  and exists(
    select 1
    from public.messages m
    where m.id=message_id
      and public.is_member(m.conversation_id)
  )
);

create policy message_reactions_delete_self
on public.message_reactions
for delete
to authenticated
using (user_id=auth.uid());

-- ============================================================
-- 41. NOTIFICATION RLS
-- ============================================================

create policy notifications_select_self
on public.notifications
for select
to authenticated
using (user_id=auth.uid());

create policy notifications_update_self
on public.notifications
for update
to authenticated
using (user_id=auth.uid())
with check (user_id=auth.uid());

-- Direct client inserts are intentionally allowed only for own user.
-- Server-side trigger notifications use security definer.
create policy notifications_insert_self
on public.notifications
for insert
to authenticated
with check (user_id=auth.uid());

create policy notifications_delete_self
on public.notifications
for delete
to authenticated
using (user_id=auth.uid());

-- ============================================================
-- 42. GAME INVITE RLS
-- ============================================================

create policy game_invites_select_participants
on public.game_invites
for select
to authenticated
using (
  sender_id=auth.uid()
  or receiver_id=auth.uid()
);

create policy game_invites_insert_sender
on public.game_invites
for insert
to authenticated
with check (
  sender_id=auth.uid()
  and not public.is_blocked_between(receiver_id)
);

create policy game_invites_update_receiver_or_sender
on public.game_invites
for update
to authenticated
using (
  sender_id=auth.uid()
  or receiver_id=auth.uid()
)
with check (
  sender_id=auth.uid()
  or receiver_id=auth.uid()
);

create policy game_invites_delete_participant
on public.game_invites
for delete
to authenticated
using (
  sender_id=auth.uid()
  or receiver_id=auth.uid()
);

-- ============================================================
-- 43. GAME MATCH RLS
-- ============================================================

create policy game_matches_select_players
on public.game_matches
for select
to authenticated
using (
  player1_id=auth.uid()
  or player2_id=auth.uid()
);

create policy game_matches_insert_player
on public.game_matches
for insert
to authenticated
with check (
  player1_id=auth.uid()
  or player2_id=auth.uid()
);

create policy game_matches_update_player
on public.game_matches
for update
to authenticated
using (
  player1_id=auth.uid()
  or player2_id=auth.uid()
)
with check (
  player1_id=auth.uid()
  or player2_id=auth.uid()
);

-- ============================================================
-- 44. CALL RLS
-- ============================================================

create policy call_sessions_select_participant
on public.call_sessions
for select
to authenticated
using (public.is_call_participant(id));

create policy call_sessions_insert_member
on public.call_sessions
for insert
to authenticated
with check (
  caller_id=auth.uid()
  and public.is_member(conversation_id)
);

create policy call_sessions_update_participant
on public.call_sessions
for update
to authenticated
using (public.is_call_participant(id))
with check (public.is_call_participant(id));

create policy call_participants_select_participant
on public.call_participants
for select
to authenticated
using (public.is_call_participant(call_id));

create policy call_participants_insert_caller_or_participant
on public.call_participants
for insert
to authenticated
with check (
  user_id=auth.uid()
  or public.is_call_participant(call_id)
);

create policy call_participants_update_self_or_participant
on public.call_participants
for update
to authenticated
using (
  user_id=auth.uid()
  or public.is_call_participant(call_id)
)
with check (
  user_id=auth.uid()
  or public.is_call_participant(call_id)
);

create policy call_participants_delete_self_or_caller
on public.call_participants
for delete
to authenticated
using (
  user_id=auth.uid()
  or public.is_call_participant(call_id)
);

create policy call_events_select_participant
on public.call_events
for select
to authenticated
using (public.is_call_participant(call_id));

create policy call_events_insert_participant
on public.call_events
for insert
to authenticated
with check (
  sender_id=auth.uid()
  and public.is_call_participant(call_id)
);

-- ============================================================
-- 45. GRANTS
-- ============================================================

grant usage on schema public to authenticated;

grant select, insert, update, delete
on public.profiles,
   public.friend_requests,
   public.friendships,
   public.contact_aliases,
   public.blocked_users,
   public.conversations,
   public.conversation_members,
   public.messages,
   public.message_reactions,
   public.notifications,
   public.game_invites,
   public.game_matches,
   public.call_sessions,
   public.call_participants,
   public.call_events
to authenticated;

grant execute
on function public.is_conversation_member(uuid),
           public.is_member(uuid),
           public.is_admin(uuid),
           public.is_blocked_by_me(uuid),
           public.is_blocked_between(uuid),
           public.block_user(uuid),
           public.unblock_user(uuid),
           public.create_direct_conversation(uuid),
           public.create_group(text,text,uuid[]),
           public.add_group_members(uuid,uuid[]),
           public.remove_group_member(uuid,uuid),
           public.set_group_member_role(uuid,uuid,text),
           public.set_group_member_ban(uuid,uuid,boolean),
           public.set_group_member_can_send(uuid,uuid,boolean),
           public.set_group_member_permissions(boolean,boolean,uuid,text,uuid),
           public.leave_group(uuid),
           public.delete_group(uuid),
           public.send_friend_request(uuid),
           public.accept_friend_request(uuid),
           public.reject_friend_request(uuid),
           public.mark_conversation_read(uuid),
           public.increment_unread_counts(uuid,uuid),
           public.pin_message(uuid,boolean),
           public.forward_message(uuid,uuid),
           public.create_user_notification(uuid,text,text,text,jsonb),
           public.set_presence_mode(text),
           public.heartbeat_presence(),
           public.set_notification_preferences(boolean,boolean,boolean,boolean),
           public.set_contact_alias(uuid,text),
           public.remove_contact_alias(uuid),
           public.start_game_invite(uuid,text),
           public.respond_game_invite(uuid,text),
           public.record_game_match(text,text,uuid,uuid,uuid,integer,integer,jsonb),
           public.is_call_participant(uuid),
           public.start_call(uuid,text),
           public.answer_call(uuid),
           public.reject_call(uuid),
           public.end_call(uuid),
           public.expire_calls(timestamptz),
           public.send_call_event(uuid,text,jsonb)
to authenticated;

-- ============================================================
-- 46. REALTIME PUBLICATIONS
-- ============================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles',
    'friend_requests',
    'friendships',
    'conversations',
    'conversation_members',
    'messages',
    'notifications',
    'game_invites',
    'call_sessions',
    'call_participants',
    'call_events'
  ]
  loop
    if not exists(
      select 1
      from pg_publication_tables
      where pubname='supabase_realtime'
        and schemaname='public'
        and tablename=t
    ) then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        t
      );
    end if;
  end loop;
end;
$$;

alter table public.messages replica identity full;
alter table public.friend_requests replica identity full;
alter table public.friendships replica identity full;
alter table public.conversations replica identity full;
alter table public.conversation_members replica identity full;
alter table public.notifications replica identity full;
alter table public.game_invites replica identity full;
alter table public.call_sessions replica identity full;
alter table public.call_participants replica identity full;
alter table public.call_events replica identity full;

-- ============================================================
-- 47. STORAGE BUCKET
-- ============================================================

insert into storage.buckets(id,name,public)
values('nexly-media','nexly-media',true)
on conflict(id)
do update set public=true;

-- Remove old Nexly storage policies by known names.
drop policy if exists nexly_media_public_read on storage.objects;
drop policy if exists nexly_media_upload_own on storage.objects;
drop policy if exists nexly_media_update_own on storage.objects;
drop policy if exists nexly_media_delete_own on storage.objects;

create policy nexly_media_public_read
on storage.objects
for select
to public
using (
  bucket_id='nexly-media'
);

create policy nexly_media_upload_own
on storage.objects
for insert
to authenticated
with check (
  bucket_id='nexly-media'
  and split_part(name,'/',1)=auth.uid()::text
);

create policy nexly_media_update_own
on storage.objects
for update
to authenticated
using (
  bucket_id='nexly-media'
  and split_part(name,'/',1)=auth.uid()::text
)
with check (
  bucket_id='nexly-media'
  and split_part(name,'/',1)=auth.uid()::text
);

create policy nexly_media_delete_own
on storage.objects
for delete
to authenticated
using (
  bucket_id='nexly-media'
  and split_part(name,'/',1)=auth.uid()::text
);

-- ============================================================
-- 48. CLEANUP / VERIFICATION HELPERS
-- ============================================================

drop view if exists public.nexly_backend_status;

create view public.nexly_backend_status
as
select
  (select count(*) from public.profiles) as profiles_count,
  (select count(*) from public.friend_requests) as friend_requests_count,
  (select count(*) from public.friendships) as friendships_count,
  (select count(*) from public.conversations) as conversations_count,
  (select count(*) from public.conversation_members) as members_count,
  (select count(*) from public.messages) as messages_count,
  (select count(*) from public.blocked_users) as blocked_users_count,
  (select count(*) from public.game_invites) as game_invites_count,
  (select count(*) from public.game_matches) as game_matches_count,
  (select count(*) from public.call_sessions) as call_sessions_count;

grant select on public.nexly_backend_status to authenticated;

-- ============================================================
-- 49. FINAL SCHEMA CHECK
-- ============================================================

do $$
declare
  required_table text;
begin
  foreach required_table in array array[
    'profiles',
    'friend_requests',
    'friendships',
    'contact_aliases',
    'blocked_users',
    'conversations',
    'conversation_members',
    'messages',
    'message_reactions',
    'notifications',
    'game_invites',
    'game_matches',
    'call_sessions',
    'call_participants',
    'call_events'
  ]
  loop
    if not exists(
      select 1
      from information_schema.tables
      where table_schema='public'
        and table_name=required_table
    ) then
      raise exception 'NEXLY_SCHEMA_CHECK_FAILED: missing table %',
        required_table;
    end if;
  end loop;

  if not exists(
    select 1
    from pg_proc
    where pronamespace='public'::regnamespace
      and proname='block_user'
  ) then
    raise exception 'NEXLY_SCHEMA_CHECK_FAILED: block_user missing';
  end if;

  if not exists(
    select 1
    from pg_proc
    where pronamespace='public'::regnamespace
      and proname='set_group_member_permissions'
  ) then
    raise exception 'NEXLY_SCHEMA_CHECK_FAILED: group permission RPC missing';
  end if;

  if not exists(
    select 1
    from pg_proc
    where pronamespace='public'::regnamespace
      and proname='start_call'
  ) then
    raise exception 'NEXLY_SCHEMA_CHECK_FAILED: start_call missing';
  end if;
end;
$$;

notify pgrst,'reload schema';

commit;

-- ============================================================
-- EXPECTED RESULT
-- ============================================================
-- Success. No rows returned
--
-- After this script:
--   block_user(target_user_id) exists
--   is_blocked_by_me(target_user_id) exists
--   is_blocked_between(other_user_id) exists
--   create_direct_conversation(target_user_id) exists
--   create_group(p_title,p_description,p_member_ids) exists
--   set_group_member_permissions(
--      p_banned,
--      p_can_send,
--      p_conversation_id,
--      p_role,
--      p_user_id
--   ) exists
--   mark_conversation_read(p_conversation_id) exists
--   start_call(p_conversation_id,p_kind) exists
--   answer_call(p_call_id) exists
--   reject_call(p_call_id) exists
--   end_call(p_call_id) exists
--   nexly-media bucket exists
-- ============================================================


-- ============================================================
-- NEXLY v8 MIGRATION: GROUP CALLS / REACTIONS / BLOCK HARDENING
-- Safe re-apply: CREATE OR REPLACE / DROP POLICY only.
-- ============================================================

-- ------------------------------------------------------------
-- GROUP CALLS
--  * one active/ringing call per group conversation
--  * caller is connected immediately and may stay alone
--  * all non-banned, non-blocked group members receive invites
--  * pressing the group call button during an active call joins it
--  * reject/leave by a non-caller never ends a group call
-- ------------------------------------------------------------
create or replace function public.start_call(
  p_conversation_id uuid,
  p_kind text default 'audio'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call_id uuid;
  v_type text;
  v_count integer;
  v_member record;
  v_existing_kind text;
begin
  if p_kind not in ('audio','video') then
    raise exception 'Invalid call kind';
  end if;

  if not public.is_member(p_conversation_id) then
    raise exception 'Not a conversation member';
  end if;

  select type into v_type
  from public.conversations
  where id=p_conversation_id;

  if v_type is null then
    raise exception 'Conversation not found';
  end if;

  select count(*) into v_count
  from public.conversation_members
  where conversation_id=p_conversation_id
    and banned=false;

  if v_count>6 then
    raise exception 'Maximum 6 call participants';
  end if;

  -- Serialize group-call creation so two users cannot create parallel sessions.
  if v_type='group' then
    perform pg_advisory_xact_lock(hashtextextended('nexly-group-call:'||p_conversation_id::text,0));

    select id,kind
      into v_call_id,v_existing_kind
    from public.call_sessions
    where conversation_id=p_conversation_id
      and status in ('ringing','active')
      and expires_at>now()
    order by created_at desc
    limit 1
    for update;

    if v_call_id is not null then
      insert into public.call_participants(call_id,user_id,status,joined_at,left_at)
      values(v_call_id,auth.uid(),'connected',now(),null)
      on conflict(call_id,user_id)
      do update set status='connected',joined_at=coalesce(public.call_participants.joined_at,now()),left_at=null;
      return v_call_id;
    end if;
  end if;

  if v_type='direct' then
    for v_member in
      select cm.user_id,p.status
      from public.conversation_members cm
      join public.profiles p on p.id=cm.user_id
      where cm.conversation_id=p_conversation_id
        and cm.user_id<>auth.uid()
        and cm.banned=false
    loop
      if public.is_blocked_between(v_member.user_id) then
        raise exception 'Calls are blocked with this user';
      end if;
      if v_member.status='dnd' then
        raise exception 'The other user is in Do Not Disturb mode';
      end if;
    end loop;
  end if;

  insert into public.call_sessions(
    conversation_id,caller_id,kind,status,expires_at
  )
  values(
    p_conversation_id,
    auth.uid(),
    p_kind,
    case when v_type='group' then 'active' else 'ringing' end,
    case when v_type='group' then now()+interval '24 hours' else now()+interval '60 seconds' end
  )
  returning id into v_call_id;

  insert into public.call_participants(call_id,user_id,status,joined_at)
  values(v_call_id,auth.uid(),'connected',now());

  for v_member in
    select cm.user_id,p.status
    from public.conversation_members cm
    join public.profiles p on p.id=cm.user_id
    where cm.conversation_id=p_conversation_id
      and cm.user_id<>auth.uid()
      and cm.banned=false
  loop
    -- Direct calls: respect DND. Group calls: explicit group calling means
    -- everyone eligible gets an invite; blocked relationships are still excluded.
    if not public.is_blocked_between(v_member.user_id)
       and (v_type='group' or v_member.status<>'dnd')
    then
      insert into public.call_participants(call_id,user_id,status)
      values(v_call_id,v_member.user_id,'invited')
      on conflict(call_id,user_id) do update
        set status=case
          when public.call_participants.status in ('left','rejected','missed') then 'invited'
          else public.call_participants.status
        end,
        left_at=null;
    end if;
  end loop;

  if v_type='direct' and not exists(
    select 1 from public.call_participants
    where call_id=v_call_id and user_id<>auth.uid() and status='invited'
  ) then
    update public.call_sessions
    set status='ended',ended_at=now()
    where id=v_call_id;
    raise exception 'No available participants';
  end if;

  return v_call_id;
end;
$$;

create or replace function public.answer_call(
  p_call_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_type text;
  v_expires timestamptz;
begin
  if not public.is_call_participant(p_call_id) then
    raise exception 'Not a call participant';
  end if;

  select cs.status,coalesce(c.type,'direct'),cs.expires_at
    into v_status,v_type,v_expires
  from public.call_sessions cs
  join public.conversations c on c.id=cs.conversation_id
  where cs.id=p_call_id;

  if v_status not in ('ringing','active') then
    return false;
  end if;

  if v_expires is null or now()>v_expires then
    if v_type='group' then
      update public.call_participants
      set status='missed',left_at=now()
      where call_id=p_call_id and user_id=auth.uid();
    else
      update public.call_sessions set status='missed',ended_at=now()
      where id=p_call_id and status='ringing';
      update public.call_participants set status='missed',left_at=now()
      where call_id=p_call_id and status='invited';
    end if;
    return false;
  end if;

  update public.call_participants
  set status='connected',joined_at=coalesce(joined_at,now()),left_at=null
  where call_id=p_call_id and user_id=auth.uid();

  if v_type='direct' then
    update public.call_sessions
    set status='active',answered_at=coalesce(answered_at,now())
    where id=p_call_id;
  else
    update public.call_sessions
    set status='active',answered_at=coalesce(answered_at,now())
    where id=p_call_id and status in ('ringing','active');
  end if;

  return true;
end;
$$;

create or replace function public.reject_call(
  p_call_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_caller uuid;
  v_remaining integer;
begin
  if not public.is_call_participant(p_call_id) then
    raise exception 'Not a call participant';
  end if;

  select c.type,cs.caller_id into v_type,v_caller
  from public.call_sessions cs
  join public.conversations c on c.id=cs.conversation_id
  where cs.id=p_call_id;

  update public.call_participants
  set status='rejected',left_at=now()
  where call_id=p_call_id and user_id=auth.uid();

  if v_type='group' then
    -- A group participant rejecting only removes that participant.
    -- The caller may continue alone and others can still join.
    return true;
  end if;

  select count(*) into v_remaining
  from public.call_participants
  where call_id=p_call_id
    and status in ('invited','connected');

  if v_remaining<=1 then
    update public.call_sessions
    set status='ended',ended_at=now()
    where id=p_call_id and status in ('ringing','active');
  end if;

  return true;
end;
$$;

create or replace function public.leave_call(
  p_call_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_call_participant(p_call_id) then
    raise exception 'Not a call participant';
  end if;

  update public.call_participants
  set status='left',left_at=now()
  where call_id=p_call_id and user_id=auth.uid();

  return true;
end;
$$;

grant execute on function public.leave_call(uuid) to authenticated;

create or replace function public.end_call(
  p_call_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_type text;
begin
  if not public.is_call_participant(p_call_id) then
    raise exception 'Not a call participant';
  end if;

  select cs.caller_id,c.type into v_caller,v_type
  from public.call_sessions cs
  join public.conversations c on c.id=cs.conversation_id
  where cs.id=p_call_id;

  update public.call_participants
  set status='left',left_at=now()
  where call_id=p_call_id
    and user_id=auth.uid()
    and status not in ('left','rejected','missed');

  if auth.uid()=v_caller then
    update public.call_sessions
    set status='ended',ended_at=now()
    where id=p_call_id and status<>'ended';
  elsif v_type<>'group' then
    if not exists(
      select 1 from public.call_participants
      where call_id=p_call_id and status in ('invited','connected')
    ) then
      update public.call_sessions
      set status='ended',ended_at=now()
      where id=p_call_id and status in ('ringing','active');
    end if;
  end if;

  return true;
end;
$$;

create or replace function public.expire_calls(
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.call_participants cp
  set status='missed',left_at=p_now
  from public.call_sessions cs
  where cp.call_id=cs.id
    and cs.status='ringing'
    and cs.expires_at<=p_now
    and cp.status='invited';

  update public.call_sessions
  set status='missed',ended_at=p_now
  where status='ringing'
    and expires_at<=p_now;

  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

-- ------------------------------------------------------------
-- GROUP CALL SYSTEM MESSAGE
-- ------------------------------------------------------------
create or replace function public.nexly_call_started_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_name text;
begin
  select type into v_type
  from public.conversations
  where id=new.conversation_id;

  if v_type<>'group' or new.status<>'active' then
    return new;
  end if;

  select coalesce(nullif(display_name,''),username,'Пользователь')
    into v_name
  from public.profiles
  where id=new.caller_id;

  insert into public.messages(
    conversation_id,sender_id,content,attachments
  )
  values(
    new.conversation_id,
    new.caller_id,
    '📞 '||v_name||' начал групповой звонок',
    jsonb_build_object(
      'type','call',
      'callId',new.id,
      'callKind',new.kind,
      'groupCall',true
    )
  );

  return new;
end;
$$;

drop trigger if exists trigger_nexly_call_started_message on public.call_sessions;
create trigger trigger_nexly_call_started_message
after insert on public.call_sessions
for each row
execute function public.nexly_call_started_message();

-- ------------------------------------------------------------
-- REACTIONS: realtime publication
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime'
      and schemaname='public'
      and tablename='message_reactions'
  ) then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
end;
$$;
alter table public.message_reactions replica identity full;

-- Re-apply the message policy so a blocked user cannot send into a chat
-- with the user who blocked them. (Existing behavior is directional at the
-- database boundary; the UI may additionally disable the blocker-side composer.)
drop policy if exists messages_insert_member on public.messages;
create policy messages_insert_member
on public.messages
for insert
to authenticated
with check (
  sender_id=auth.uid()
  and public.is_member(conversation_id)
  and exists(
    select 1
    from public.conversation_members cm
    where cm.conversation_id=messages.conversation_id
      and cm.user_id=auth.uid()
      and cm.banned=false
      and cm.can_send=true
  )
  and not exists(
    select 1
    from public.conversation_members cm_other
    join public.conversations c on c.id=messages.conversation_id
    where c.type='direct'
      and cm_other.conversation_id=messages.conversation_id
      and cm_other.user_id<>auth.uid()
      and cm_other.banned=false
      and exists(
        select 1
        from public.blocked_users b
        where b.blocker_id=cm_other.user_id
          and b.blocked_id=auth.uid()
      )
  )
);

notify pgrst,'reload schema';
