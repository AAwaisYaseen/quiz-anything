"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { store, type RoomSession } from "@/lib/client-store";
import { LEVEL_LABEL, LoadingBar, MESSAGES, PRESETS, generate, postJson } from "@/components/common";
import {
  DIFFICULTIES,
  cleanName,
  cleanRoomCode,
  cleanTopic,
  topicSlug,
  type Difficulty,
  type ErrorCode,
  type RoomState,
} from "@/lib/shared";

type Props = { initialCode: string | null; onExit: () => void; onOpenSettings: () => void };
type Err = { text: string; settings?: boolean } | null;

const errOf = (data: unknown): ErrorCode => {
  const code = (data as { error?: ErrorCode })?.error;
  return code && code in MESSAGES ? code : "SERVER_ERROR";
};

function setRoomInUrl(code: string | null) {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  window.history.replaceState(null, "", url);
}

/** Entry point for friend rooms: the menu (create or join), then the room itself. */
export default function Room({ initialCode, onExit, onOpenSettings }: Props) {
  const [session, setSession] = useState<RoomSession | null>(() => {
    const s = store.getRoom();
    return s && (!initialCode || s.code === initialCode) ? s : null;
  });
  const [name, setName] = useState(() => store.getName());
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [custom, setCustom] = useState("");
  const [joinCode, setJoinCode] = useState(initialCode ?? "");
  const [busy, setBusy] = useState<{ msg: string; writing: boolean } | null>(null);
  const [error, setError] = useState<Err>(null);

  const enter = (s: RoomSession) => {
    store.setRoom(s);
    setRoomInUrl(s.code);
    setSession(s);
  };

  const leave = useCallback(
    (why?: Err) => {
      store.clearRoom();
      setRoomInUrl(null);
      setSession(null);
      setError(why ?? null);
      if (!why) onExit();
    },
    [onExit],
  );

  const checkName = () => {
    const n = cleanName(name);
    if (!n) setError({ text: MESSAGES.BAD_NAME });
    else store.setName(n);
    return n;
  };

  const create = async (raw: string) => {
    setError(null);
    const n = checkName();
    if (!n) return;
    const topic = cleanTopic(raw);
    if (!topic || !topicSlug(topic)) return setError({ text: MESSAGES.BAD_REQUEST });

    setBusy({ msg: "Creating your room", writing: false });
    const r = await postJson("/api/room/create", { name: n, topic, difficulty });
    if (!r.ok) {
      setBusy(null);
      return setError({ text: MESSAGES[errOf(r.data)] });
    }
    const { code, token, bank, needed } = r.data as RoomSession & { bank: number; needed: number };
    if (bank < needed) {
      setBusy({ msg: "Writing new questions", writing: true });
      const genErr = await generate(topic, difficulty);
      if (genErr) {
        setBusy(null);
        return setError({ text: MESSAGES[genErr], settings: genErr === "NEEDS_OWN_KEY" || genErr === "BAD_KEY" });
      }
    }
    setBusy(null);
    enter({ code, token });
  };

  const join = async () => {
    setError(null);
    const n = checkName();
    if (!n) return;
    const code = cleanRoomCode(joinCode);
    if (!code) return setError({ text: MESSAGES.ROOM_NOT_FOUND });
    setBusy({ msg: "Joining the room", writing: false });
    const r = await postJson("/api/room/join", { name: n, code });
    setBusy(null);
    if (!r.ok) return setError({ text: MESSAGES[errOf(r.data)] });
    enter(r.data as RoomSession);
  };

  if (session) return <RoomView session={session} onLeave={leave} />;

  if (busy) {
    return (
      <section className="loading">
        <p className="load-msg" aria-live="polite">
          {busy.msg}
        </p>
        <LoadingBar writing={busy.writing} />
      </section>
    );
  }

  return (
    <section>
      <div className="head">
        <h1>Play with a friend</h1>
        <button className="link" onClick={() => leave()}>
          Back
        </button>
      </div>
      <p className="sub">Same questions at the same time. The fastest right answer wins the point.</p>

      <h2>Your nickname</h2>
      <div className="own">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. QuizWhiz"
          maxLength={20}
          autoComplete="nickname"
          aria-label="Your nickname"
        />
      </div>

      <h2>{initialCode ? "Join the room" : "Have a code?"}</h2>
      <form
        className="own"
        onSubmit={(e) => {
          e.preventDefault();
          join();
        }}
      >
        <input
          className="code-input"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          placeholder="ROOM CODE"
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-label="Room code"
        />
        <button className="btn" type="submit">
          Join
        </button>
      </form>

      {initialCode ? null : (
        <>
          <h2>Or create a room</h2>
          <div className="levels" role="group" aria-label="Difficulty">
            {DIFFICULTIES.map((d) => (
              <button key={d} aria-pressed={difficulty === d} onClick={() => setDifficulty(d)}>
                {LEVEL_LABEL[d]}
              </button>
            ))}
          </div>
          <p className="hint">Tap a topic, or type your own.</p>
          <div className="chips">
            {PRESETS.map((p) => (
              <button key={p} className="chip" onClick={() => create(p)}>
                {p}
              </button>
            ))}
          </div>
          <form
            className="own gap-top"
            onSubmit={(e) => {
              e.preventDefault();
              create(custom);
            }}
          >
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="e.g. Ancient Rome, cricket"
              maxLength={80}
              enterKeyHint="go"
              aria-label="Custom topic"
            />
            <button className="btn" type="submit">
              Create
            </button>
          </form>
        </>
      )}

      {error && (
        <div className="err" role="alert">
          <p>{error.text}</p>
          {error.settings && (
            <div className="err-actions">
              <button className="btn small" onClick={onOpenSettings}>
                Add your Gemini key
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Polls the room state. Polls faster near a phase change, slower when the tab is hidden. */
function useRoomState(session: RoomSession, onGone: () => void) {
  const [state, setState] = useState<RoomState | null>(null);
  const [offline, setOffline] = useState(false);
  const [skew, setSkew] = useState(0); // server clock minus local clock, in ms
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (timer.current) clearTimeout(timer.current);
      const t0 = Date.now();
      const r = await postJson("/api/room/state", session);
      const t1 = Date.now();
      if (stopped) return;

      let delay = 1500;
      if (r.ok) {
        const s = r.data as RoomState;
        const sk = Date.parse(s.now) - (t0 + t1) / 2;
        setSkew(sk);
        setState(s);
        setOffline(false);
        if (s.status === "playing" && s.phase_ends_at) {
          const left = Date.parse(s.phase_ends_at) - (Date.now() + sk);
          delay = Math.min(1000, Math.max(200, left + 120));
        } else if (s.status === "done") {
          delay = 2000;
        }
      } else if (errOf(r.data) === "ROOM_NOT_FOUND") {
        return onGone();
      } else {
        setOffline(true);
        delay = 2500;
      }
      timer.current = setTimeout(tick, document.hidden ? 4000 : delay);
    };
    tickRef.current = tick;
    tick();
    const onVisible = () => !document.hidden && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, onGone]);

  const refresh = useCallback(() => tickRef.current(), []);
  return { state, offline, skew, refresh };
}

/** The current time, refreshed every 100ms while active, for countdowns. */
function useClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function RoomView({ session, onLeave }: { session: RoomSession; onLeave: (why?: Err) => void }) {
  const onGone = useCallback(() => onLeave({ text: MESSAGES.ROOM_NOT_FOUND }), [onLeave]);
  const { state: s, offline, skew, refresh } = useRoomState(session, onGone);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [localPick, setLocalPick] = useState<{ key: string; choice: number } | null>(null);
  const [shared, setShared] = useState(false);

  const now = useClock(s?.status === "playing");

  const act = async (action: "start" | "rematch") => {
    setActionErr(null);
    const r = await postJson(`/api/room/${action}`, session);
    if (!r.ok) setActionErr(MESSAGES[errOf(r.data)]);
    refresh();
  };

  const qKey = s ? `${s.round}:${s.q_index}` : "";
  const mine = s?.current?.answers.find((a) => a.player === s.me);
  const picked = mine?.choice ?? (localPick?.key === qKey ? localPick.choice : null);

  const answer = useCallback(
    async (choice: number) => {
      if (!s || s.phase !== "question" || picked !== null) return;
      setLocalPick({ key: qKey, choice });
      await postJson("/api/room/answer", { ...session, q: s.q_index, choice });
      refresh();
    },
    [s, picked, qKey, session, refresh],
  );

  // Keyboard: 1-4 to answer.
  useEffect(() => {
    if (s?.phase !== "question") return;
    const onKey = (e: KeyboardEvent) => {
      if (["1", "2", "3", "4"].includes(e.key)) answer(Number(e.key) - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s?.phase, answer]);

  const share = async () => {
    const url = `${window.location.origin}/?room=${session.code}`;
    const text = `Join my quiz room: ${session.code}`;
    try {
      if (navigator.share) await navigator.share({ title: "Quiz anything", text, url });
      else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        setShared(true);
      }
    } catch {
      /* share sheet dismissed */
    }
  };

  if (!s) {
    return (
      <section className="loading">
        <p className="load-msg">Opening the room</p>
        <LoadingBar writing={false} />
      </section>
    );
  }

  const me = s.players.find((p) => p.id === s.me);
  const others = s.players.filter((p) => p.id !== s.me);
  const nameOf = (id: string | null) => (id === s.me ? "You" : (s.players.find((p) => p.id === id)?.name ?? "Someone"));
  const msLeft = s.phase_ends_at ? Date.parse(s.phase_ends_at) - (now + skew) : 0;
  const secsLeft = Math.max(0, Math.ceil(msLeft / 1000));
  const header = (
    <div className="top">
      <span className="topic">
        {s.topic} · {LEVEL_LABEL[s.difficulty]}
      </span>
      <button className="link" onClick={() => onLeave()}>
        Leave
      </button>
    </div>
  );
  const offlineNote = offline && <p className="note">Connection lost. Trying again…</p>;

  if (s.status === "lobby") {
    const full = s.players.length >= s.max_players;
    return (
      <section>
        {header}
        {offlineNote}
        <p className="hint">Room code</p>
        <p className="room-code" aria-label={`Room code ${s.code.split("").join(" ")}`}>
          {s.code}
        </p>
        <button className="btn plain wide" onClick={share}>
          {shared ? "Invite link copied" : "Share invite link"}
        </button>

        <h2>Players</h2>
        <ul className="players">
          {s.players.map((p) => (
            <li key={p.id}>
              <span>
                {p.name}
                {p.id === s.me && <em> (you)</em>}
              </span>
              {p.away ? <small>away</small> : p.host ? <small>host</small> : null}
            </li>
          ))}
          {Array.from({ length: Math.max(0, s.max_players - s.players.length) }, (_, i) => (
            <li key={`empty-${i}`} className="empty">
              Waiting for a friend to join…
            </li>
          ))}
        </ul>

        <button className="btn wide gap-top" disabled={!full} onClick={() => act("start")}>
          {full ? (s.round > 0 ? "Start rematch" : "Start game") : "Waiting for players"}
        </button>
        {actionErr && (
          <p className="err" role="alert">
            {actionErr}
          </p>
        )}
      </section>
    );
  }

  const scoreboard = (
    <div className="scores">
      {[me, ...others].filter(Boolean).map((p) => (
        <div key={p!.id} className={`score${p!.id === s.me ? " me" : ""}`}>
          <span>{p!.id === s.me ? "You" : p!.name}</span>
          <b>{p!.score}</b>
          {p!.away && <small>away</small>}
        </div>
      ))}
    </div>
  );

  if (s.status === "done") {
    const top = Math.max(...s.players.map((p) => p.score));
    const leaders = s.players.filter((p) => p.score === top);
    const headline =
      leaders.length > 1 ? "It's a draw!" : leaders[0].id === s.me ? "You win!" : `${leaders[0].name} wins`;
    return (
      <section>
        {header}
        <p className="big-title">{headline}</p>
        {scoreboard}
        <div className="row">
          <button className="btn" onClick={() => act("rematch")}>
            Rematch
          </button>
          <button className="btn plain" onClick={() => onLeave()}>
            Leave room
          </button>
        </div>
        {actionErr && (
          <p className="err" role="alert">
            {actionErr}
          </p>
        )}
        <h2>How it went</h2>
        {s.review?.map((r, i) => (
          <div className="miss" key={i}>
            <p>{r.question}</p>
            <span>{r.answer}</span>
            <small className={r.winner === s.me ? "won" : ""}>
              {r.winner ? `Point: ${nameOf(r.winner)}` : "No point"}
            </small>
          </div>
        ))}
      </section>
    );
  }

  // Playing.
  if (s.phase === "ready" || !s.current) {
    return (
      <section>
        {header}
        {scoreboard}
        <div className="ready">
          <p className="load-msg">Get ready</p>
          <p className="ready-count" aria-live="polite">
            {secsLeft || "Go!"}
          </p>
        </div>
      </section>
    );
  }

  const cur = s.current;
  const reveal = s.phase === "reveal";
  const othersAnswered = others.filter((p) => cur.answers.some((a) => a.player === p.id));
  let status = "";
  if (reveal) {
    status = cur.winner ? (cur.winner === s.me ? "You got the point!" : `${nameOf(cur.winner)} got the point`) : "No point this time";
  } else if (picked !== null) {
    const waiting = others.filter((p) => !cur.answers.some((a) => a.player === p.id));
    status = waiting.length ? `Locked in. Waiting for ${waiting.map((p) => p.name).join(", ")}…` : "Locked in.";
  } else if (othersAnswered.length) {
    status = `${othersAnswered.map((p) => p.name).join(", ")} answered. Hurry!`;
  }
  const timeFrac = reveal ? 0 : Math.max(0, Math.min(1, msLeft / (s.question_seconds * 1000)));

  return (
    <section>
      {header}
      {offlineNote}
      {scoreboard}
      <div className="meta">
        <span>
          Question {s.q_index + 1} of {s.q_count}
        </span>
        <span className={!reveal && secsLeft <= 5 ? "hurry" : ""}>{reveal ? `Next in ${secsLeft}` : `${secsLeft}s`}</span>
      </div>
      <div className="timer" aria-hidden>
        <div className={`timer-fill${timeFrac < 0.34 ? " low" : ""}`} style={{ width: `${timeFrac * 100}%` }} />
      </div>
      <p className="q">{cur.question}</p>
      <div className="opts">
        {cur.options.map((o, i) => {
          let cls = "opt";
          if (reveal) {
            if (i === cur.answer_index) cls += " ok";
            else if (i === picked) cls += " no";
            else cls += " fade";
          } else if (picked !== null) {
            cls += i === picked ? " picked" : " fade";
          }
          const who = reveal ? cur.answers.filter((a) => a.choice === i).map((a) => nameOf(a.player)) : [];
          return (
            <button key={i} className={cls} disabled={reveal || picked !== null} onClick={() => answer(i)}>
              <b>{"ABCD"[i]}</b>
              <span>{o}</span>
              {who.length > 0 && <i className="tags">{who.join(", ")}</i>}
            </button>
          );
        })}
      </div>
      {status && (
        <div className={`fb${reveal ? "" : " quiet"}`} aria-live="polite">
          <strong>{status}</strong>
          {reveal && cur.explanation && <p>{cur.explanation}</p>}
        </div>
      )}
    </section>
  );
}
