# Project Foundation

Name: Do Good Arching  
Type: saas  
Purpose: multi-user archery training tracker for athletes and their coach.

One deployment is one shared coaching team. Start with the [README quick start](../README.md#quick-start); this folder is the design reference.

# Technical Foundation

## Languages and Frameworks

### Frontend

Language: TypeScript  
Frameworks: React 19, Tailwind CSS v4, TanStack Query, Recharts and Vite; installable PWA.

Guidance:

- Keep the application shell in `frontend/src/App.tsx`, feature UI in `features/`, reusable UI in `components/`, and client utilities in `lib/`.
- Use the typed `api.ts` client and invalidate TanStack Query data after writes. Keep domain data on the API; see [caching](architecture/design.md#component-10).
- Use shared safe links and the existing theme and navigation patterns; see [interface](uxui/interface.md).

### Backend

Language: TypeScript on Cloudflare Workers  
Frameworks: Hono, Zod, Drizzle ORM for D1, and R2 for uploaded files.

Guidance:

- Keep routes thin: validation, access checks, service calls and HTTP responses. Route modules must not import other route modules.
- Put domain functions in `src/services/`, taking explicit database, user ID and input dependencies; pass the R2 bucket explicitly when needed.
- Centralize schemas in `lib/validation.ts`, date arithmetic in `lib/dates.ts`, HTTP helpers in `lib/http.ts` and access checks in `lib/rbac.ts`.
- Use WebCrypto and Cloudflare bindings in runtime code, without Node-only APIs. Node tooling is confined to development/build scripts.

# Best Practices

- Organize code in small, simple, modular components
- Each component should contain unit tests that validate its behaviour in terms of inputs and outputs
- The overall codebase should contain integration tests that validate the interation between components that are used together
- Scope every tracker query by `user_id`. Import relationship mapping and all replacement writes are scoped to the authenticated account.
- Route coach access to an athlete's plans and summaries through `resolveAthlete`; the download authorization exception is explicit in the RBAC table below.
- Use `batch()` for D1 writes that must be atomic; never use `transaction()`.
- Share field validation schemas between write endpoints and import, including calendar dates and HTTP(S) URLs; enforce import relationships and resource budgets before writes.

# Personas

The following table is the detailed access reference. The [README roles table](../README.md#roles--permissions-enforced-server-side-on-every-endpoint) is its quick-start summary. Owner is a coach with `isOwner`, not a third stored role.

| Capability | Athlete | Coach | Owner |
|---|---|---|---|
| Own tracker data and own export/import | Full access | None (no personal tracker) | None (no personal tracker) |
| Athlete plans, schedule and plan attachments | Own only | View/edit every athlete | View/edit every athlete |
| Athlete weekly/cycle summaries | Own only | View every athlete | View every athlete |
| Team overview of active athletes' current cycles | No | Yes | Yes |
| Team meals in Fuel | Read all | Create/edit/delete any | Create/edit/delete any |
| Another user's individual sessions, scores, notes, setups, maintenance or inspiration | No | No | No |
| List athletes | No | Active by default; include deactivated | Active by default; include deactivated |
| Invite athletes | No | Yes | Yes |
| Invite coaches and list coaches | No | No | Yes |
| List/revoke invites | No | Own invites | All invites |
| Download plan files | Own files | Any stored plan file | Any stored plan file |
| Target another coach through athlete-edit endpoints | No | No | No |
| Deactivate/reactivate athletes | No | Yes | Yes |
| Transfer ownership to another active coach | No | No | Yes |
| Delete own account with password | Yes | Unless last active coach | Transfer ownership first |

Download authorization currently checks attachment ownership **or any coach role**. Coaches no longer own plan files, so this covers athlete files. Inviter provenance grants no permissions. All cross-user exports are forbidden.

Any coach may deactivate an athlete: login stops, sessions are revoked, and the default roster hides them. Data and the reserved username remain; coaches retain plan/summary access. Reactivation restores login eligibility but not old sessions. Coaches cannot be deactivated through these endpoints.

An owner must transfer ownership before account deletion; the last active coach is also explicitly refused. Password-confirmed deletion removes the caller's personal rows and queues their blobs for post-commit cleanup. Deleting a non-owner coach leaves all athletes and files on their plans intact; inviter references become null and unexpired athlete invites remain usable. Old-owner or creatorless coach invites cannot be accepted. UI flows are in [experience](uxui/experience.md#signup-and-account).

### Persona 1:

Name: Owner  
Purpose: establish and administer the shared coaching team.

Use-cases:

- Bootstrap the first account, invite coaches and athletes, manage invitations and coach athletes.

RBAC:

- Allowed: all Coach capabilities, coach invitations, the coach roster and all invite listing/revocation.
- Disallowed: other users' private logs, cross-user export/import and targeting coach accounts through athlete endpoints.
- Transfer ownership to another active coach with password confirmation. The guarded batch rechecks eligibility and ownership; a stale transfer fails without removing the owner.

### Persona 2:

Name: Coach  
Purpose: coach any athlete in the deployment-wide team.

Use-cases:

- Invite athletes, edit their plans and attachments, adjust schedules and review weekly/cycle aggregates, including the team overview on Today.
- Post, edit and delete team meals that appear in every athlete's Fuel.

RBAC:

- Allowed: every athlete's plans and summaries, the team overview, team meals, athlete invitations, own invitation management and athlete deactivation/reactivation.
- Disallowed: personal tracker routes and export/import (403; coaches have no personal training data), coach invitations, coach roster, other coaches' invite management, athletes' individual logs and athletes' own inspiration entries.

### Persona 3:

Name: Athlete  
Purpose: plan and record personal archery training.

Use-cases:

- Log training and scores, keep weekly notes, manage gear, edit plans and export/import personal data.

RBAC:

- Allowed: own data, including export/import, and reading team meals; own plans and summaries are visible to all coaches.
- Disallowed: other users' data, team/coach endpoints (including meal writes) and invitation management.
