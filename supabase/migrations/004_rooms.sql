-- Quiz anything: friend rooms (multiplayer).
-- The server owns the game clock. Each room moves through:
--   lobby -> playing (ready 3s -> [question Ns -> reveal 4s] x count) -> done -> (rematch) lobby
-- A question closes early once every player has answered.
-- Scoring: per question, only the fastest correct answer gets the point.
-- Like everything else, these tables are server-only: RLS on, no policies, no public grants.

create table if not exists rooms (
  code              text primary key,
  topic_slug        text not null,
  topic_name        text not null,
  difficulty        text not null check (difficulty in ('easy', 'medium', 'hard')),
  max_players       int  not null default 2,
  question_seconds  int  not null default 15,
  reveal_seconds    int  not null default 4,
  status            text not null default 'lobby' check (status in ('lobby', 'playing', 'done')),
  round             int  not null default 0,
  phase             text check (phase in ('ready', 'question', 'reveal')),
  q_index           int  not null default -1,
  q_count           int  not null default 0,
  phase_ends_at     timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists rooms_created_idx on rooms (created_at);

-- token_hash is a sha256 of a random secret held only by that player's browser.
create table if not exists room_players (
  room_code   text not null references rooms (code) on delete cascade,
  player_id   uuid not null default gen_random_uuid(),
  token_hash  text not null unique,
  name        text not null,
  is_host     boolean not null default false,
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  primary key (room_code, player_id)
);

-- A snapshot of each round's questions, options already shuffled, so both players see the same order
-- and later edits to the bank (or a question being hidden) can't change a game in progress.
create table if not exists room_questions (
  room_code     text not null references rooms (code) on delete cascade,
  round         int  not null,
  q_index       int  not null,
  question_id   uuid not null,
  question      text not null,
  options       jsonb not null,
  answer_index  smallint not null,
  explanation   text not null default '',
  primary key (room_code, round, q_index)
);

create table if not exists room_answers (
  room_code    text not null,
  round        int  not null,
  q_index      int  not null,
  player_id    uuid not null,
  choice       smallint not null check (choice between 0 and 3),
  correct      boolean not null,
  answered_at  timestamptz not null default clock_timestamp(),
  primary key (room_code, round, q_index, player_id),
  foreign key (room_code, player_id) references room_players (room_code, player_id) on delete cascade
);

alter table rooms          enable row level security;
alter table room_players   enable row level security;
alter table room_questions enable row level security;
alter table room_answers   enable row level security;

grant select, insert, update, delete on rooms, room_players, room_questions, room_answers to service_role;
revoke all on rooms, room_players, room_questions, room_answers from anon, authenticated;

-- Moves a playing room's clock forward to "now". Phases chain from the previous phase's end time,
-- so the schedule stays exact even if nobody polls for a while.
create or replace function room_tick(p_code text)
returns void
language plpgsql
as $$
declare
  r rooms%rowtype;
  n_players int;
  n_answers int;
  t timestamptz := clock_timestamp();
begin
  select * into r from rooms where code = p_code for update;
  if not found or r.status <> 'playing' then
    return;
  end if;

  loop
    if r.phase = 'ready' then
      exit when r.phase_ends_at > t;
      r.phase := 'question';
      r.q_index := 0;
      r.phase_ends_at := r.phase_ends_at + make_interval(secs => r.question_seconds);

    elsif r.phase = 'question' then
      select count(*) into n_players from room_players where room_code = r.code;
      select count(*) into n_answers from room_answers
        where room_code = r.code and round = r.round and q_index = r.q_index;
      if n_answers >= n_players then
        -- Everyone answered: reveal now (or at the deadline, if that already passed).
        r.phase := 'reveal';
        r.phase_ends_at := least(t, r.phase_ends_at) + make_interval(secs => r.reveal_seconds);
      elsif r.phase_ends_at <= t then
        r.phase := 'reveal';
        r.phase_ends_at := r.phase_ends_at + make_interval(secs => r.reveal_seconds);
      else
        exit;
      end if;

    elsif r.phase = 'reveal' then
      exit when r.phase_ends_at > t;
      if r.q_index + 1 >= r.q_count then
        r.status := 'done';
        r.phase := null;
        r.phase_ends_at := null;
        exit;
      end if;
      r.q_index := r.q_index + 1;
      r.phase := 'question';
      r.phase_ends_at := r.phase_ends_at + make_interval(secs => r.question_seconds);

    else
      exit;
    end if;
  end loop;

  update rooms
     set status = r.status, phase = r.phase, q_index = r.q_index, phase_ends_at = r.phase_ends_at
   where code = r.code;
end;
$$;

-- Creates a room and its host. Returns the host's player_id, or null if the code is taken
-- (the caller retries with a new code). Also clears out rooms older than 6 hours.
create or replace function room_create(
  p_code text, p_topic_slug text, p_topic_name text, p_difficulty text,
  p_max_players int, p_question_seconds int, p_token_hash text, p_name text
)
returns uuid
language plpgsql
as $$
declare
  v_player uuid;
begin
  delete from rooms where created_at < now() - interval '6 hours';

  insert into rooms (code, topic_slug, topic_name, difficulty, max_players, question_seconds)
  values (p_code, p_topic_slug, p_topic_name, p_difficulty, p_max_players, p_question_seconds)
  on conflict (code) do nothing;
  if not found then
    return null;
  end if;

  insert into room_players (room_code, token_hash, name, is_host)
  values (p_code, p_token_hash, p_name, true)
  returning player_id into v_player;
  return v_player;
end;
$$;

-- Joins a room in its lobby. Returns {player_id} or {error}.
create or replace function room_join(p_code text, p_token_hash text, p_name text)
returns jsonb
language plpgsql
as $$
declare
  r rooms%rowtype;
  n int;
  v_player uuid;
begin
  select * into r from rooms where code = p_code for update;
  if not found then
    return jsonb_build_object('error', 'ROOM_NOT_FOUND');
  end if;
  if r.status <> 'lobby' then
    return jsonb_build_object('error', 'ROOM_STARTED');
  end if;
  select count(*) into n from room_players where room_code = p_code;
  if n >= r.max_players then
    return jsonb_build_object('error', 'ROOM_FULL');
  end if;

  insert into room_players (room_code, token_hash, name)
  values (p_code, p_token_hash, p_name)
  returning player_id into v_player;
  return jsonb_build_object('player_id', v_player);
end;
$$;

-- Starts a round: picks p_count random questions from the bank (preferring ones this room hasn't
-- played yet), snapshots them with shuffled options, and starts the 3-second "get ready".
-- Any player in the room may start. Returns {ok} or {error}.
create or replace function room_start(p_code text, p_token_hash text, p_count int)
returns jsonb
language plpgsql
as $$
declare
  r rooms%rowtype;
  n_players int;
  n_avail int;
  v_round int;
begin
  select * into r from rooms where code = p_code for update;
  if not found or not exists (
    select 1 from room_players where room_code = p_code and token_hash = p_token_hash
  ) then
    return jsonb_build_object('error', 'ROOM_NOT_FOUND');
  end if;
  if r.status <> 'lobby' then
    return jsonb_build_object('error', 'ROOM_STARTED');
  end if;
  select count(*) into n_players from room_players where room_code = p_code;
  if n_players < 2 then
    return jsonb_build_object('error', 'NEED_PLAYERS');
  end if;
  select count(*) into n_avail from questions
   where topic_slug = r.topic_slug and difficulty = r.difficulty and not hidden;
  if n_avail < p_count then
    return jsonb_build_object('error', 'NOT_ENOUGH_QUESTIONS', 'available', n_avail);
  end if;

  v_round := r.round + 1;

  insert into room_questions (room_code, round, q_index, question_id, question, options, answer_index, explanation)
  select p_code, v_round, (row_number() over (order by pick.played, pick.rnd))::int - 1,
         pick.id, pick.question, sh.opts,
         (array_position(sh.perm, pick.answer_index::bigint) - 1)::smallint,
         pick.explanation
    from (
      select q.id, q.question, q.options, q.answer_index, q.explanation,
             exists (select 1 from room_questions rq where rq.room_code = p_code and rq.question_id = q.id) as played,
             random() as rnd
        from questions q
       where q.topic_slug = r.topic_slug and q.difficulty = r.difficulty and not q.hidden
       order by played, rnd
       limit p_count
    ) pick
    cross join lateral (
      select jsonb_agg(e.opt order by e.rnd) as opts,
             array_agg(e.ord order by e.rnd) as perm
        from (
          select opt, ord - 1 as ord, random() as rnd
            from jsonb_array_elements_text(pick.options) with ordinality as x(opt, ord)
        ) e
    ) sh;

  update rooms
     set status = 'playing', round = v_round, q_count = p_count, q_index = -1,
         phase = 'ready', phase_ends_at = clock_timestamp() + interval '3 seconds'
   where code = p_code;
  return jsonb_build_object('ok', true);
end;
$$;

-- Records one answer (one try per question) if the question is still open. Returns {ok} or {error}.
create or replace function room_answer(p_code text, p_token_hash text, p_q_index int, p_choice int)
returns jsonb
language plpgsql
as $$
declare
  r rooms%rowtype;
  v_player uuid;
  v_answer smallint;
begin
  select player_id into v_player from room_players where room_code = p_code and token_hash = p_token_hash;
  if v_player is null then
    return jsonb_build_object('error', 'ROOM_NOT_FOUND');
  end if;

  perform room_tick(p_code);
  select * into r from rooms where code = p_code for update;
  if r.status <> 'playing' or r.phase <> 'question' or r.q_index <> p_q_index
     or r.phase_ends_at <= clock_timestamp() then
    return jsonb_build_object('error', 'TOO_LATE');
  end if;

  select answer_index into v_answer from room_questions
   where room_code = p_code and round = r.round and q_index = p_q_index;

  insert into room_answers (room_code, round, q_index, player_id, choice, correct)
  values (p_code, r.round, p_q_index, v_player, p_choice, p_choice = v_answer)
  on conflict do nothing;

  perform room_tick(p_code); -- may reveal early if everyone has now answered
  return jsonb_build_object('ok', true);
end;
$$;

-- Sends everyone back to the lobby for another round with the same players. Returns {ok} or {error}.
create or replace function room_rematch(p_code text, p_token_hash text)
returns jsonb
language plpgsql
as $$
begin
  if not exists (select 1 from room_players where room_code = p_code and token_hash = p_token_hash) then
    return jsonb_build_object('error', 'ROOM_NOT_FOUND');
  end if;
  update rooms set status = 'lobby', phase = null, q_index = -1, phase_ends_at = null
   where code = p_code and status = 'done';
  return jsonb_build_object('ok', true);
end;
$$;

-- Everything a player's screen needs, in one round trip. Never includes the answer to an open question.
create or replace function room_state(p_code text, p_token_hash text)
returns jsonb
language plpgsql
as $$
declare
  r rooms%rowtype;
  v_player uuid;
  t timestamptz;
  closed_upto int; -- questions with q_index < closed_upto are closed and scored
  players jsonb;
  cur jsonb := null;
  review jsonb := null;
begin
  update room_players set last_seen = now()
   where room_code = p_code and token_hash = p_token_hash
   returning player_id into v_player;
  if v_player is null then
    return jsonb_build_object('error', 'ROOM_NOT_FOUND');
  end if;

  perform room_tick(p_code);
  select * into r from rooms where code = p_code;
  t := clock_timestamp();

  closed_upto := case
    when r.status = 'done' then r.q_count
    when r.status = 'playing' and r.phase = 'reveal' then r.q_index + 1
    when r.status = 'playing' then greatest(r.q_index, 0)
    else 0 end;

  -- Winners of closed questions: the earliest correct answer.
  with winners as (
    select distinct on (q_index) q_index, player_id
      from room_answers
     where room_code = p_code and round = r.round and correct and q_index < closed_upto
     order by q_index, answered_at, player_id
  )
  select jsonb_agg(jsonb_build_object(
           'id', p.player_id,
           'name', p.name,
           'host', p.is_host,
           'away', p.last_seen < now() - interval '10 seconds',
           'score', (select count(*) from winners w where w.player_id = p.player_id)
         ) order by p.joined_at)
    into players
    from room_players p
   where p.room_code = p_code;

  if r.status = 'playing' and r.q_index >= 0 then
    select jsonb_build_object(
             'question', q.question,
             'options', q.options,
             'answer_index', case when r.phase = 'reveal' then q.answer_index end,
             'explanation', case when r.phase = 'reveal' then q.explanation end,
             'answers', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'player', a.player_id,
                        'choice', case when r.phase = 'reveal' or a.player_id = v_player then a.choice end,
                        'correct', case when r.phase = 'reveal' then a.correct end
                      ) order by a.answered_at)
                 from room_answers a
                where a.room_code = p_code and a.round = r.round and a.q_index = r.q_index
             ), '[]'::jsonb),
             'winner', case when r.phase = 'reveal' then (
               select a.player_id from room_answers a
                where a.room_code = p_code and a.round = r.round and a.q_index = r.q_index and a.correct
                order by a.answered_at, a.player_id limit 1
             ) end
           )
      into cur
      from room_questions q
     where q.room_code = p_code and q.round = r.round and q.q_index = r.q_index;
  end if;

  if r.status = 'done' then
    select jsonb_agg(jsonb_build_object(
             'question', q.question,
             'answer', q.options ->> q.answer_index::int,
             'winner', (
               select a.player_id from room_answers a
                where a.room_code = p_code and a.round = r.round and a.q_index = q.q_index and a.correct
                order by a.answered_at, a.player_id limit 1
             )
           ) order by q.q_index)
      into review
      from room_questions q
     where q.room_code = p_code and q.round = r.round;
  end if;

  return jsonb_build_object(
    'code', r.code,
    'topic', r.topic_name,
    'difficulty', r.difficulty,
    'status', r.status,
    'round', r.round,
    'phase', r.phase,
    'q_index', r.q_index,
    'q_count', r.q_count,
    'phase_ends_at', r.phase_ends_at,
    'now', t,
    'question_seconds', r.question_seconds,
    'max_players', r.max_players,
    'me', v_player,
    'players', coalesce(players, '[]'::jsonb),
    'current', cur,
    'review', review
  );
end;
$$;

-- Only the server (service role) may call these.
revoke execute on function room_tick(text)                                          from public, anon, authenticated;
revoke execute on function room_create(text, text, text, text, int, int, text, text) from public, anon, authenticated;
revoke execute on function room_join(text, text, text)                              from public, anon, authenticated;
revoke execute on function room_start(text, text, int)                              from public, anon, authenticated;
revoke execute on function room_answer(text, text, int, int)                        from public, anon, authenticated;
revoke execute on function room_rematch(text, text)                                 from public, anon, authenticated;
revoke execute on function room_state(text, text)                                  from public, anon, authenticated;
grant  execute on function room_tick(text)                                          to service_role;
grant  execute on function room_create(text, text, text, text, int, int, text, text) to service_role;
grant  execute on function room_join(text, text, text)                              to service_role;
grant  execute on function room_start(text, text, int)                              to service_role;
grant  execute on function room_answer(text, text, int, int)                        to service_role;
grant  execute on function room_rematch(text, text)                                 to service_role;
grant  execute on function room_state(text, text)                                   to service_role;
