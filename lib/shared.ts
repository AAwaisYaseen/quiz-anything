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
  | "SERVER_ERROR";

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
