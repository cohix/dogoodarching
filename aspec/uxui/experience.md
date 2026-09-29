# Experience

## Signup and account

Signup flow:

- A fresh database shows first-coach bootstrap. The first coach is the owner; later accounts join through owner/coach-issued invitations according to [RBAC](../foundation.md#personas).
- Invite links are shared out of band, with no email service. These are account-creation links, not passwordless login: the recipient chooses a username and password. New links use fragments, with immediate token capture/URL scrubbing and legacy path compatibility described in [security](../architecture/security.md#api-security).

Account management:

- Settings shows username/role, export/import and current-session logout. Change password asks for current, new and confirmed passwords, displays mismatch/server errors, and keeps this session while revoking others. Sign out everywhere and successful account deletion clear account caches and return to authentication. Import rejects files over 8 MB before reading, displays indexed server validation/resource errors, and clears account caches on authentication failure. Forgotten passwords use the [operator reset](../devops/operations.md#admin-runbook).
- Non-owners see password-confirmed deletion with an irreversible-action confirmation. Owners instead see a transfer picker excluding themselves, backed by the owner-only coach roster; an empty list directs them to invite a coach. Successful transfer refreshes identity and discards owner-only roster/invite caches. [Foundation](../foundation.md#personas) defines deletion and transfer rules. Account controls disable during pending operations.

Invitations and team/group management:

- One deployment is one team. The owner invites coaches; any coach invites athletes. The Team tab offers create/list/revoke and role-labelled shareable links. The owner also sees the coach roster.
- Invites are single-use and expire after 24 hours. The raw token is returned only on creation; list/revoke access follows [foundation](../foundation.md#personas). The API list includes used/expired records, while the UI lists pending invites and summarizes the others.
- Athlete invites survive deletion of their creating coach. Coach invites are claimable only while their creator remains owner. `invited_by` is provenance, not team membership.
- Team offers Deactivate (with confirmation) and Reactivate per athlete. “Show deactivated” includes flagged inactive athletes; their detail/plan view remains available. Mutations refresh roster/overview state and display server errors. [Foundation](../foundation.md#personas) owns the data-retention and access rules.

RBAC/permissions:

- Use the [persona and RBAC reference](../foundation.md#personas). The UI hides unavailable actions, but the API is the authority.

Billing, subscriptions, plans:

- Not applicable: there is no billing, subscription or payment flow. Training plans are training content, not paid tiers.

## Regular usage

Login flow:

- Username/password login establishes the [30-day cookie session](../architecture/apis.md#design). Any authenticated query/mutation 401 clears account caches and returns to login, including deactivation or revocation. Account changes cancel old queries and reset local tab/modal/history state. Network failures show retry UI rather than pretending the user is unauthenticated.
- New athletes start at cycle 1/week 1 with poundage unset. Today asks for an integer bow poundage from 1–100 before displaying the poundage-dependent next milestone. Saving poundage preserves an existing cycle/week anchor.
- The seven-day weekly rhythm is a generic, editable starter plan with badges on unsaved days. Athlete and coach edits override individual days. There are no bundled SPT workout images; files can be attached to plan days. Existing saved overrides remain in use.
- The frontend still supplies six-week focus fallbacks and fixed 24/28/32/34 lb milestones, including dated targets, from `features/plan/defaults.ts`. These remain current presentation defaults; they are not newly defined athlete-specific requirements. Existing-user backfill behavior is in [migration operations](../devops/operations.md#ongoing-operations).

Emails, notifications, texts:

- None are sent by the app. Status messages and copied/shared links are user-driven UI actions, not background notifications.
