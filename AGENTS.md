<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
Inbox Concierge — Agent Instructions
Read CLAUDE.md for the full project context, architecture, and code style rules. That file is the source of truth. This file exists as a cross-agent entry point.
Quick Reference

Stack: Next.js 16, TypeScript strict, Supabase Auth + Postgres, Tailwind, TanStack Query, Zustand, Claude API, Gmail API
Privacy rule: never persist email content (subject, snippet, body, full sender) to the database. Only opaque metadata.
Code style: no any, no console.log (use structured logger), no inline styles, all API routes have auth + Zod + rate limit
Before writing Next.js code: read node_modules/next/dist/docs/ for the relevant API. Do not generate from training data.
Before changing architecture: stop and ask. The stack is locked.

Common Pitfalls

cookies(), headers(), draftMode() are async in Next.js 16 — must be awaited
params and searchParams are Promises in pages/layouts — must be awaited
revalidateTag(tag, cacheLifeProfile) requires the second argument
Turbopack is default — no custom webpack config
React 19 minimum — useFormState replaced by useActionState

For everything else, see CLAUDE.md.