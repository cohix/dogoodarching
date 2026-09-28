# Do Good Arching

A multi-user archery training tracker for **athletes** and **coaches**, built on the
native Cloudflare stack: **Workers** + **D1** (via Drizzle ORM) + **R2**, with a React
single-page app served from the same Worker. Installable as a PWA on iOS and Android.

Coaches manage a team of athletes: they can view and edit their athletes' training
**plans** and **weekly/cycle summaries**, while athletes' individual log entries
(sessions, scores, notes) stay private.

## Stack

- Runtime: Cloudflare Workers (TypeScript, no Node-only dependencies)
- API: [Hono](https://hono.dev), validation with [Zod](https://zod.dev)
- Database: Cloudflare D1, accessed via [Drizzle ORM](https://orm.drizzle.team)
- File attachments: Cloudflare R2
- Frontend: React 19 + Tailwind CSS v4 + TanStack Query + Recharts, built with Vite
  and served from the Worker via Workers Static Assets (SPA fallback)
- Auth: username + password (WebCrypto PBKDF2), sessions in D1, `httpOnly` cookie

## Prerequisites

- Node.js 20+ and npm
- A Cloudflare account (`npx wrangler login`)

## Quick start

```bash
npm install
npx wrangler login
```

### 1. Create the D1 database

```bash
npx wrangler d1 create do-good-arching
```

Copy the returned `database_id` into `wrangler.toml` (replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`).

### 2. Create the R2 bucket (plan attachments: documents/photos)

```bash
npx wrangler r2 bucket create do-good-arching-attachments
```

### 3. Apply migrations

```bash
npm run db:migrate:local   # local dev database
npm run db:migrate         # production (remote) database
```

Migrations live in `migrations/` and create an empty schema — no seed data.

### 4. Local development

```bash
npm run build   # typecheck + build the frontend into dist/client
npm run dev     # wrangler dev -> http://localhost:8787 with local D1 + R2
```

On the first run against a fresh database, run the migrations first
(`npm run db:migrate:local`).

### 5. Deploy

```bash
npm run deploy   # builds, then `wrangler deploy`
```

That's it — one Worker serves both the API and the app.

## First run: accounts, roles, invites

There is no pre-seeded admin. The flow is:

1. Open the deployed app. With zero users in the database you'll see
   **"Create coach account"** — pick a username and password. This bootstraps
   the first **Coach**.
2. As the coach, open the **Team** tab → **Invite athlete**. You'll get a magic
   link like `https://your-app.workers.dev/invite/<token>` (single-use, expires
   in exactly 24 hours). Share it with the athlete out of band (there is no
   email service in v1).
3. The athlete opens the link, chooses a username + password, and joins your team.

### Roles & permissions (enforced server-side on every endpoint)

| | Athlete | Coach |
|---|---|---|
| Own training data (sessions, scores, notes, gear, …) | full access | full access (own account) |
| Athlete's **plans** (weekly rhythm, cycle plans, schedule, attachments) | own only | view + edit for their team |
| Athlete's **weekly/cycle summaries** (arrow counts, completion pips) | own only | view for their team |
| Athlete's **individual log entries** (sessions, practice scores, weekly notes, gear setups, maintenance) | own only | **never visible** |

## Data export / import

Both roles get **Settings → Export my data**: a single JSON download
(`dga-export-YYYYMMDD.json`) containing the account's full training data, and a
matching **Import** that replaces the account's data after validation. Export is
strictly per-account — there is no cross-user export.

Limitation: uploaded document/photo attachments live in R2 and are **not**
included in the JSON export (link attachments are). Re-upload files after an
import if needed.

## PWA: install on your phone

The app ships a web manifest, iOS meta tags, and a lightweight service worker,
so athletes and coaches can add it to their home screens:

- **iOS (Safari):** open the app → Share → **Add to Home Screen**.
- **Android (Chrome):** open the app → menu → **Add to Home screen** (or Install).

The service worker caches only the static app shell for fast loads; **all
`/api/*` requests are network-only** — the cloud database is always the source
of truth and API data is never served stale. There is no offline data sync in v1.

## Project structure

```
src/
  index.ts            Worker entry (Hono app, mounts all /api routes)
  db/
    schema.ts         Drizzle schema — every tracker table scoped by user_id
    index.ts          D1 client + Env bindings (DB, ATTACHMENTS)
  lib/
    auth.ts           PBKDF2 passwords, session/invite tokens, cookies (WebCrypto only)
    rbac.ts           auth middleware, coach guard, team-membership checks
  routes/
    auth.ts           status, bootstrap, login/logout, me, invites, accept-invite
    tracker.ts        personal tracker endpoints (sessions, scores, plans, gear, …)
    coach.ts          team roster, athlete overviews, coach plan editing
    export.ts         JSON export download + validated import
migrations/
  0001_init.sql       full schema, empty (no seed data)
frontend/
  index.html          SPA shell + PWA manifest / iOS meta tags
  public/
    manifest.webmanifest
    sw.js             app-shell service worker (API is network-only)
    icons/            PWA icons (192/512/maskable/apple-touch)
  src/
    App.tsx           full UI: dashboard, log, plan, gear, fuel, team, settings
    api.ts            typed fetch client for every /api endpoint
    theme.css         Tailwind v4 theme
```

## API overview

All endpoints are JSON under `/api/*` and require a session cookie except the
marked ones.

- `GET /api/auth/status` (public), `POST /api/auth/bootstrap` (public, first user),
  `POST /api/auth/login` (public), `POST /api/auth/logout`, `GET /api/auth/me`,
  `POST /api/auth/invites` (coach), `POST /api/auth/accept-invite` (public)
- `GET /api/tracker`, `POST /api/sessions`, `PUT/DELETE /api/sessions/:id`,
  `POST /api/scores`, `DELETE /api/scores/:id`, `POST /api/notes/weekly`,
  `POST /api/plan/sessions`, `POST /api/plan/sessions/links`,
  `POST /api/plan/sessions/files`, `DELETE /api/plan/attachments/:id`,
  `GET /api/plan/attachments/:id/file`, `POST /api/plan/weeks`,
  `POST /api/plan/adjust`, `POST /api/checks`, `POST /api/maintenance/...`,
  `POST /api/setups`, `POST /api/setups/:id/duplicate`, `POST /api/inspiration`
- `GET /api/coach/athletes`, `GET /api/coach/athletes/:id/overview`,
  `PUT/POST /api/coach/athletes/:id/plan/...` (coach plan editing)
- `GET /api/export`, `POST /api/import`

## Notes

- No secrets to configure: sessions are random tokens stored in D1; password
  hashing is PBKDF2-HMAC-SHA256 (210k iterations) via WebCrypto.
- The schema is single-migration (`migrations/0001_init.sql`); add new
  migrations as `0002_*.sql` etc. and apply with `npm run db:migrate`.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Verification status

- `npm install`: clean
- `npm run typecheck` (Worker + frontend): clean
- `npm run build`: succeeds; `dist/client/` contains the SPA, PWA manifest, icons, and service worker
- D1 migrations: applied to a local dev database without errors (empty schema)
- Not run: the `wrangler dev` HTTP smoke test (auth flow, RBAC, SPA fallback), because even local wrangler commands contact the Cloudflare API. Verify these flows yourself after `npx wrangler login` with `npm run dev`.
