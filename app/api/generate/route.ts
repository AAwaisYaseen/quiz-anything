import { db } from "@/lib/server/db";
import { GeminiError, generateQuestions } from "@/lib/server/gemini";
import { clientIp, envInt, fail, readJson } from "@/lib/server/http";
import { cleanTopic, isDifficulty, topicSlug } from "@/lib/shared";

export const maxDuration = 60;

const BATCH = 20;

export async function POST(req: Request) {
  const body = await readJson(req);
  const topic = cleanTopic(body?.topic);
  const difficulty = body?.difficulty;
  if (!topic || !isDifficulty(difficulty)) return fail("BAD_REQUEST", 400);

  // A player's own key. Used for this one call only: never stored, never logged.
  const ownKey = req.headers.get("x-gemini-key")?.trim() || null;
  const supabase = db();

  // Per-IP limit applies to everyone, own key or not, so nobody can flood the bank.
  const { data: withinLimit, error: rlError } = await supabase.rpc("try_rate_limit", {
    p_key: `gen:${clientIp(req)}`,
    p_max: envInt("RATE_LIMIT_PER_HOUR", 10),
    p_window_seconds: 3600,
  });
  if (rlError) {
    console.error("rate limit check failed:", rlError.message);
    return fail("SERVER_ERROR", 500);
  }
  if (!withinLimit) return fail("RATE_LIMITED", 429);

  let apiKey = ownKey;
  if (!apiKey) {
    const serverKey = process.env.GEMINI_API_KEY;
    if (!serverKey) return fail("NEEDS_OWN_KEY", 429);
    const { data: allowed, error } = await supabase.rpc("try_use_daily", {
      p_cap: envInt("DAILY_CAP", 30),
    });
    if (error) {
      console.error("daily cap check failed:", error.message);
      return fail("SERVER_ERROR", 500);
    }
    if (!allowed) return fail("NEEDS_OWN_KEY", 429);
    apiKey = serverKey;
  }

  const slug = topicSlug(topic);

  // Recent questions on this topic+difficulty, so Gemini avoids repeating them.
  const { data: existing } = await supabase
    .from("questions")
    .select("question")
    .eq("topic_slug", slug)
    .eq("difficulty", difficulty)
    .order("created_at", { ascending: false })
    .limit(80);

  let generated;
  try {
    generated = await generateQuestions({
      topic,
      difficulty,
      count: BATCH,
      avoid: (existing ?? []).map((r) => r.question as string),
      apiKey,
    });
  } catch (e) {
    if (e instanceof GeminiError) {
      if (e.kind === "BAD_KEY") return ownKey ? fail("BAD_KEY", 400) : fail("GEN_FAILED", 502);
      if (e.kind === "QUOTA") return ownKey ? fail("OWN_KEY_QUOTA", 429) : fail("NEEDS_OWN_KEY", 429);
    }
    return fail("GEN_FAILED", 502);
  }

  if (generated.length === 0) return Response.json({ added: 0 });

  const rows = generated.map((g) => ({
    topic_slug: slug,
    topic_name: topic,
    difficulty,
    question: g.question,
    options: g.options,
    answer_index: g.answer_index,
    explanation: g.explanation,
    hash: g.hash,
  }));

  // ON CONFLICT (hash) DO NOTHING: duplicates of anything already in the bank are dropped.
  const { data: inserted, error: insError } = await supabase
    .from("questions")
    .upsert(rows, { onConflict: "hash", ignoreDuplicates: true })
    .select("id");

  if (insError) {
    console.error("insert failed:", insError.message);
    return fail("SERVER_ERROR", 500);
  }

  return Response.json({ added: inserted?.length ?? 0 });
}
