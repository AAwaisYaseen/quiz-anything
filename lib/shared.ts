// Shared between client and server.

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const ROUND_SIZE = 10;
/** When fewer unseen questions than this remain after a round is served, write more in the background. */
export const REFILL_BELOW = 20;

export type Question = {
  id: string;
  question: string;
  options: string[];
  answer_index: number;
  explanation: string;
};

export type ErrorCode =
  | "BAD_REQUEST"
  | "NEEDS_OWN_KEY"
  | "RATE_LIMITED"
  | "BAD_KEY"
  | "OWN_KEY_QUOTA"
  | "GEN_FAILED"
  | "SERVER_ERROR"
  | "BAD_NAME"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ROOM_STARTED"
  | "NEED_PLAYERS"
  | "NOT_ENOUGH_QUESTIONS"
  | "TOO_LATE";

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === "string" && (DIFFICULTIES as readonly string[]).includes(v);
}

/** Trim and collapse whitespace; returns null if the topic is unusable. */
export function cleanTopic(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length < 2 || t.length > 80) return null;
  return t;
}

/** Stable key for a topic. Works for non-Latin scripts too (e.g. Urdu). */
export function topicSlug(topic: string): string {
  return topic
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Friend rooms.
export const ROOM_MAX_PLAYERS = 2;
export const ROOM_QUESTION_SECONDS = 15;
export const ROOM_CODE_LENGTH = 6;
/** No 0/O, 1/I/L: easy to read out loud and type. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function cleanRoomCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== ROOM_CODE_LENGTH) return null;
  return [...c].every((ch) => ROOM_CODE_ALPHABET.includes(ch)) ? c : null;
}

/** Nicknames: 1 to 20 characters, whitespace collapsed. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.replace(/\s+/g, " ").trim();
  return n.length >= 1 && n.length <= 20 ? n : null;
}

export type RoomPlayer = { id: string; name: string; host: boolean; away: boolean; score: number };
export type RoomAnswer = { player: string; choice: number | null; correct: boolean | null };
export type RoomState = {
  code: string;
  topic: string;
  difficulty: Difficulty;
  status: "lobby" | "playing" | "done";
  round: number;
  phase: "ready" | "question" | "reveal" | null;
  q_index: number;
  q_count: number;
  phase_ends_at: string | null;
  now: string;
  question_seconds: number;
  max_players: number;
  me: string;
  players: RoomPlayer[];
  current: {
    question: string;
    options: string[];
    answer_index: number | null;
    explanation: string | null;
    answers: RoomAnswer[];
    winner: string | null;
  } | null;
  review: { question: string; answer: string; winner: string | null }[] | null;
};
