import { db } from "@/lib/server/db";
import { clientIp, fail, readJson } from "@/lib/server/http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const body = await readJson(req);
  const id = body?.id;
  if (typeof id !== "string" || !UUID.test(id)) return fail("BAD_REQUEST", 400);

  const supabase = db();
  const { data: ok, error: rlError } = await supabase.rpc("try_rate_limit", {
    p_key: `report:${clientIp(req)}`,
    p_max: 30,
    p_window_seconds: 3600,
  });
  if (rlError) {
    console.error("rate limit check failed:", rlError.message);
    return fail("SERVER_ERROR", 500);
  }
  if (!ok) return fail("RATE_LIMITED", 429);

  const { error } = await supabase.rpc("report_question", { p_id: id });
  if (error) {
    console.error("report failed:", error.message);
    return fail("SERVER_ERROR", 500);
  }
  return Response.json({ ok: true });
}
