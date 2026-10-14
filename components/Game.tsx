"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { store } from "@/lib/client-store";
import {
  DIFFICULTIES,
  REFILL_BELOW,
  ROUND_SIZE,
  cleanTopic,
  topicSlug,
  type Difficulty,
  type ErrorCode,
  type Question,
} from "@/lib/shared";

type Screen = "home" | "loading" | "play" | "done";
type HomeAction = "replay" | "settings";
type HomeError = { text: string; actions?: HomeAction[] };
type RoundResponse = { questions: Question[]; remaining: number; total: number };

const PRESETS = [
  "General knowledge",
  "World geography",
  "Capitals & flags",
  "History",
  "Science",
  "Logic & IQ puzzles",
  "Space",
  "Countries & cultures",
  "Words & languages",
  "Sports",
  "Inventions",
  "Human body",
];

const LEVEL_LABEL: Record<Difficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

const MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: "That topic didn't work. Use 2 to 80 characters.",
  NEEDS_OWN_KEY: "Today's free allowance for new questions is used up. Add your own free Gemini key to keep going.",
  RATE_LIMITED: "Too many new-question requests from your network. Try again in an hour.",
  BAD_KEY: "Your Gemini key was rejected. Check it in Settings.",
  OWN_KEY_QUOTA: "Your Gemini key hit its rate limit. Wait a minute and try again.",
  GEN_FAILED: "Couldn't write new questions right now. Try again.",
  SERVER_ERROR: "Couldn't reach the question bank. Check your connection and try again.",
};

function shuffleOptions(q: Question): Question {
  const order = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { ...q, options: order.map((i) => q.options[i]), answer_index: order.indexOf(q.answer_index) };
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { error: "SERVER_ERROR" } };
  }
}

async function fetchRound(topic: string, difficulty: Difficulty): Promise<RoundResponse | null> {
  const r = await postJson("/api/questions", {
    topic,
    difficulty,
    exclude: store.getSeen(topicSlug(topic), difficulty),
  });
  return r.ok ? (r.data as RoundResponse) : null;
}

/** Ask the server to write a new batch. Returns an error code, or null on success. */
async function generate(topic: string, difficulty: Difficulty): Promise<ErrorCode | null> {
  const key = store.getKey();
  const r = await postJson("/api/generate", { topic, difficulty }, key ? { "x-gemini-key": key } : {});
  if (r.ok) return null;
  const code = (r.data as { error?: ErrorCode }).error;
  return code && code in MESSAGES ? code : "GEN_FAILED";
}

export default function Game() {
  const [screen, setScreen] = useState<Screen>("home");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [custom, setCustom] = useState("");
  const [topic, setTopic] = useState("");
  const [loadMsg, setLoadMsg] = useState("");
  const [loadWriting, setLoadWriting] = useState(false);
  const [homeError, setHomeError] = useState<HomeError | null>(null);

  const [round, setRound] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [results, setResults] = useState<boolean[]>([]);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [reported, setReported] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<{ best: number; newBest: boolean } | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const genRunning = useRef(false);
  const errRef = useRef<HTMLDivElement>(null);

  // On a phone the error sits below the fold, so bring it into view.
  useEffect(() => {
    if (screen !== "home" || !homeError) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    errRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [screen, homeError]);

  const backgroundGenerate = useCallback((t: string, d: Difficulty) => {
    if (genRunning.current) return;
    genRunning.current = true;
    generate(t, d).finally(() => {
      genRunning.current = false;
    });
  }, []);

  const startRound = useCallback(
    async (raw: string) => {
      const t = cleanTopic(raw);
      if (!t || !topicSlug(t)) {
        setHomeError({ text: MESSAGES.BAD_REQUEST });
        return;
      }
      const d = difficulty;
      setHomeError(null);
      setTopic(t);
      setLoadMsg("Finding questions");
      setLoadWriting(false);
      setScreen("loading");

      let r = await fetchRound(t, d);
      if (!r) {
        setHomeError({ text: MESSAGES.SERVER_ERROR });
        setScreen("home");
        return;
      }

      let genErr: ErrorCode | null = null;
      if (r.questions.length < ROUND_SIZE) {
        setLoadMsg(r.questions.length ? "Writing a few more questions" : "Writing new questions");
        setLoadWriting(true);
        genErr = await generate(t, d);
        if (!genErr) r = (await fetchRound(t, d)) ?? r;
      }

      if (r.questions.length === 0) {
        const actions: HomeAction[] = [];
        if (r.total > 0) actions.push("replay");
        if (genErr === "NEEDS_OWN_KEY" || genErr === "BAD_KEY") actions.push("settings");
        const lead = r.total > 0 ? `You've answered every ${t} question in the bank. ` : "";
        const reason = genErr
          ? MESSAGES[genErr]
          : "No questions came back for that topic. Try wording it differently.";
        setHomeError({ text: lead + reason, actions });
        setScreen("home");
        return;
      }

      setRound(r.questions.map(shuffleOptions));
      setIdx(0);
      setPicked(null);
      setResults([]);
      setStreak(0);
      setBestStreak(0);
      setReported(new Set());
      setSummary(null);
      setNote(
        genErr && r.questions.length < ROUND_SIZE
          ? `Only ${r.questions.length} unseen question${r.questions.length === 1 ? "" : "s"} left. ${MESSAGES[genErr]}`
          : null,
      );
      setScreen("play");
      window.scrollTo(0, 0);

      if (r.remaining < REFILL_BELOW && !genErr) backgroundGenerate(t, d);
    },
    [difficulty, backgroundGenerate],
  );

  const pick = useCallback(
    (i: number) => {
      if (picked !== null || screen !== "play") return;
      const q = round[idx];
      const right = i === q.answer_index;
      setPicked(i);
      setResults((rs) => [...rs, right]);
      if (right) {
        setStreak((s) => {
          const n = s + 1;
          setBestStreak((b) => Math.max(b, n));
          return n;
        });
      } else {
        setStreak(0);
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(40);
      }
      store.addSeen(topicSlug(topic), difficulty, q.id);
    },
    [picked, screen, round, idx, topic, difficulty],
  );

  const finish = useCallback(
    (finalResults: boolean[]) => {
      const slug = topicSlug(topic);
      const score = finalResults.filter(Boolean).length;
      const prev = store.getBest(slug, difficulty);
      const newBest = finalResults.length > 0 && score > prev;
      if (newBest) store.setBest(slug, difficulty, score);
      setSummary({ best: Math.max(prev, score), newBest });
      setScreen("done");
      window.scrollTo(0, 0);
    },
    [topic, difficulty],
  );

  const next = useCallback(() => {
    if (idx + 1 >= round.length) return finish(results);
    setIdx(idx + 1);
    setPicked(null);
    window.scrollTo(0, 0);
  }, [idx, round.length, results, finish]);

  const report = useCallback(async (id: string) => {
    setReported((s) => new Set(s).add(id));
    await postJson("/api/report", { id });
  }, []);

  // Keyboard: 1-4 to answer, Enter for next.
  useEffect(() => {
    if (screen !== "play") return;
    const onKey = (e: KeyboardEvent) => {
      if (picked === null && ["1", "2", "3", "4"].includes(e.key)) pick(Number(e.key) - 1);
      else if (picked !== null && e.key === "Enter") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, picked, pick, next]);

  const runHomeAction = (a: HomeAction) => {
    if (a === "settings") setSettingsOpen(true);
    if (a === "replay") {
      store.clearSeen(topicSlug(topic), difficulty);
      startRound(topic);
    }
  };

  const score = results.filter(Boolean).length;
  const q = round[idx];

  return (
    <main>
      {screen === "home" && (
        <section>
          <div className="head">
            <h1>Quiz anything</h1>
            <button className="link" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          </div>
          <p className="sub">Pick a topic, answer 10 questions, repeat.</p>

          <h2>Difficulty</h2>
          <div className="levels" role="group" aria-label="Difficulty">
            {DIFFICULTIES.map((d) => (
              <button key={d} aria-pressed={difficulty === d} onClick={() => setDifficulty(d)}>
                {LEVEL_LABEL[d]}
              </button>
            ))}
          </div>

          <h2>Tap a topic to start</h2>
          <div className="chips">
            {PRESETS.map((p) => (
              <button key={p} className="chip" onClick={() => startRound(p)}>
                {p}
              </button>
            ))}
          </div>

          <h2>Or type your own</h2>
          <form
            className="own"
            onSubmit={(e) => {
              e.preventDefault();
              startRound(custom);
            }}
          >
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="e.g. Ancient Rome, cricket, the human body"
              maxLength={80}
              enterKeyHint="go"
              aria-label="Custom topic"
            />
            <button className="btn" type="submit">
              Start
            </button>
          </form>

          {homeError && (
            <div className="err" role="alert" ref={errRef}>
              <p>{homeError.text}</p>
              {homeError.actions?.length ? (
                <div className="err-actions">
                  {homeError.actions.includes("replay") && (
                    <button className="btn plain small" onClick={() => runHomeAction("replay")}>
                      Replay seen questions
                    </button>
                  )}
                  {homeError.actions.includes("settings") && (
                    <button className="btn small" onClick={() => runHomeAction("settings")}>
                      Add your Gemini key
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </section>
      )}

      {screen === "loading" && (
        <section className="loading">
          <p className="load-msg" aria-live="polite">
            {loadMsg}
          </p>
          <LoadingBar writing={loadWriting} />
        </section>
      )}

      {screen === "play" && q && (
        <section>
          <div className="top">
            <span className="topic">
              {topic} · {LEVEL_LABEL[difficulty]}
            </span>
            <button className="link" onClick={() => finish(results)}>
              End round
            </button>
          </div>
          {note && <p className="note">{note}</p>}
          <div className="track" aria-hidden>
            {round.map((_, i) => (
              <span
                key={i}
                className={results[i] === true ? "ok" : results[i] === false ? "no" : i === idx ? "now" : ""}
              />
            ))}
          </div>
          <div className="meta">
            <span>
              Score {score}/{results.length}
            </span>
            {streak >= 2 && <span>🔥 {streak} in a row</span>}
          </div>
          <p className="q">{q.question}</p>
          <div className="opts">
            {q.options.map((o, i) => {
              let cls = "opt";
              if (picked !== null) {
                if (i === q.answer_index) cls += " ok";
                else if (i === picked) cls += " no";
                else cls += " fade";
              }
              return (
                <button key={i} className={cls} disabled={picked !== null} onClick={() => pick(i)}>
                  <b>{"ABCD"[i]}</b>
                  <span>{o}</span>
                </button>
              );
            })}
          </div>
          {picked !== null && (
            <div className="fb">
              <strong>{picked === q.answer_index ? "Correct" : "Not quite"}</strong>
              {q.explanation && <p>{q.explanation}</p>}
              <button className="btn wide" onClick={next} autoFocus>
                {idx + 1 >= round.length ? "See results" : "Next question"}
              </button>
              <button className="link report" disabled={reported.has(q.id)} onClick={() => report(q.id)}>
                {reported.has(q.id) ? "Reported, thanks" : "Report this question"}
              </button>
            </div>
          )}
        </section>
      )}

      {screen === "done" && (
        <section>
          <p className="sub tight">
            {topic} · {LEVEL_LABEL[difficulty]}
          </p>
          <p className="big">
            {score}
            <small>/{results.length}</small>
          </p>
          <p className="stats">
            {summary?.newBest ? "New best for this topic!" : `Best on this topic: ${summary?.best ?? 0}`}
            <br />
            Longest streak: {bestStreak}
          </p>
          <div className="row">
            <button className="btn" onClick={() => startRound(topic)}>
              Play again
            </button>
            <button className="btn plain" onClick={() => setScreen("home")}>
              Change topic
            </button>
          </div>
          {results.some((r) => !r) && <h2>Worth remembering</h2>}
          {round.slice(0, results.length).map((rq, i) =>
            results[i] ? null : (
              <div className="miss" key={rq.id}>
                <p>{rq.question}</p>
                <span>{rq.options[rq.answer_index]}</span>
              </div>
            ),
          )}
        </section>
      )}

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}

const WRITING_STEPS = [
  "Picking sub-topics",
  "Writing questions",
  "Adding tricky wrong answers",
  "Checking the answers",
  "Shuffling the options",
];

/**
 * There's no real progress signal from the server, so the bar eases toward a target and never
 * claims to be done early: up to 25% while searching the bank, then on toward 94% over the
 * ~17s it takes to write a batch.
 */
function LoadingBar({ writing }: { writing: boolean }) {
  const [pct, setPct] = useState(4);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const target = writing ? 94 : 25;
    const rate = writing ? 0.012 : 0.1; // share of the remaining gap closed every 100ms
    const id = setInterval(() => setPct((p) => p + (target - p) * rate), 100);
    return () => clearInterval(id);
  }, [writing]);

  useEffect(() => {
    if (!writing) return;
    const id = setInterval(() => setStep((s) => Math.min(s + 1, WRITING_STEPS.length - 1)), 3500);
    return () => clearInterval(id);
  }, [writing]);

  return (
    <>
      <div className="bar" role="progressbar" aria-label="Loading questions">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="load-step" aria-hidden>
        {writing ? `${WRITING_STEPS[step]}…` : " "}
      </p>
    </>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = useState(() => (typeof window === "undefined" ? "" : store.getKey()));
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title">Your Gemini key</h2>
        <p className="sheet-text">
          Questions already in the bank are free to play. Writing new ones uses a small shared daily allowance, or your own
          free Gemini key for unlimited topics.
        </p>
        <p className="sheet-text">
          Your key stays in this browser and is only sent along with requests to write new questions. The server never
          saves or logs it.
        </p>

        {saved ? (
          <div className="keyrow">
            <span>Key added (ends in {saved.slice(-4)})</span>
            <button
              className="btn plain small"
              onClick={() => {
                store.clearKey();
                setSaved("");
              }}
            >
              Remove key
            </button>
          </div>
        ) : (
          <form
            className="own"
            onSubmit={(e) => {
              e.preventDefault();
              const k = draft.trim();
              if (!k) return;
              store.setKey(k);
              setSaved(k);
              setDraft("");
            }}
          >
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Paste your Gemini API key"
              autoComplete="off"
              spellCheck={false}
              aria-label="Gemini API key"
            />
            <button className="btn" type="submit">
              Save
            </button>
          </form>
        )}

        <a className="ext" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          Get a free key from Google AI Studio
        </a>
        <button className="btn plain wide" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
