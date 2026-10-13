// Browser-only storage helpers. Everything here lives in the player's localStorage.
import type { Difficulty } from "@/lib/shared";

const KEY_GEMINI = "qa:gemini-key";
const MAX_SEEN = 3000;

function get<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function set(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full or blocked: ignore */
  }
}

const seenKey = (slug: string, d: Difficulty) => `qa:seen:${slug}:${d}`;
const bestKey = (slug: string, d: Difficulty) => `qa:best:${slug}:${d}`;

export const store = {
  getSeen: (slug: string, d: Difficulty) => get<string[]>(seenKey(slug, d), []),
  addSeen(slug: string, d: Difficulty, id: string) {
    const s = get<string[]>(seenKey(slug, d), []);
    if (!s.includes(id)) set(seenKey(slug, d), [...s, id].slice(-MAX_SEEN));
  },
  clearSeen: (slug: string, d: Difficulty) => set(seenKey(slug, d), []),

  getBest: (slug: string, d: Difficulty) => get<number>(bestKey(slug, d), 0),
  setBest: (slug: string, d: Difficulty, n: number) => set(bestKey(slug, d), n),

  getKey: () => get<string>(KEY_GEMINI, ""),
  setKey: (k: string) => set(KEY_GEMINI, k),
  clearKey() {
    try {
      localStorage.removeItem(KEY_GEMINI);
    } catch {}
  },
};
