# Experience

## Signup and account

Signup flow:

- A fresh database shows first-coach bootstrap. The first coach is the owner; later accounts join through owner/coach-issued invitations according to [RBAC](../foundation.md#personas).
- Invite links are shared out of band, with no email service. These are account-creation links, not passwordless login: the recipient chooses a username and password. Current paths are `/invite/<token>` and the SPA removes the path after successful acceptance. [Security](../architecture/security.md#api-security) records the hosted auth blocker.

Account management:

- Settings shows the username/role, personal export/import and logout for the current session. There is no password change, sign-out-everywhere, account deletion, athlete deactivation or ownership transfer UI/API today. Forgotten passwords require the [manual administrator procedure](../devops/operations.md#admin-runbook).
- **Planned (work item 0002):** password change using the current password, revoking other sessions; logout-all; password-confirmed account deletion including owned rows/blobs. Owners must transfer ownership before deleting their account, and the last active coach cannot delete their account. Deleting a non-owner coach leaves athletes and coach-uploaded files on athlete plans intact. Password reset without the current password remains manual.

Invitations and team/group management:

- One deployment is one team. The owner invites coaches; any coach invites athletes. The Team tab offers create/list/revoke and role-labelled shareable links. The owner also sees the coach roster.
- Invites are single-use and expire after 24 hours. The raw token is returned only on creation; list/revoke access follows [foundation](../foundation.md#personas). The API list includes used/expired records, while the UI lists pending invites and summarizes the others.
- Athlete invites survive deletion of their creating coach. Coach invites are claimable only while their creator remains owner. `invited_by` is provenance, not team membership.
- **Planned (work item 0002):** any coach can deactivate/reactivate an athlete. Deactivation disables login, revokes sessions and hides the athlete from the default roster, while keeping their data and username reserved; coaches retain plan access. A toggle includes deactivated athletes. The owner can transfer ownership to another active coach; the old owner's pending coach invites then become invalid. Invite-token fragments are planned in [security](../architecture/security.md#planned-work-item-0002).

RBAC/permissions:

- Use the [persona and RBAC reference](../foundation.md#personas). The UI hides unavailable actions, but the API is the authority.

Billing, subscriptions, plans:

- Not applicable: there is no billing, subscription or payment flow. Training plans are training content, not paid tiers.

## Regular usage

Login flow:

- Username/password login establishes the [30-day cookie session](../architecture/apis.md#design). Expired sessions return the user to the login form. Network failures show retry UI rather than pretending the user is unauthenticated.
- New athletes start at cycle 1/week 1 with poundage unset. Today asks for an integer bow poundage from 1–100 before displaying the poundage-dependent next milestone. Saving poundage preserves an existing cycle/week anchor.
- The seven-day weekly rhythm is a generic, editable starter plan with badges on unsaved days. Athlete and coach edits override individual days. There are no bundled SPT workout images; files can be attached to plan days. Existing saved overrides remain in use.
- The frontend still supplies six-week focus fallbacks and fixed 24/28/32/34 lb milestones, including dated targets, from `features/plan/defaults.ts`. These remain current presentation defaults; they are not newly defined athlete-specific requirements. Existing-user backfill behavior is in [migration operations](../devops/operations.md#ongoing-operations).

Emails, notifications, texts:

- None are sent by the app. Status messages and copied/shared links are user-driven UI actions, not background notifications.
