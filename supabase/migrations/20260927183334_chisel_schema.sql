-- Journal entries: one row per entry, owned by the signed-in user.
create table public.entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default '',
  body text not null default '',
  with_whom text not null default '',
  tags text[] not null default '{}',
  entry_date date not null,
  entry_time text not null check (entry_time ~ '^\d{2}:\d{2}$'),
  created_at timestamptz not null default now(),
  drive jsonb  -- {docId, tabId, dayTabId, syncedAt} once copied to Google Drive
);
create index entries_user_date_idx on public.entries (user_id, entry_date desc, entry_time desc);

-- Voice notes attached to an entry; audio lives in the voice-notes storage bucket.
create table public.clips (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  position int not null default 0,
  storage_path text not null,
  mime text not null,
  duration real not null default 0,
  transcript text not null default '',
  drive_file_id text,
  drive_link text,
  created_at timestamptz not null default now()
);
create index clips_entry_idx on public.clips (entry_id);
create index clips_user_idx on public.clips (user_id);

-- Google Drive sync state, one row per user who connected Drive.
create table public.drive_sync (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  google_email text not null,
  ids jsonb not null default '{}',              -- cached Drive folder / doc ids
  days jsonb not null default '{}',             -- 'YYYY-MM-DD' -> {docId, tabId}
  pending_deletes jsonb not null default '[]',  -- Drive copies to remove on next sync
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.entries enable row level security;
alter table public.clips enable row level security;
alter table public.drive_sync enable row level security;

create policy "own entries: select" on public.entries for select to authenticated using ((select auth.uid()) = user_id);
create policy "own entries: insert" on public.entries for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own entries: update" on public.entries for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own entries: delete" on public.entries for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own clips: select" on public.clips for select to authenticated using ((select auth.uid()) = user_id);
create policy "own clips: insert" on public.clips for insert to authenticated with check (
  (select auth.uid()) = user_id
  and exists (select 1 from public.entries e where e.id = entry_id and e.user_id = (select auth.uid()))
);
create policy "own clips: update" on public.clips for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own clips: delete" on public.clips for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own drive sync: select" on public.drive_sync for select to authenticated using ((select auth.uid()) = user_id);
create policy "own drive sync: insert" on public.drive_sync for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own drive sync: update" on public.drive_sync for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own drive sync: delete" on public.drive_sync for delete to authenticated using ((select auth.uid()) = user_id);

-- Private audio bucket; objects are stored under '<user id>/...'.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice-notes', 'voice-notes', false, 52428800,
        array['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/x-m4a']);

create policy "own voice notes: select" on storage.objects for select to authenticated
  using (bucket_id = 'voice-notes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own voice notes: insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'voice-notes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own voice notes: update" on storage.objects for update to authenticated
  using (bucket_id = 'voice-notes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own voice notes: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'voice-notes' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Lets a user delete their own account (entries, clips and sync state cascade).
-- The client removes the user's storage objects first, since storage can't be cleared from SQL.
create function public.delete_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
