-- Quiz anything: initial schema.
-- Run this once in the Supabase dashboard (SQL editor) or with the Supabase CLI.
-- The app only talks to the database from the server with the service role key,
-- so RLS is enabled with no policies: the public anon key can't read or write anything.

create extension if not exists pgcrypto;

create table if not exists questions (
  id            uuid primary key default gen_random_uuid(),
  topic_slug    text not null,
  topic_name    text not null,
  difficulty    text not null check (difficulty in ('easy', 'medium', 'hard')),
  question      text not null,
  options       jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 4),
  answer_index  smallint not null check (answer_index between 0 and 3),
  explanation   text not null default '',
  hash          text not null unique,
  flags         int not null default 0,
  hidden        boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists questions_topic_idx
  on questions (topic_slug, difficulty, created_at desc)
  where not hidden;

-- Generations made with the owner's Gemini key, per UTC day.
create table if not exists usage_daily (
  day          date primary key,
  generations  int not null default 0
);

-- Fixed-window rate limits keyed by e.g. 'gen:<ip>' or 'report:<ip>'.
create table if not exists rate_limits (
  key           text primary key,
  window_start  timestamptz not null,
  count         int not null
);

alter table questions   enable row level security;
alter table usage_daily enable row level security;
alter table rate_limits enable row level security;

-- Returns true and counts one generation if today's total is still under the cap.
create or replace function try_use_daily(p_cap int)
returns boolean
language plpgsql
as $$
declare v int;
begin
  insert into usage_daily (day, generations)
  values ((now() at time zone 'utc')::date, 1)
  on conflict (day) do update
    set generations = usage_daily.generations + 1
    where usage_daily.generations < p_cap
  returning generations into v;
  return v is not null and v <= p_cap;
end;
$$;

-- Returns true if this key is still within p_max requests for the current window.
create or replace function try_rate_limit(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
as $$
declare v int;
begin
  insert into rate_limits (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update
    set count = case
          when rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then 1
          else rate_limits.count + 1 end,
        window_start = case
          when rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then now()
          else rate_limits.window_start end
  returning count into v;
  return v <= p_max;
end;
$$;

-- One more report; a question is hidden once it has 3.
create or replace function report_question(p_id uuid)
returns void
language sql
as $$
  update questions
     set flags = flags + 1,
         hidden = hidden or (flags + 1) >= 3
   where id = p_id;
$$;

-- Only the server (service role) may call these.
revoke execute on function try_use_daily(int)              from public, anon, authenticated;
revoke execute on function try_rate_limit(text, int, int)  from public, anon, authenticated;
revoke execute on function report_question(uuid)           from public, anon, authenticated;
grant  execute on function try_use_daily(int)              to service_role;
grant  execute on function try_rate_limit(text, int, int)  to service_role;
grant  execute on function report_question(uuid)           to service_role;
