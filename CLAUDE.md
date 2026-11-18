# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Synqonix is a self-hostable, developer-focused project manager (tasks, sprints, chat, GitHub integration) with a VS Code extension that lives in its own repository (https://github.com/Synqonix/synqonix-vscode-extension) and talks to the API over HTTP. This repo is **two independent apps**, each with its own `package.json` and lockfile. There is no root package and no npm workspaces — do not add either. Use npm (CI runs `npm ci`). Node 22.

| Folder | Stack |
|---|---|
| `api/` | NestJS (ESM, `.js` import suffixes in TS), Prisma + PostgreSQL 17, Socket.IO, JWT |
| `web/` | Next.js App Router (v16, React 19), Tailwind |

`web/CLAUDE.md` / `web/AGENTS.md` warn that this Next.js version has breaking changes: read the relevant guide in `web/node_modules/next/dist/docs/` before writing Next code.

## Commands

Run from inside each app folder. Before a PR, run in each app you touched: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

Dev infrastructure (Postgres :5432 + Dev-Remail :6245, a local Resend-compatible mailbox with `synqonix.local` registered) from the repo root: `docker compose -f docker-compose.dev.yml up -d`. Email is Resend-only (no SMTP): in development the same SDK points at Dev-Remail via `RESEND_BASE_URL`. `docker compose up --build` instead runs the whole stack (API, web, Postgres, Dev-Remail) for trying it out; `--profile demo` adds demo data.

**api/** (first time: `cp .env.example .env`, `npm ci`, `npx prisma migrate deploy`)
- `npm run start:dev` — watch mode on :4000 (Swagger at `/docs`, health at `/api/v1/health/ready`)
- `npm test` — unit tests (`*.spec.ts`, vitest); single file: `npx vitest run src/permissions/permissions.spec.ts`; by name: `npx vitest run -t "name"`
- `npm run test:e2e` — `test/*.e2e-spec.ts` against a real Postgres, runs serially (shared DB) and **wipes users/workspaces in the DB `DATABASE_URL` points at**; use a throwaway DB. Single suite: `npx vitest run --config ./vitest.config.e2e.ts test/tasks.e2e-spec.ts`. Set `THROTTLE_DISABLED=1` to bypass rate limits.
- `npm run lint` (oxlint), `npm run typecheck`, `npm run prisma:migrate` (new migration), `npm run generate:openapi`
- `node scripts/seed-demo.mjs` — demo data (`demo@synqonix.local` / `demo-password-123`)

**web/** (`cp .env.example .env.local`)
- `npm run dev` (:3000), `npm test` (vitest; single file `npx vitest run src/lib/tasks.test.ts`), `npm run lint` (eslint), `npm run typecheck`
- `npm run test:e2e` — Playwright against a running built web app + API started with `THROTTLE_DISABLED=1` (also CSP and axe accessibility checks)
- `npm run generate:api` — regenerate `src/lib/api/schema.d.ts` from `../api/openapi.json`

## Architecture

### Cross-app contract
`api/openapi.json` is the only link between apps; nothing is imported across folders. After changing any endpoint/DTO: `npm run generate:openapi` in `api/`, then `npm run generate:api` in `web/`, and commit all generated files. The VS Code extension is a separate repository that does not read `openapi.json`; keep the endpoints it uses (tasks, comments, timer, notifications, search, projects, workspaces, members) backwards compatible.

### API (`api/src`)
- `app.module.ts` wires one Nest module per domain (auth, workspaces, projects, tasks, agile, channels, github, notifications, search, time, insights, dataio, templates, webhooks, automation, retention, views, realtime, storage, mail, audit). Controllers + services + `dto/` per module; env is validated at boot in `config/env.ts` (bad/missing secrets fail startup). A global rate-limit guard applies everywhere.
- **Permissions:** `permissions/permissions.ts` is the single source of truth mapping workspace roles (OWNER/ADMIN/MEMBER/VIEWER) to permissions; `workspace.guard.ts` and `projects/project-access.service.ts` enforce them (projects can be private). `web/src/lib/permissions.ts` mirrors this for the UI.
- **Events:** modules communicate through `@nestjs/event-emitter` events (`*/events.ts`). Task/chat/notification events feed the Socket.IO `RealtimeGateway` (`realtime/`), notification listeners, automation rules, and outbound webhooks. Realtime events carry only identifiers (clients refetch over HTTP), so HTTP access rules are never bypassed. Rooms: `project:`, `channel:`, `user:`, `presence:`. Clients authenticate with a session JWT or personal API token (tokens can be read-only and/or bound to one workspace). With `REDIS_URL` set, Socket.IO, rate limits and scheduled jobs (`@RunOnce`) work across several API instances; without it everything stays in one process. Keep `socket.data` plain JSON (other instances read it).
- Auth accepts either session JWT or API tokens (`auth/jwt-auth.guard.ts`); the extension uses API tokens or a browser sign-in handoff via the web app.
- Pure logic is split into small testable files with colocated `*.spec.ts` (e.g. `agile/stats.ts`, `insights/series.ts`, `channels/task-keys.ts`). Files go to local disk in dev or S3-compatible storage via presigned links (`storage/`).
- Database: `prisma/schema.prisma`; generated client lands in `src/generated/prisma` (ESM — keep the pinned `.js` import extension). Migrations must be additive and safe on a running system.
- Every new route must be covered by the route matrix in `test/security.e2e-spec.ts`, which fails if a route is reachable unauthenticated unless explicitly listed as public.

### Web (`web/src`)
- `app/` has `(auth)` and `(app)` route groups. Each `page.tsx` is a small server component that exports `metadata` (title) and renders the client `view.tsx` beside it; data is fetched in the browser because the session lives there (access token in localStorage, refresh token in an httpOnly API cookie). `proxy.ts` is the Next 16 request proxy (nonce-based CSP lives in `lib/csp.ts`). Feature components are grouped by domain in `components/` (tasks, views, agile, chat, github, …); `components/ui` holds primitives.
- `lib/api/client.ts` is the typed API client over the generated `schema.d.ts`; `lib/use-query.ts` is the data-fetching hook on TanStack Query (`useQuery([endpointPath, callSiteTag, ...deps], fetcher)`; the cache is cleared on sign-out); `lib/realtime.ts` + `use-project-events.ts` + `components/chat/chat-provider.tsx` handle Socket.IO updates. Domain logic in `lib/*.ts` is pure with colocated `*.test.ts`.

## Conventions
- Follow surrounding code style (oxlint for api, ESLint for web, Prettier configs where present). Use imperative commit messages.
- Add tests for behavior changes; permission checks especially.
- UI must work in light/dark mode and by keyboard.
- Deployment/config docs live in `docs/` (`deployment.md`, `test-plan.md`, `github-integration.md`); `docker-compose.prod.yml` is the production stack.
