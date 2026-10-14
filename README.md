# Quiz anything

A mobile-first quiz game: pick any topic and difficulty, answer rounds of 10 multiple-choice questions, and see the right answer with a one-line explanation when you miss.

Questions are written by Gemini and saved to a shared Supabase bank, so each one is generated once and then played for free by everyone after that. When the bank runs low on a topic, the app writes a new batch, either on the owner's key (within a small daily cap) or on the player's own free Gemini key.

## How it works

- **Play from the bank first.** `POST /api/questions` returns up to 10 questions the player hasn't seen. Seen question ids live in the player's localStorage, so no accounts are needed.
- **Refill in the background.** When fewer than 20 unseen questions remain, the client calls `POST /api/generate` so the next round is ready. If a round can't be filled at all, it generates before starting.
- **No duplicates.** Each question's normalised text is hashed (`sha256`) with a unique constraint, and Gemini gets the 80 most recent questions for that topic as an "avoid" list.
- **Bring your own key.** If a player saves a key in Settings, it is sent in the `x-gemini-key` header to `/api/generate` only, used for that single call, and never stored or logged by the server. Without one, generation uses `GEMINI_API_KEY` up to `DAILY_CAP` batches per UTC day, then asks the player to add their own.
- **Abuse limits.** `/api/generate` is limited per IP (`RATE_LIMIT_PER_HOUR`, everyone, own key or not), and `/api/report` to 30 per IP per hour.
- **Quality.** Gemini returns structured JSON, which is validated with zod (4 distinct options, valid answer index). Players can report bad questions; 3 reports hide one.

## Setup

1. **Install:** `npm install`
2. **Supabase:** create a free project, open the SQL editor, and run `supabase/migrations/001_init.sql`.
3. **Gemini:** create a key at https://aistudio.google.com/apikey. Keep billing **off** on that Google Cloud project, then the worst case is running out of free quota, never a bill.
4. **Env:** copy `.env.example` to `.env.local` and fill it in:

   | Variable | What it is |
   | --- | --- |
   | `SUPABASE_URL` | Project URL (Project settings > API) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Service role key. Server only, full DB access. |
   | `GEMINI_API_KEY` | Your key. Leave empty to require players' own keys. |
   | `GEMINI_MODEL` | Default `gemini-3.5-flash-lite`. Any free-tier Flash/Flash-Lite model works. |
   | `DAILY_CAP` | Batches per UTC day on your key. Default 30. |
   | `RATE_LIMIT_PER_HOUR` | Generate requests per IP per hour. Default 10. |

5. **Run:** `npm run dev` and open http://localhost:3000

## Deploy (Vercel)

Import the repo, add the same env vars in Project settings > Environment Variables, and deploy. `/api/generate` sets `maxDuration = 60` because a batch of 20 can take a while.

## Security notes

- Never give these env vars a `NEXT_PUBLIC_` prefix. That would ship them to every browser.
- All tables have RLS enabled with no policies, and the SQL functions can only be executed by `service_role`. The public anon key can't touch anything.
- `lib/server/*` imports `server-only`, so the build fails if server code is ever imported into a client component.
- `.claude/settings.json` denies Claude Code read access to `.env` files. Still check approval prompts for shell commands that touch them.
- If the service role key ever leaks, rotate it in the Supabase dashboard immediately.

## Project layout

```
app/
  api/questions/route.ts   serve unseen questions from the bank
  api/generate/route.ts    write a new batch with Gemini (key fallback, caps, dedupe)
  api/report/route.ts      flag a question
  layout.tsx, page.tsx, globals.css
components/Game.tsx        the whole game UI + settings sheet
lib/shared.ts              types and helpers used on both sides
lib/client-store.ts        localStorage (seen ids, best scores, player's key)
lib/server/                db client, Gemini call, HTTP helpers
supabase/migrations/       schema + SQL functions
```

## Ideas for later

- Timer mode or an endless mode
- Admin page to review reported questions
- Daily challenge: same 10 questions for everyone
