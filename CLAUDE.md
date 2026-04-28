@AGENTS.md
# Inbox Concierge — CLAUDE.md

This file is the source of truth for Claude Code and Cursor when working in this repo. Read it fully before making changes.

## CRITICAL: Next.js 16 — Do Not Trust Training Data

This project uses Next.js 16. Most LLM training data predates Next.js 16 and contains patterns that no longer work. **Before writing or modifying any Next.js-specific code (route handlers, layouts, middleware, request APIs, caching, server actions, etc.), read the relevant guide in `node_modules/next/dist/docs/`.**

Specifically beware of:
- `cookies()`, `headers()`, `draftMode()` — now async, must be `await`ed
- `params` and `searchParams` in pages/layouts — now Promises, must be `await`ed
- `revalidateTag(tag)` — requires a second argument: `revalidateTag(tag, cacheLifeProfile)`
- Default bundler is Turbopack — no custom webpack config
- `"use cache"` directive and Cache Components are the new caching primitive
- Minimum React version is 19 — `useFormState` is replaced by `useActionState`
- AMP, `next/amp`, and related APIs are fully removed
- The `app/` router is the only router — pages router patterns will mislead you

If you're unsure whether a Next.js API has changed, **read the docs in node_modules first**. Do not generate from memory.

## What This Project Is

An AI-powered Gmail triage system. The user authenticates with Google, the system pulls their last 200 threads, and a Claude-powered classification pipeline buckets them into Important / Can Wait / Auto-Archive / Newsletter (plus user-defined custom buckets). The differentiator is **autopilot**: high-confidence classifications auto-execute (archive, label) while low-confidence ones queue for user review.

This is a take-home assignment for Tenex. The bar is production-grade, not demo-grade.

## Architecture (Locked — Do Not Change Without Explicit Approval)

| Concern | Choice |
|---|---|
| Framework | Next.js 16 App Router + TypeScript strict mode |
| Auth | Supabase Auth with Google OAuth (Gmail scopes) |
| Database | Supabase Postgres with Row Level Security |
| Server state | TanStack Query |
| Client state | Zustand (UI state only — modals, expanded panels) |
| API security | Zod validation + Supabase JWT verification on every route |
| Inbound rate limit | Upstash Ratelimit |
| Outbound rate limit | p-limit + exponential backoff on Claude and Gmail calls |
| LLM | Claude API (server-side only, model: claude-sonnet-4-5) |
| Gmail | Gmail REST API via googleapis SDK (server-side only) |
| Error tracking | Sentry (client + server) |
| Logging | Structured JSON logs |
| Testing | Vitest for parser, executor, threshold logic |
| Styling | Tailwind CSS |
| Env validation | Zod-validated env schema, fails at startup if missing |
| Deployment | Vercel |

## Privacy Architecture (Critical — Never Violate)

Email content has three valid locations. Anywhere else is a bug:

1. **Gmail API** — source of truth, always
2. **Next.js server in-memory** — pass-through during a single request lifecycle
3. **Claude API call** — for the duration of classification only

**Never persist to Postgres:** subject, snippet, full body, full sender email, Claude's reasoning text.

**Persist to Postgres:** thread ID, sender domain (parsed from full email), date, classification result (bucket, confidence, action), status flags.

**Logger and Sentry must scrub email content.** Use allowlist serialization (only known-safe field names get logged), not denylist.

**OAuth refresh tokens must be encrypted at rest** with pgcrypto, using a key from env (never in code).

## Thread Definition

A Gmail thread is a conversation (multiple messages with shared subject). The internal `GmailThread` type captures:

- `id` (Gmail thread ID, opaque)
- `subject` (from first message)
- `latestSnippet` (from most recent message — what the user sees in the inbox)
- `latestSender` + `latestSenderDomain` (most recent message)
- `latestDate` (ISO timestamp)
- `isUnread` (any message unread)
- `hasAttachments`
- `labelIds` (Gmail's existing labels)
- `messageCount`

Use `format=metadata` on `users.threads.get` — never fetch full bodies.

## Confidence Thresholds

Stored per-user in `profiles` table. Defaults:

- `>= 0.90` → auto-execute recommended action immediately
- `0.70 - 0.89` → push to review queue with suggested action
- `< 0.70` → bucket only, no action suggested

These are tunable. The user has a settings panel to adjust.

## Classification Pipeline Rules

- Batch size: 20 threads per Claude call
- Max concurrent batches: 5 (use p-limit)
- Per-batch error isolation: one failed batch never blocks others
- Idempotency: skip threads with `classification_status = 'classified'` unless force-rerun
- Retry: 3 attempts with exponential backoff (1s, 2s, 4s) on 429 or 5xx
- Output validation: 3-layer Zod check — JSON shape, thread coverage, bucket validity
- Stream progress to client via Server-Sent Events

## Code Style Rules

- TypeScript strict mode — no `any`, no `!` non-null assertions without comment justification
- All API routes start with: auth verification, Zod body validation, rate limit check
- Every async function has try/catch with typed errors from `lib/errors.ts`
- No `console.log` — use `logger.info` / `logger.error` with structured fields
- No inline styles — Tailwind classes only
- Components: one component per file, named export, PascalCase filename
- Hooks: `use*` prefix, one hook per file
- Server-only modules: top of file `import 'server-only'`

## File Layout

```
app/
  (auth)/login/page.tsx
  (app)/inbox/page.tsx
  api/
    gmail/fetch-threads/route.ts
    gmail/archive/route.ts
    gmail/draft/route.ts
    classify/route.ts
    queue/approve/route.ts
    queue/override/route.ts
  auth/callback/route.ts
  layout.tsx
  page.tsx

components/
  inbox/{InboxView,BucketColumn,EmailCard}.tsx
  queue/{ReviewQueue,ReviewCard}.tsx
  buckets/BucketManager.tsx
  dashboard/AutopilotBar.tsx
  ui/{Badge,Button,Spinner,ConfidenceMeter}.tsx

lib/
  supabase/{client,server,middleware}.ts
  gmail/{client,tokenManager}.ts
  claude/{client,prompts,parser}.ts
  pipeline/{batch,executor,idempotency}.ts
  ratelimit.ts
  logger.ts
  env.ts
  errors.ts

store/
  uiStore.ts             # Zustand — UI only

hooks/
  useThreads.ts          # TanStack Query
  useClassification.ts   # TanStack Query + SSE
  useReviewQueue.ts      # TanStack Query

types/
  thread.ts
  classification.ts
  queue.ts
  supabase.ts            # Generated by Supabase CLI

middleware.ts            # Root middleware for session refresh

supabase/
  migrations/001_init.sql
```

## Commands

- `pnpm dev` — local dev server
- `pnpm build` — production build
- `pnpm test` — run Vitest
- `pnpm lint` — ESLint
- `pnpm typecheck` — tsc --noEmit
- `pnpm db:push` — push migrations to Supabase
- `pnpm db:types` — regenerate TypeScript types from schema

## Pre-commit (Husky)

Runs on every commit:
1. ESLint --fix
2. Prettier --write
3. Type check
4. Vitest run for changed files

## Things That Will Get You Stuck

- Supabase OAuth requires the Google scopes to be configured in BOTH the Google Cloud Console AND the Supabase Auth dashboard. Missing scopes = silent auth success but no Gmail access.
- Gmail API quota: 1 quota unit per `threads.list`, 5 per `threads.get` with metadata. 200 threads = ~1000 units. Default quota is 1B units/day. You will not hit it in dev.
- Vercel API route timeout: 60s on Hobby, 300s on Pro. The classification pipeline is designed to stream so this isn't an issue, but a single API call that processes all 200 threads sequentially WILL time out.
- Claude API rate limit on tier 1: 50 requests/min. With 10 batches running, you're nowhere near. With concurrency >5 you might hit it. p-limit is mandatory.
- Refresh token encryption: pgcrypto's `pgp_sym_encrypt` returns bytea. Storing in `text` column will silently corrupt. Use `bytea`.
- Next.js 16: Turbopack is now the default for `next build` and `next dev`. If you have a custom webpack config it will fail — either migrate or use `--webpack` flag. We don't have a custom webpack config, so this is fine.
- Next.js 16: async request APIs are mandatory (`headers()`, `cookies()`, `draftMode()`, dynamic route params all return Promises). Always `await` them.
- Next.js 16: minimum React version is 19. `@types/react` and `@types/react-dom` must be on v19 too.
- Next.js 16: `revalidateTag` now requires a second argument specifying a `cacheLife` profile.

## When Generating New Code

1. Always check this CLAUDE.md first for the relevant rule
2. If a rule doesn't exist for your case, follow the pattern of existing similar code
3. If still unclear, ask before generating
4. Never reach for a new dependency without explicit approval — the stack is locked
