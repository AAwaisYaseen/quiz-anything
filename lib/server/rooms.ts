import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@/lib/shared";

export function newRoomCode(): string {
  let c = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) c += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return c;
}

/** A player's secret. The browser keeps it; the database only ever sees its hash. */
export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function cleanToken(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{32}$/.test(v) ? v : null;
}
