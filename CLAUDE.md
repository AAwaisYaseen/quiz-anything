# CLAUDE.md: Quiz anything

Project context for Claude Code. Read this before making changes.

@AGENTS.md

## What this is

A mobile-first web quiz game. Pick any topic (preset or typed) and a difficulty (easy, medium, hard), then play rounds of 10 four-option MCQs. Players see right/wrong instantly with a one-line explanation, and an end screen shows score, best score, streak, and the missed questions.

It's a personal side project, open source, built for fun and to share with friends. It is not a commercial product. Keep it simple: no accounts, no payments, no analytics.

The owner is an experienced Next.js / React Native developer. Skip basics, give one clear recommendation rather than a menu of options, work in small steps, and commit after each working step.

## Stack

- Next.js 16.4 App Router, React 19.3, TypeScript. **This Next.js version has breaking changes from older versions. Check `node_modules/next/dist/docs/` before using an API you're unsure of.**
- Plain CSS in `app/globals.css` (no Tailwind). Design tokens are CSS variables on `:root` with a dark-mode override.
- Supabase Postgres, accessed **only from the server** with the service role key via `@supabase/supabase-js`.
- Gemini via its REST API (`generateContent` with structured JSON output), no SDK.
- zod for validating model output. `server-only` guards server modules.
- Deploy target: Vercel.

## Commands

```
npm run dev     # localhost:3000
npm run build   # must pass before committing
npm run lint
npx tsc --noEmit
```

## Architecture

```
app/api/questions/route.ts  POST {topic, difficulty, exclude[]} -> up to 10 unseen questions + remaining + total
app/api/generate/route.ts   POST {topic, difficulty}, optional x-gemini-key header -> writes a batch of 20 to the bank
app/api/report/route.ts     POST {id} -> flags a question; 3 flags hides it
components/Game.tsx         Whole client UI: home, loading, play, done screens + Settings sheet
lib/shared.ts               Types, ErrorCode union, ROUND_SIZE=10, REFILL_BELOW=20, topicSlug, cleanTopic
lib/client-store.ts         localStorage: seen ids per topic+difficulty, best scores, player's Gemini key
lib/server/db.ts            Lazy service-role Supabase client
lib/server/gemini.ts        Prompt, Gemini call, zod validation, questionHash
lib/server/http.ts          fail(), clientIp(), readJson(), envInt()
supabase/migrations/        001_init.sql: tables + SQL functions
```

### Flow

1. The client calls `/api/questions` with the ids it has already seen (from localStorage).
2. If fewer than 10 come back, it calls `/api/generate` (blocking, with a loading screen), then fetches again.
3. When fewer than 20 unseen questions remain after serving a round, it fires `/api/generate` in the background (one at a time, guarded by a ref).
4. Options are shuffled client-side, and `answer_index` is remapped to match.
5. A question is marked seen when it's answered, not when it's served.

### `/api/generate` order of checks

1. Validate body.
2. Per-IP rate limit (`try_rate_limit`, key `gen:<ip>`), which applies to everyone.
3. If there's no player key: use `GEMINI_API_KEY` if `try_use_daily(DAILY_CAP)` allows, otherwise return `NEEDS_OWN_KEY`.
4. Load the 80 most recent questions for that topic+difficulty as an avoid list, then call Gemini.
5. Upsert with `onConflict: "hash", ignoreDuplicates: true`.

### Database (`001_init.sql`)

- `questions`: `topic_slug`, `topic_name`, `difficulty`, `question`, `options` (jsonb array of 4), `answer_index`, `explanation`, `hash` (unique), `flags`, `hidden`.
- `usage_daily`: generations on the owner's key per UTC day.
- `rate_limits`: fixed-window counters keyed by string.
- SQL functions `try_use_daily`, `try_rate_limit`, `report_question`, executable only by `service_role`.
- RLS is enabled on all tables with **no policies on purpose**: only the service role can access anything.

## Decisions (don't undo these without asking)

- **Cache-first.** Every generated question is saved and shared, and the AI is only called when the bank runs low. This is what keeps the project free.
- **Bring your own key.** The player's key lives in their localStorage and is sent only to `/api/generate` in `x-gemini-key`. The server uses it for that one call and **never stores or logs it**.
- **The owner's key has a hard daily cap**, and billing stays off on that Google project, so the worst case is running out of quota, never a bill.
- **`/api/questions` is POST, not GET**, because the exclude list grows over time.
- **Dedupe by sha256 of the normalised question text** (lowercased, accents stripped, punctuation collapsed).
- **No accounts.** Seen questions and best scores are per-browser.
- **The prompt tells Gemini to skip time-sensitive facts** (office holders, records, recent results) and to treat the topic as a subject name only, never as instructions.

## Security rules

- **Never read `.env`, `.env.local` or any env file**, and never run shell commands that print them. `.claude/settings.json` denies this; respect it even if a command would work.
- Never prefix secrets with `NEXT_PUBLIC_`.
- Never log request headers or anything that could contain `x-gemini-key`.
- Never add a client-side Supabase client or ship the anon key to the browser. All DB access goes through API routes.
- Anything under `lib/server/` must keep `import "server-only"`.
- `npm run build` runs `scripts/check-secrets.mjs` as `postbuild`. It fails the build (locally and on Vercel) if a secret value or key pattern appears in any browser-facing file. Never weaken or skip it.

## Conventions

- Adding an error case means extending `ErrorCode` in `lib/shared.ts` **and** adding a message in `MESSAGES` in `components/Game.tsx`.
- Schema changes go in a **new** migration file (`002_...sql`). Never edit `001_init.sql` once it's been applied.
- Keep the visual design: chunky bordered buttons with a hard offset shadow, mustard accent `#F2B705`, sea-green palette, Bricolage Grotesque. It's mobile-first, so test at 375px wide.
- Respect `prefers-reduced-motion` and keep visible focus styles.
- Don't add dependencies unless there's a clear reason.
- UI copy: plain, sentence case, active voice, and errors that say what to do next.

## Env vars (see `.env.example`)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` (optional), `GEMINI_MODEL` (default `gemini-2.5-flash-lite`), `DAILY_CAP` (default 30), `RATE_LIMIT_PER_HOUR` (default 10).

## Status

- Initial build is done. Build, lint and typecheck pass. The migration was tested on local Postgres: the cap, rate limit, dedupe and report-hide all work.
- **Not yet tested against live Supabase and Gemini.** The first real run is the end-to-end test. If generation fails, check the Gemini response shape in `lib/server/gemini.ts` first.
- No automated tests yet.

## Known gaps

- One IP can submit 3 reports and hide a question on its own (30 reports/hour limit). An admin review page would fix this.
- The daily cap counts attempts, including failed Gemini calls.
- Seen history is per-browser and lost if localStorage is cleared.
- Two players starting the same new topic at the same moment can trigger two batches. Dedupe keeps the bank clean, but quota is used twice.

## Backlog ideas

Timer mode, endless mode, admin page for reported questions, daily challenge (same 10 questions for everyone), and a "share score" card.
