"use client";

// Pieces shared by solo mode (Game.tsx) and friend rooms (Room.tsx).
import { useEffect, useState } from "react";
import { store } from "@/lib/client-store";
import type { Difficulty, ErrorCode } from "@/lib/shared";

export const PRESETS = [
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

export const LEVEL_LABEL: Record<Difficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

export const MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: "That topic didn't work. Use 2 to 80 characters.",
  NEEDS_OWN_KEY: "Today's free allowance for new questions is used up. Add your own free Gemini key to keep going.",
  RATE_LIMITED: "Too many new-question requests from your network. Try again in an hour.",
  BAD_KEY: "Your Gemini key was rejected. Check it in Settings.",
  OWN_KEY_QUOTA: "Your Gemini key hit its rate limit. Wait a minute and try again.",
  GEN_FAILED: "Couldn't write new questions right now. Try again.",
  SERVER_ERROR: "Couldn't reach the question bank. Check your connection and try again.",
};

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
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

/** Ask the server to write a new batch. Returns an error code, or null on success. */
export async function generate(topic: string, difficulty: Difficulty): Promise<ErrorCode | null> {
  const key = store.getKey();
  const r = await postJson("/api/generate", { topic, difficulty }, key ? { "x-gemini-key": key } : {});
  if (r.ok) return null;
  const code = (r.data as { error?: ErrorCode }).error;
  return code && code in MESSAGES ? code : "GEN_FAILED";
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
export function LoadingBar({ writing }: { writing: boolean }) {
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
