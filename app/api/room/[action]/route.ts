import { db } from "@/lib/server/db";
import { clientIp, fail, readJson } from "@/lib/server/http";
import { cleanToken, hashToken, newRoomCode, newToken } from "@/lib/server/rooms";
import {
  ROOM_MAX_PLAYERS,
  ROOM_QUESTION_SECONDS,
  ROUND_SIZE,
  cleanName,
  cleanRoomCode,
  cleanTopic,
  isDifficulty,
  topicSlug,
  type ErrorCode,
} from "@/lib/shared";

// Friend rooms: POST /api/room/{create|join|state|start|answer|rematch}.
// Players authenticate with the token they got on create/join; only its hash is stored.

type Body = Record<string, unknown> | null;

const STATUS: Partial<Record<ErrorCode, number>> = {
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  ROOM_STARTED: 409,
  NEED_PLAYERS: 409,
  NOT_ENOUGH_QUESTIONS: 409,
  TOO_LATE: 409,
};

/** Calls a room_* SQL function that returns {error} or data. */
async function call(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db().rpc(fn, args);
  if (error) {
    console.error(`${fn} failed:`, error.message);
    return fail("SERVER_ERROR", 500);
  }
  const code = (data as { error?: ErrorCode } | null)?.error;
  if (code) return Response.json(data, { status: STATUS[code] ?? 400 });
  return Response.json(data);
}

async function withinLimit(key: string, max: number) {
  const { data, error } = await db().rpc("try_rate_limit", { p_key: key, p_max: max, p_window_seconds: 3600 });
  if (error) console.error("rate limit check failed:", error.message);
  return !error && Boolean(data);
}

/** Code + token from the body, for actions by a player already in a room. */
function auth(body: Body) {
  const code = cleanRoomCode(body?.code);
  const token = cleanToken(body?.token);
  return code && token ? { p_code: code, p_token_hash: hashToken(token) } : null;
}

async function create(req: Request, body: Body) {
  const name = cleanName(body?.name);
  if (!name) return fail("BAD_NAME", 400);
  const topic = cleanTopic(body?.topic);
  const difficulty = body?.difficulty;
  if (!topic || !topicSlug(topic) || !isDifficulty(difficulty)) return fail("BAD_REQUEST", 400);
  if (!(await withinLimit(`room:${clientIp(req)}`, 20))) return fail("RATE_LIMITED", 429);

  const slug = topicSlug(topic);
  const token = newToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newRoomCode();
    const { data: playerId, error } = await db().rpc("room_create", {
      p_code: code,
      p_topic_slug: slug,
      p_topic_name: topic,
      p_difficulty: difficulty,
      p_max_players: ROOM_MAX_PLAYERS,
      p_question_seconds: ROOM_QUESTION_SECONDS,
      p_token_hash: hashToken(token),
      p_name: name,
    });
    if (error) {
      console.error("room_create failed:", error.message);
      return fail("SERVER_ERROR", 500);
    }
    if (!playerId) continue; // code already taken

    // How many questions the bank has, so the host can top it up before the game starts.
    const { count } = await db()
      .from("questions")
      .select("id", { count: "exact", head: true })
      .eq("topic_slug", slug)
      .eq("difficulty", difficulty)
      .eq("hidden", false);
    return Response.json({ code, token, player_id: playerId, bank: count ?? 0, needed: ROUND_SIZE });
  }
  return fail("SERVER_ERROR", 500);
}

async function join(req: Request, body: Body) {
  const name = cleanName(body?.name);
  if (!name) return fail("BAD_NAME", 400);
  const code = cleanRoomCode(body?.code);
  if (!code) return fail("ROOM_NOT_FOUND", 404);
  // Also caps guessing codes: 60 tries an hour against ~887 million codes.
  if (!(await withinLimit(`join:${clientIp(req)}`, 60))) return fail("RATE_LIMITED", 429);

  const token = newToken();
  const { data, error } = await db().rpc("room_join", { p_code: code, p_token_hash: hashToken(token), p_name: name });
  if (error) {
    console.error("room_join failed:", error.message);
    return fail("SERVER_ERROR", 500);
  }
  const res = data as { error?: ErrorCode; player_id?: string };
  if (res.error) return fail(res.error, STATUS[res.error] ?? 400);
  return Response.json({ code, token, player_id: res.player_id });
}

export async function POST(req: Request, ctx: RouteContext<"/api/room/[action]">) {
  const { action } = await ctx.params;
  const body = await readJson(req);

  if (action === "create") return create(req, body);
  if (action === "join") return join(req, body);

  const who = auth(body);
  if (!who) return fail("ROOM_NOT_FOUND", 404);

  switch (action) {
    case "state":
      return call("room_state", who);
    case "start":
      return call("room_start", { ...who, p_count: ROUND_SIZE });
    case "rematch":
      return call("room_rematch", who);
    case "answer": {
      const q = body?.q;
      const choice = body?.choice;
      if (!Number.isInteger(q) || !Number.isInteger(choice) || (choice as number) < 0 || (choice as number) > 3) {
        return fail("BAD_REQUEST", 400);
      }
      return call("room_answer", { ...who, p_q_index: q, p_choice: choice });
    }
    default:
      return fail("BAD_REQUEST", 404);
  }
}
