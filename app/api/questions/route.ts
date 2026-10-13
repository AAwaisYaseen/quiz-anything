import { db } from "@/lib/server/db";
import { fail, readJson } from "@/lib/server/http";
import { ROUND_SIZE, cleanTopic, isDifficulty, topicSlug, type Question } from "@/lib/shared";

// POST (not GET) so the list of already-seen ids can be long without hitting URL limits.
export async function POST(req: Request) {
  const body = await readJson(req);
  const topic = cleanTopic(body?.topic);
  const difficulty = body?.difficulty;
  if (!topic || !isDifficulty(difficulty)) return fail("BAD_REQUEST", 400);

  const exclude = new Set(
    Array.isArray(body?.exclude)
      ? body.exclude.filter((x): x is string => typeof x === "string").slice(0, 5000)
      : [],
  );

  const { data, error } = await db()
    .from("questions")
    .select("id, question, options, answer_index, explanation")
    .eq("topic_slug", topicSlug(topic))
    .eq("difficulty", difficulty)
    .eq("hidden", false)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) {
    console.error("questions select failed:", error.message);
    return fail("SERVER_ERROR", 500);
  }

  const all = (data ?? []) as Question[];
  const unseen = all.filter((q) => !exclude.has(q.id));

  // Fisher-Yates shuffle, then take a round.
  for (let i = unseen.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unseen[i], unseen[j]] = [unseen[j], unseen[i]];
  }
  const questions = unseen.slice(0, ROUND_SIZE);

  return Response.json({
    questions,
    remaining: unseen.length - questions.length, // unseen left after this round
    total: all.length,
  });
}
