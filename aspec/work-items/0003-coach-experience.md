# Work Item: Feature

Title: Coach-specific Today, navigation, Fuel broadcast and athlete detail layout
Issue: TBD

## Summary:
- Coaches currently get the athlete UI with their own (usually empty) tracker data: Today shows the coach's own cycle, and Log, Plan and Gear edit the coach's own rows (`aspec/uxui/interface.md` "Menus": "The personal tabs continue to show the coach's own data"). This item makes coaches coaching-only accounts:
  1. **Today** shows a list of every active athlete's current-cycle overview with arrow counts and averages, instead of the athlete dashboard.
  2. **Log, Plan and Gear** are not shown to coaches. Coaches no longer have personal training data: the server rejects coach writes to personal tracker routes, and a migration deletes coaches' existing personal data.
  3. **Fuel** lets a coach post a meal that appears in every active athlete's Fuel feed. Coaches can edit and delete team meals.
  4. **Team → athlete detail** shows the current cycle summary, arrows summary and an arrows chart at the top instead of the bottom.
  5. **The header poundage label is removed for everyone.** Every tab except Today currently shows a "N lb" / "Poundage not set" label at the top right; it is removed for coaches and athletes alike.
- Athletes' experience is unchanged except that coach-posted meals appear in their Fuel feed and the header poundage label is gone.
- Builds on 0001 (shared coaching team: every coach sees every athlete) and 0002 (overview privacy, deactivation, CSRF, rate limiting, durable blob cleanup). Applied migrations end at `0006_import_mapping.sql`.

### Current state (2026-09-29)
- Tabs are defined in `frontend/src/components/navigation.ts`. Code ids differ from labels: Today=`dashboard`, Gear=`bow`, Fuel=`nutrition`. `coachNav` is `athleteNav` plus Team. `App.tsx` `TrackerShell` picks the list by `me.role`, defaults to `dashboard`, always loads `/api/tracker` for the signed-in user, and sizes the bottom nav with `nav.length > 6 ? "grid-cols-7" : "grid-cols-6"`. Tab bodies aren't gated by role. Tabs have no URLs; the service worker and manifest don't reference tabs.
- Today is `features/dashboard/Dashboard.tsx`, fed entirely from the `/api/tracker` payload. The hero card shows "Cycle X, Week Y", the 6-week grid and totals "Cycle arrows" and "Average / week" (`cycleTotal / currentWeek`).
- The coach overview is per-athlete only: `GET /api/coach/athletes/:athleteId/overview` → `getCoachOverview` (`src/services/dashboard.ts`), returning exactly `state`, `weeklyPlans`, `plannedSessions`, `weeklyArrows` (last 8 logged weeks) and `cycleSummaries`. Averages are computed on the client. Its query projection is privacy-constrained (`aspec/architecture/security.md` "RBAC"; enforced by `test/worker/coach-overview.test.ts`).
- **Fuel is not a meal log.** `features/fuel/Nutrition.tsx` renders `recipes[]` from the tracker payload, which are the recipe fields of `inspiration_entries` rows. Each row also carries the thought-of-the-day and video; the newest row drives Today's `<Inspiration>` card. Rows are written only by `POST /api/inspiration` to the caller's own account (from an external daily check-in client or import). No UI calls `api.addInspiration`, and there is no coach write path into Fuel.
- Personal tracker routes (`src/routes/tracker.ts`) and export/import (`src/routes/transfer.ts`, "both roles") serve coaches and athletes alike, scoped to `c.get("user").id`. `test/worker/rbac.test.ts` currently asserts that coaches "get their own, empty" tracker.
- Team athlete detail is `AthleteDetail` in `features/team/TeamTab.tsx`. Order: back link, athlete header, `PlanEditor`, "Arrows by week" summary button (opens `ArrowHistoryModal`), then "Cycle summaries" (`CycleSummaryCard`, all cycles, newest first) last.
- Active athletes are `role = 'athlete' AND deactivated_at IS NULL` (`listAthletes` in `src/services/team.ts`). `resolveAthlete` deliberately also matches deactivated athletes.

### Decisions (confirmed with the product owner, 2026-09-29)
- **Meal storage:** coach meals live in a new team-level table, not in athletes' `inspiration_entries`. Every athlete, including those invited later, sees every team meal. Athletes' Today inspiration card is unaffected (§3).
- **Recipients:** all active athletes on the team, matching 0001's shared-team model. There are no per-coach athlete lists and no per-meal recipient selection.
- **Meal management:** any coach can edit or delete any team meal (§3).
- **Coach personal data:** coaches have no personal training data. Log, Plan and Gear are hidden, the server rejects coach access to personal tracker routes, and a migration deletes coaches' existing personal rows and queues their personal R2 files for deletion (§5). There is no existing data to preserve (developer preview only), so no backups are needed.
- **Coach inspiration and export:** coaches' own `inspiration_entries` are deleted too, and personal export/import is athlete-only (§5).
- **Averages on coach Today:** show both **average per week** (current-cycle arrows ÷ current week number, the figure athletes see) and **average per session** (current-cycle arrows ÷ sessions logged this cycle) (§2).
- **Athlete detail top section:** the current cycle's summary, the arrows summary and an inline arrows-by-week chart. Earlier cycle summaries move below the plan editor (§4).
- **Today list interaction:** tapping an athlete opens their detail page in the Team tab (§2).
- **Header poundage label:** removed from every tab for both roles. It is display-only, so no editing path is lost: athletes still set poundage through the Today `PoundagePrompt`, and the per-athlete poundage in coach views stays (§1).

## User Stories

### User Story 1:
As a: coach

I want to:
open the app to a list of all my athletes showing where each is in their cycle, their arrow counts and their averages

So I can:
see at a glance who is on track without opening each athlete one by one

### User Story 2:
As a: coach

I want to:
not see the Log, Plan and Gear tabs

So I can:
work in a navigation that only contains things that apply to coaching

### User Story 3:
As a: coach

I want to:
add a meal once in Fuel, and correct or remove it later, and have it show up in every athlete's Fuel feed

So I can:
share nutrition guidance with the whole team without entering it per athlete

### User Story 4:
As a: athlete

I want to:
see meals my coaches have shared alongside my own, clearly marked as from the team

So I can:
use team nutrition guidance without it replacing my own check-in entries

### User Story 5:
As a: coach

I want to:
see an athlete's current cycle summary, arrow totals and arrows chart first when I open them in the Team tab

So I can:
check their progress before scrolling past the plan editor


## Implementation Details:

### 1. Coach navigation: `frontend/src/components/navigation.ts`, `frontend/src/App.tsx`
- `coachNav` becomes **Today, Fuel, Team, Settings**, with its `mark` numbers renumbered ("01"–"04"). `athleteNav` is unchanged.
- Replace the `nav.length > 6 ? "grid-cols-7" : "grid-cols-6"` switch with a class derived from `nav.length` that covers 4 and 6. Tailwind needs the literal class names present in source.
- Gate tab bodies by role, not just the nav list: a coach must never mount `Dashboard`, `TrainingLog`, `TrainingPlan` or `BowAndGear`, even if tab state holds one of those ids. Fall back to `dashboard`, which renders the coach Today view for coaches.
- **Header poundage label (both roles):** remove the `currentPoundage` label from the `TrackerShell` header (`App.tsx`, the non-Today branch of the header action). Non-Today tabs have no header action. Athletes keep the Today "History" button, and athletes still set poundage through `PoundagePrompt` on Today. Poundage shown inside content is unchanged: the Team athlete header, coach Today cards and the Gear setup form.
- For coaches, the header also has no "History" button (it opens the coach's own cycle history). Coach tabs have no header action.
- The coach shell doesn't load `/api/tracker` (it now returns 403 for coaches, §5). Coach Today and Fuel use the coach endpoints below. Athlete loading is unchanged.

### 2. Coach Today: team overview list
**Server:** `src/services/dashboard.ts`, `src/routes/coach.ts`
- Add `GET /api/coach/overview?today=YYYY-MM-DD` (coach router, so `authMiddleware` + `requireCoach` apply; validate `today` like the existing overview route). Returns active athletes only, ordered by display name, then username:
  ```
  { athletes: [{ id, username, displayName, currentPoundage, currentCycle, currentWeek,
                 currentCycleSummary: { cycle, weeks: [{ weekNumber, weekStart, arrows, dayStatuses }] },
                 cycleArrows, cycleSessions, averagePerWeek, averagePerSession }] }
  ```
- Definitions (one shared server helper, reused anywhere else these figures appear):
  - `cycleArrows`: arrows logged in the current cycle's six weeks.
  - `averagePerWeek`: `cycleArrows ÷ max(currentWeek, 1)`, the same figure as the athlete Dashboard's "Average / week".
  - `cycleSessions`: training sessions logged in the current cycle's six weeks.
  - `averagePerSession`: `cycleArrows ÷ cycleSessions`, or `null` when `cycleSessions` is 0 (the UI shows "—", never 0 or NaN).
  - Round for display only; the API returns unrounded numbers.
- Build it from the same projections `getCoachOverview` uses (program state, SQL arrow sums, distinct session dates) plus a SQL `COUNT` of sessions per athlete in the cycle window, batched across athletes with `IN (...)` / grouped queries. The query count must be constant in the number of athletes (no per-athlete loop of queries). Chunk ID lists to stay within D1's bound-parameter limit.
- Privacy is the same as `getCoachOverview` (`security.md` "RBAC"). Never call `getTrackerPayload`; never select session notes, focus or score, and never read scores, weekly notes, setups, maintenance, milestones or inspiration. The session count is an aggregate over ids/dates only. Add the new function to the projection test.
- Share the week/day-status computation with `loadPlanAndAggregates` rather than duplicating it. Don't change the five-field per-athlete overview response.

**Client:** new `features/coach/CoachToday.tsx`, `frontend/src/api.ts`
- `api.coachOverview(today)` using the client's local-calendar `today` helper, like the per-athlete overview.
- One card per athlete: name, "Cycle X, Week Y", the 6-week grid (reuse `CycleSummaryCard` or extract the Dashboard hero grid into a shared component; don't fork the markup), cycle arrows, average / week, average / session, and poundage or "Poundage not set".
- Tapping a card switches to the Team tab with that athlete's detail open. This needs `TeamTab` to accept a selected athlete id from the shell. Keep it as in-app state; don't add URL routing. "Back to team" from there returns to the Team list, not Today.
- Empty state (no active athletes) points to Team → invite. Loading and error states match other coach queries.
- Invalidate the new query key alongside the existing `coach-overview` key wherever a coach edits a plan or (de)activates an athlete.

### 3. Team meals in Fuel
**Schema and migration:** `src/db/schema.ts`, new migration (numbered after `0006`)
- New table `team_meals`:
  - `id` (autoincrement)
  - `author_id` (FK `users.id`, `ON DELETE SET NULL`, so deleting a coach keeps their meals)
  - `updated_by` (FK `users.id`, `ON DELETE SET NULL`)
  - `name`, `summary`, `ingredients`, `instructions` (default `""`)
  - `created_at`, `updated_at` (`timestamp_ms`)
  - Index on `created_at`.
- Generate with `npm run db:generate`; `npm run db:check` must pass.

**Server:** new `src/services/team-meals.ts`, `src/routes/coach.ts`, `src/services/dashboard.ts`, `src/lib/validation.ts`
- Coach router routes:
  - `GET /api/coach/meals`: newest first by `created_at`.
  - `POST /api/coach/meals`: create.
  - `PUT /api/coach/meals/:id`: full replace of the four text fields; sets `updated_by` and `updated_at`.
  - `DELETE /api/coach/meals/:id`.
- Any coach may edit or delete any meal. A missing id returns 404 for PUT and DELETE.
- Concurrent edits are last-write-wins: two coaches editing the same meal is acceptable, and the list refetches after each save.
- Validation reuses the `inspirationInput` recipe field rules and length limits, via a shared recipe schema. Apply the existing coach-write rate-limit allowance and the standard JSON/CSRF handling.
- The athlete tracker payload merges team meals into `recipes[]`:
  - Keep the existing fields and add `source: "own" | "team"` and a stable `key` (`own:<id>` / `team:<id>`), because the two id spaces collide.
  - Sort newest first, using `created_at` for team meals, so editing a meal doesn't move it to the top.
  - Show the author only by display name, or "Coach" if the author was deleted. Don't expose author ids.
- Team meals never affect `inspiration` (Today's thought/video/power-meal card), which stays the athlete's newest own `inspiration_entries` row.
- Team meals are team data, not the athlete's. They are excluded from personal export and never created by import; version-1 export stays compatible for the existing fields.

**Client:** `features/fuel/Nutrition.tsx`, new coach Fuel view
- Coach Fuel:
  - an "Add meal" form (name, summary, ingredients, instructions) above the team meal list, reusing the existing card and details modal;
  - each card has an edit action (the same form, prefilled) and a delete action with confirmation.
- Athlete Fuel:
  - unchanged layout, with team meals labelled "From your coach";
  - use `key` for React keys;
  - update the intro copy, which currently says the feed is only "Meals from your daily check-ins".

### 4. Athlete detail layout: `features/team/TeamTab.tsx`
- New order:
  1. back link
  2. athlete header
  3. **current cycle summary** (`CycleSummaryCard` for `state.currentCycle`)
  4. **arrows summary** ("N arrows across M logged weeks")
  5. **arrows-by-week chart shown inline**
  6. `PlanEditor`
  7. "Earlier cycles" (the remaining cycle summaries, newest first)
- Extract the recharts bar chart from `ArrowHistoryModal` into a shared component. It is used inline here; after §5 the Log tab is athlete-only, so the modal and the inline widget must render the same component. The arrows summary can still open the modal for the full history.
- No server change: all data is already in the per-athlete overview response.

### 5. Coaches have no personal training data
**Server enforcement:** `src/lib/rbac.ts`, `src/routes/tracker.ts`, `src/routes/transfer.ts`
- Add `requireAthlete` (the counterpart of `requireCoach`) and apply it to every personal tracker route and to export/import:
  - `GET /api/tracker`
  - sessions, scores, weekly notes
  - plan, planned sessions, plan attachments and uploads
  - checks, setups, maintenance
  - `POST /api/inspiration`
  - `/api/export` and `/api/import`
- Coaches get 403 with the standard JSON error body.
- Unaffected: `/api/auth/*`, `/api/me`, Settings (password, sign out everywhere, account deletion, ownership transfer) and all `/api/coach/*` routes. Coach writes into athlete plans keep working because they are stored under the athlete's `user_id`.
- Account-creation paths (bootstrap, coach invite acceptance) must not create personal rows for coaches. Verify that starter-plan/program-state seeding, if any, is athlete-only.

**Data removal migration** (numbered after the team-meals migration, or combined with it)
- For every user with `role = 'coach'`, delete their rows in:
  - `training_sessions`, `program_state`, `cycle_week_plans`, `planned_session_overrides`, `planned_session_attachments`
  - `milestone_checks`, `maintenance_checks`, `maintenance_items`
  - `inspiration_entries`, `weekly_notes`, `practice_scores`, `practice_score_ends`, `bow_setups`
  - their own `upload_reservations` where `user_id` is the coach
- Keep `upload_reservations` where only `actor_id` is the coach: those are uploads into athlete plans.
- Before deleting coach-owned file attachments, insert their blob keys into `blob_cleanup` (reason `coach-data-removal`, `next_attempt_at` = migration time) in the same migration, mirroring `enqueueBlobCleanupFromAttachments`. The scheduled job then deletes the R2 objects. Never delete R2 objects referenced by athlete rows.
- The app has only been deployed as a developer preview, so there is no production data to protect: no backup step, runbook change or deploy-ordering procedure is needed for this migration. Order child tables before parents where FKs don't cascade.

**Client:** `features/settings/SettingsTab.tsx`, `frontend/src/api.ts`
- Hide export/import in Settings for coaches. Keep account controls.

### 6. Documentation
Update in the same change:
- `aspec/uxui/interface.md` ("Layout": remove "the other headers show poundage or its unset state"; "Menus", Team description; remove "The personal tabs continue to show the coach's own data")
- `aspec/uxui/experience.md` ("Regular usage", "Invitations and team/group management", and "Emails, notifications, texts": meals appear in-app, no push notifications)
- `aspec/architecture/apis.md` (team contracts, new coach routes, athlete-only personal routes)
- `aspec/architecture/design.md` (principle 3, components 4/5/9, data model)
- `aspec/architecture/security.md` (RBAC: `requireAthlete`, the new overview's projection rule, coaches write team meals but never read athlete inspiration)
- `aspec/foundation.md` persona table (coach has no personal tracker or export; new coach-to-team Fuel capability)
- `README.md` (roles table, API overview, export description)


## Edge Case Considerations:
- **Coach Today:**
  - An athlete with no program state row still appears, using the same defaults `loadProgramState` applies.
  - Poundage is unset; an athlete has never logged a session (average per session is "—").
  - Week 1 average per week divides by 1; a cycle rollover on `today`; a client `today` that differs from UTC.
  - Many athletes: exceed the D1 parameter limit to prove chunking; confirm the query count is constant.
  - A deactivated athlete is excluded and a reactivated one reappears. A coach account (including the owner) never appears.
- **Navigation:**
  - An owner sees the same four tabs.
  - Stale tab state (e.g. a cached shell) that points at a hidden tab falls back to Today.
  - Bottom-nav layout at 4 and 6 items on a narrow phone.
- **Coach data removal:**
  - A coach with no personal data (the migration is a no-op for them).
  - A coach whose own plan had file attachments (blob keys queued, R2 objects removed by cron, athlete blobs untouched).
  - Coach uploads into athlete plans are unaffected.
  - A coach calling personal routes from a stale client gets 403, not 500.
- **Team meals:**
  - Two coaches post or edit at the same time (last write wins, no lost meal).
  - A coach deletes or edits a meal while an athlete has its details modal open (the modal shows the refreshed or removed state after refetch).
  - Deleting the author's account keeps the meal and shows "Coach".
  - Oversized or empty fields, and a `javascript:` payload in text fields (rendered as text, never as HTML).
  - Cross-site POST/PUT/DELETE is rejected by CSRF; an athlete calling the coach meal routes gets 403.
  - Athlete export/import round-trips don't duplicate, drop or import team meals.
- **Athlete detail:**
  - No logged weeks: an empty chart state, not a blank or zero-height chart.
  - Only one cycle: the "Earlier cycles" section is hidden.
  - A deactivated athlete's detail keeps the same order.

## Test Considerations:
- **Worker (Vitest + `@cloudflare/vitest-plugin`):**
  - `/api/coach/overview`:
    - Returns only active athletes.
    - Per-week arrows, `cycleArrows` and `averagePerWeek` match the per-athlete overview and the athlete's own Dashboard numbers for the same `today`. `cycleSessions`/`averagePerSession` are correct, including `null` at zero sessions.
    - Extend `coach-overview.test.ts`'s projection/table-access assertions to the new function, including that no inspiration, notes, focus or score columns are read.
    - Assert a constant query count as athletes increase.
  - Athletes get 403 on `/api/coach/overview` and all `/api/coach/meals` routes.
  - Coaches get 403 on every personal tracker route and on export/import. Replace the existing "coaches get their own, empty" tracker assertion in `rbac.test.ts`. Coach writes into athlete plans still succeed.
  - Meal CRUD:
    - validation, 404 on missing edit/delete, any coach can edit/delete another coach's meal, `updated_by` is set;
    - CSRF on the new unsafe routes; rate-limit binding selection.
  - The athlete tracker payload merges and orders team meals with `source`/`key` (edits don't reorder) and leaves `inspiration` unchanged.
  - Author deletion sets `author_id` to NULL.
  - Export excludes team meals; import neither creates nor deletes them.
  - Migration tests:
    - Empty and populated databases.
    - A seeded coach with rows in every personal table ends with none.
    - A coach with file attachments ends with those keys queued in `blob_cleanup`.
    - Athlete rows and coach-authored uploads into athlete plans are untouched.
    - `PRAGMA foreign_key_check` stays clean.
- **Frontend (jsdom):**
  - Coach navigation renders exactly Today, Fuel, Team and Settings, and Dashboard/Log/Plan/Gear components are never mounted for a coach. Athlete navigation is unchanged.
  - No tab header shows a poundage label for either role; the athlete Today header still shows "History". Update any existing test that asserts the header pill.
  - The coach shell never requests `/api/tracker`.
  - Coach Today renders the athlete list with both averages ("—" for no sessions), empty and error states, and tapping a card opens that athlete in Team.
  - Coach Fuel adds, edits and deletes (with confirmation) meals. The athlete Fuel feed labels team meals.
  - Settings hides export/import for coaches.
  - `AthleteDetail` renders the current cycle summary, arrows summary and chart before `PlanEditor`, with earlier cycles after it. `ArrowHistoryModal` still works in the Log tab using the shared chart component.
- `npm run typecheck`, `lint`, `docs:check`, `db:check`, `test` and `build` pass.

## Codebase Integration:
- follow established conventions, best practices, testing, and architecture patterns from the project's aspec.
- Keep routes thin and put logic in `src/services/`. Coach services receive ids from `requireCoach`/team queries; recipient lists come from the active-athlete query, not `resolveAthlete`.
- Reuse `validateJson`, `rateLimit`, `enqueueBlobCleanupFromAttachments`, the local-calendar `today` helpers, `CycleSummaryCard` and the existing query-invalidation patterns. Don't add a client router.
