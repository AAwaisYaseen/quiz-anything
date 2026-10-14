-- Quiz anything: one report per reporter per question.
-- Before this, one IP could report the same question 3 times and hide it alone.
-- reporter is a sha256 of the client IP (hashed in the API route), never the raw IP.

create table if not exists question_reports (
  question_id  uuid not null references questions (id) on delete cascade,
  reporter     text not null,
  created_at   timestamptz not null default now(),
  primary key (question_id, reporter)
);

alter table question_reports enable row level security;
grant select, insert, update, delete on question_reports to service_role;
revoke all on question_reports from anon, authenticated;

-- Replace the old one-argument version.
drop function if exists report_question(uuid);

-- Counts a report only the first time this reporter flags this question; hidden at 3.
create or replace function report_question(p_id uuid, p_reporter text)
returns void
language plpgsql
as $$
begin
  if not exists (select 1 from questions where id = p_id) then
    return;
  end if;

  insert into question_reports (question_id, reporter)
  values (p_id, p_reporter)
  on conflict do nothing;

  if found then
    update questions
       set flags = flags + 1,
           hidden = hidden or (flags + 1) >= 3
     where id = p_id;
  end if;
end;
$$;

revoke execute on function report_question(uuid, text) from public, anon, authenticated;
grant  execute on function report_question(uuid, text) to service_role;
