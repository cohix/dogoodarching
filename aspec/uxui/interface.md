# User Interface

The app uses a browser/PWA interface; [CLI](cli.md) does not apply.

## Style

Aesthetic:

- Mobile-first training dashboard with rounded cards, compact uppercase section headings, bold metric text and a narrow reading column. `theme.css` uses Aptos/Segoe UI/system sans-serif, 14px card radii and custom form focus borders/shadows.

Brand and colors:

- `frontend/src/theme.css` defines semantic tokens for backgrounds, surfaces, text, borders, accent, green and completion status. The light accent is orange `#d04a26` with green `#266849`; dark mode uses `#ff7954` and `#71c395`. Completed/skipped/upcoming indicators have separate tokens.
- `color-scheme: light dark` and `prefers-color-scheme: dark` follow system preference. No in-app theme switch exists.

Desktop vs mobile:

- The same layout serves both, with a 320px minimum body width and centered `max-w-3xl` content. Top/bottom safe-area insets support installed PWAs. Fixed bottom navigation and padded content keep controls above the device edge; forms and score grids adapt to narrow screens.

## Usage

Layout:

- `App.tsx` gates invite acceptance and authentication, then mounts the athlete or coach shell; both share one title/header and bottom navigation. The header shows no poundage for either role: athlete Today has a History action and all other tabs, including every coach tab, have none. Poundage appears only in content (athlete Today prompt, Gear setups, coach Today cards and the Team athlete header). [Experience](experience.md#regular-usage) owns initial-state and starter-plan behavior.
- Athlete Today shows cycle progress, plan and training summaries. Coach Today lists one card per active athlete with name, cycle/week, poundage or its unset state, the shared six-week grid, cycle arrows, average per week and average per session (“—” before any session). Tapping a card opens that athlete in Team.
- Editing sessions, scores and planned days uses overlays/modals. Mutations refresh queries, with specific missing-record recovery described in [SPA design](../architecture/design.md#component-9). History can load older sessions using the [API cursor](../architecture/apis.md#design).

Menus:

- `components/navigation.ts` defines `athleteNav`: **Today, Log, Plan, Gear, Fuel, Settings**.
- `coachNav` is **Today, Fuel, Team, Settings**; owners use this same navigation with owner-only team controls. Coaches have no personal tracker: the coach shell never loads `/api/tracker` or mounts athlete Today, Log, Plan or Gear, and any other tab id falls back to coach Today.
- Coach Fuel has an add/edit meal form (name, summary, ingredients, method) above the team meal list; each card offers Edit, which prefills the form, and Delete with confirmation. Athlete Fuel lists own check-in meals and team meals newest first, labelling team meals “From your coach”.
- The Team tab contains invitation management and athlete selection. The selected athlete's detail shows the back link, athlete header, current cycle summary, arrows summary (opening the full history) with an inline arrows-by-week chart, the plan editor and then earlier cycles. The current cycle's weekly average divides arrows by the current week, matching Today; completed cycles divide by six. “Back to team” returns to the roster, even when the athlete was opened from coach Today. Permissions are defined in [foundation](../foundation.md#personas).

Empty states:

- `components/Empty.tsx` renders a centered, muted text message inside the standard padded card. Features provide relevant no-data text; loading and network errors have their own messages/retry actions. Team's empty roster prompts creation of an athlete invite; coach Today's empty list points to Team to invite one.

Accessibility:

- Semantic header/main/nav elements, form labels, `aria-label` for selected controls, `aria-current="page"` on active navigation, and `role="status"` for feedback are present. Inputs have focus styling; modal overlays declare `role="dialog"`, `aria-modal` and labelled titles, and use the shared Escape-to-close hook where wired.
- Coverage is incomplete: the custom modal overlays have no shared focus trap/restoration or inert background management, and menu roles alone do not implement arrow-key focus navigation. Small navigation/status text also needs a manual readability review. No comprehensive keyboard, screen-reader or contrast audit is recorded; these are current implementation gaps, not a claim of accessibility conformance.

Machine use:

- Athlete Settings exports/imports version-1 JSON (coaches have no export/import) via `services/transfer.ts`: `{ version: 1, exportedAt, username, data }`. Import requires `version` and `data`; the export's metadata does not choose the destination user, which is always the authenticated account.
- `data` contains `trainingSessions`, `practiceScores`, `practiceScoreEnds`, `programState` (object or null), `cycleWeekPlans`, `plannedSessionOverrides`, `plannedSessionAttachments`, `milestoneChecks`, `maintenanceChecks`, `maintenanceItems`, `inspirationEntries`, `weeklyNotes` and `bowSetups`. These correspond to the [data model](../architecture/design.md#data-model-summary); IDs relate parents/children and can change on import.
- Export includes link attachments, not document/photo bytes or their file rows; it excludes authentication data, team meals and the removed `entries` table. Legacy `entries` keys are accepted and ignored. Import replaces all of the caller's tracker data after validation, with an explicit UI confirmation. Current failure/validation limits and planned hardening are in [transfer design](../architecture/design.md#component-6) and [security](../architecture/security.md#input-validation).
- API date/time encodings are defined in [API objects](../architecture/apis.md#design). There is no machine-facing CLI or separate third-party client contract.
