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

- `App.tsx` gates invite acceptance and authentication, then mounts feature tabs with a shared title/header and bottom navigation. Today shows cycle progress, plan and training summaries; the other headers show poundage or its unset state. [Experience](experience.md#regular-usage) owns initial-state and starter-plan behavior.
- Editing sessions, scores and planned days uses overlays/modals. Mutations refresh queries, with specific missing-record recovery described in [SPA design](../architecture/design.md#component-9). History can load older sessions using the [API cursor](../architecture/apis.md#design).

Menus:

- `components/navigation.ts` defines `athleteNav`: **Today, Log, Plan, Gear, Fuel, Settings**.
- `coachNav` adds **Team** before Settings; owners use this same navigation with owner-only team controls. The personal tabs continue to show the coach's own data.
- The Team tab contains invitation management and athlete selection, with the selected athlete's plan/summary editor. Permissions are defined in [foundation](../foundation.md#personas).

Empty states:

- `components/Empty.tsx` renders a centered, muted text message inside the standard padded card. Features provide relevant no-data text; loading and network errors have their own messages/retry actions. Team's empty roster prompts creation of an athlete invite.

Accessibility:

- Semantic header/main/nav elements, form labels, `aria-label` for selected controls, `aria-current="page"` on active navigation, and `role="status"` for feedback are present. Inputs have focus styling; modal overlays declare `role="dialog"`, `aria-modal` and labelled titles, and use the shared Escape-to-close hook where wired.
- Coverage is incomplete: the custom modal overlays have no shared focus trap/restoration or inert background management, and menu roles alone do not implement arrow-key focus navigation. Small navigation/status text also needs a manual readability review. No comprehensive keyboard, screen-reader or contrast audit is recorded; these are current implementation gaps, not a claim of accessibility conformance.

Machine use:

- Settings exports/imports version-1 JSON via `services/transfer.ts`: `{ version: 1, exportedAt, username, data }`. Import requires `version` and `data`; the export's metadata does not choose the destination user, which is always the authenticated account.
- `data` contains `trainingSessions`, `practiceScores`, `practiceScoreEnds`, `programState` (object or null), `cycleWeekPlans`, `plannedSessionOverrides`, `plannedSessionAttachments`, `milestoneChecks`, `maintenanceChecks`, `maintenanceItems`, `inspirationEntries`, `weeklyNotes` and `bowSetups`. These correspond to the [data model](../architecture/design.md#data-model-summary); IDs relate parents/children and can change on import.
- Export includes link attachments, not document/photo bytes or their file rows; it excludes authentication data and the removed `entries` table. Legacy `entries` keys are accepted and ignored. Import replaces all of the caller's tracker data after validation, with an explicit UI confirmation. Current failure/validation limits and planned hardening are in [transfer design](../architecture/design.md#component-6) and [security](../architecture/security.md#input-validation).
- API date/time encodings are defined in [API objects](../architecture/apis.md#design). There is no machine-facing CLI or separate third-party client contract.
