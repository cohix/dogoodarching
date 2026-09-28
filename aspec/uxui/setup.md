# Setup

## User installation

Download:

- Install the hosted PWA using Safari's Add to Home Screen on iOS or Chrome's Add to Home screen/Install on Android, as in the [README installation instructions](../../README.md#pwa-install-on-your-phone). There is no app-store binary.

Initial configuration:

- Open the app against an empty database to bootstrap the owner coach, then use invitations for subsequent accounts. See [README first run](../../README.md#first-run-accounts-roles-invites) and [signup experience](experience.md#signup-and-account). The [hosted auth blocker](../architecture/security.md#api-security) still applies pending work item 0002.

Superuser access:

- The owner is the highest application role, with the additional coach-invite/roster and invitation capabilities in [foundation](../foundation.md#personas). Database-level administration is separate; use the [operations runbook](../devops/operations.md#admin-runbook).
- **Planned (work item 0002):** ownership transfer, with the rules defined in [account management](experience.md#signup-and-account).
