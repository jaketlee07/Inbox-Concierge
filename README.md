# Inbox Concierge

[Live Demo](https://inbox-concierge-nu.vercel.app)
[Demo Video](https://youtu.be/nNMN9R6wr0U)

An AI-powered Gmail triage system. Sign in with Google, and Claude reads the metadata of your most recent ~200 threads, sorts them into buckets (Important / Can Wait / Auto-Archive / Newsletter, plus any custom ones you create), and — when it's confident — fires the right Gmail action automatically. When it's not confident, the thread lands in a sidebar review queue you can approve, override, or dismiss.

This repo is a take-home for Tenex. It is built to a production-grade bar (auth, RLS, encryption at rest, structured logs, error tracking, rate limits, retries, tests) rather than a demo bar.

---

## Table of Contents

1. [What it does (demo)](#what-it-does-demo)
2. [Why I built it this way](#why-i-built-it-this-way)
3. [Tech choices and trade-offs](#tech-choices-and-trade-offs)
4. [Architecture overview](#architecture-overview)
5. [Privacy contract](#privacy-contract)
6. [Business impact](#business-impact)
7. [Running it locally](#running-it-locally)
8. [Project layout](#project-layout)
9. [Commands](#commands)
10. [Next steps](#next-steps)

---

## What it does (demo)

1. **Sign in with Google.** OAuth requests `gmail.readonly`, `gmail.modify`, and `gmail.compose` scopes. Refresh tokens are encrypted with AES-256-GCM and stored in a service-role-only Postgres table.
2. **Fetch the inbox.** The most recent 200 threads are pulled via the Gmail API in `format=metadata` mode (no bodies). Per-thread failures are isolated — one bad thread never blocks the rest.
3. **Classify with Claude.** A "Classify inbox" button kicks off a Server-Sent Events stream. Threads are batched 20 at a time, run through `claude-sonnet-4-5` with a tool-call schema, capped at 5 concurrent batches via `p-limit`, and parsed through a 3-layer Zod validator (shape → bucket validity → thread coverage).
4. **Autopilot.** Each classification carries a confidence score:
   - `>= 0.90` (default) → the recommended action fires immediately (archive or label in Gmail, write a row to `classifications`).
   - `0.70 – 0.89` → lands in the **Review Queue** in the sidebar with the suggested bucket and confidence meter.
   - `< 0.70` → bucketed only, no action.
     The two thresholds are user-tunable from the settings modal, and there's a one-click "pause autopilot" toggle that funnels everything mid-confidence into the queue instead of auto-firing.
5. **Review queue.** For each queued item: **Approve** (executes the suggested action), **Override** (pick a different bucket — written to an `overrides` table that feeds back into future classification prompts), or **Dismiss**.
6. **Custom buckets.** Add or delete custom buckets from the settings modal. Deletion forces a reassign-target so existing classifications never orphan. Bucket changes prompt a one-click reclassify.
7. **Stats bar.** Live counts of "auto-handled today", "queued for review", and "overrides this week" sit in the header so the user sees the autopilot earning its keep.

---

## Why I built it this way

The brief is a Gmail triage tool, but the **interesting** product question is: _what makes a user trust an AI to touch their inbox?_ The answer isn't "make it smarter" — it's "make it cautious by default and let the user dial in how brave it can get."

So the differentiator is **graduated autonomy**:

- High confidence → act.
- Medium confidence → ask.
- Low confidence → just bucket.
- And let the user move both thresholds independently, plus a kill-switch.

That decision drove almost every other architectural choice:

- The classifier returns a **confidence number**, so we needed structured output (Anthropic tool use, not free-text JSON).
- The same metadata view powers the inbox AND the queue, so we can't store full bodies (privacy contract).
- Auto-execution must be **idempotent** so a crashed pipeline doesn't double-archive — hence the `classification_status` state machine on `threads`.
- Mid-confidence Gmail failures must **degrade to queued** rather than throwing — the user just picks it up in the queue.
- Overrides must feed back into future prompts so the system gets less wrong over time — hence the `overrides` table and a summary string that gets passed in user payload (not the system prompt, so prompt caching still hits).

---

## Tech choices and trade-offs

| Concern            | Choice                                                     | Why                                                                                                                                                                                                                            | Trade-off                                                                                                                                |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Framework          | **Next.js 16 (App Router) + TS strict**                    | Server actions, Route Handlers, SSE, and React Server Components in one runtime. Deploys to Vercel with no glue code.                                                                                                          | Next 16 is brand new — `cookies()`, `headers()`, `params`, `revalidateTag` all changed shape, and the middleware file is now `proxy.ts`. |
| Auth               | **Supabase Auth (Google OAuth)**                           | The Gmail OAuth scopes piggyback on a single sign-in; Supabase's session model gives us a JWT we re-verify on every API route.                                                                                                 | Two sources of truth (Google scopes in the Cloud Console AND in Supabase) — easy to misconfigure once.                                   |
| DB                 | **Supabase Postgres + RLS**                                | Per-user data isolation is enforced _in the database_, not the application — even a buggy route can't leak another user's threads.                                                                                             | RLS policies are easy to write wrong; oauth*tokens deliberately has \_no* policies and is service-role-only.                             |
| Token storage      | **AES-256-GCM at rest, `bytea` columns**                   | Refresh tokens are credentials. pgcrypto + an env-side key gives us encryption-at-rest without bringing in a KMS.                                                                                                              | Key rotation orphans every token (acknowledged in code comments — would warrant a migration path in production).                         |
| Server state       | **TanStack Query**                                         | Threads, classifications, queue, stats, profile all share a single cache. Optimistic updates on review queue mutations are nearly free.                                                                                        | Lots of cache keys to keep invalidations honest — most bug fixes during the build were cache-invalidation bugs.                          |
| Client state       | **Zustand (UI only)**                                      | Modals, expanded panels. Server data does not live in Zustand.                                                                                                                                                                 | None worth flagging — the rule "Zustand never holds server data" is the one to enforce.                                                  |
| LLM                | **Claude Sonnet 4.5** with **tool use**                    | Tool input schema gives us guaranteed JSON shape; `bucket` is `string` (not enum) on purpose so the schema is byte-stable across users with different bucket lists, which keeps the system prompt eligible for prompt caching. | Tool input validation is shallow — bucket-name validity is the parser's job, not the SDK's.                                              |
| Concurrency        | **`p-limit(5)` per pipeline + module-level Gmail limiter** | Caps the in-flight batches at 5 (Anthropic tier-1 friendly) and shares a Gmail budget across concurrent routes.                                                                                                                | Two limiters → two failure modes. Documented inline so future readers don't strip one.                                                   |
| Inbound rate limit | **Upstash Ratelimit (sliding window)**                     | Per-user, per-route. Each route picks a budget appropriate to its weight (1/min for `/classify`, 60/min for app reads).                                                                                                        | Adds a Redis dependency. Cost is negligible (free tier covers this app).                                                                 |
| Retries            | **3 attempts with 1s/2s/4s backoff** on Claude and Gmail   | Handles 429 + 5xx without overwhelming upstreams.                                                                                                                                                                              | Worst-case batch latency is ~93s — the orchestrator's overall budget has to accommodate it.                                              |
| Streaming          | **Server-Sent Events**                                     | One-way, simple, survives Vercel's HTTP runtime, no WebSocket setup. Client gets `pipeline_started`, `batch_complete`, `batch_failed`, `pipeline_complete`, `pipeline_error` events.                                           | Disconnect doesn't cancel server work — we let in-flight DB writes finish, which is the right trade for atomicity.                       |
| Error tracking     | **Sentry**                                                 | Both client and server. Breadcrumbs record user actions ("classify_started", "queue_approve") so we can replay the path to a failure.                                                                                          | Sentry SDK is heavy on the client; we keep it tightly scoped.                                                                            |
| Logging            | **Structured JSON, allowlist-serialized**                  | The logger ships only field names on a known-safe list. A future bug that tries to log `{ subject }` simply won't print it.                                                                                                    | Mistakes here are silent — we mitigate with `logger.test.ts` that asserts the allowlist.                                                 |
| Tests              | **Vitest**                                                 | Unit-tests for the parser (3-layer validator), executor (every branch), token manager (encryption round-trip + invalid_grant path), Gmail client (retry + extractStatus), and the env schema.                                  | No E2E — this is a take-home, not a full QA harness.                                                                                     |
| Styling            | **Tailwind CSS v4 + Radix primitives**                     | No custom CSS, accessible primitives for slider / dialog / tooltip out of the box.                                                                                                                                             | Tailwind class soup is real; `cn()` and `class-variance-authority` keep it readable.                                                     |
| Env validation     | **Zod schema, fails at startup**                           | Boot fails loudly with a per-key message if any required env var is missing or malformed (e.g. `ANTHROPIC_API_KEY` must literally start with `sk-ant-`).                                                                       | None — this should be table stakes.                                                                                                      |

---

## Architecture overview

```
            Browser                                Server (Next.js 16 / Vercel)
            ──────────                             ───────────────────────────
   ┌──────────────────────┐                  ┌──────────────────────────────────┐
   │ /login               │  Google OAuth    │ /auth/callback                   │
   │  Sign in with Google │ ───────────────▶ │  - exchange code → session       │
   └──────────────────────┘                  │  - encrypt refresh token         │
                                             │  - upsert into oauth_tokens      │
                                             └────────────┬─────────────────────┘
                                                          ▼
   ┌──────────────────────┐    GET           ┌────────────────────────┐
   │ /inbox (RSC shell)   │ ◀──────────────  │ Auth-guarded layout    │
   │  + InboxView         │                  └────────────┬───────────┘
   │  + ReviewQueue       │                               │
   │  + AutopilotBar      │                               ▼
   └──────────┬───────────┘             ┌─────────────────────────────────┐
              │   POST /api/gmail/      │ GmailClient (server-only)       │
              │    fetch-threads        │  - getAccessToken (refresh on   │
              │ ────────────────────▶   │    expiry, decrypt at use)      │
              │                         │  - threads.list (200)           │
              │                         │  - threads.get (metadata) × N   │
              │                         │    → Promise.allSettled         │
              │                         │  - upsert thread metadata only  │
              │   threads + cached      │    (no subject/snippet/body)    │
              │   classifications       │  - rehydrate prior              │
              │ ◀────────────────────   │    classifications for reload   │
              │                         └─────────────────────────────────┘
              │
              │   POST /api/classify  (SSE)
              │ ────────────────────▶   ┌───────────────────────────────────┐
              │                         │ Pipeline                          │
              │                         │  ① auth + ratelimit + Zod         │
              │                         │  ② fetch pending threads + buckets│
              │                         │  ③ rehydrate metadata from Gmail  │
              │                         │  ④ runBatches(20 × pLimit(5))     │
              │   pipeline_started      │      └─ Anthropic tool-call       │
              │   batch_complete × N    │      └─ 3-layer Zod parser        │
              │   batch_failed × ?      │  ⑤ executor per thread:           │
              │   pipeline_complete     │      conf ≥ auto → Gmail action   │
              │ ◀────────────────────   │      conf ≥ queue → review_queue  │
              │                         │      else        → bucketed       │
              │                         │  Gmail failure → degrade to queue │
              │                         └───────────────────────────────────┘
              │
              │   POST /api/queue/{approve|override|dismiss}
              │ ────────────────────▶   marks queue row + (approve/override)
              │                         fires the Gmail action.
              │
              │   POST /api/buckets       create / list custom buckets
              │   DELETE /api/buckets/:id reassign-on-delete
              │   GET    /api/stats       autopilot bar counts
              │   GET    /api/profile     thresholds + paused
              │   PATCH  /api/profile     update thresholds / pause
              │
              ▼
   ┌──────────────────────┐
   │ Postgres (RLS on)    │   profiles · buckets · threads · classifications ·
   │                      │   review_queue · overrides · oauth_tokens (svc only)
   └──────────────────────┘
```

### The graduated-autonomy state machine

```
                    Claude returns confidence + bucket + recommended_action
                                              │
                                              ▼
                               ┌────────────────────────────┐
                               │ executor (lib/pipeline)    │
                               └────────────┬───────────────┘
                                            │
        confidence ≥ auto_execute_threshold │       confidence ∈ [queue, auto)
        (and not paused)                    │
        ┌───────────────────────────────────┴────────────┐
        ▼                                                ▼
   action ∈ {archive,label}                  push to review_queue
        │                                    threads.status = 'queued'
        ▼
   call Gmail
        │
        ├── ok    → mark executed, threads.status = 'executed'
        └── fail  → push to review_queue (degrade), threads.status = 'queued'

        confidence < queue_threshold  → just bucket (no action)
```

---

## Privacy contract

This is enforced both in the schema and in code:

**Email content has exactly three valid locations:**

1. The Gmail API (source of truth)
2. The Next.js server's request memory (transient pass-through)
3. The Claude API call (during classification only)

**Anywhere else is a bug.** In particular:

- The DB stores **thread ID, sender domain, latest_date, label IDs, message_count, classification_status** — and that's all.
- It deliberately has **no columns** for: subject, snippet, body, full sender email, or Claude's reasoning text.
- The logger uses an **allowlist** (`threadId`, `userId`, `bucket`, `confidence`, `requestId`, `errorCode`, etc.). A field that is not on the allowlist is silently dropped — there is no way to accidentally log a subject line.
- OAuth refresh tokens are encrypted with **AES-256-GCM** before being written to `oauth_tokens.refresh_token` (a `bytea` column, because `text` would silently corrupt the IV bytes).
- The `oauth_tokens` table has **no RLS policies for the authenticated role**. Only `service_role` (server-side, bypasses RLS) can read or write it.

The reasoning text Claude generates _is_ shown to the user in tooltips and the review queue, because the user owns their own session. It just never crosses the DB boundary.

---

## Business impact

The pitch isn't "another email client." It's **time-saved-per-week with an audit trail**:

- **Top-of-funnel**: a power user with 50–100 newsletter / receipt / automated emails per day reclaims most of that triage in the first week. The "auto-handled today" pill in the header puts that win front and center.
- **Trust ramp**: new users default to a conservative `0.90` threshold, see Claude make the same calls they'd make, and dial it down. The pause toggle is the seatbelt that gets people to try autopilot at all.
- **Defensibility**: the override loop turns one user's correction into a better prompt for that user's next batch — the system becomes more right _for that person_ over time without retraining anything.
- **Privacy as a moat**: "we never store the body of your email" is a credible promise that any consumer-facing email AI has to compete with. The schema enforces it, not just the marketing.
- **Operationally cheap**: classification is the only paid call, and prompt caching plus 20-thread batching keeps it well under a cent per inbox-load on Sonnet 4.5 list prices. Gmail API quota is functionally unlimited for this workload.

---

## Running it locally

### 1. Prerequisites

- Node.js ≥ 20 (Next.js 16 requires it)
- npm (or pnpm/bun — instructions below use npm)
- A Google Cloud Console project with the Gmail API enabled
- A Supabase project (free tier is fine)
- An Anthropic API key (`sk-ant-…`)
- An Upstash Redis REST credential pair

### 2. Clone and install

```bash
git clone <this repo>
cd inbox-concierge
npm install
```

### 3. Set up Google OAuth

In the [Google Cloud Console](https://console.cloud.google.com):

1. Create an OAuth 2.0 Client (type: Web application).
2. Add `http://localhost:3000` (and your deploy URL) as an Authorized JavaScript origin.
3. Add `https://<your-supabase-ref>.supabase.co/auth/v1/callback` as an Authorized redirect URI. **This is Supabase's URL, not yours** — Supabase Auth handles the Google handshake, then redirects to your app's `/auth/callback`.
4. On the OAuth consent screen, add these scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.compose`
5. While the app is in "Testing", add yourself as a test user.
6. Note the **Client ID** and **Client Secret**.

### 4. Set up Supabase

1. Create a Supabase project. Note the project URL, anon key, and service-role key (Project Settings → API).
2. Authentication → Providers → Google: enable it, paste the Google Client ID + Secret, and **add the same Gmail scopes** in the "Additional scopes" field. Both Google AND Supabase need the scopes — missing them in Supabase silently strips them from the issued token.
3. Run the migrations against your project:

   ```bash
   # Option A: psql against your DB
   psql "$SUPABASE_DB_URL" -f supabase/migrations/001_init.sql
   psql "$SUPABASE_DB_URL" -f supabase/migrations/002_overrides.sql
   psql "$SUPABASE_DB_URL" -f supabase/migrations/003_autopilot_paused.sql

   # Option B: paste each file into the Supabase SQL editor in order
   ```

   The `001` migration creates all tables, RLS policies, the auth-signup trigger that seeds the four system buckets, and a default `profiles` row for every new user.

### 5. Set up Upstash Redis

1. Create a Redis database at [console.upstash.com](https://console.upstash.com).
2. Copy the REST URL and REST token.

### 6. Environment variables

Create `.env.local` in the project root:

```bash
# --- Supabase ---
NEXT_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# --- Google OAuth (used server-side for refresh-token grant) ---
GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<secret>

# --- Anthropic ---
ANTHROPIC_API_KEY=sk-ant-...

# --- Upstash ---
UPSTASH_REDIS_REST_URL=https://<host>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<token>

# --- Encryption ---
# At least 32 chars. Generate with: openssl rand -base64 32
# Pick once and never change it — rotating orphans every encrypted refresh token.
DB_ENCRYPTION_KEY=<≥32-char-secret>

# --- Sentry (optional) ---
SENTRY_DSN=
NEXT_PUBLIC_SENTRY_DSN=
```

The Zod env schema (`lib/env.schema.ts`) validates these on boot. Missing or malformed vars fail loudly with a per-key error.

### 7. Run

```bash
npm run dev
```

Open http://localhost:3000. You'll be redirected to `/login`. Sign in with the Google account you added as a test user. After consent you'll land at `/inbox`.

First load fetches your 200 most recent threads (the columns will be empty because nothing is classified yet). Click **Classify inbox** to kick off the pipeline. You'll see threads stream into bucket columns as batches complete. Anything mid-confidence shows up in the **Review queue** sidebar.

### 8. Run the tests

```bash
npm run test         # one shot
npm run test:watch   # watch mode
npm run test:coverage
```

Vitest covers the classifier parser, executor branching, token-manager refresh + revoke flow, Gmail retry/error wrapping, env schema, logger allowlist, and the Gmail API routes.

### 9. Lint / typecheck / format

```bash
npm run lint
npm run typecheck
npm run format
```

Husky runs `lint-staged` on every commit (ESLint --fix, Prettier --write).

---

## Project layout

```
app/
  (auth)/login/                   sign-in page + signInWithGoogle server action
  (app)/inbox/                    auth-guarded inbox page (RSC shell + client view)
  api/
    classify/route.ts             SSE streaming classification pipeline
    classify-preview/route.ts     dry-run a single thread before committing
    gmail/fetch-threads/route.ts  list 200 + getMetadata + upsert metadata
    gmail/archive/route.ts        manual archive
    gmail/draft/route.ts          create draft on a thread
    gmail/label/route.ts          add a label
    queue/{approve,override,dismiss}/route.ts  review-queue mutations
    buckets/[id]/route.ts         delete + reassign
    profile/route.ts              get/patch thresholds + paused
    stats/route.ts                autopilot bar counts
  auth/callback/route.ts          OAuth redirect target — encrypts + persists tokens

components/
  inbox/{InboxView,BucketColumn,EmailCard}.tsx
  queue/{ReviewQueue,ReviewCard,MobileReviewQueueButton}.tsx
  buckets/BucketManager.tsx
  dashboard/{AutopilotBar,SettingsModal}.tsx
  ui/{Badge,Button,Modal,Skeleton,Spinner,Toast,Tooltip,ConfidenceMeter}.tsx
  auth/TokenRevokedModal.tsx

lib/
  supabase/{client,server,middleware,admin}.ts   server / browser / svc-role clients
  gmail/{client,tokenManager,parser}.ts          retrying Gmail wrapper + token refresh
  claude/{client,prompts,parser}.ts              Anthropic tool-use + 3-layer Zod
  pipeline/{batch,executor,idempotency,deps}.ts  batching, confidence routing, dep injection
  api/fetch.ts                                   shared apiFetch (auth + 401 handling)
  auth/revoked.ts                                global token-revoked modal trigger
  sentry/breadcrumbs.ts                          recordUserAction
  ratelimit.ts                                   five Upstash limiters by route weight
  crypto.ts                                      AES-256-GCM at the bytea boundary
  logger.ts                                      allowlist-serialized JSON
  env.{ts,schema.ts}                             Zod-validated env, fails at boot
  errors.ts                                      typed app errors (AppError, AuthError, …)
  buckets.ts                                     SYSTEM_BUCKETS metadata

hooks/
  useThreads.ts useClassification.ts useReviewQueue.ts useBuckets.ts
  useStats.ts useProfile.ts useClassifyPreview.ts

supabase/migrations/
  001_init.sql                    profiles + buckets + threads + classifications
                                  + review_queue + oauth_tokens + RLS + seed trigger
  002_overrides.sql               override capture (feeds back into prompts)
  003_autopilot_paused.sql        pause toggle column

proxy.ts                          root proxy for session refresh (Next 16 — was middleware.ts)
```

---

## Commands

| Command                 | What it does                 |
| ----------------------- | ---------------------------- |
| `npm run dev`           | local dev server (Turbopack) |
| `npm run build`         | production build             |
| `npm run start`         | production server            |
| `npm run lint`          | ESLint                       |
| `npm run typecheck`     | `tsc --noEmit`               |
| `npm run format`        | Prettier --write             |
| `npm run format:check`  | Prettier --check             |
| `npm run test`          | Vitest one-shot              |
| `npm run test:watch`    | Vitest watch mode            |
| `npm run test:coverage` | Vitest with V8 coverage      |

---

## Things that will get you stuck

A few footguns I hit and that future-me would want to know about:

- **Gmail scopes need to be set in Supabase too**, not just Google Cloud Console. Missing them in Supabase = silent auth success but no Gmail access.
- **`oauth_tokens` columns must be `bytea`.** `pgp_sym_encrypt` returns binary; storing it in `text` silently corrupts the IV. The migration is correct — don't "fix" it to text.
- **Refresh tokens are only issued with `prompt=consent` + `access_type=offline`.** Subsequent logins without these silently omit the refresh token, which silently breaks revocation recovery. The `signInWithGoogle` server action sets both.
- **Vercel Hobby's 60s API timeout** is fine for this workload (10 batches × pLimit(5) finishes in ~10–20s) but a single sequential pass over all 200 threads would time out. Don't refactor the orchestrator into a serial loop.
- **Next.js 16 changed the world.** `cookies()` / `headers()` / `params` are async, `revalidateTag` takes a second argument, the middleware file is `proxy.ts`, and Turbopack is the default. Most LLM training data still thinks otherwise. See `CLAUDE.md` and `node_modules/next/dist/docs/`.

---

## Next steps

If this were going past a take-home, the obvious follow-ups are:

1. **Continuous classification.** Right now the pipeline runs on a button click. Wire up Gmail push notifications (Pub/Sub → webhook → classify the new thread only) so the inbox stays sorted as mail arrives.
2. **Smarter override feedback.** The `overrides` table exists and the prompt accepts a summary string; the summary is currently empty. Build a small summarizer (or even a deterministic rules layer: "user always overrides X@domain into Y") and inject it.
3. **Reply suggestions.** The `gmail.compose` scope is already requested and `/api/gmail/draft` works. The natural next product surface is one-click "draft a reply" on Important threads, with a per-thread accept/edit/discard.
4. **Background classification with Vercel Cron + Edge KV state.** Move the SSE stream off the request path so the user can close the tab and come back to a finished inbox.
5. **Pagination beyond the most recent 200.** History import + a bounded backfill job. Keeps the privacy contract intact (still metadata-only) but unlocks "show me all my receipts from last year" use cases.
6. **Multi-account.** The schema is per-`user_id`; today one Supabase user maps to one Google account. A `gmail_accounts` table keyed off the Supabase user would let one human triage multiple inboxes.
7. **Self-hosted deployment story.** Encryption key rotation, a real KMS, CI-driven migrations, observability dashboards (the Sentry + structured logs are the foundation; pulling Postgres + Gmail + Claude latency into a single Grafana board is the next step).
8. **A11y + keyboard shortcuts.** The UI uses Radix primitives and is screen-reader-correct, but power users want `j/k` to navigate the queue, `e` to approve, `o` to override, `d` to dismiss. Cheap to build, big retention win.
